import type { SyncMeta } from './sync';

/**
 * FINANZ-CORE-DURABILITY-01B — `cloud`: die Zeile ist aus der Cloud bekannt,
 * die Bytes liegen (noch) nicht auf diesem Geraet. Nach dem verifizierten
 * Download wird daraus `indexeddb`.
 */
export type DocumentFileStorageType = 'local_data_url' | 'indexeddb' | 'cloud';

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
  /** 01B — Herkunft eines Derivats (technische Eigenschaft der Datei, keine Rolle). */
  derivedFromFileRefId?: string;
  /** 01B — Cloud-Registrierung: Pfad {workspace_id}/{sha256}; gesetzt nach Upload oder Pull. */
  cloud?: { storagePath: string; uploadedAt?: string };
  sync?: SyncMeta;
}

export interface DocumentFileBlob {
  dataUrl: string;
}

export function isLegacyDocumentFileRef(ref: DocumentFileRef): boolean {
  return ref.storageType === 'local_data_url';
}

export function isCloudOnlyDocumentFileRef(ref: DocumentFileRef): boolean {
  return ref.storageType === 'cloud';
}

export function isIndexedDbDocumentFileRef(ref: DocumentFileRef): boolean {
  return ref.storageType === 'indexeddb';
}
