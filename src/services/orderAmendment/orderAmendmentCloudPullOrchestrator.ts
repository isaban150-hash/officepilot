import { getSupabaseClient, isSupabaseConfigured } from '../../lib/supabase';
import { buildPersistedStateSnapshot, persistAll } from '../persistenceService';
import {
  getAllVorgaenge,
  getVorgangStoreSnapshot,
  hydrateVorgangStore,
} from '../vorgangService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import * as orderAmendmentConfirmIntentService from './orderAmendmentConfirmIntentService';
import type { OrderAmendmentConfirmIntent } from './orderAmendmentConfirmIntentService';
import {
  mapAmendmentPullRowsIsolated,
  mergeCloudAmendmentsIntoVorgaenge,
  sanitizeOrderAmendmentPullIssue,
  type MergeCloudAmendmentsResult,
  type OrderAmendmentIntentClearKey,
  type OrderAmendmentPullIssue,
} from './orderAmendmentCloudPullMergeService';
import {
  rpcPullWorkspaceOrderAmendmentRows,
  WorkspaceOrderAmendmentCloudError,
} from './workspaceOrderAmendmentCloudService';

function shortenReportId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export type OrderAmendmentCloudPullFailureReason =
  | 'cloud_unavailable'
  | 'session_required'
  | 'workspace_required'
  | 'network_or_unknown'
  | 'invalid_response'
  | 'rpc_failed'
  | 'local_persist_failed';

export type OrderAmendmentCloudPullReport = {
  remoteRowsReceived: number;
  validRows: number;
  invalidRows: number;
  appliedCount: number;
  /** Idempotent no-op count. */
  noopCount: number;
  orphanCount: number;
  conflictCount: number;
  sequenceConflictCount: number;
  positionConflictCount: number;
  duplicateContentWarningCount: number;
  reconciledIntentCount: number;
  pendingIntentClearCount: number;
  intentClearFailureCount: number;
  affectedVorgangIds: string[];
  persisted: boolean;
  issues: OrderAmendmentPullIssue[];
  orphanReferences: MergeCloudAmendmentsResult['orphanReferences'];
  warnings: OrderAmendmentPullIssue[];
};

export type OrderAmendmentCloudPullResult =
  | {
      ok: true;
      report: OrderAmendmentCloudPullReport;
      merge: MergeCloudAmendmentsResult;
      clearedIntents: OrderAmendmentIntentClearKey[];
    }
  | {
      ok: false;
      reason: OrderAmendmentCloudPullFailureReason;
      errorKey: string;
      message?: string;
      report?: OrderAmendmentCloudPullReport;
    };

function errorKeyForReason(reason: OrderAmendmentCloudPullFailureReason): string {
  const map: Record<OrderAmendmentCloudPullFailureReason, string> = {
    cloud_unavailable: 'order_amendment_cloud_unavailable',
    session_required: 'order_amendment_session_required',
    workspace_required: 'order_amendment_workspace_required',
    network_or_unknown: 'order_amendment_pull_network_or_unknown',
    invalid_response: 'order_amendment_pull_invalid_response',
    rpc_failed: 'order_amendment_cloud_unavailable',
    local_persist_failed: 'order_amendment_local_persist_failed',
  };
  return map[reason];
}

async function hasAuthSession(): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;
  const { data, error } = await client.auth.getSession();
  return Boolean(!error && data.session);
}

function resolveActiveWorkspaceId(): string {
  return resolveCloudWorkspaceId(buildPersistedStateSnapshot()) ?? '';
}

function emptyReport(partial?: Partial<OrderAmendmentCloudPullReport>): OrderAmendmentCloudPullReport {
  return {
    remoteRowsReceived: 0,
    validRows: 0,
    invalidRows: 0,
    appliedCount: 0,
    noopCount: 0,
    orphanCount: 0,
    conflictCount: 0,
    sequenceConflictCount: 0,
    positionConflictCount: 0,
    duplicateContentWarningCount: 0,
    reconciledIntentCount: 0,
    pendingIntentClearCount: 0,
    intentClearFailureCount: 0,
    affectedVorgangIds: [],
    persisted: false,
    issues: [],
    orphanReferences: [],
    warnings: [],
    ...partial,
  };
}

