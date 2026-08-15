/**
 * UPLOAD-DRAFT-RESUME-01B1 — local metadata store for unconfirmed upload drafts.
 *
 * Own database, version 1: the document blob database keeps its version and needs
 * no migration. Records hold metadata only — never bytes, blobs or data URLs.
 * Every read is scope-isolated, so a draft of another user or workspace is
 * invisible here.
 */
import type { DocumentClassificationResult } from '../../types/models';
import type { ResolvedStoragePolicy } from '../../types/storagePolicy';
import type { StorageRecommendation } from '../../types/storageRecommendation';
import type {
  DocumentTextExtractionResult,
  OcrPreviewSummary,
} from '../ocrDocumentService';
import { buildDocumentBlobScopeKey } from './documentBlobScopeService';
import { getActiveStorageScope, type StorageScope } from './storageScopeService';

export const UPLOAD_DRAFT_DB_NAME = 'officepilot-upload-drafts';
export const UPLOAD_DRAFT_DB_VERSION = 1;
export const UPLOAD_DRAFT_STORE_NAME = 'upload_drafts';
export const UPLOAD_DRAFT_SCHEMA_VERSION = 1;

/** Maximum lifetime of an unconfirmed draft. */
export const UPLOAD_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export interface UploadDraftRecord {
  id: string;
  schemaVersion: number;
  scopeKey: string;
  userId: string | null;
  workspaceId: string | null;
  source: 'upload';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;

  fileRefId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  contentHash: string;

  extraction: DocumentTextExtractionResult;
  preview: OcrPreviewSummary;
  previewClassification: DocumentClassificationResult;
  storageRecommendation: StorageRecommendation;
  storagePolicy: ResolvedStoragePolicy;
}

export class UploadDraftStorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'UploadDraftStorageError';
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;
let activeDb: IDBDatabase | null = null;
let resetQueue: Promise<void> = Promise.resolve();

function resolveIndexedDb(): IDBFactory | null {
  return typeof indexedDB !== 'undefined' ? indexedDB : null;
}

export async function openUploadDraftDatabase(): Promise<IDBDatabase> {
  const factory = resolveIndexedDb();
  if (!factory) {
    throw new UploadDraftStorageError('upload_draft_storage_unavailable');
  }
  if (activeDb) return activeDb;

  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = factory.open(UPLOAD_DRAFT_DB_NAME, UPLOAD_DRAFT_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(UPLOAD_DRAFT_STORE_NAME)) {
          const store = db.createObjectStore(UPLOAD_DRAFT_STORE_NAME, { keyPath: 'id' });
          store.createIndex('scopeKey', 'scopeKey', { unique: false });
          store.createIndex('fileRefId', 'fileRefId', { unique: false });
        }
      };
      request.onsuccess = () => {
        activeDb = request.result;
        activeDb.onclose = () => {
          activeDb = null;
          dbPromise = null;
        };
        resolve(activeDb);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(new UploadDraftStorageError('upload_draft_storage_unavailable', request.error));
      };
      request.onblocked = () => {
        dbPromise = null;
        reject(new UploadDraftStorageError('upload_draft_storage_unavailable'));
      };
    });
  }

  try {
    return await dbPromise;
  } catch (error) {
    dbPromise = null;
    if (error instanceof UploadDraftStorageError) throw error;
    throw new UploadDraftStorageError('upload_draft_storage_unavailable', error);
  }
}

/**
 * Resolves on transaction.oncomplete, never on request.onsuccess: only a
 * completed transaction is durable. The request result is buffered until then.
 */
function runTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openUploadDraftDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let settled = false;
        let buffered: T | undefined;

        const finish = (value: T) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error ?? new UploadDraftStorageError('upload_draft_request_failed'));
        };

        let transaction: IDBTransaction;
        try {
          transaction = db.transaction(UPLOAD_DRAFT_STORE_NAME, mode);
          const request = operation(transaction.objectStore(UPLOAD_DRAFT_STORE_NAME));
          request.onsuccess = () => {
            buffered = request.result;
          };
          request.onerror = () => {
            fail(request.error ?? new UploadDraftStorageError('upload_draft_request_failed'));
          };
        } catch (error) {
          fail(error);
          return;
        }

        transaction.oncomplete = () => finish(buffered as T);
        transaction.onerror = () =>
          fail(transaction.error ?? new UploadDraftStorageError('upload_draft_transaction_failed'));
        transaction.onabort = () =>
          fail(transaction.error ?? new UploadDraftStorageError('upload_draft_transaction_aborted'));
      }),
  );
}

export function buildUploadDraftScopeKey(scope: StorageScope = getActiveStorageScope()): string {
  return buildDocumentBlobScopeKey(scope);
}

/** Scope identity for a new record — same shape the blob store uses. */
export function buildUploadDraftScopeFields(scope: StorageScope = getActiveStorageScope()): {
  scopeKey: string;
  userId: string | null;
  workspaceId: string | null;
} {
  return {
    scopeKey: buildUploadDraftScopeKey(scope),
    userId: scope.type === 'user' ? scope.userId : null,
    workspaceId: scope.type === 'workspace' ? scope.workspaceId : null,
  };
}

export async function saveUploadDraftRecord(record: UploadDraftRecord): Promise<void> {
  await runTransaction('readwrite', (store) => store.put(record));
}

/** Returns the record only when it belongs to the active scope. */
export async function getUploadDraftRecordById(
  id: string,
): Promise<UploadDraftRecord | null> {
  if (!id) return null;
  const record = await runTransaction<UploadDraftRecord | undefined>('readonly', (store) =>
    store.get(id),
  );
  if (!record) return null;
  if (record.scopeKey !== buildUploadDraftScopeKey()) return null;
  return record;
}

/**
 * Scope-safe delete: a record of another user or workspace is never removed.
 * Returns true only when a record of the active scope was deleted.
 */
export async function deleteUploadDraftRecordById(id: string): Promise<boolean> {
  if (!id) return false;
  const record = await runTransaction<UploadDraftRecord | undefined>('readonly', (store) =>
    store.get(id),
  );
  if (!record || record.scopeKey !== buildUploadDraftScopeKey()) return false;
  await runTransaction('readwrite', (store) => store.delete(id));
  return true;
}

export async function listUploadDraftRecordsForActiveScope(): Promise<UploadDraftRecord[]> {
  const all = await runTransaction<UploadDraftRecord[]>('readonly', (store) => store.getAll());
  const scopeKey = buildUploadDraftScopeKey();
  return (all ?? []).filter((record) => record.scopeKey === scopeKey);
}

export async function resetUploadDraftStoreForTests(): Promise<void> {
  resetQueue = resetQueue.then(async () => {
    const factory = resolveIndexedDb();
    if (!factory) return;
    try {
      const db = await openUploadDraftDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(UPLOAD_DRAFT_STORE_NAME, 'readwrite');
        transaction.objectStore(UPLOAD_DRAFT_STORE_NAME).clear();
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('Failed to clear upload draft store'));
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('Failed to clear upload draft store'));
      });
    } catch {
      /* DB unavailable or never created — nothing to clear */
    }
  });
  return resetQueue;
}
