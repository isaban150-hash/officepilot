import type { SupabaseClient } from '@supabase/supabase-js';
import type { Vorgang, VorgangInvoice } from '../../types/models';
import type { SyncSimulationReport } from '../../types/sync';
import {
  mapPullRowsIsolated,
  mergeCloudInvoicesIntoVorgaenge,
  type MergeCloudInvoicesResult,
} from './invoiceCloudPullMergeService';
import * as workspaceInvoiceCloud from './workspaceInvoiceCloudService';
import { WorkspaceInvoiceCloudError } from './workspaceInvoiceCloudService';
import { isInvoicePaymentCloudSilent, pullInvoicePaymentsFromCloud } from './workspaceInvoicePaymentCloudService';
import { calculatePaymentSummary } from '../invoicePaymentService';
import {
  mergeCloudPaymentsIntoInvoice,
  type CloudInvoicePaymentEntry,
} from '../vorgangService';
import { alignInvoiceFactsForMember } from './invoiceMemberAlignment';
import { recordServicePeriodCloudProofs } from './invoiceOutputClearance';

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
  /**
   * MANUAL-INVOICE-01B2c — die Rechnungen ohne Auftrag bekommen ihre Cloud-
   * Zahlungen über dieselbe Zusammenführung. Bisher liefen sie leer: Die
   * Zahlungstabelle adressiert über `client_invoice_id`, hier wurde aber nur
   * über die Vorgänge iteriert.
   */
  manualInvoices: readonly VorgangInvoice[],
  workspaceId: string,
  client?: SupabaseClient | null,
  since?: string | null,
  report?: SyncSimulationReport,
): Promise<{ vorgaenge: Vorgang[]; manualInvoices: VorgangInvoice[] }> {
  const pulled = await pullInvoicePaymentsFromCloud({ client, workspaceId, since });
  /*
   * FINANZ-CORE-01A (ZAH-17) — ein gescheiterter Zahlungsabzug steht im Bericht. Bisher meldete
   * der Sync Erfolg, obwohl Zahlungen anderer Geräte fehlten; die Rechnungen blieben „offen".
   */
  if (pulled.outcome !== 'synced' && report && !isInvoicePaymentCloudSilent(pulled.outcome)) {
    report.errorCount += 1;
    report.errors.push({ outboxId: 'invoice-payment-pull', message: pulled.detail ?? pulled.outcome });
  }
  if (pulled.outcome !== 'synced' || pulled.rows.length === 0) {
    return { vorgaenge, manualInvoices: [...manualInvoices] };
  }

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
      method: row.method,
      createdAt: row.createdAt,
      reversedAt: row.reversedAt,
    });
    byInvoice.set(row.clientInvoiceId, list);
  }

  const applyToInvoice = (invoice: VorgangInvoice): VorgangInvoice => {
    const entries = byInvoice.get(invoice.id);
    if (!entries) return invoice;
    const payments = mergeCloudPaymentsIntoInvoice(invoice, entries);
    const next = { ...invoice, payments };
    return { ...next, paymentStatus: calculatePaymentSummary(next).status };
  };

  return {
    vorgaenge: vorgaenge.map((vorgang) => {
      let changed = false;
      const invoices = vorgang.invoices.map((invoice) => {
        const next = applyToInvoice(invoice);
        if (next !== invoice) changed = true;
        return next;
      });
      return changed ? { ...vorgang, invoices } : vorgang;
    }),
    manualInvoices: manualInvoices.map(applyToInvoice),
  };
}

/**
 * GO-LIVE-SECURITY-01 — auf dem Gerät eines Mitglieds gelten Versand und
 * Bestätigung des Leistungszeitraums so, wie die Cloud sie trägt (siehe
 * `invoiceMemberAlignment`). Der monotone Merge davor bleibt unverändert; er
 * ist für Inhaber und Verwaltung richtig, deren lokaler Stand ein noch nicht
 * gesicherter Vermerk sein kann.
 */
function alignInvoicesForMember(
  vorgaenge: Vorgang[],
  manualInvoices: VorgangInvoice[],
  cloudInvoices: ReadonlyMap<string, VorgangInvoice>,
): { vorgaenge: Vorgang[]; manualInvoices: VorgangInvoice[] } {
  const align = (invoice: VorgangInvoice): VorgangInvoice => {
    const cloud = cloudInvoices.get(invoice.id);
    return cloud ? (alignInvoiceFactsForMember(invoice, cloud) ?? invoice) : invoice;
  };
  return {
    vorgaenge: vorgaenge.map((vorgang) => {
      const invoices = vorgang.invoices.map(align);
      return invoices.some((invoice, index) => invoice !== vorgang.invoices[index]) ? { ...vorgang, invoices } : vorgang;
    }),
    manualInvoices: manualInvoices.map(align),
  };
}

export async function applyInvoicePullAfterVorgangMerge(input: {
  workspaceId: string;
  vorgaenge: Vorgang[];
  report: SyncSimulationReport;
  client?: SupabaseClient | null;
  since?: string | null;
  /** GO-LIVE-SECURITY-01 — nur für eine bekannte Mitgliedsrolle setzen. */
  alignForMember?: boolean;
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
    const withPayments = await applyCloudPaymentsToVorgaenge(
      merge.vorgaenge,
      merge.manualInvoices,
      input.workspaceId,
      input.client,
      input.since,
      input.report,
    );

    const aligned = input.alignForMember
      ? alignInvoicesForMember(
          withPayments.vorgaenge,
          withPayments.manualInvoices,
          new Map(mapped.map((cloud) => [cloud.clientInvoiceId, cloud.invoice])),
        )
      : withPayments;
    if (input.alignForMember) {
      /*
       * GO-LIVE-SECURITY-01 — was die Cloud bestätigt trägt, darf dieses Gerät
       * auch offline ausgeben (siehe `invoiceOutputClearance`).
       */
      recordServicePeriodCloudProofs(
        input.workspaceId,
        mapped
          .filter((cloud) => cloud.invoice.servicePeriodConfirmed === true)
          .map((cloud) => cloud.clientInvoiceId),
      );
    }

    return {
      vorgaenge: aligned.vorgaenge,
      invoiceRpcFailed: false,
      /* 01B2c — der Merge trägt die freien Rechnungen weiter, jetzt mit
         eingeflochtenen Cloud-Zahlungen. */
      merge: { ...merge, manualInvoices: aligned.manualInvoices },
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
