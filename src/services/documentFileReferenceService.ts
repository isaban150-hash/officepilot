import { getDocumentStoreSnapshot } from './documentService';
import { getInboxStoreSnapshot } from './inboxService';
import { isEntitySyncActive } from './sync/syncMetaService';
import { getDocumentFileRepresentationBindingStoreSnapshot } from './documentFileRepresentationBindingStoreService';
import {
  getDocumentFileRefById,
  removeDocumentFileStoreEntry,
} from './documentFileStoreService';

/**
 * Distinct FileRef ids held by one document: original fileRefId plus any
 * representation-binding targets. Same id via original and binding counts once.
 */
export function collectFileRefIdsHeldByDocument(
  documentId: string,
  originalFileRefId: string | undefined,
): string[] {
  const held = new Set<string>();
  if (typeof originalFileRefId === 'string' && originalFileRefId.length > 0) {
    held.add(originalFileRefId);
  }
  for (const binding of getDocumentFileRepresentationBindingStoreSnapshot()) {
    if (binding.documentId === documentId) {
      held.add(binding.fileRefId);
    }
  }
  return [...held];
}

/**
 * Active references to a FileRef across inbox items and documents.
 * Per document, each distinct FileRef contributes at most once (original and
 * bindings to the same id do not double-count). Inbox counting is unchanged.
 */
export function countActiveReferencesToFileRef(fileRefId: string): number {
  let count = 0;
  for (const item of getInboxStoreSnapshot()) {
    if (item.fileRefId === fileRefId && isEntitySyncActive(item)) {
      count += 1;
    }
  }
  for (const doc of getDocumentStoreSnapshot()) {
    if (!isEntitySyncActive(doc)) {
      continue;
    }
    const held = collectFileRefIdsHeldByDocument(doc.id, doc.fileRefId);
    if (held.includes(fileRefId)) {
      count += 1;
    }
  }
  return count;
}

export async function releaseDocumentFileIfUnreferenced(
  fileRefId: string | undefined,
): Promise<boolean> {
  if (!fileRefId) return false;
  if (countActiveReferencesToFileRef(fileRefId) > 0) return false;
  const ref = getDocumentFileRefById(fileRefId);
  if (!ref) return false;
  return removeDocumentFileStoreEntry(ref.id, ref.localDataKey);
}
