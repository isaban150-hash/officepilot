import {
  DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS,
  type DocumentFileRepresentationBinding,
  type DocumentFileRepresentationBindingKind,
  type DocumentFileRepresentationBindingNaturalKey,
} from '../types/documentFileRepresentationBinding';

export interface CreateDocumentFileRepresentationBindingInput {
  documentId: string;
  kind: DocumentFileRepresentationBindingKind;
  fileRefId: string;
}

function assertNonEmptyId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid representation binding ${label}`);
  }
  // Reject empty / whitespace-only; do not trim — caller string is returned unchanged.
  if (value.length === 0 || value.trim().length === 0) {
    throw new TypeError(`Invalid representation binding ${label}`);
  }
}

function assertBindingKind(value: unknown): asserts value is DocumentFileRepresentationBindingKind {
  if (
    typeof value !== 'string' ||
    !(DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS as readonly string[]).includes(value)
  ) {
    throw new TypeError('Invalid representation binding kind');
  }
}

/**
 * Pure factory for a document-scoped representation binding entity shape.
 * Does not persist, allocate UUIDs, or inspect FileRefs/blobs.
 */
export function createDocumentFileRepresentationBinding(
  input: CreateDocumentFileRepresentationBindingInput,
): DocumentFileRepresentationBinding {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid representation binding input');
  }

  assertNonEmptyId(input.documentId, 'documentId');
  assertBindingKind(input.kind);
  assertNonEmptyId(input.fileRefId, 'fileRefId');

  return Object.freeze({
    documentId: input.documentId,
    kind: input.kind,
    fileRefId: input.fileRefId,
  });
}

/**
 * Structural natural key for uniqueness: documentId + kind.
 * Does not include fileRefId and does not use `${fileRefId}:kind`.
 */
export function toDocumentFileRepresentationBindingNaturalKey(
  binding: DocumentFileRepresentationBinding,
): DocumentFileRepresentationBindingNaturalKey {
  if (binding === null || typeof binding !== 'object') {
    throw new TypeError('Invalid representation binding');
  }

  assertNonEmptyId(binding.documentId, 'documentId');
  assertBindingKind(binding.kind);

  return Object.freeze({
    documentId: binding.documentId,
    kind: binding.kind,
  });
}
