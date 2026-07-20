import type {
  DocumentFileRepresentationBindingKind,
} from '../types/documentFileRepresentationBinding';
import type { DocumentFileDerivativeStepErrorCode } from '../types/documentFileDerivativeStepOutcome';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  replaceDocumentFileRepresentationBindingStore,
} from './documentFileRepresentationBindingStoreService';
import { persistAll } from './persistenceService';
import { releaseDocumentFileIfUnreferenced } from './documentFileReferenceService';

export interface ExactDocumentFileRepresentationBindingKey {
  readonly documentId: string;
  readonly kind: DocumentFileRepresentationBindingKind;
  readonly fileRefId: string;
}

/**
 * Remove a binding only when documentId + kind + fileRefId all match the current entry.
 * Does not touch other documents or sibling kinds. Does not persist.
 */
export function removeDocumentFileRepresentationBindingIfExactMatch(
  key: ExactDocumentFileRepresentationBindingKey,
): boolean {
  if (key === null || typeof key !== 'object') {
    throw new TypeError('Invalid exact representation binding key');
  }
  if (typeof key.documentId !== 'string' || key.documentId.trim().length === 0) {
    throw new TypeError('Invalid exact representation binding documentId');
  }
  if (typeof key.kind !== 'string' || key.kind.trim().length === 0) {
    throw new TypeError('Invalid exact representation binding kind');
  }
  if (typeof key.fileRefId !== 'string' || key.fileRefId.trim().length === 0) {
    throw new TypeError('Invalid exact representation binding fileRefId');
  }

  const current = getDocumentFileRepresentationBindingStoreSnapshot();
  const index = current.findIndex(
    (entry) =>
      entry.documentId === key.documentId &&
      entry.kind === key.kind &&
      entry.fileRefId === key.fileRefId,
  );
  if (index === -1) {
    return false;
  }

  replaceDocumentFileRepresentationBindingStore([
    ...current.slice(0, index),
    ...current.slice(index + 1),
  ]);
  return true;
}

/**
 * Undo a binding created in this orchestration run (exact match only) and optionally
 * release a FileRef that was newly created in the same run.
 * Failures are reported only as stable error codes — never raw Error objects.
 */
export async function rollbackOwnedDerivedRepresentationCreation(input: {
  createdBinding: ExactDocumentFileRepresentationBindingKey | null;
  createdFileRefId: string | null;
  reportError: (errorCode: DocumentFileDerivativeStepErrorCode) => void;
}): Promise<void> {
  if (input.createdBinding) {
    try {
      const removed = removeDocumentFileRepresentationBindingIfExactMatch(input.createdBinding);
      if (removed) {
        persistAll();
      }
    } catch {
      input.reportError('rollback_failed');
    }
  }

  if (input.createdFileRefId) {
    try {
      await releaseDocumentFileIfUnreferenced(input.createdFileRefId);
    } catch {
      input.reportError('cleanup_failed');
    }
  }
}
