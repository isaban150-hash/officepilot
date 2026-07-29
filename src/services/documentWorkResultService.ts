/**
 * Document Work Result facade — project, merge, upsert, restore helpers.
 *
 * Analysis hotpath updates the in-memory store only. Durable writes ride the
 * next natural `persistAll()` (inbox mutations, confirms, etc.).
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
  buildDocumentWorkTruthAssistContextLines,
  buildDocumentWorkTruthConflictDisplayLines,
} from './documentWorkResultResolveService';
export { buildDocumentWorkTruthViewForInboxItem } from './documentWorkResultTruthOrchestration';
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
 * After a successful detail analysis: project, merge overlay, upsert in memory.
 * Does **not** call `persistAll()` — analysis must not rewrite the full app snapshot.
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

/**
 * @deprecated Prefer `upsertDocumentWorkResultFromWorkflow`.
 * `options.persist === true` is the only way to force an immediate full-app flush from here.
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
 * Explicit full-app flush including Document Work Results. Not used by analysis.
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
