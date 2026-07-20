import type { DocumentFileDerivativeStepOutcome } from '../types/documentFileDerivativeStepOutcome';

let outcomes: DocumentFileDerivativeStepOutcome[] = [];

function cloneOutcome(entry: DocumentFileDerivativeStepOutcome): DocumentFileDerivativeStepOutcome {
  const cloned: DocumentFileDerivativeStepOutcome = {
    documentId: entry.documentId,
    stepId: entry.stepId,
    representationKind: entry.representationKind,
    outcome: entry.outcome,
    sourceFileRefId: entry.sourceFileRefId,
    sourceMimeType: entry.sourceMimeType,
    createdFileRef: entry.createdFileRef,
    attempt: entry.attempt,
    updatedAt: entry.updatedAt,
  };
  if (entry.noopReason !== undefined) {
    (cloned as { noopReason?: typeof entry.noopReason }).noopReason = entry.noopReason;
  }
  if (entry.errorCode !== undefined) {
    (cloned as { errorCode?: typeof entry.errorCode }).errorCode = entry.errorCode;
  }
  if (entry.registrationStatus !== undefined) {
    (cloned as { registrationStatus?: typeof entry.registrationStatus }).registrationStatus =
      entry.registrationStatus;
  }
  if (entry.resultFileRefId !== undefined) {
    (cloned as { resultFileRefId?: string }).resultFileRefId = entry.resultFileRefId;
  }
  return Object.freeze(cloned);
}

/**
 * Replace in-memory derivative step outcomes. Does not persist.
 */
export function hydrateDocumentFileDerivativeStepOutcomeStore(
  entries: readonly DocumentFileDerivativeStepOutcome[] = [],
): void {
  if (!Array.isArray(entries)) {
    throw new TypeError('Invalid derivative step outcome store hydrate input');
  }
  outcomes = entries.map(cloneOutcome);
}

export function resetDocumentFileDerivativeStepOutcomeStoreForTests(): void {
  outcomes = [];
}

export function getDocumentFileDerivativeStepOutcomeStoreSnapshot(): DocumentFileDerivativeStepOutcome[] {
  return outcomes.map(cloneOutcome);
}

export function replaceDocumentFileDerivativeStepOutcomeStore(
  entries: readonly DocumentFileDerivativeStepOutcome[],
): void {
  if (!Array.isArray(entries)) {
    throw new TypeError('Invalid derivative step outcome store replace input');
  }
  outcomes = entries.map(cloneOutcome);
}

export function removeDocumentFileDerivativeStepOutcomesForDocument(documentId: string): number {
  if (typeof documentId !== 'string' || documentId.length === 0 || documentId.trim().length === 0) {
    throw new TypeError('Invalid derivative step outcome documentId');
  }
  const before = outcomes.length;
  outcomes = outcomes.filter((entry) => entry.documentId !== documentId);
  return before - outcomes.length;
}

export function findDocumentFileDerivativeStepOutcome(
  documentId: string,
  stepId: DocumentFileDerivativeStepOutcome['stepId'],
): DocumentFileDerivativeStepOutcome | null {
  const found = outcomes.find(
    (entry) => entry.documentId === documentId && entry.stepId === stepId,
  );
  return found ? cloneOutcome(found) : null;
}
