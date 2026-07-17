import type { DocumentFileRef } from '../types/documentFileRef';
import type { DocumentFileRepresentation } from '../types/documentFileRepresentation';

/** Stable projection id for the implicit original representation — not a persisted entity. */
export function buildImplicitOriginalRepresentationId(fileRefId: string): string {
  return `${fileRefId}:original`;
}

/**
 * Pure projection of an existing DocumentFileRef as kind `original`.
 * Does not persist, read blobs, recompute hashes, or mutate the input.
 */
export function toOriginalDocumentFileRepresentation(
  fileRef: DocumentFileRef,
): DocumentFileRepresentation {
  return {
    id: buildImplicitOriginalRepresentationId(fileRef.id),
    fileRefId: fileRef.id,
    kind: 'original',
    mimeType: fileRef.mimeType,
    fileSize: fileRef.fileSize,
    contentHash: fileRef.contentHash,
    storageType: fileRef.storageType,
    localDataKey: fileRef.localDataKey,
    createdAt: fileRef.createdAt,
  };
}
