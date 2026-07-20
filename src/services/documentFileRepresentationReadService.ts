import {
  DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS,
  type DocumentFileRepresentationBinding,
  type DocumentFileRepresentationBindingKind,
} from '../types/documentFileRepresentationBinding';
import type { DocumentFileRepresentationReadResult } from '../types/documentFileRepresentationRead';
import { getDocumentFileRepresentationBindingStoreSnapshot } from './documentFileRepresentationBindingStoreService';
import { createDocumentFileRepresentationBinding } from './documentFileRepresentationBindingService';
import { getDocumentFileBlob, getDocumentFileRefById } from './documentFileStoreService';

export interface ResolveDocumentFileRepresentationInput {
  documentId: string;
  kind: DocumentFileRepresentationBindingKind;
}

function assertNonEmptyId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid representation read ${label}`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new TypeError(`Invalid representation read ${label}`);
  }
}

function assertBindingKind(value: unknown): asserts value is DocumentFileRepresentationBindingKind {
  if (
    typeof value !== 'string' ||
    !(DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS as readonly string[]).includes(value)
  ) {
    throw new TypeError('Invalid representation read kind');
  }
}

function findBinding(
  documentId: string,
  kind: DocumentFileRepresentationBindingKind,
): DocumentFileRepresentationBinding | undefined {
  return getDocumentFileRepresentationBindingStoreSnapshot().find(
    (entry) => entry.documentId === documentId && entry.kind === kind,
  );
}

/**
 * Resolve a persisted archive/preview/thumbnail binding to its committed FileRef blob.
 * Read-only: does not mutate stores, transform bytes, create Object URLs, or fall back to original.
 */
export async function resolveDocumentFileRepresentation(
  input: ResolveDocumentFileRepresentationInput,
): Promise<DocumentFileRepresentationReadResult> {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid representation read input');
  }

  assertNonEmptyId(input.documentId, 'documentId');
  assertBindingKind(input.kind);

  const binding = findBinding(input.documentId, input.kind);
  if (!binding) {
    return Object.freeze({ kind: 'missing_binding' });
  }

  // Re-freeze via factory so callers cannot mutate store-owned shapes.
  const frozenBinding = createDocumentFileRepresentationBinding({
    documentId: binding.documentId,
    kind: binding.kind,
    fileRefId: binding.fileRefId,
  });

  const fileRef = getDocumentFileRefById(frozenBinding.fileRefId);
  if (!fileRef) {
    return Object.freeze({ kind: 'missing_file_ref' });
  }

  if (fileRef.lifecycleStatus !== 'committed') {
    return Object.freeze({ kind: 'not_committed' });
  }

  const blob = await getDocumentFileBlob(fileRef);
  if (!blob) {
    return Object.freeze({ kind: 'missing_blob' });
  }

  return Object.freeze({
    kind: 'ready',
    binding: frozenBinding,
    fileRef,
    blob,
  });
}
