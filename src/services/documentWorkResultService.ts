/**
 * Document Work Result facade — project, merge, upsert, restore helpers.
 *
 * Successful analysis commits DWR to the in-memory store and flushes via
 * `flushDocumentWorkResultPersistence()` (existing `persistAll`). Unusable /
 * failed projections must not destroy a previous valid snapshot.
 */
import type { DocumentWorkResult } from '../types/documentWorkResult';
import type { InboxItem, WorkflowResult, WorkflowWarning } from '../types/models';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import { mergeDocumentWorkResultOnReanalysis } from './documentWorkResultMergeService';
import {
  buildDocumentWorkResultSourceFingerprint,
  projectDocumentWorkResultFromWorkflow,
} from './documentWorkResultProjectionService';
import {
  getDocumentWorkResult,
  removeDocumentWorkResultForInboxItem,
  upsertDocumentWorkResult,
} from './documentWorkResultStoreService';
import { persistAll, type PersistResult } from './persistenceService';
import { getSyncClient } from './sync/syncClientService';
import { getWorkspaceStoreSnapshot } from './workspace/workspaceStore';

export {
  buildDocumentWorkResultSourceFingerprint,
  projectDocumentWorkResultFromWorkflow,
} from './documentWorkResultProjectionService';
export {
  mergeDocumentWorkResultOnReanalysis,
  resolveDocumentWorkResultOverlaySlot,
  upsertDocumentWorkResultOverlayEntry,
} from './documentWorkResultMergeService';
export {
  resolveDocumentWorkResult,
  mergeDocumentWorkResultOverlayWithSession,
  listDocumentWorkTruthAssistFacts,
  buildDocumentWorkTruthAssistContextLines,
  buildDocumentWorkTruthConflictDisplayLines,
} from './documentWorkResultResolveService';
export { buildDocumentWorkTruthViewForInboxItem } from './documentWorkResultTruthOrchestration';
export {
  resolveDocumentWorkTruthViewForCompanyDocument,
  type CompanyDocumentTruthReason,
  type CompanyDocumentTruthDiagnostic,
  type ResolveDocumentWorkTruthViewForCompanyDocumentResult,
} from './documentWorkResultTruthOrchestration';
export { mapFillConfirmRowsToSessionTruthOverlay } from './documentFieldFillConfirmTruthBridge';
export {
  DOCUMENT_WORK_RESULT_SLOT_HANDLERS,
  getDocumentWorkResultSlotHandler,
  isDocumentWorkResultKnownSlotId,
} from './documentWorkResultSlotRegistry';
export {
  getDocumentWorkResult,
  getDocumentWorkResultStoreSnapshot,
  hydrateDocumentWorkResultStore,
  isValidDocumentWorkResultEntry,
  removeDocumentWorkResultForInboxItem,
  resetDocumentWorkResultStoreForTests,
  upsertDocumentWorkResult,
} from './documentWorkResultStoreService';

function resolveWorkspaceId(): string | null {
  return (
    getWorkspaceStoreSnapshot()?.id ??
    getSyncClient().serverWorkspaceId ??
    getSyncClient().workspaceId ??
    null
  );
}

function cloneDocumentWorkResult(entry: DocumentWorkResult): DocumentWorkResult {
  return JSON.parse(JSON.stringify(entry)) as DocumentWorkResult;
}

/**
 * Small usability gate for analysis projections.
 * Requires a non-null Business Interpretation core — no large validation engine.
 */
export function isDocumentWorkResultCoreUsable(
  result: Pick<DocumentWorkResult, 'businessInterpretation' | 'inboxItemId' | 'sourceFingerprint'>,
): boolean {
  if (typeof result.inboxItemId !== 'string' || result.inboxItemId.trim().length === 0) {
    return false;
  }
  if (typeof result.sourceFingerprint !== 'string' || result.sourceFingerprint.trim().length === 0) {
    return false;
  }
  return result.businessInterpretation != null;
}

export function isDocumentWorkResultUsableForDisplay(
  result: DocumentWorkResult,
  item: InboxItem,
  options?: { workspaceId?: string | null },
): boolean {
  if (result.inboxItemId !== item.id) return false;
  const workspaceId = options?.workspaceId ?? resolveWorkspaceId();
  if (
    typeof workspaceId === 'string' &&
    workspaceId.trim().length > 0 &&
    typeof result.workspaceId === 'string' &&
    result.workspaceId.trim().length > 0 &&
    result.workspaceId !== workspaceId
  ) {
    return false;
  }
  const fingerprint = buildDocumentWorkResultSourceFingerprint(item);
  return result.sourceFingerprint === fingerprint;
}

/**
 * Load snapshot for an inbox item, applying current-workspace isolation when possible.
 */
export function getDocumentWorkResultForItem(
  inboxItemId: string,
  options?: { workspaceId?: string | null },
): DocumentWorkResult | null {
  return getDocumentWorkResult(inboxItemId, {
    workspaceId: options?.workspaceId ?? resolveWorkspaceId(),
  });
}

/**
 * Project + merge + upsert in memory only (no flush).
 * Prefer `commitDocumentWorkResultFromAnalysis` on the analysis hotpath.
 */
export function upsertDocumentWorkResultFromWorkflow(
  workflow: WorkflowResult,
  inboxItem: InboxItem,
): DocumentWorkResult {
  const projected = projectDocumentWorkResultFromWorkflow({
    workflow,
    inboxItem,
    workspaceId: resolveWorkspaceId(),
  });
  const previous = getDocumentWorkResult(inboxItem.id);
  const merged = mergeDocumentWorkResultOnReanalysis(previous, projected);
  return upsertDocumentWorkResult(merged);
}

