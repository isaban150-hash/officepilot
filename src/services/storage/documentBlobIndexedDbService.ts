import { getActiveStorageScope } from './storageScopeService';
import {
  buildDocumentBlobRecordId,
  buildDocumentBlobScopeKey,
} from './documentBlobScopeService';

export const DOCUMENT_BLOB_DB_NAME = 'officepilot-document-blobs';
export const DOCUMENT_BLOB_DB_VERSION = 1;
export const DOCUMENT_BLOB_STORE_NAME = 'document_blobs';

export type DocumentBlobStorageErrorCode =
  | 'blob_storage_unavailable'
  | 'blob_write_failed'
  | 'blob_read_failed'
  | 'blob_delete_failed'
  | 'blob_missing_after_write'
  | 'blob_size_mismatch'
  | 'blob_hash_mismatch';

export class DocumentBlobStorageError extends Error {
  readonly code: DocumentBlobStorageErrorCode;

  constructor(code: DocumentBlobStorageErrorCode, cause?: unknown) {
    super(code);
    this.name = 'DocumentBlobStorageError';
    this.code = code;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export interface DocumentBlobRecord {
  id: string;
  scopeKey: string;
  fileRefId: string;
  userId?: string;
  workspaceId?: string;
  blobData: ArrayBuffer;
  mimeType: string;
  fileSize: number;
  contentHash: string;
  createdAt: string;
}

export interface DocumentBlobReadResult {
  id: string;
  scopeKey: string;
  fileRefId: string;
  userId?: string;
  workspaceId?: string;
  blob: Blob;
  mimeType: string;
  fileSize: number;
  contentHash: string;
  createdAt: string;
}

export interface SaveDocumentBlobInput {
  fileRefId: string;
  blob: Blob;
  mimeType: string;
  fileSize: number;
  contentHash: string;
  createdAt: string;
  scope?: import('./storageScopeService').StorageScope;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let activeDb: IDBDatabase | null = null;
let resetQueue: Promise<void> = Promise.resolve();

function resolveIndexedDb(): IDBFactory | null {
  if (typeof indexedDB !== 'undefined') {
    return indexedDB;
  }
  return null;
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDocumentBlobDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(DOCUMENT_BLOB_STORE_NAME, mode);
        const request = operation(transaction.objectStore(DOCUMENT_BLOB_STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          reject(request.error ?? new Error('IndexedDB request failed'));
        };
        transaction.onabort = () => {
          reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
        };
      }),
  );
}

export async function openDocumentBlobDatabase(): Promise<IDBDatabase> {
  const factory = resolveIndexedDb();
  if (!factory) {
    throw new DocumentBlobStorageError('blob_storage_unavailable');
  }

  if (activeDb) {
    return activeDb;
  }

  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = factory.open(DOCUMENT_BLOB_DB_NAME, DOCUMENT_BLOB_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DOCUMENT_BLOB_STORE_NAME)) {
          const store = db.createObjectStore(DOCUMENT_BLOB_STORE_NAME, { keyPath: 'id' });
          store.createIndex('scopeKey', 'scopeKey', { unique: false });
          store.createIndex('fileRefId', 'fileRefId', { unique: false });
          store.createIndex('contentHash', 'contentHash', { unique: false });
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
        reject(new DocumentBlobStorageError('blob_storage_unavailable', request.error));
      };
      request.onblocked = () => {
        dbPromise = null;
        reject(new DocumentBlobStorageError('blob_storage_unavailable'));
      };
    });
  }

  try {
    return await dbPromise;
  } catch (error) {
    dbPromise = null;
    if (error instanceof DocumentBlobStorageError) {
      throw error;
    }
    throw new DocumentBlobStorageError('blob_storage_unavailable', error);
  }
}

function buildRecord(input: SaveDocumentBlobInput, blobData: ArrayBuffer): DocumentBlobRecord {
  const scope = input.scope ?? getActiveStorageScope();
  const scopeKey = buildDocumentBlobScopeKey(scope);
  const parsedScope = scope.type === 'user'
    ? { userId: scope.userId }
    : scope.type === 'workspace'
      ? { workspaceId: scope.workspaceId }
      : {};

  return {
    id: buildDocumentBlobRecordId(scopeKey, input.fileRefId),
    scopeKey,
    fileRefId: input.fileRefId,
    ...parsedScope,
    blobData,
    mimeType: input.mimeType,
    fileSize: input.fileSize,
    contentHash: input.contentHash,
    createdAt: input.createdAt,
  };
}

