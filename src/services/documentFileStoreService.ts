import type { DocumentFileRef } from '../types/documentFileRef';
import { buildCommittedLifecycleFields } from './documentFileStorageLifecycleService';
import { generateEntityId } from './sync/syncMetaService';
import type { CachedDocumentFilePayload } from './cachedDocumentFileService';
import { computeBufferContentHash, computeDataUrlContentHash } from './documentFileHashService';
import {
  copyDocumentBlobToScope,
  deleteDocumentBlob,
  DocumentBlobStorageError,
  hasDocumentBlob,
  migrateDocumentBlobsToScope,
  readDocumentBlob,
  saveDocumentBlob,
} from './storage/documentBlobIndexedDbService';
import { getActiveStorageScope, type StorageScope } from './storage/storageScopeService';

let fileRefs: DocumentFileRef[] = [];
let fileBlobs: Record<string, string> = {};

function cloneRef(ref: DocumentFileRef): DocumentFileRef {
  return { ...ref };
}

export function hydrateDocumentFileStore(
  refs: DocumentFileRef[] = [],
  blobs: Record<string, string> = {},
): void {
  fileRefs = refs.map(cloneRef);
  fileBlobs = { ...blobs };
}

export function resetDocumentFileStoreForTests(): void {
  fileRefs = [];
  fileBlobs = {};
}

export function getDocumentFileRefStoreSnapshot(): DocumentFileRef[] {
  return fileRefs.map(cloneRef);
}

/** Legacy Data-URL blobs still persisted in localStorage for migrated files. */
export function getDocumentFileBlobStoreSnapshot(): Record<string, string> {
  return { ...fileBlobs };
}

export function getDocumentFileRefById(id: string): DocumentFileRef | undefined {
  const ref = fileRefs.find((entry) => entry.id === id);
  return ref ? cloneRef(ref) : undefined;
}

export function getDocumentFileRefByHash(contentHash: string): DocumentFileRef | undefined {
  if (!contentHash) return undefined;
  const ref = fileRefs.find((entry) => entry.contentHash === contentHash);
  return ref ? cloneRef(ref) : undefined;
}

export function getDocumentFileDataUrl(ref: DocumentFileRef | string): string | undefined {
  const resolved = typeof ref === 'string' ? getDocumentFileRefById(ref) : ref;
  if (!resolved || resolved.storageType !== 'local_data_url') return undefined;
  return fileBlobs[resolved.localDataKey];
}

function buildBlobFallbackScopes(activeScope: StorageScope, userId?: string): StorageScope[] {
  const scopes: StorageScope[] = [];
  if (activeScope.type !== 'guest') {
    scopes.push({ type: 'guest' });
  }
  if (userId && activeScope.type === 'workspace') {
    scopes.push({ type: 'user', userId });
  }
  return scopes;
}

async function readDocumentBlobWithFallback(
  fileRefId: string,
  fallbackScopes: StorageScope[] = [],
): Promise<Awaited<ReturnType<typeof readDocumentBlob>>> {
  const activeScope = getActiveStorageScope();
  const activeRecord = await readDocumentBlob(fileRefId, activeScope);
  if (activeRecord) {
    return activeRecord;
  }

  for (const sourceScope of fallbackScopes) {
    const copied = await copyDocumentBlobToScope(fileRefId, sourceScope, activeScope);
    if (copied) {
      return readDocumentBlob(fileRefId, activeScope);
    }
  }

  return null;
}

export async function ensureDocumentBlobsForActiveScope(
  fileRefIds: string[],
  sourceScopes: StorageScope[] = [{ type: 'guest' }],
): Promise<{ migrated: number; missing: string[] }> {
  return migrateDocumentBlobsToScope(fileRefIds, sourceScopes, getActiveStorageScope());
}

