import type { Vorgang, VorgangInvoice } from '../../types/models';
import type { SyncSimulationReport } from '../../types/sync';
import { buildInvoiceContentFingerprintFromInvoice } from '../invoiceService';
import {
  applyFinalizedInvoiceToVorgang,
  immutableInvoiceFingerprint,
} from '../vorgangService';
import {
  clearInvoiceFinalizeIntent,
  getInvoiceFinalizeIntent,
} from './invoiceFinalizeIntentService';
import type { MappedWorkspaceInvoicePull } from './workspaceInvoiceCloudService';
import { parseWorkspaceInvoicePullRow, mapWorkspaceInvoicePullRowToVorgangInvoice } from './workspaceInvoiceCloudService';

export type InvoicePullMergeConflictReason =
  | 'id_content_conflict'
  | 'number_id_conflict'
  | 'orphan'
  | 'invalid_row'
  | 'intent_fingerprint_conflict';

export interface InvoicePullMergeConflict {
  reason: InvoicePullMergeConflictReason;
  clientInvoiceId?: string;
  cloudInvoiceId?: string;
  vorgangId?: string;
  message: string;
}

export interface MergeCloudInvoicesResult {
  vorgaenge: Vorgang[];
  insertedCount: number;
  noopCount: number;
  statusRaisedCount: number;
  conflicts: InvoicePullMergeConflict[];
  /**
   * Intents that match adopted cloud invoices.
   * Cleared by the caller only after successful batch persist.
   */
  pendingIntentClears: string[];
}

function recordInvoiceConflict(
  report: SyncSimulationReport | undefined,
  conflict: InvoicePullMergeConflict,
): void {
  if (!report) return;
  report.conflictCount += 1;
  report.conflicts.push({
    entityType: 'vorgang',
    entityId: conflict.clientInvoiceId
      ? `invoice:${conflict.clientInvoiceId}`
      : `invoice:${conflict.reason}`,
    resolution: 'conflict',
  });
  report.errors.push({
    outboxId: 'invoice-pull',
    message: conflict.message,
  });
  report.errorCount += 1;
}

/**
 * Append-only merge of cloud invoices into local Vorgänge.
 * No second invoice domain. Reuses applyFinalizedInvoiceToVorgang rules.
 * Does not persist — caller applies state once.
 */
export function mergeCloudInvoicesIntoVorgaenge(
  vorgaenge: Vorgang[],
  cloudInvoices: MappedWorkspaceInvoicePull[],
  options?: {
    workspaceId?: string;
    report?: SyncSimulationReport;
    reconcileIntents?: boolean;
  },
): MergeCloudInvoicesResult {
  const byId = new Map(vorgaenge.map((v) => [v.id, v]));
  const conflicts: InvoicePullMergeConflict[] = [];
  let insertedCount = 0;
  let noopCount = 0;
  let statusRaisedCount = 0;
  const pendingIntentClears: string[] = [];
  const workspaceId = options?.workspaceId?.trim() ?? '';

  for (const cloud of cloudInvoices) {
    if (workspaceId && cloud.workspaceId !== workspaceId) {
      const conflict: InvoicePullMergeConflict = {
        reason: 'orphan',
        clientInvoiceId: cloud.clientInvoiceId,
        cloudInvoiceId: cloud.cloudInvoiceId,
        vorgangId: cloud.vorgangId,
        message: `Rechnung ${cloud.clientInvoiceId} gehört nicht zum aktiven Workspace.`,
      };
      conflicts.push(conflict);
      recordInvoiceConflict(options?.report, conflict);
      continue;
    }

    const local = byId.get(cloud.vorgangId);
    if (!local) {
      const conflict: InvoicePullMergeConflict = {
        reason: 'orphan',
        clientInvoiceId: cloud.clientInvoiceId,
        cloudInvoiceId: cloud.cloudInvoiceId,
        vorgangId: cloud.vorgangId,
        message: `Orphan-Rechnung ${cloud.clientInvoiceId}: Vorgang ${cloud.vorgangId} fehlt lokal.`,
      };
      conflicts.push(conflict);
      recordInvoiceConflict(options?.report, conflict);
      continue;
    }

    const applied = applyFinalizedInvoiceToVorgang(local, cloud.invoice);
    if (!applied.ok || !applied.vorgang) {
      const reason: InvoicePullMergeConflictReason =
        !applied.ok && applied.reason === 'number_id_conflict'
          ? 'number_id_conflict'
          : 'id_content_conflict';
      const conflict: InvoicePullMergeConflict = {
        reason,
        clientInvoiceId: cloud.clientInvoiceId,
        cloudInvoiceId: cloud.cloudInvoiceId,
        vorgangId: cloud.vorgangId,
        message:
          reason === 'number_id_conflict'
            ? `Nummernkonflikt für Rechnung ${cloud.invoice.number} (ID ${cloud.clientInvoiceId}).`
            : `Inhaltskonflikt für Rechnung ${cloud.clientInvoiceId}.`,
      };
      conflicts.push(conflict);
      recordInvoiceConflict(options?.report, conflict);
      continue;
    }

    byId.set(cloud.vorgangId, applied.vorgang);
    if (applied.action === 'inserted') insertedCount += 1;
    else if (applied.action === 'status_raised') statusRaisedCount += 1;
    else noopCount += 1;

    if (options?.reconcileIntents !== false && workspaceId) {
      const intentResult = matchInvoiceFinalizeIntentForClear({
        workspaceId,
        vorgangId: cloud.vorgangId,
        invoice: applied.invoice,
      });
      if (intentResult === 'matched') {
        pendingIntentClears.push(cloud.vorgangId);
      } else if (intentResult === 'fingerprint_conflict') {
        const conflict: InvoicePullMergeConflict = {
          reason: 'intent_fingerprint_conflict',
          clientInvoiceId: cloud.clientInvoiceId,
          cloudInvoiceId: cloud.cloudInvoiceId,
          vorgangId: cloud.vorgangId,
          message: `Finalize-Intent für ${cloud.clientInvoiceId} weicht vom Cloud-Inhalt ab.`,
        };
        conflicts.push(conflict);
        recordInvoiceConflict(options?.report, conflict);
      }
    }
  }

  // Preserve original order; replace merged vorgänge by id.
  const nextVorgaenge = vorgaenge.map((v) => byId.get(v.id) ?? v);

  if (options?.report && (insertedCount > 0 || statusRaisedCount > 0)) {
    options.report.mergedEntityCount += insertedCount + statusRaisedCount;
  }

  return {
    vorgaenge: nextVorgaenge,
    insertedCount,
    noopCount,
    statusRaisedCount,
    conflicts,
    pendingIntentClears,
  };
}