function normalizeBlobData(data: unknown): ArrayBuffer {
  if (data instanceof ArrayBuffer) {
    return data;
  }
  if (data instanceof Uint8Array) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  throw new DocumentBlobStorageError('blob_read_failed');
}

function toReadResult(record: DocumentBlobRecord): DocumentBlobReadResult {
  const blobData = normalizeBlobData(record.blobData);
  return {
    id: record.id,
    scopeKey: record.scopeKey,
    fileRefId: record.fileRefId,
    userId: record.userId,
    workspaceId: record.workspaceId,
    blob: new Blob([blobData], { type: record.mimeType }),
    mimeType: record.mimeType,
    fileSize: record.fileSize,
    contentHash: record.contentHash,
    createdAt: record.createdAt,
  };
}

export async function saveDocumentBlob(input: SaveDocumentBlobInput): Promise<DocumentBlobReadResult> {
  try {
    const blobData = await input.blob.arrayBuffer();
    const record = buildRecord(input, blobData);
    await runTransaction('readwrite', (store) => store.put(record));
    return toReadResult(record);
  } catch (error) {
    if (error instanceof DocumentBlobStorageError) {
      throw error;
    }
    throw new DocumentBlobStorageError('blob_write_failed', error);
  }
}

export async function readDocumentBlob(
  fileRefId: string,
  scope = getActiveStorageScope(),
): Promise<DocumentBlobReadResult | null> {
  try {
    const scopeKey = buildDocumentBlobScopeKey(scope);
    const id = buildDocumentBlobRecordId(scopeKey, fileRefId);
    const record = await runTransaction<DocumentBlobRecord | undefined>('readonly', (store) => store.get(id));
    return record ? toReadResult(record) : null;
  } catch (error) {
    if (error instanceof DocumentBlobStorageError) {
      throw error;
    }
    throw new DocumentBlobStorageError('blob_read_failed', error);
  }
}

export async function hasDocumentBlob(
  fileRefId: string,
  scope = getActiveStorageScope(),
): Promise<boolean> {
  const record = await readDocumentBlob(fileRefId, scope);
  return record !== null;
}

export async function deleteDocumentBlob(
  fileRefId: string,
  scope = getActiveStorageScope(),
): Promise<boolean> {
  try {
    const scopeKey = buildDocumentBlobScopeKey(scope);
    const id = buildDocumentBlobRecordId(scopeKey, fileRefId);
    await runTransaction('readwrite', (store) => store.delete(id));
    return true;
  } catch (error) {
    if (error instanceof DocumentBlobStorageError) {
      throw error;
    }
    throw new DocumentBlobStorageError('blob_delete_failed', error);
  }
}

export async function copyDocumentBlobToScope(
  fileRefId: string,
  sourceScope: import('./storageScopeService').StorageScope,
  targetScope: import('./storageScopeService').StorageScope,
): Promise<boolean> {
  const sourceKey = buildDocumentBlobScopeKey(sourceScope);
  const targetKey = buildDocumentBlobScopeKey(targetScope);
  if (sourceKey === targetKey) {
    return hasDocumentBlob(fileRefId, targetScope);
  }

  if (await hasDocumentBlob(fileRefId, targetScope)) {
    return true;
  }

  const source = await readDocumentBlob(fileRefId, sourceScope);
  if (!source) {
    return false;
  }

  await saveDocumentBlob({
    fileRefId,
    blob: source.blob,
    mimeType: source.mimeType,
    fileSize: source.fileSize,
    contentHash: source.contentHash,
    createdAt: source.createdAt,
    scope: targetScope,
  });
  return true;
}

