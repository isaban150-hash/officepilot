import {
  DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS,
  type DocumentFileRepresentationBindingKind,
} from '../types/documentFileRepresentationBinding';
import {
  POST_IMPORT_DERIVATIVE_STEP_IDS,
  type DocumentFileDerivativeStepOutcome,
  type PostImportDerivativeStepId,
} from '../types/documentFileDerivativeStepOutcome';
import type {
  DocumentFileDerivativeRecoveryDetailProblem,
  DocumentFileDerivativeRecoveryDetailStatus,
  DocumentFileDerivativeRecoveryDetailStatusViewModel,
} from '../types/documentFileDerivativeRecoveryDetailStatus';
import { DOCUMENT_FILE_DERIVATIVE_STEP_MAX_ATTEMPTS } from './documentFileDerivativeStepManualRetryService';
import { getDocumentFileDerivativeStepOutcomeStoreSnapshot } from './documentFileDerivativeStepOutcomeStoreService';
import { getDocumentFileTransformPlanForDerivativeRetry } from './documentFileDerivativeRecoveryContextService';
import { resolveDocumentFileRepresentation } from './documentFileRepresentationReadService';

const KIND_ORDER: readonly DocumentFileRepresentationBindingKind[] =
  DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS;

function displayTitleForKind(kind: DocumentFileRepresentationBindingKind): string {
  switch (kind) {
    case 'preview':
      return 'Vorschau fehlt';
    case 'thumbnail':
      return 'Vorschaubild fehlt';
    case 'archive':
      return 'Archivkopie fehlt';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function displayDetailForStatus(status: DocumentFileDerivativeRecoveryDetailStatus): string {
  switch (status) {
    case 'error':
      return 'Die Erstellung ist fehlgeschlagen.';
    case 'missing_after_persist':
      return 'Die Datei wurde als erstellt gemeldet, ist aber nicht verfügbar.';
    case 'conflict':
      return 'Es gibt einen Konflikt bei der Zuordnung. Bitte manuell prüfen.';
    case 'exhausted':
      return 'Erneute Versuche sind ausgeschöpft.';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function stepOrderIndex(stepId: PostImportDerivativeStepId): number {
  return POST_IMPORT_DERIVATIVE_STEP_IDS.indexOf(stepId);
}

function isExhaustedOutcome(outcome: DocumentFileDerivativeStepOutcome): boolean {
  return (
    outcome.attempt >= DOCUMENT_FILE_DERIVATIVE_STEP_MAX_ATTEMPTS &&
    (outcome.outcome === 'error' || outcome.outcome === 'persisted')
  );
}

/**
 * Diagnosis priority: exhausted > conflict > error > persisted+missing.
 * Lower number = higher priority.
 */
function diagnosisPriority(outcome: DocumentFileDerivativeStepOutcome): number | null {
  if (outcome.outcome === 'noop') {
    return null;
  }
  if (isExhaustedOutcome(outcome)) {
    return 0;
  }
  if (outcome.outcome === 'conflict') {
    return 1;
  }
  if (outcome.outcome === 'error') {
    return 2;
  }
  if (outcome.outcome === 'persisted') {
    return 3;
  }
  return null;
}

function pickDiagnosticOutcome(
  candidates: readonly DocumentFileDerivativeStepOutcome[],
): DocumentFileDerivativeStepOutcome | null {
  let best: DocumentFileDerivativeStepOutcome | null = null;
  let bestPriority = Number.POSITIVE_INFINITY;
  let bestOrder = Number.POSITIVE_INFINITY;

  for (const entry of candidates) {
    const priority = diagnosisPriority(entry);
    if (priority === null) {
      continue;
    }
    const order = stepOrderIndex(entry.stepId);
    if (
      priority < bestPriority ||
      (priority === bestPriority && order < bestOrder)
    ) {
      best = entry;
      bestPriority = priority;
      bestOrder = order;
    }
  }

  return best;
}

function mapOutcomeToStatus(
  outcome: DocumentFileDerivativeStepOutcome,
): DocumentFileDerivativeRecoveryDetailStatus {
  if (isExhaustedOutcome(outcome)) {
    return 'exhausted';
  }
  if (outcome.outcome === 'conflict') {
    return 'conflict';
  }
  if (outcome.outcome === 'error') {
    return 'error';
  }
  return 'missing_after_persist';
}

function selectRetryStepId(
  candidates: readonly DocumentFileDerivativeStepOutcome[],
): PostImportDerivativeStepId | undefined {
  const ordered = [...candidates].sort(
    (left, right) => stepOrderIndex(left.stepId) - stepOrderIndex(right.stepId),
  );
  for (const entry of ordered) {
    if (
      (entry.outcome === 'error' || entry.outcome === 'persisted') &&
      entry.attempt < DOCUMENT_FILE_DERIVATIVE_STEP_MAX_ATTEMPTS
    ) {
      return entry.stepId;
    }
  }
  return undefined;
}

function buildProblemForKind(input: {
  kind: DocumentFileRepresentationBindingKind;
  outcomes: readonly DocumentFileDerivativeStepOutcome[];
  hasRecoveryPlan: boolean;
}): DocumentFileDerivativeRecoveryDetailProblem | null {
  const kindOutcomes = input.outcomes.filter(
    (entry) => entry.representationKind === input.kind && entry.outcome !== 'noop',
  );
  if (kindOutcomes.length === 0) {
    return null;
  }

  const diagnostic = pickDiagnosticOutcome(kindOutcomes);
  if (!diagnostic) {
    return null;
  }

  const status = mapOutcomeToStatus(diagnostic);
  const selectedStepId = selectRetryStepId(kindOutcomes);
  const canRetry =
    (status === 'error' || status === 'missing_after_persist') &&
    input.hasRecoveryPlan &&
    diagnostic.attempt < DOCUMENT_FILE_DERIVATIVE_STEP_MAX_ATTEMPTS &&
    selectedStepId !== undefined;

  return Object.freeze({
    representationKind: input.kind,
    status,
    ...(selectedStepId !== undefined ? { selectedStepId } : {}),
    canRetry,
    attempt: diagnostic.attempt,
    displayTitle: displayTitleForKind(input.kind),
    displayDetail: displayDetailForStatus(status),
    ...(canRetry ? { retryHint: 'Erneutes Erstellen ist möglich.' } : {})
  });
}

/**
 * Build the document-detail recovery status view-model.
 * Does not execute transforms, retries, or replanning.
 */
export async function buildDocumentFileDerivativeRecoveryDetailStatus(
  documentId: string,
): Promise<DocumentFileDerivativeRecoveryDetailStatusViewModel> {
  if (typeof documentId !== 'string' || documentId.trim().length === 0) {
    throw new TypeError('Invalid derivative recovery detail status documentId');
  }

  const hasRecoveryPlan = getDocumentFileTransformPlanForDerivativeRetry(documentId) !== null;
  const outcomes = getDocumentFileDerivativeStepOutcomeStoreSnapshot().filter(
    (entry) => entry.documentId === documentId,
  );

  const problems: DocumentFileDerivativeRecoveryDetailProblem[] = [];

  for (const kind of KIND_ORDER) {
    const representation = await resolveDocumentFileRepresentation({
      documentId,
      kind,
    });
    if (representation.kind === 'ready') {
      continue;
    }

    const problem = buildProblemForKind({
      kind,
      outcomes,
      hasRecoveryPlan,
    });
    if (problem) {
      problems.push(problem);
    }
  }

  return Object.freeze({
    documentId,
    hasRecoveryPlan,
    problems: Object.freeze(problems),
  });
}
