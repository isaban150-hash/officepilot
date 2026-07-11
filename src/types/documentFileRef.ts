export type DocumentFileStorageType = 'local_data_url';

/** Lokale Dateireferenz – Bytes liegen unter `localDataKey` im File-Store. */
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