export async function migrateDocumentBlobsToScope(
  fileRefIds: string[],
  sourceScopes: import('./storageScopeService').StorageScope[],
  targetScope: import('./storageScopeService').StorageScope,
): Promise<{ migrated: number; missing: string[] }> {
  const uniqueIds = [...new Set(fileRefIds.filter(Boolean))];
  const missing: string[] = [];
  let migrated = 0;

  for (const fileRefId of uniqueIds) {
    if (await hasDocumentBlob(fileRefId, targetScope)) {
      continue;
    }

    let copied = false;
    for (const sourceScope of sourceScopes) {
      if (await copyDocumentBlobToScope(fileRefId, sourceScope, targetScope)) {
        copied = true;
        migrated += 1;
        break;
      }
    }

    if (!copied) {
      missing.push(fileRefId);
    }
  }

  return { migrated, missing };
}

/* ------------------------------------------------------------------------- *
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02P2 — Quarantäne-Blobs
 *
 * Bewusst getrennt von allem oberhalb: kein StorageScope, kein Default-
 * Parameter, kein getActiveStorageScope, kein buildDocumentBlobScopeKey, kein
 * parseDocumentBlobScopeKey, keine Fallback-Suche, keine Migration, keine
 * Kopie. Der Namensraum `quarantine:` kann per Konstruktion nie mit
 * `guest`, `user:*` oder `workspace:*` kollidieren.
 *
 * Gleiche Datenbank, gleicher Object Store, gleiche Datensatzform, keine
 * Versionsänderung.
 * ------------------------------------------------------------------------- */

export const QUARANTINE_BLOB_SCOPE_PREFIX = 'quarantine:';

export type QuarantineBlobScopeKey = `quarantine:${string}`;

/**
 * Streng geprüft — der Präfix allein genügt nicht. Zulässig ist ausschließlich
 * `quarantine:q-<16 Hex Archivanteil>-<mindestens 16 Hex Zufall>`; damit ist ein
 * Quarantäneschlüssel weder als `guest`, `user:*` noch `workspace:*` lesbar und
 * auch kein frei gewählter Name.
 */
const QUARANTINE_SCOPE_KEY_PATTERN = /^quarantine:q-[0-9a-f]{16}-[0-9a-f]{16,}$/;

export function isQuarantineBlobScopeKey(value: unknown): value is QuarantineBlobScopeKey {
  return typeof value === 'string' && QUARANTINE_SCOPE_KEY_PATTERN.test(value);
}

function assertQuarantineScopeKey(value: unknown): asserts value is QuarantineBlobScopeKey {
  if (!isQuarantineBlobScopeKey(value)) {
    throw new TypeError('quarantine_scope_key_invalid');
  }
}

function assertQuarantineFileRefId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.includes('::')) {
    throw new TypeError('quarantine_file_ref_id_invalid');
  }
}

export interface WriteQuarantineBlobInput {
  scopeKey: QuarantineBlobScopeKey;
  fileRefId: string;
  bytes: Uint8Array;
  mimeType: string;
  fileSize: number;
  contentHash: string;
  createdAt: string;
}

export async function writeQuarantineBlob(input: WriteQuarantineBlobInput): Promise<void> {
  assertQuarantineScopeKey(input.scopeKey);
  assertQuarantineFileRefId(input.fileRefId);

  const copy = new Uint8Array(input.bytes);
  const record: DocumentBlobRecord = {
    id: `${input.scopeKey}::${input.fileRefId}`,
    scopeKey: input.scopeKey,
    fileRefId: input.fileRefId,
    blobData: copy.buffer.slice(0, copy.byteLength) as ArrayBuffer,
    mimeType: input.mimeType,
    fileSize: input.fileSize,
    contentHash: input.contentHash,
    createdAt: input.createdAt,
  };
  await runTransaction('readwrite', (store) => store.put(record));
}

export async function readQuarantineBlob(
  scopeKey: QuarantineBlobScopeKey,
  fileRefId: string,
): Promise<{ bytes: Uint8Array; mimeType: string; fileSize: number; contentHash: string } | null> {
  assertQuarantineScopeKey(scopeKey);
  assertQuarantineFileRefId(fileRefId);

  const record = await runTransaction<DocumentBlobRecord | undefined>('readonly', (store) =>
    store.get(`${scopeKey}::${fileRefId}`),
  );
  if (!record) return null;
  // Die Datensatzidentität muss zum angeforderten Bereich passen.
  if (record.scopeKey !== scopeKey || record.fileRefId !== fileRefId) return null;
  return {
    bytes: new Uint8Array(normalizeBlobData(record.blobData)),
    mimeType: record.mimeType,
    fileSize: record.fileSize,
    contentHash: record.contentHash,
  };
}