export async function getOriginalDocumentFileBytes(
  ref: DocumentFileRef | string,
  fallbackScopes: StorageScope[] = [],
): Promise<Uint8Array | null> {
  const blob = await getDocumentFileBlob(ref, fallbackScopes);
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

export async function verifyDocumentFileIntegrity(
  ref: DocumentFileRef,
  fallbackScopes: StorageScope[] = [],
): Promise<boolean> {
  if (!ref.contentHash) return false;
  const bytes = await getOriginalDocumentFileBytes(ref, fallbackScopes);
  if (!bytes) return false;
  const hash = await computeBufferContentHash(bytes);
  return hash === ref.contentHash;
}

export function downloadDocumentFile(ref: DocumentFileRef): void {
  if (typeof document === 'undefined') return;
  void getDocumentFileBlob(ref).then((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = ref.originalFileName;
    anchor.rel = 'noopener';
    anchor.click();
    URL.revokeObjectURL(url);
  });
}

export async function getDocumentFileBlob(
  ref: DocumentFileRef | string,
  fallbackScopes: StorageScope[] = [],
): Promise<Blob | null> {
  const resolved = typeof ref === 'string' ? getDocumentFileRefById(ref) : ref;
  if (!resolved) return null;

  if (resolved.storageType === 'local_data_url') {
    const dataUrl = fileBlobs[resolved.localDataKey];
    if (!dataUrl) return null;
    const response = await fetch(dataUrl);
    return response.blob();
  }

  const record = await readDocumentBlobWithFallback(resolved.id, fallbackScopes);
  return record?.blob ?? null;
}

export async function hasStoredOriginalDocumentFile(
  ref: DocumentFileRef,
  fallbackScopes: StorageScope[] = [],
): Promise<boolean> {
  if (ref.storageType === 'local_data_url') {
    return Boolean(fileBlobs[ref.localDataKey]);
  }
  if (await hasDocumentBlob(ref.id)) {
    return true;
  }
  for (const sourceScope of fallbackScopes) {
    if (await hasDocumentBlob(ref.id, sourceScope)) {
      return true;
    }
  }
  return false;
}

export async function storeDocumentFileFromCachedPayload(
  payload: CachedDocumentFilePayload,
): Promise<{ fileRef: DocumentFileRef; created: boolean }> {
  let contentHash: string;
  try {
    contentHash = await computeBufferContentHash(payload.bytes);
  } catch {
    throw new Error('hash_failed');
  }

  const existing = getDocumentFileRefByHash(contentHash);
  if (existing) {
    await ensureDocumentBlobsForActiveScope([existing.id], [{ type: 'guest' }]);
    const stored = await hasStoredOriginalDocumentFile(existing, [{ type: 'guest' }]);
    if (!stored) {
      throw new DocumentBlobStorageError('blob_read_failed');
    }
    return { fileRef: existing, created: false };
  }

  const fileRefId = generateEntityId('file-ref');
  const createdAt = new Date().toISOString();
  const mimeType = payload.mimeType || 'application/octet-stream';

  let blob: Blob;
  try {
    blob = new Blob([payload.bytes], { type: mimeType });
  } catch {
    throw new DocumentBlobStorageError('blob_write_failed');
  }

  try {
    await saveDocumentBlob({
      fileRefId,
      blob,
      mimeType,
      fileSize: payload.fileSize,
      contentHash,
      createdAt,
    });
  } catch (error) {
    if (error instanceof DocumentBlobStorageError) {
      throw error;
    }
    throw new DocumentBlobStorageError('blob_write_failed', error);
  }

  const fileRef: DocumentFileRef = {
    id: fileRefId,
    originalFileName: payload.fileName,
    mimeType,
    fileSize: payload.fileSize,
    contentHash,
    storageType: 'indexeddb',
    localDataKey: fileRefId,
    createdAt,
    ...buildCommittedLifecycleFields(createdAt),
  };
  fileRefs = [...fileRefs, fileRef];
  return { fileRef, created: true };
}

export { buildBlobFallbackScopes };

export async function removeDocumentFileStoreEntry(
  fileRefId: string,
  localDataKey: string,
): Promise<boolean> {
  const ref = fileRefs.find((entry) => entry.id === fileRefId);
  const refIndex = fileRefs.findIndex((entry) => entry.id === fileRefId);
  if (refIndex === -1) return false;

  fileRefs = fileRefs.filter((entry) => entry.id !== fileRefId);

  if (ref?.storageType === 'local_data_url') {
    if (Object.prototype.hasOwnProperty.call(fileBlobs, localDataKey)) {
      const nextBlobs = { ...fileBlobs };
      delete nextBlobs[localDataKey];
      fileBlobs = nextBlobs;
    }
    return true;
  }

  if (ref?.storageType === 'indexeddb') {
    try {
      await deleteDocumentBlob(fileRefId);
    } catch (error) {
      if (error instanceof DocumentBlobStorageError) {
        throw error;
      }
      throw new DocumentBlobStorageError('blob_delete_failed', error);
    }
  }

  return true;
}

/** @deprecated Prefer storeDocumentFileFromCachedPayload after a single file read. */
export async function storeDocumentFileFromUpload(
  file: File,
): Promise<{ fileRef: DocumentFileRef; created: boolean }> {
  const buffer = await file.arrayBuffer();
  return storeDocumentFileFromCachedPayload({
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    fileSize: file.size,
    bytes: new Uint8Array(buffer),
  });
}

export async function backfillMissingFileRefHashes(): Promise<void> {
  let changed = false;
  const updates = await Promise.all(
    fileRefs.map(async (ref) => {
      if (ref.contentHash) return ref;
      if (ref.storageType === 'indexeddb') {
        try {
          const record = await readDocumentBlob(ref.id);
          if (record?.contentHash) {
            changed = true;
            return { ...ref, contentHash: record.contentHash };
          }
        } catch {
          return ref;
        }
      }
      const dataUrl = fileBlobs[ref.localDataKey];
      if (!dataUrl) return ref;
      try {
        const contentHash = await computeDataUrlContentHash(dataUrl);
        changed = true;
        return { ...ref, contentHash };
      } catch {
        return ref;
      }
    }),
  );
  if (changed) {
    fileRefs = updates;
  }
}

export async function registerLegacyDocumentFile(input: {
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  dataUrl: string;
  legacyId: string;
}): Promise<DocumentFileRef> {
  const existing = fileRefs.find((entry) => entry.id === `legacy-upl-${input.legacyId}`);
  if (existing) return cloneRef(existing);

  let contentHash = '';
  try {
    contentHash = await computeDataUrlContentHash(input.dataUrl);
  } catch {
    contentHash = `legacy:${input.legacyId}`;
  }

  const hashMatch = getDocumentFileRefByHash(contentHash);
  if (hashMatch) return hashMatch;

  const localDataKey = generateEntityId('file-blob');
  fileBlobs[localDataKey] = input.dataUrl;

  const createdAt = new Date().toISOString();
  const fileRef: DocumentFileRef = {
    id: `legacy-upl-${input.legacyId}`,
    originalFileName: input.originalFileName,
    mimeType: input.mimeType,
    fileSize: input.fileSize,
    contentHash,
    storageType: 'local_data_url',
    localDataKey,
    createdAt,
    ...buildCommittedLifecycleFields(createdAt),
  };
  fileRefs = [...fileRefs, fileRef];
  return fileRef;
}

export { DocumentBlobStorageError } from './storage/documentBlobIndexedDbService';
