/**
 * OFFICEPILOT-LOCAL-SCOPE-BLOB-RECOVERY-01B — rein lesender Zugang zu den
 * Dokumentdateien der Notfallansicht.
 *
 * Bewusst **ohne** `openDocumentBlobDatabase()`: jene Funktion legt über
 * `onupgradeneeded` Datenbank und Store an, wenn beides fehlt. Hier darf nichts
 * entstehen. Deshalb:
 *   - Existenzprüfung über `indexedDB.databases()`, sofern vorhanden;
 *   - sonst Öffnen **ohne Version**; ein trotzdem ausgelöstes Upgrade wird
 *     sofort abgebrochen, sodass keine Datenbank zurückbleibt;
 *   - ausschließlich `readonly`-Transaktionen, niemals put/add/delete/clear.
 */
const DOCUMENT_BLOB_DB_NAME = 'officepilot-document-blobs';
const DOCUMENT_BLOB_STORE_NAME = 'document_blobs';
const STORAGE_KEY_PREFIX = 'officepilot-state';

export type ScopeBlobReadStatus =
  | 'ok'
  | 'missing'
  | 'unavailable'
  | 'database_missing'
  | 'store_missing'
  | 'read_error';

export interface ScopeBlobRecordMeta {
  scopeKey: string;
  fileRefId: string;
  mimeType?: string;
  fileSize?: number;
  contentHash?: string;
  createdAt?: string;
}

export interface ScopeBlobReadResult {
  status: ScopeBlobReadStatus;
  bytes?: Uint8Array;
  meta?: ScopeBlobRecordMeta;
  errorMessage?: string;
}

/**
 * Der Scope wird ausschließlich aus dem gewählten Storage-Key abgeleitet —
 * niemals aus dem aktiven Scope und niemals mit Rückfall auf guest/user.
 * Alt- und Quarantäneformate liefern bewusst `null`: für sie gibt es keine
 * eindeutige Scope-Zuordnung der Dateien.
 */
export function buildScopeKeyFromStorageKey(storageKey: string): string | null {
  if (storageKey === `${STORAGE_KEY_PREFIX}:guest`) return 'guest';
  const userPrefix = `${STORAGE_KEY_PREFIX}:user:`;
  const workspacePrefix = `${STORAGE_KEY_PREFIX}:workspace:`;
  if (storageKey.startsWith(userPrefix)) {
    const id = storageKey.slice(userPrefix.length);
    return id && !id.includes(':') ? `user:${id}` : null;
  }
  if (storageKey.startsWith(workspacePrefix)) {
    const id = storageKey.slice(workspacePrefix.length);
    return id && !id.includes(':') ? `workspace:${id}` : null;
  }
  return null;
}

export function buildBlobRecordId(scopeKey: string, fileRefId: string): string {
  return `${scopeKey}::${fileRefId}`;
}

function resolveFactory(): IDBFactory | null {
  return typeof indexedDB !== 'undefined' ? indexedDB : null;
}

async function databaseListedAsMissing(factory: IDBFactory): Promise<boolean> {
  const withDatabases = factory as IDBFactory & {
    databases?: () => Promise<{ name?: string }[]>;
  };
  if (typeof withDatabases.databases !== 'function') return false;
  try {
    const list = await withDatabases.databases();
    return !list.some((entry) => entry.name === DOCUMENT_BLOB_DB_NAME);
  } catch {
    // Feature vorhanden, aber nicht nutzbar: kein Urteil fällen.
    return false;
  }
}

type OpenResult =
  | { status: 'ok'; db: IDBDatabase }
  | { status: 'unavailable' | 'database_missing' | 'store_missing' };

async function openExistingBlobDatabase(): Promise<OpenResult> {
  const factory = resolveFactory();
  if (!factory) return { status: 'unavailable' };

  if (await databaseListedAsMissing(factory)) {
    return { status: 'database_missing' };
  }

  return new Promise<OpenResult>((resolve) => {
    let creationAborted = false;
    // Ohne Versionsangabe: eine vorhandene Datenbank wird niemals migriert.
    const request = factory.open(DOCUMENT_BLOB_DB_NAME);

    request.onupgradeneeded = () => {
      // Die Datenbank existierte nicht. Abbrechen, damit nichts zurückbleibt.
      creationAborted = true;
      try {
        request.transaction?.abort();
      } catch {
        // ignore
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (creationAborted) {
        db.close();
        resolve({ status: 'database_missing' });
        return;
      }
      if (!db.objectStoreNames.contains(DOCUMENT_BLOB_STORE_NAME)) {
        db.close();
        resolve({ status: 'store_missing' });
        return;
      }
      resolve({ status: 'ok', db });
    };
    request.onerror = () => {
      resolve({ status: creationAborted ? 'database_missing' : 'unavailable' });
    };
    request.onblocked = () => resolve({ status: 'unavailable' });
  });
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  return null;
}

/**
 * Liest genau einen Datensatz `scopeKey::fileRefId`. Kein Fallback auf andere
 * Scopes, keine Reparatur, keine Schreibtransaktion.
 */
export async function readScopeBlobRecord(
  scopeKey: string,
  fileRefId: string,
): Promise<ScopeBlobReadResult> {
  const opened = await openExistingBlobDatabase();
  if (opened.status !== 'ok') {
    return { status: opened.status };
  }

  const db = opened.db;
  try {
    const record = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const transaction = db.transaction(DOCUMENT_BLOB_STORE_NAME, 'readonly');
      const request = transaction
        .objectStore(DOCUMENT_BLOB_STORE_NAME)
        .get(buildBlobRecordId(scopeKey, fileRefId));
      request.onsuccess = () => resolve(request.result as Record<string, unknown> | undefined);
      request.onerror = () => reject(request.error ?? new Error('blob_read_failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('blob_read_aborted'));
    });

    if (!record) return { status: 'missing' };

    /**
     * OFFICEPILOT-…-01B-K1 — der zusammengesetzte Schlüssel allein genügt nicht.
     * Widersprechen die internen Felder dem angeforderten Scope oder Ref, werden
     * die Bytes nicht herausgegeben: sie könnten zu einem fremden Bereich gehören.
     */
    const recordScopeKey = typeof record.scopeKey === 'string' ? record.scopeKey : undefined;
    const recordFileRefId = typeof record.fileRefId === 'string' ? record.fileRefId : undefined;
    if (recordScopeKey !== scopeKey || recordFileRefId !== fileRefId) {
      return {
        status: 'read_error',
        errorMessage: 'Datensatz-Identität passt nicht zum angeforderten Bereich',
      };
    }

    const bytes = toBytes(record.blobData);
    const meta: ScopeBlobRecordMeta = {
      scopeKey,
      fileRefId,
      mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
      fileSize: typeof record.fileSize === 'number' ? record.fileSize : undefined,
      contentHash: typeof record.contentHash === 'string' ? record.contentHash : undefined,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
    };
    if (!bytes) {
      return { status: 'read_error', meta, errorMessage: 'blobData ist kein Binärinhalt' };
    }
    return { status: 'ok', bytes, meta };
  } catch (error) {
    return {
      status: 'read_error',
      errorMessage: error instanceof Error ? error.message : 'unbekannter Lesefehler',
    };
  } finally {
    db.close();
  }
}