export type CommitDocumentWorkResultFromAnalysisOutcome = {
  /** Stored DWR after commit, or previous when skipped / rolled back. */
  result: DocumentWorkResult | null;
  persisted: boolean;
  skipped: boolean;
  reason: 'ok' | 'unusable_projection' | 'persist_failed';
  persistResult?: PersistResult;
};

/**
 * Analysis hotpath: merge usable projection, upsert, flush via existing persistAll.
 * Unusable projections leave a previous valid DWR untouched.
 * Persist failure restores the prior memory snapshot (Fill-Confirm rollback pattern).
 */
export function commitDocumentWorkResultFromAnalysis(
  workflow: WorkflowResult,
  inboxItem: InboxItem,
): CommitDocumentWorkResultFromAnalysisOutcome {
  const previous = getDocumentWorkResult(inboxItem.id);
  const previousSnapshot = previous ? cloneDocumentWorkResult(previous) : null;

  const projected = projectDocumentWorkResultFromWorkflow({
    workflow,
    inboxItem,
    workspaceId: resolveWorkspaceId(),
  });

  if (!isDocumentWorkResultCoreUsable(projected)) {
    return {
      result: previousSnapshot,
      persisted: false,
      skipped: true,
      reason: 'unusable_projection',
    };
  }

  const merged = mergeDocumentWorkResultOnReanalysis(previous, projected);
  upsertDocumentWorkResult(merged);

  const persistResult = flushDocumentWorkResultPersistence();
  if (!persistResult.success) {
    if (previousSnapshot) {
      upsertDocumentWorkResult(previousSnapshot);
    } else {
      removeDocumentWorkResultForInboxItem(inboxItem.id);
    }
    console.warn(
      '[documentWorkResult] Persistenz nach Analyse fehlgeschlagen – vorheriger Zustand wiederhergestellt.',
      persistResult,
    );
    return {
      result: previousSnapshot,
      persisted: false,
      skipped: false,
      reason: 'persist_failed',
      persistResult,
    };
  }

  return {
    result: getDocumentWorkResult(inboxItem.id),
    persisted: true,
    skipped: false,
    reason: 'ok',
    persistResult,
  };
}

/**
 * @deprecated Prefer `commitDocumentWorkResultFromAnalysis` on the analysis path.
 * Memory upsert; optional immediate flush when `persist === true`.
 */
export function persistDocumentWorkResultFromWorkflow(
  workflow: WorkflowResult,
  inboxItem: InboxItem,
  options?: { persist?: boolean },
): DocumentWorkResult {
  const saved = upsertDocumentWorkResultFromWorkflow(workflow, inboxItem);
  if (options?.persist === true) {
    persistAll();
  }
  return saved;
}

/**
 * Explicit full-app flush including Document Work Results.
 */
export function flushDocumentWorkResultPersistence(): PersistResult {
  return persistAll();
}

/**
 * Display-only WorkflowResult adapter from a restored Document Work Result.
 * Must never be treated as a live specialist analysis for confirm/execution.
 * Overlay is preserved on the snapshot but not applied onto BI in this sprint.
 */
export function buildWorkflowResultFromDocumentWorkResult(
  result: DocumentWorkResult,
  inboxItem: InboxItem,
): WorkflowResult {
  const bi = result.businessInterpretation;
  const refs = result.specialistRefs;
  const warnings: WorkflowWarning[] = [
    {
      id: 'document_work_result_restored_snapshot',
      message:
        'Wiederhergestellter Analyse-Snapshot (kein vollständiges Live-WorkflowResult).',
    },
  ];
  if (!bi) {
    warnings.push({
      id: 'document_work_result_bi_missing',
      message: 'Gespeicherte Analyse ohne Business Interpretation.',
    });
  }

  const classificationConfidence =
    bi?.sourceDocument.classificationConfidence ?? 'low';

  return {
    inboxItemId: inboxItem.id,
    companyRelevant: refs.companyRelevant,
    companyRelevance: {
      isRelevant: refs.companyRelevant,
      reasons: [],
      matchedHints: [],
    },
    classifiedKind: refs.classifiedKind ?? inboxItem.classifiedKind ?? 'sonstiges',
    classificationConfidence,
    classification: null,
    documentExplanation: null,
    documentUnderstanding: null,
    documentAiActions: [],
    contractAnalysis: null,
    contractIntelligence: null,
    contractOrderProposal: null,
    suggestedVorgang: null,
    similarVorgaenge: [],
    suggestedOrderPositions: [],
    suggestedTasks: [],
    suggestedArchiveFolder: inboxItem.digitalFolder,
    requiredDocuments: [],
    pendingSummary: null,
    warnings,
    nextActions: [],
    businessInterpretation: bi,
    workflowDecision: result.workflowDecision ?? null,
  };
}

/** True when a WorkflowResult originated from a restored Document Work Result shell. */
export function isRestoredDocumentWorkResultWorkflow(
  workflow: WorkflowResult | null | undefined,
): boolean {
  return Boolean(
    workflow?.warnings.some((warning) => warning.id === 'document_work_result_restored_snapshot'),
  );
}

/** Test helper: serialize round-trip. */
export function serializeDocumentWorkResult(result: DocumentWorkResult): string {
  return JSON.stringify(result);
}

export function deserializeDocumentWorkResult(raw: string): DocumentWorkResult {
  return JSON.parse(raw) as DocumentWorkResult;
}

export function clearDocumentWorkResultForInboxItem(
  inboxItemId: string,
  options?: { persist?: boolean },
): void {
  removeDocumentWorkResultForInboxItem(inboxItemId);
  if (options?.persist === true) {
    persistAll();
  }
}

/** Expose text length for diagnostics/tests without exporting OCR helpers. */
export function getDocumentWorkResultSourceTextLength(item: InboxItem): number {
  return getInboxExtractedDocumentText(item).trim().length;
}
