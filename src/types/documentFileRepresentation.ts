import type { DocumentFileStorageType } from './documentFileRef';

export const DOCUMENT_FILE_REPRESENTATION_KINDS = [
  'original',
  'archive',
  'preview',
  'thumbnail',
] as const;

export type DocumentFileRepresentationKind =
  (typeof DOCUMENT_FILE_REPRESENTATION_KINDS)[number];

/**
 * Maps StoragePolicyRequirements role fields to representation kinds.
 * Declarative compatibility only — does not plan or create representations.
 */
export const STORAGE_REQUIREMENT_TO_REPRESENTATION_KIND = {
  retainOriginal: 'original',
  archiveRepresentation: 'archive',
  previewRequirement: 'preview',
  thumbnailRequirement: 'thumbnail',
} as const satisfies Record<string, DocumentFileRepresentationKind>;

/**
 * Concrete physical file representation metadata.
 * Not persisted in this foundation sprint; original is projected from DocumentFileRef.
 */
export interface DocumentFileRepresentation {
  id: string;
  fileRefId: string;
  kind: DocumentFileRepresentationKind;
  mimeType: string;
  fileSize: number;
  contentHash: string;
  storageType: DocumentFileStorageType;
  /** Same blob/location key convention as DocumentFileRef.localDataKey. */
  localDataKey: string;
  createdAt: string;
}