/**
 * Match finalize intent for later clear (after successful batch persist).
 * Does not mutate storage.
 */
export function matchInvoiceFinalizeIntentForClear(input: {
  workspaceId: string;
  vorgangId: string;
  invoice: VorgangInvoice;
}): 'matched' | 'kept' | 'fingerprint_conflict' | 'absent' {
  const intent = getInvoiceFinalizeIntent(input.vorgangId);
  if (!intent) return 'absent';
  if (intent.workspaceId !== input.workspaceId) return 'kept';
  if (intent.clientInvoiceId !== input.invoice.id) return 'kept';

  const cloudFingerprint = buildInvoiceContentFingerprintFromInvoice(input.invoice);
  if (intent.contentFingerprint !== cloudFingerprint) {
    return 'fingerprint_conflict';
  }

  return 'matched';
}

/**
 * Test/helper: match + clear immediately.
 * Production pull defers clear until after batch persist via pendingIntentClears.
 */
export function reconcileInvoiceFinalizeIntentAfterMerge(input: {
  workspaceId: string;
  vorgangId: string;
  invoice: VorgangInvoice;
}): 'cleared' | 'kept' | 'fingerprint_conflict' | 'absent' {
  const match = matchInvoiceFinalizeIntentForClear(input);
  if (match === 'matched') {
    clearInvoiceFinalizeIntent(input.vorgangId);
    return 'cleared';
  }
  return match;
}

export function clearMatchedInvoiceFinalizeIntents(vorgangIds: string[]): void {
  for (const vorgangId of vorgangIds) {
    clearInvoiceFinalizeIntent(vorgangId);
  }
}

/**
 * Validate raw RPC rows, skip invalid ones (isolated), map to pull models.
 */
export function mapPullRowsIsolated(
  rawRows: unknown[],
  workspaceId: string,
  report?: SyncSimulationReport,
): { mapped: MappedWorkspaceInvoicePull[]; invalidCount: number } {
  const mapped: MappedWorkspaceInvoicePull[] = [];
  let invalidCount = 0;

  for (const raw of rawRows) {
    const parsed = parseWorkspaceInvoicePullRow(raw);
    if (!parsed || parsed.workspace_id !== workspaceId) {
      invalidCount += 1;
      const rawClientId =
        raw && typeof raw === 'object'
          ? String((raw as { client_invoice_id?: string }).client_invoice_id ?? '').trim()
          : '';
      const conflict: InvoicePullMergeConflict = {
        reason: 'invalid_row',
        message: 'Ungültige Cloud-Rechnungszeile übersprungen.',
        clientInvoiceId: parsed?.client_invoice_id || rawClientId || undefined,
      };
      recordInvoiceConflict(report, conflict);
      continue;
    }
    mapped.push(mapWorkspaceInvoicePullRowToVorgangInvoice(parsed));
  }

  return { mapped, invalidCount };
}

/** Test helper — exposes fingerprint parity checks. */
export function invoicesHaveSameImmutableContent(
  a: VorgangInvoice,
  b: VorgangInvoice,
  vorgangId?: string,
): boolean {
  return immutableInvoiceFingerprint(a, vorgangId) === immutableInvoiceFingerprint(b, vorgangId);
}
