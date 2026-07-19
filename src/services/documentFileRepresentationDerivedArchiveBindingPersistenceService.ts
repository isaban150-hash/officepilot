import type { DocumentFileRepresentationBindingRegistrationResult } from '../types/documentFileRepresentationBindingRegistration';
import { createDocumentFileRepresentationBinding } from './documentFileRepresentationBindingService';
import { registerDocumentFileRepresentationBinding } from './documentFileRepresentationBindingRegistrationService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  replaceDocumentFileRepresentationBindingStore,
} from './documentFileRepresentationBindingStoreService';
import { getDocumentById } from './documentService';
import { getDocumentFileRefById } from './documentFileStoreService';
import { persistAll } from './persistenceService';

export interface PersistDerivedArchiveRepresentationBindingInput {
  documentId: string;
  /** Committed FileRef for the archive role; may differ from document.fileRefId. */
  archiveFileRefId: string;
}

/**
 * Persist archive → committed FileRef for a CompanyDocument.
 * Unlike source-reuse persistence, the archive FileRef may differ from the original.
 * Never replaces on conflict. Calls persistAll only when a binding is newly created.
 */
export function persistDerivedArchiveRepresentationBinding(
  input: PersistDerivedArchiveRepresentationBindingInput,
): DocumentFileRepresentationBindingRegistrationResult {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid derived archive binding persistence input');
  }

  if (typeof input.documentId !== 'string' || input.documentId.trim().length === 0) {
    throw new TypeError('Invalid derived archive binding documentId');
  }

  if (
    typeof input.archiveFileRefId !== 'string' ||
    input.archiveFileRefId.length === 0 ||
    input.archiveFileRefId.trim().length === 0
  ) {
    throw new TypeError('Invalid derived archive binding archiveFileRefId');
  }

  const document = getDocumentById(input.documentId);
  if (!document) {
    throw new TypeError('Document not found for derived archive binding');
  }

  const archiveFileRef = getDocumentFileRefById(input.archiveFileRefId);
  if (!archiveFileRef) {
    throw new TypeError('Archive FileRef not found for derived archive binding');
  }

  if (archiveFileRef.lifecycleStatus !== 'committed') {
    throw new TypeError('Archive FileRef must be committed for derived archive binding');
  }

  const binding = createDocumentFileRepresentationBinding({
    documentId: input.documentId,
    kind: 'archive',
    fileRefId: input.archiveFileRefId,
  });

  const result = registerDocumentFileRepresentationBinding({
    bindings: getDocumentFileRepresentationBindingStoreSnapshot(),
    binding,
  });

  if (result.kind === 'conflict') {
    return result;
  }

  replaceDocumentFileRepresentationBindingStore(result.bindings);
  if (result.kind === 'created') {
    persistAll();
  }

  return result;
}