export async function deleteQuarantineBlob(
  scopeKey: QuarantineBlobScopeKey,
  fileRefId: string,
): Promise<void> {
  assertQuarantineScopeKey(scopeKey);
  assertQuarantineFileRefId(fileRefId);
  await runTransaction('readwrite', (store) => store.delete(`${scopeKey}::${fileRefId}`));
}

/**
 * Listet ausschließlich die Datensätze genau eines Quarantäne-Tokens.
 * Bewusst über einen Cursor statt über den `scopeKey`-Index: so ist die
 * Funktion unabhängig davon, ob eine bereits vorhandene Datenbank den Index
 * trägt — und es bleibt bei Version 1.
 */
export async function listQuarantineBlobRecords(
  scopeKey: QuarantineBlobScopeKey,
): Promise<{ fileRefId: string; fileSize: number; contentHash: string; mimeType: string }[]> {
  assertQuarantineScopeKey(scopeKey);
  const db = await openDocumentBlobDatabase();
  return new Promise((resolve, reject) => {
    const found: { fileRefId: string; fileSize: number; contentHash: string; mimeType: string }[] = [];
    const transaction = db.transaction(DOCUMENT_BLOB_STORE_NAME, 'readonly');
    const request = transaction.objectStore(DOCUMENT_BLOB_STORE_NAME).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        found.sort((a, b) => a.fileRefId.localeCompare(b.fileRefId));
        resolve(found);
        return;
      }
      const record = cursor.value as DocumentBlobRecord;
      if (record?.scopeKey === scopeKey) {
        found.push({
          fileRefId: record.fileRefId,
          fileSize: record.fileSize,
          contentHash: record.contentHash,
          mimeType: record.mimeType,
        });
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('quarantine_list_failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('quarantine_list_aborted'));
  });
}

async function deleteDatabaseWithRetry(factory: IDBFactory, attempts = 8): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(DOCUMENT_BLOB_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to delete IndexedDB'));
    request.onblocked = () => {
      if (activeDb) {
        try {
          activeDb.close();
        } catch {
          /* ignore */
        }
        activeDb = null;
      }
      dbPromise = null;
      if (attempts <= 0) {
        resolve();
        return;
      }
      setTimeout(() => {
        deleteDatabaseWithRetry(factory, attempts - 1).then(resolve).catch(reject);
      }, 25);
    };
  });
}

/**
 * Clears all blob records without deleting the database (faster than deleteDatabase).
 * Prefer this in test beforeEach hooks when suites write real IndexedDB blobs.
 */
export async function clearDocumentBlobStoreForTests(): Promise<void> {
  resetQueue = resetQueue.then(async () => {
    const factory = resolveIndexedDb();
    if (!factory) return;

    if (typeof factory.databases === 'function') {
      try {
        const existing = await factory.databases();
        if (!existing.some((entry) => entry.name === DOCUMENT_BLOB_DB_NAME)) {
          return;
        }
      } catch {
        /* listing unsupported — fall through to open+clear */
      }
    }

    try {
      const db = await openDocumentBlobDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(DOCUMENT_BLOB_STORE_NAME, 'readwrite');
        transaction.objectStore(DOCUMENT_BLOB_STORE_NAME).clear();
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => {
          reject(transaction.error ?? new Error('Failed to clear document blob store'));
        };
        transaction.onerror = () => {
          reject(transaction.error ?? new Error('Failed to clear document blob store'));
        };
      });
    } catch {
      /* DB unavailable or never usable — nothing to clear */
    }
  });
  return resetQueue;
}

export async function resetDocumentBlobDatabaseForTests(): Promise<void> {
  resetQueue = resetQueue.then(async () => {
    if (activeDb) {
      try {
        activeDb.close();
      } catch {
        /* ignore */
      }
      activeDb = null;
    }
    dbPromise = null;

    const factory = resolveIndexedDb();
    if (!factory) return;

    await deleteDatabaseWithRetry(factory);
  });
  return resetQueue;
}
