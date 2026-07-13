export type DocumentFileStorageType = 'local_data_url' | 'indexeddb';

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
