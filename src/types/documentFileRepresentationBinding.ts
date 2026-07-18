import {
  DOCUMENT_FILE_REPRESENTATION_KINDS,
  type DocumentFileRepresentationKind,
} from './documentFileRepresentation';

/**
 * Additional representation roles that may be persisted as document-scoped bindings.
 * `original` remains document.fileRefId in the current transitional architecture.
 */
export const DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS =
  DOCUMENT_FILE_REPRESENTATION_KINDS.filter(
    (kind): kind is Exclude<DocumentFileRepresentationKind, 'original'> => kind !== 'original',
  );

export type DocumentFileRepresentationBindingKind =
  (typeof DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS)[number];

/**
 * Backend-neutral persisted binding shape: document role → existing FileRef.
 * Does not store denormalized file metadata; those stay on DocumentFileRef.
 */
export interface DocumentFileRepresentationBinding {
  readonly documentId: string;
  readonly kind: DocumentFileRepresentationBindingKind;
  readonly fileRefId: string;
}

/**
 * Natural uniqueness key for one active binding per document role.
 * Document-scoped — not FileRef-scoped — so duplicate-shared FileRefs stay correct.
 */
export interface DocumentFileRepresentationBindingNaturalKey {
  readonly documentId: string;
  readonly kind: DocumentFileRepresentationBindingKind;
}
