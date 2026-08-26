import type { SupabaseClient } from '@supabase/supabase-js';
import type { Vorgang } from '../../types/models';
import type { SyncSimulationReport } from '../../types/sync';
import {
  mapPullRowsIsolated,
  mergeCloudInvoicesIntoVorgaenge,
  type MergeCloudInvoicesResult,
} from './invoiceCloudPullMergeService';
import * as workspaceInvoiceCloud from './workspaceInvoiceCloudService';
import { WorkspaceInvoiceCloudError } from './workspaceInvoiceCloudService';
import { pullInvoicePaymentsFromCloud } from './workspaceInvoicePaymentCloudService';
import { calculatePaymentSummary } from '../invoicePaymentService';
import {
  mergeCloudPaymentsIntoInvoice,
  type CloudInvoicePaymentEntry,
} from '../vorgangService';

export interface ApplyInvoicePullResult {
  vorgaenge: Vorgang[];
  invoiceRpcFailed: boolean;
  merge: MergeCloudInvoicesResult | null;
  /** Clear only after successful local batch persist. */
  pendingIntentClears: string[];
}

/**
 * CLOUD-ORDER-CHAIN-03B2: pull invoices after vorgang merge, append-only merge, reconcile intents.
 * On full RPC failure: keep vorgaenge, report error, do not wipe local invoices.
 */
/**
 * PAYMENT-CLOUD-DURABILITY-04B2B — flicht die Cloud-Zahlungen in die Rechnungen.
 *
 * Zusammengeführt wird je Rechnung über die Zahlungskennung, nie über Betrag
 * oder Datum. Grabsteine (`reversedAt`) entfernen die gleichnamige lokale
 * Zahlung — sonst würde ein Gerät mit alter Kopie sie wiederbeleben.
 *
 * `paymentStatus` wird anschließend neu abgeleitet und **nicht** aus der Cloud
 * übernommen: Zahlungen sind die Wahrheit, der Status ist ihr Ergebnis.
 */
async function applyCloudPaymentsToVorgaenge(
  vorgaenge: Vorgang[],
  workspaceId: string,
  client?: SupabaseClient | null,
  since?: string | null,
): Promise<Vorgang[]> {
  const pulled = await pullInvoicePaymentsFromCloud({ client, workspaceId, since });
  if (pulled.outcome !== 'synced' || pulled.rows.length === 0) return vorgaenge;

  const byInvoice = new Map<string, CloudInvoicePaymentEntry[]>();
  for (const row of pulled.rows) {
    const list = byInvoice.get(row.clientInvoiceId) ?? [];
    list.push({
      clientInvoiceId: row.clientInvoiceId,
      clientPaymentId: row.clientPaymentId,
      amount: row.amount,
      paidOn: row.paidOn,
      reference: row.reference,
      note: row.note,
      createdAt: row.createdAt,
      reversedAt: row.reversedAt,
    });
    byInvoice.set(row.clientInvoiceId, list);
  }

  return vorgaenge.map((vorgang) => {
    let changed = false;
    const invoices = vorgang.invoices.map((invoice) => {
      const entries = byInvoice.get(invoice.id);
      if (!entries) return invoice;

      const payments = mergeCloudPaymentsIntoInvoice(invoice, entries);
      const next = { ...invoice, payments };
      changed = true;
      return { ...next, paymentStatus: calculatePaymentSummary(next).status };
    });
    return changed ? { ...vorgang, invoices } : vorgang;
  });
}

export async function applyInvoicePullAfterVorgangMerge(input: {
  workspaceId: string;
  vorgaenge: Vorgang[];
  report: SyncSimulationReport;
  client?: SupabaseClient | null;
  since?: string | null;
}): Promise<ApplyInvoicePullResult> {
  try {
    const rows = await workspaceInvoiceCloud.rpcPullWorkspaceInvoiceRows(input.workspaceId, {
      client: input.client,
      since: input.since,
    });
    const { mapped } = mapPullRowsIsolated(rows, input.workspaceId, input.report);
    const merge = mergeCloudInvoicesIntoVorgaenge(input.vorgaenge, mapped, {
      workspaceId: input.workspaceId,
      report: input.report,
      reconcileIntents: true,
    });

    /*
     * PAYMENT-CLOUD-DURABILITY-04B2B — Zahlungen reisen in einer eigenen
     * Tabelle und werden hier eingeflochten. Ein Fehlschlag darf den
     * Rechnungs-Pull nicht scheitern lassen: Ohne Zahlungen ist der Stand
     * unvollständig, ohne Rechnungen wäre er leer.
     */
    const vorgaengeWithPayments = await applyCloudPaymentsToVorgaenge(
      merge.vorgaenge,
      input.workspaceId,
      input.client,
      input.since,
    );

    return {
      vorgaenge: vorgaengeWithPayments,
      invoiceRpcFailed: false,
      merge,
      pendingIntentClears: merge.pendingIntentClears,
    };
  } catch (invoiceError) {
    const message =
      invoiceError instanceof WorkspaceInvoiceCloudError
        ? invoiceError.message
        : invoiceError instanceof Error
          ? invoiceError.message
          : 'Invoice-Pull fehlgeschlagen';
    input.report.errorCount += 1;
    input.report.errors.push({ outboxId: 'invoice-pull', message });
    return {
      vorgaenge: input.vorgaenge,
      invoiceRpcFailed: true,
      merge: null,
      pendingIntentClears: [],
    };
  }
}
