import type { DocumentFileRepresentationBindingRegistrationResult } from '../types/documentFileRepresentationBindingRegistration';
import { createDocumentFileRepresentationBinding } from './documentFileRepresentationBindingService';
import { registerDocumentFileRepresentationBinding } from './documentFileRepresentationBindingRegistrationService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  replaceDocumentFileRepresentationBindingStore,
} from './documentFileRepresentationBindingStoreService';
import { getDocumentById } from './documentService';
import { getDocumentFileRefById } from './documentFileStoreService';

export interface PersistDerivedPreviewRepresentationBindingInput {
  documentId: string;
  /** Committed FileRef for the preview role; may differ from document.fileRefId. */
  previewFileRefId: string;
}

/**
 * Register preview → committed FileRef for a CompanyDocument in the binding store.
 * Never replaces on conflict. Does not call persistAll — callers persist after `created`.
 */
export function persistDerivedPreviewRepresentationBinding(
  input: PersistDerivedPreviewRepresentationBindingInput,
): DocumentFileRepresentationBindingRegistrationResult {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid derived preview binding persistence input');
  }

  if (typeof input.documentId !== 'string' || input.documentId.trim().length === 0) {
    throw new TypeError('Invalid derived preview binding documentId');
  }

  if (
    typeof input.previewFileRefId !== 'string' ||
    input.previewFileRefId.length === 0 ||
    input.previewFileRefId.trim().length === 0
  ) {
    throw new TypeError('Invalid derived preview binding previewFileRefId');
  }

  const document = getDocumentById(input.documentId);
  if (!document) {
    throw new TypeError('Document not found for derived preview binding');
  }

  const previewFileRef = getDocumentFileRefById(input.previewFileRefId);
  if (!previewFileRef) {
    throw new TypeError('Preview FileRef not found for derived preview binding');
  }

  if (previewFileRef.lifecycleStatus !== 'committed') {
    throw new TypeError('Preview FileRef must be committed for derived preview binding');
  }

  const binding = createDocumentFileRepresentationBinding({
    documentId: input.documentId,
    kind: 'preview',
    fileRefId: input.previewFileRefId,
  });

  const result = registerDocumentFileRepresentationBinding({
    bindings: getDocumentFileRepresentationBindingStoreSnapshot(),
    binding,
  });

  if (result.kind === 'conflict') {
    return result;
  }

  replaceDocumentFileRepresentationBindingStore(result.bindings);
  return result;
}