function buildReport(
  merge: MergeCloudAmendmentsResult,
  options: {
    persisted: boolean;
    intentClearFailureCount?: number;
    extraIssues?: OrderAmendmentPullIssue[];
  },
): OrderAmendmentCloudPullReport {
  const extra = (options.extraIssues ?? []).map(sanitizeOrderAmendmentPullIssue);
  const issues = [...merge.issues, ...extra];
  return {
    remoteRowsReceived: merge.remoteRowsReceived,
    validRows: merge.validRows,
    invalidRows: merge.invalidRows,
    appliedCount: merge.appliedCount,
    noopCount: merge.noopCount,
    orphanCount: merge.orphanCount,
    conflictCount: merge.conflictCount,
    sequenceConflictCount: merge.sequenceConflictCount,
    positionConflictCount: merge.positionConflictCount,
    duplicateContentWarningCount: merge.duplicateContentWarningCount,
    reconciledIntentCount: merge.reconciledIntentCount,
    pendingIntentClearCount: merge.pendingIntentClearCount,
    intentClearFailureCount: options.intentClearFailureCount ?? 0,
    affectedVorgangIds: merge.affectedVorgangIds.map((id) => shortenReportId(id)),
    persisted: options.persisted,
    issues,
    orphanReferences: merge.orphanReferences,
    warnings: issues.filter(
      (item) =>
        item.reason === 'duplicate_content_warning' ||
        item.reason === 'intent_clear_failure',
    ),
  };
}

/**
 * Persist-free pull+merge core for ORDER-AMENDMENT-01B3B reuse.
 * Does not touch intents storage or persistAll.
 */
export async function pullAndMergeWorkspaceOrderAmendmentsInMemory(input: {
  workspaceId: string;
  vorgaenge: ReturnType<typeof getAllVorgaenge>;
  intents?: OrderAmendmentConfirmIntent[];
}): Promise<
  | { ok: true; merge: MergeCloudAmendmentsResult }
  | { ok: false; reason: OrderAmendmentCloudPullFailureReason; message?: string }
> {
  let rawRows: unknown[];
  try {
    rawRows = await rpcPullWorkspaceOrderAmendmentRows(input.workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceOrderAmendmentCloudError) {
      if (error.code === 'auth') {
        return { ok: false, reason: 'session_required', message: error.message };
      }
      if (error.code === 'invalid_response') {
        return { ok: false, reason: 'invalid_response', message: error.message };
      }
      if (error.code === 'network') {
        return { ok: false, reason: 'network_or_unknown', message: error.message };
      }
      if (error.code === 'validation') {
        return { ok: false, reason: 'workspace_required', message: error.message };
      }
      return { ok: false, reason: 'rpc_failed', message: error.message };
    }
    return {
      ok: false,
      reason: 'network_or_unknown',
      message: error instanceof Error ? error.message : 'Unbekannter Fehler',
    };
  }

  const mapped = mapAmendmentPullRowsIsolated(rawRows, input.workspaceId);
  const merge = mergeCloudAmendmentsIntoVorgaenge(input.vorgaenge, mapped.mapped, {
    workspaceId: input.workspaceId,
    intents: input.intents ?? orderAmendmentConfirmIntentService.listOrderAmendmentConfirmIntents(),
  });
  merge.invalidRows = mapped.invalidCount;
  merge.validRows = mapped.mapped.length;
  merge.remoteRowsReceived = rawRows.length;
  merge.issues = [
    ...mapped.issues.map(sanitizeOrderAmendmentPullIssue),
    ...merge.issues,
  ];

  return { ok: true, merge };
}

