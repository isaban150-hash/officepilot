/**
 * DOCUMENT-ARCHIVE-TRUTH-03A1 — persist Fill-Confirm rows into existing DWR overlay.
 * Local App-Snapshot only (`persistAll`). No cloud / sync / InboxItem mutation.
 */
import type { DocumentFieldFillConfirmRow } from '../types/documentFieldFillConfirm';
import type { DocumentWorkResult } from '../types/documentWorkResult';
import { mapFillConfirmRowsToDocumentWorkResultOverlayEntries } from './documentFieldFillConfirmTruthBridge';
import { upsertDocumentWorkResultOverlayEntry } from './documentWorkResultMergeService';
import {
  getDocumentWorkResultForItem,
  upsertDocumentWorkResult,
} from './documentWorkResultService';
import { getDocumentWorkResultStoreSnapshot } from './documentWorkResultStoreService';
import { persistAll, type PersistResult } from './persistenceService';
import { getSyncClient } from './sync/syncClientService';
import { getWorkspaceStoreSnapshot } from './workspace/workspaceStore';

export type PersistFillConfirmOverlayErrorCode =
  | 'missing_document_work_result'
  | 'workspace_mismatch'
  | 'persist_failed';

export type PersistFillConfirmOverlayResult = {
  success: boolean;
  errorCode?: PersistFillConfirmOverlayErrorCode;
  persistResult?: PersistResult;
  documentWorkResult?: DocumentWorkResult;
};

function resolveWorkspaceId(): string | null {
  return (
    getWorkspaceStoreSnapshot()?.id ??
    getSyncClient().serverWorkspaceId ??
    getSyncClient().workspaceId ??
    null
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Same rule as documentWorkResultStoreService.workspaceMismatch (no new security exception). */
function workspaceMismatch(
  entryWorkspaceId: string | null | undefined,
  requestedWorkspaceId: string | null | undefined,
): boolean {
  if (!isNonEmptyString(requestedWorkspaceId)) return false;
  if (!isNonEmptyString(entryWorkspaceId)) return false;
  return entryWorkspaceId !== requestedWorkspaceId;
}

function mergeOverlayEntries(
  result: DocumentWorkResult,
  entries: ReturnType<typeof mapFillConfirmRowsToDocumentWorkResultOverlayEntries>,
): DocumentWorkResult {
  let next = result;
  for (const entry of entries) {
    next = upsertDocumentWorkResultOverlayEntry(next, entry);
  }
  return next;
}

/**
 * Batch-write Fill-Confirm confirmations/corrections/discards into DWR overlay,
 * then flush via a single `persistAll`. Rolls back the in-memory DWR on persist failure.
 */
export function persistFillConfirmRowsToDocumentWorkOverlay(input: {
  inboxItemId: string;
  rows: readonly DocumentFieldFillConfirmRow[];
  updatedAt?: string;
}): PersistFillConfirmOverlayResult {
  const inboxItemId = input.inboxItemId.trim();
  if (!inboxItemId) {
    return { success: false, errorCode: 'missing_document_work_result' };
  }

  const workspaceId = resolveWorkspaceId();
  const raw = getDocumentWorkResultStoreSnapshot().find(
    (entry) => entry.inboxItemId === inboxItemId,
  );
  if (!raw) {
    return { success: false, errorCode: 'missing_document_work_result' };
  }
  if (workspaceMismatch(raw.workspaceId, workspaceId)) {
    return { success: false, errorCode: 'workspace_mismatch' };
  }

  const current = getDocumentWorkResultForItem(inboxItemId, { workspaceId });
  if (!current) {
    return { success: false, errorCode: 'missing_document_work_result' };
  }

  const previousSnapshot = JSON.parse(JSON.stringify(current)) as DocumentWorkResult;
  const overlayEntries = mapFillConfirmRowsToDocumentWorkResultOverlayEntries(
    input.rows,
    input.updatedAt ?? new Date().toISOString(),
  );
  const merged = mergeOverlayEntries(current, overlayEntries);
  upsertDocumentWorkResult(merged);

  const persistResult = persistAll();
  if (!persistResult.success) {
    upsertDocumentWorkResult(previousSnapshot);
    return {
      success: false,
      errorCode: 'persist_failed',
      persistResult,
    };
  }

  return {
    success: true,
    persistResult,
    documentWorkResult: getDocumentWorkResultForItem(inboxItemId, { workspaceId }) ?? merged,
  };
}
