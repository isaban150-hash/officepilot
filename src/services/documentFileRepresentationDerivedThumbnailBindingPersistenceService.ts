import type { DocumentFileRepresentationBindingRegistrationResult } from '../types/documentFileRepresentationBindingRegistration';
import { createDocumentFileRepresentationBinding } from './documentFileRepresentationBindingService';
import { registerDocumentFileRepresentationBinding } from './documentFileRepresentationBindingRegistrationService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  replaceDocumentFileRepresentationBindingStore,
} from './documentFileRepresentationBindingStoreService';
import { getDocumentById } from './documentService';
import { getDocumentFileRefById } from './documentFileStoreService';

export interface PersistDerivedThumbnailRepresentationBindingInput {
  documentId: string;
  /** Committed FileRef for the thumbnail role; may differ from document.fileRefId. */
  thumbnailFileRefId: string;
}

/**
 * Register thumbnail → committed FileRef for a CompanyDocument in the binding store.
 * Never replaces on conflict. Does not call persistAll — callers persist after `created`.
 */
export function persistDerivedThumbnailRepresentationBinding(
  input: PersistDerivedThumbnailRepresentationBindingInput,
): DocumentFileRepresentationBindingRegistrationResult {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid derived thumbnail binding persistence input');
  }

  if (typeof input.documentId !== 'string' || input.documentId.trim().length === 0) {
    throw new TypeError('Invalid derived thumbnail binding documentId');
  }

  if (
    typeof input.thumbnailFileRefId !== 'string' ||
    input.thumbnailFileRefId.length === 0 ||
    input.thumbnailFileRefId.trim().length === 0
  ) {
    throw new TypeError('Invalid derived thumbnail binding thumbnailFileRefId');
  }

  const document = getDocumentById(input.documentId);
  if (!document) {
    throw new TypeError('Document not found for derived thumbnail binding');
  }

  const thumbnailFileRef = getDocumentFileRefById(input.thumbnailFileRefId);
  if (!thumbnailFileRef) {
    throw new TypeError('Thumbnail FileRef not found for derived thumbnail binding');
  }

  if (thumbnailFileRef.lifecycleStatus !== 'committed') {
    throw new TypeError('Thumbnail FileRef must be committed for derived thumbnail binding');
  }

  const binding = createDocumentFileRepresentationBinding({
    documentId: input.documentId,
    kind: 'thumbnail',
    fileRefId: input.thumbnailFileRefId,
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
