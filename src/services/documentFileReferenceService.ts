import { getDocumentStoreSnapshot } from './documentService';
import { getInboxStoreSnapshot } from './inboxService';
import { isEntitySyncActive } from './sync/syncMetaService';
import {
  getDocumentFileRefById,
  removeDocumentFileStoreEntry,
} from './documentFileStoreService';

export function countActiveReferencesToFileRef(fileRefId: string): number {
  let count = 0;
  for (const item of getInboxStoreSnapshot()) {
    if (item.fileRefId === fileRefId && isEntitySyncActive(item)) {
      count += 1;
    }
  }
  for (const doc of getDocumentStoreSnapshot()) {
    if (doc.fileRefId === fileRefId && isEntitySyncActive(doc)) {
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
