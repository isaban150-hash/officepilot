import type { PostImportDerivativeStepId } from '../types/documentFileDerivativeStepOutcome';

function lockKey(documentId: string, stepId: PostImportDerivativeStepId): string {
  return `${documentId}\0${stepId}`;
}

const inFlightKeys = new Set<string>();

/**
 * Try to acquire the shared in-memory lock for one documentId + stepId.
 * Used by the post-import coordinator and manual retry.
 */
export function tryAcquireDocumentFileDerivativeStepInFlightLock(
  documentId: string,
  stepId: PostImportDerivativeStepId,
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
  stepId: PostImportDerivativeStepId,
): void {
  inFlightKeys.delete(lockKey(documentId, stepId));
}

export function resetDocumentFileDerivativeStepInFlightLocksForTests(): void {
  inFlightKeys.clear();
}

export function isDocumentFileDerivativeStepInFlightForTests(
  documentId: string,
  stepId: PostImportDerivativeStepId,
): boolean {
  return inFlightKeys.has(lockKey(documentId, stepId));
}
