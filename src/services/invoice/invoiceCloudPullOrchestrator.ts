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
    return {
      vorgaenge: merge.vorgaenge,
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
