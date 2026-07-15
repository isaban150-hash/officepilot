export type DocumentFileStorageType = 'local_data_url' | 'indexeddb';

export const DOCUMENT_FILE_LIFECYCLE_STATUSES = ['temp', 'staged', 'committed', 'trashed'] as const;
export type DocumentFileLifecycleStatus = (typeof DOCUMENT_FILE_LIFECYCLE_STATUSES)[number];

/** Lokale Dateireferenz – Bytes liegen unter `localDataKey` (Legacy) oder in IndexedDB. */
export interface DocumentFileRef {
  id: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  contentHash: string;
  storageType: DocumentFileStorageType;
  localDataKey: string;
  createdAt: string;
  lifecycleStatus: DocumentFileLifecycleStatus;
  expiresAt?: string;
  committedAt?: string;
}

export interface DocumentFileBlob {
  dataUrl: string;
}

export function isLegacyDocumentFileRef(ref: DocumentFileRef): boolean {
  return ref.storageType === 'local_data_url';
}

export function isIndexedDbDocumentFileRef(ref: DocumentFileRef): boolean {
  return ref.storageType === 'indexeddb';
}
