import { getInboxStoreSnapshot } from './inboxService';
import { getDocumentStoreSnapshot } from './documentService';
import { getDocumentFileRefByHash } from './documentFileStoreService';

export type DuplicateMatchType = 'inbox' | 'document';

export interface DuplicateMatch {
  type: DuplicateMatchType;
  id: string;
  title: string;
  fileRefId?: string;
}

export function findDuplicateByContentHash(contentHash: string): DuplicateMatch | null {
  if (!contentHash) return null;

  const fileRef = getDocumentFileRefByHash(contentHash);
  const fileRefId = fileRef?.id;

  for (const doc of getDocumentStoreSnapshot()) {
    if (doc.sourceFileHash === contentHash || (fileRefId && doc.fileRefId === fileRefId)) {
      return {
        type: 'document',
        id: doc.id,
        title: doc.title,
        fileRefId: doc.fileRefId,
      };
    }
  }

  for (const item of getInboxStoreSnapshot()) {
    if (item.status === 'abgelegt') continue;
    if (item.sourceFileHash === contentHash || (fileRefId && item.fileRefId === fileRefId)) {
      return {
        type: 'inbox',
        id: item.id,
        title: item.title,
        fileRefId: item.fileRefId,
      };
    }
  }

  return null;
}
