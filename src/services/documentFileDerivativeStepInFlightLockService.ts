import type { DocumentFileDerivativeStepId } from '../types/documentFileDerivativeStepOutcome';

function lockKey(documentId: string, stepId: DocumentFileDerivativeStepId): string {
  return `${documentId}\0${stepId}`;
}

const inFlightKeys = new Set<string>();

/**
 * Try to acquire the shared in-memory lock for one documentId + stepId.
 * Used by the post-import coordinator and manual retry.
 */
export function tryAcquireDocumentFileDerivativeStepInFlightLock(
  documentId: string,
  stepId: DocumentFileDerivativeStepId,
): boolean {
  const key = lockKey(documentId, stepId);
  if (inFlightKeys.has(key)) {
    return false;
  }
  inFlightKeys.add(key);
  return true;
}

export function releaseDocumentFileDerivativeStepInFlightLock(
  documentId: string,
  stepId: DocumentFileDerivativeStepId,
): void {
  inFlightKeys.delete(lockKey(documentId, stepId));
}

export function resetDocumentFileDerivativeStepInFlightLocksForTests(): void {
  inFlightKeys.clear();
}

export function isDocumentFileDerivativeStepInFlightForTests(
  documentId: string,
  stepId: DocumentFileDerivativeStepId,
): boolean {
  return inFlightKeys.has(lockKey(documentId, stepId));
}
