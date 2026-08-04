/**
 * Document-scoped orchestration for TruthView (store read + resolve).
 * Keep UI free of overlay rules — only call this helper.
 *
 * DOCUMENT-ARCHIVE-TRUTH-03A2 — read-only CompanyDocument → Inbox TruthView adapter.
 */
import type { DocumentFieldFillConfirmRow } from '../types/documentFieldFillConfirm';
import type { CompanyDocument, InboxItem, WorkflowResult } from '../types/models';
import type { DocumentWorkTruthView } from '../types/documentWorkTruth';
import { mapFillConfirmRowsToSessionTruthOverlay } from './documentFieldFillConfirmTruthBridge';
import {
  getDocumentWorkResultForItem,
  isDocumentWorkResultUsableForDisplay,
} from './documentWorkResultService';
import { resolveDocumentWorkResult } from './documentWorkResultResolveService';
import { resolveDocumentWorkTruthViewFromArchiveSnapshot } from './documentArchiveTruthSnapshotService';
import { getInboxItemById } from './inboxService';
import { isEntitySyncActive } from './sync/syncMetaService';

export function buildDocumentWorkTruthViewForInboxItem(input: {
  item: InboxItem;
  liveWorkflow?: WorkflowResult | null;
  /** Session Fill-Confirm rows — ephemeral overlay into the same TruthView. */
  sessionFillConfirmRows?: readonly DocumentFieldFillConfirmRow[] | null;
  /**
   * Optional explicit workspace for DWR guards.
   * When omitted, getDocumentWorkResultForItem / isDocumentWorkResultUsableForDisplay
   * use their existing ambient workspace resolution (unchanged callers).
   */
  workspaceId?: string | null;
}): DocumentWorkTruthView | null {
  const { item, liveWorkflow, sessionFillConfirmRows, workspaceId } = input;
  if (liveWorkflow && liveWorkflow.inboxItemId !== item.id) {
    return null;
  }

  const workspaceOptions =
    workspaceId !== undefined ? { workspaceId } : undefined;

  const stored = getDocumentWorkResultForItem(item.id, workspaceOptions);
  const usableStored =
    stored && isDocumentWorkResultUsableForDisplay(stored, item, workspaceOptions)
      ? stored
      : null;

  const bridge = mapFillConfirmRowsToSessionTruthOverlay(sessionFillConfirmRows);

  const liveBi = liveWorkflow?.businessInterpretation ?? null;
  if (liveBi) {
    return resolveDocumentWorkResult({
      documentWorkResult: usableStored,
      liveBusinessInterpretation: liveBi,
      liveWorkflowDecision: liveWorkflow.workflowDecision ?? null,
      inboxItemId: item.id,
      sessionOverlayEntries: bridge.sessionOverlayEntries,
      sessionConfirmedExtraFacts: bridge.sessionConfirmedExtraFacts,
    });
  }

  if (usableStored) {
    return resolveDocumentWorkResult({
      documentWorkResult: usableStored,
      liveBusinessInterpretation: null,
      inboxItemId: item.id,
      sessionOverlayEntries: bridge.sessionOverlayEntries,
      sessionConfirmedExtraFacts: bridge.sessionConfirmedExtraFacts,
    });
  }

  // No live BI and no stored DWR — still allow session-only truth when Fill-Confirm
  // has confirmed values: need a minimal BI shell is not available → null.
  // Session overlay alone cannot synthesize BI without a base.
  return null;
}

/** DOCUMENT-ARCHIVE-TRUTH-03A2 — slim reason codes (no status platform). */
export type CompanyDocumentTruthReason =
  | 'available'
  | 'document_inactive'
  | 'no_source_inbox'
  | 'source_inbox_missing'
  | 'truth_unavailable';

export type CompanyDocumentTruthDiagnostic = 'origin_conflict';

export type ResolveDocumentWorkTruthViewForCompanyDocumentResult = {
  truthView: DocumentWorkTruthView | null;
  reason: CompanyDocumentTruthReason;
  /** Non-blocking diagnostics (e.g. reverse-link mismatch). */
  diagnostic?: CompanyDocumentTruthDiagnostic;
};

/**
 * DOCUMENT-ARCHIVE-TRUTH-03A2 — read-only TruthView for archived CompanyDocuments.
 * Origin: document.sourceInboxItemId first (live Inbox + DWR).
 * ARCHIVE-TRUTH-DURABILITY-01 — fallback to immutable archiveTruthSnapshot when
 * InboxItem or usable DWR is missing.
 * Never persists, never repairs links, never synthesizes confirmations.
 *
 * Workspace security: optional input.workspaceId is forwarded to the Inbox TruthView
 * path and to snapshot usability checks. No parallel Truth engine.
 *
 * InboxItem sync.workspaceId: no dedicated public membership API exists; rely on DWR guards.
 */
export function resolveDocumentWorkTruthViewForCompanyDocument(input: {
  document: CompanyDocument;
  workspaceId?: string | null;
}): ResolveDocumentWorkTruthViewForCompanyDocumentResult {
  const { document } = input;

  if (!isEntitySyncActive(document)) {
    return { truthView: null, reason: 'document_inactive' };
  }

  const workspaceOptions =
    input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : undefined;

  const sourceInboxItemId = document.sourceInboxItemId?.trim();
  if (!sourceInboxItemId) {
    const fromSnapshot = tryResolveArchiveTruthSnapshot(document, workspaceOptions);
    if (fromSnapshot) {
      return { truthView: fromSnapshot, reason: 'available' };
    }
    return { truthView: null, reason: 'no_source_inbox' };
  }

  const item = getInboxItemById(sourceInboxItemId);
  if (!item) {
    const fromSnapshot = tryResolveArchiveTruthSnapshot(document, workspaceOptions);
    if (fromSnapshot) {
      // Keep diagnostic reason; Facts-Card / AI still receive TruthView.
      return { truthView: fromSnapshot, reason: 'source_inbox_missing' };
    }
    return { truthView: null, reason: 'source_inbox_missing' };
  }

  let diagnostic: CompanyDocumentTruthDiagnostic | undefined;
  if (
    typeof item.archiveDocumentId === 'string' &&
    item.archiveDocumentId.trim().length > 0 &&
    item.archiveDocumentId !== document.id
  ) {
    diagnostic = 'origin_conflict';
  }

  const truthView = buildDocumentWorkTruthViewForInboxItem({
    item,
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
  });

  if (truthView) {
    return { truthView, reason: 'available', diagnostic };
  }

  const fromSnapshot = tryResolveArchiveTruthSnapshot(document, workspaceOptions);
  if (fromSnapshot) {
    return { truthView: fromSnapshot, reason: 'available', diagnostic };
  }

  return { truthView: null, reason: 'truth_unavailable', diagnostic };
}

function tryResolveArchiveTruthSnapshot(
  document: CompanyDocument,
  workspaceOptions?: { workspaceId?: string | null },
): DocumentWorkTruthView | null {
  const snapshot = document.archiveTruthSnapshot;
  if (!snapshot) return null;
  // Workspace gate: same ambient/explicit workspaceId as live DWR (workspace store /
  // caller). Do not compare to document.sync.workspaceId — sync client IDs differ.
  return resolveDocumentWorkTruthViewFromArchiveSnapshot(snapshot, workspaceOptions);
}