function clearPendingIntentsSafely(
  keys: OrderAmendmentIntentClearKey[],
): { cleared: OrderAmendmentIntentClearKey[]; failures: OrderAmendmentPullIssue[] } {
  const cleared: OrderAmendmentIntentClearKey[] = [];
  const failures: OrderAmendmentPullIssue[] = [];
  if (keys.length === 0) {
    return { cleared, failures };
  }

  try {
    orderAmendmentConfirmIntentService.clearOrderAmendmentConfirmIntents(keys);
  } catch {
    for (const key of keys) {
      if (orderAmendmentConfirmIntentService.getOrderAmendmentConfirmIntent(
        key.vorgangId,
        key.draftId,
      )) {
        failures.push({
          reason: 'intent_clear_failure',
          errorKey: 'order_amendment_intent_clear_failure',
          message: 'Confirm-Intent konnte nach Persistenz nicht gelöscht werden.',
          vorgangId: key.vorgangId,
          draftId: key.draftId,
        });
      } else {
        cleared.push(key);
      }
    }
    return { cleared, failures };
  }

  for (const key of keys) {
    if (orderAmendmentConfirmIntentService.getOrderAmendmentConfirmIntent(
      key.vorgangId,
      key.draftId,
    )) {
      failures.push({
        reason: 'intent_clear_failure',
        errorKey: 'order_amendment_intent_clear_failure',
        message: 'Confirm-Intent konnte nach Persistenz nicht gelöscht werden.',
        vorgangId: key.vorgangId,
        draftId: key.draftId,
      });
    } else {
      cleared.push(key);
    }
  }
  return { cleared, failures };
}

/**
 * Standalone ORDER-AMENDMENT-01B3A pull:
 * full remote pull → validate/isolate → write-once merge → one persist → intent clear.
 * Not wired into SyncAdapter / Bootstrap.
 */
export async function pullAndApplyWorkspaceOrderAmendmentsStandalone(): Promise<OrderAmendmentCloudPullResult> {
  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      reason: 'cloud_unavailable',
      errorKey: errorKeyForReason('cloud_unavailable'),
    };
  }

  if (!(await hasAuthSession())) {
    return {
      ok: false,
      reason: 'session_required',
      errorKey: errorKeyForReason('session_required'),
    };
  }

  const workspaceId = resolveActiveWorkspaceId();
  if (!workspaceId) {
    return {
      ok: false,
      reason: 'workspace_required',
      errorKey: errorKeyForReason('workspace_required'),
    };
  }

  const intents = orderAmendmentConfirmIntentService.listOrderAmendmentConfirmIntents();
  const pulled = await pullAndMergeWorkspaceOrderAmendmentsInMemory({
    workspaceId,
    vorgaenge: getAllVorgaenge(),
    intents,
  });

  if (!pulled.ok) {
    return {
      ok: false,
      reason: pulled.reason,
      errorKey: errorKeyForReason(pulled.reason),
      message: pulled.message,
      report: emptyReport(),
    };
  }

  const { merge } = pulled;

  if (!merge.changed && merge.pendingIntentClears.length === 0) {
    return {
      ok: true,
      merge,
      clearedIntents: [],
      report: buildReport(merge, { persisted: false }),
    };
  }

  const previous = getVorgangStoreSnapshot();
  hydrateVorgangStore(merge.vorgaenge);
  const persistResult = persistAll();
  if (!persistResult.success) {
    hydrateVorgangStore(previous);
    return {
      ok: false,
      reason: 'local_persist_failed',
      errorKey: errorKeyForReason('local_persist_failed'),
      message: 'Nachtrags-Pull konnte lokal nicht persistiert werden.',
      report: buildReport(merge, { persisted: false }),
    };
  }

  const clearResult = clearPendingIntentsSafely(merge.pendingIntentClears);

  return {
    ok: true,
    merge,
    clearedIntents: clearResult.cleared,
    report: buildReport(merge, {
      persisted: true,
      intentClearFailureCount: clearResult.failures.length,
      extraIssues: clearResult.failures,
    }),
  };
}
