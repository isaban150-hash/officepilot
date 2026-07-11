import type { DocumentFileRef } from '../types/documentFileRef';
import { generateEntityId } from './sync/syncMetaService';
import { computeDataUrlContentHash, computeFileContentHash } from './documentFileHashService';

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
  if (!resolved) return undefined;
  return fileBlobs[resolved.localDataKey];
}

export async function storeDocumentFileFromUpload(
  file: File,
): Promise<{ fileRef: DocumentFileRef; created: boolean }> {
  const contentHash = await computeFileContentHash(file);
  const existing = getDocumentFileRefByHash(contentHash);
  if (existing) {
    return { fileRef: existing, created: false };
  }

  const reader = new FileReader();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Datei konnte nicht gelesen werden.'));
    };
    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });

  const localDataKey = generateEntityId('file-blob');
  fileBlobs[localDataKey] = dataUrl;

  const fileRef: DocumentFileRef = {
    id: generateEntityId('file-ref'),
    originalFileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    fileSize: file.size,
    contentHash,
    storageType: 'local_data_url',
    localDataKey,
    createdAt: new Date().toISOString(),
  };
  fileRefs = [...fileRefs, fileRef];
  return { fileRef, created: true };
}

export async function backfillMissingFileRefHashes(): Promise<void> {
  let changed = false;
  const updates = await Promise.all(
    fileRefs.map(async (ref) => {
      if (ref.contentHash) return ref;
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

  const fileRef: DocumentFileRef = {
    id: `legacy-upl-${input.legacyId}`,
    originalFileName: input.originalFileName,
    mimeType: input.mimeType,
    fileSize: input.fileSize,
    contentHash,
    storageType: 'local_data_url',
    localDataKey,
    createdAt: new Date().toISOString(),
  };
  fileRefs = [...fileRefs, fileRef];
  return fileRef;
}
