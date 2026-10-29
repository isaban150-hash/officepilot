import { BRANDING_ASSET_DB_NAME, BRANDING_ASSET_DB_VERSION, BRANDING_ASSET_STORE_NAME } from '../branding/brandingAssetCacheService';
import { INVOICE_DRAFT_DB_NAME, INVOICE_DRAFT_DB_VERSION, INVOICE_DRAFT_STORE_NAME } from '../invoice/invoiceDraftDurabilityService';
import { DOCUMENT_BLOB_DB_NAME, DOCUMENT_BLOB_DB_VERSION, DOCUMENT_BLOB_STORE_NAME } from './documentBlobIndexedDbService';
import { UPLOAD_DRAFT_DB_NAME, UPLOAD_DRAFT_DB_VERSION, UPLOAD_DRAFT_STORE_NAME } from './uploadDraftIndexedDbService';
import { STORAGE_KEY_PREFIX } from './storageScopeService';

/**
 * EINRICHTUNG-01 (AP7; Verträge 1.25, 1.29) — die lokalen Bestände genau eines Kontos auf diesem Gerät.
 *
 * Kontogebunden sind: der Betriebs- und Kontobestand (`officepilot-state:workspace:<betrieb>:account:<konto>:…`,
 * `officepilot-state:user:<konto>`), Zugriffsauskünfte, Profil-Zwischenspeicher, Anfrage-IDs und weitere Schlüssel mit der
 * Kontokennung — in localStorage und sessionStorage —, dazu die IndexedDB-Einträge der Bereiche dieses Kontos (Dokument-
 * dateien, Upload-Entwürfe, Rechnungsentwürfe) und die zwischengespeicherten Logos seiner Betriebe. Bestände anderer
 * Konten bleiben; ein Betrieb, den noch ein anderes Konto auf diesem Gerät führt, behält seinen Logo-Zwischenspeicher.
 *
 * Reine Gerätewirkung: Serverdaten bleiben unverändert. Die Abmeldung (lokal) übernimmt der Aufrufer.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LAST_ACCOUNT_KEY = 'officetakt-auth-last-account';

export interface LocalAccountWorkspace {
  workspaceId: string;
  storageKey: string;
  bytes: number;
}

export interface LocalAccountInventory {
  workspaces: LocalAccountWorkspace[];
  /** Andere Konten mit Beständen auf diesem Gerät — nur als Anzahl. */
  otherAccounts: number;
}

function keysOf(storage: Storage | undefined): string[] {
  if (!storage) return [];
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

function safeStorage(kind: 'local' | 'session'): Storage | undefined {
  try {
    return kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

const WORKSPACE_KEY = new RegExp(`^${STORAGE_KEY_PREFIX}:workspace:([^:]+):account:([^:]+):(full|member)$`);

/** Die Betriebsbestände dieses Kontos und die Zahl anderer Konten (ohne deren Kennungen). */
export function inventoryLocalAccountData(userId: string): LocalAccountInventory {
  const local = safeStorage('local');
  const workspaces: LocalAccountWorkspace[] = [];
  const andere = new Set<string>();
  for (const key of keysOf(local)) {
    const treffer = WORKSPACE_KEY.exec(key);
    const userKey = key.startsWith(`${STORAGE_KEY_PREFIX}:user:`) ? key.slice(`${STORAGE_KEY_PREFIX}:user:`.length) : null;
    const besitzer = treffer?.[2] ?? userKey;
    if (!besitzer) continue;
    if (besitzer !== userId) {
      andere.add(besitzer);
      continue;
    }
    if (treffer) {
      let bytes = 0;
      try {
        bytes = (local?.getItem(key) ?? '').length * 2;
      } catch {
        bytes = 0;
      }
      workspaces.push({ workspaceId: treffer[1], storageKey: key, bytes });
    }
  }
  return { workspaces, otherAccounts: andere.size };
}

function scopeBelongsTo(scopeKey: unknown, userId: string): boolean {
  if (typeof scopeKey !== 'string') return false;
  return scopeKey === `user:${userId}` || scopeKey.includes(`:account:${userId}:`);
}

function openExisting(name: string, version: number): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let factory: IDBFactory | undefined;
    try {
      factory = globalThis.indexedDB;
    } catch {
      factory = undefined;
    }
    if (!factory) {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, version);
    } catch {
      resolve(null);
      return;
    }
    // Fehlt die Datenbank, entsteht hier keine: das Upgrade wird abgebrochen (nichts zu entfernen).
    request.onupgradeneeded = () => {
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function deleteMatching(
  name: string,
  version: number,
  storeName: string,
  matches: (value: Record<string, unknown>) => boolean,
): Promise<number> {
  const db = await openExisting(name, version);
  if (!db) return 0;
  try {
    if (!db.objectStoreNames.contains(storeName)) return 0;
    return await new Promise<number>((resolve, reject) => {
      let removed = 0;
      const transaction = db.transaction(storeName, 'readwrite');
      const cursorRequest = transaction.objectStore(storeName).openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const value = cursor.value as Record<string, unknown>;
        if (value && matches(value)) {
          cursor.delete();
          removed += 1;
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(removed);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Öffnet eine vorhandene Datenbank zum Lesen. Fehlt sie, entsteht keine (das Upgrade wird abgebrochen) und es gibt nichts
 * zu lesen; jeder andere Fehler ist `failed` — eine Prüfung darf ihn nie als „leer“ deuten.
 */
function openForReading(name: string, version: number): Promise<{ db: IDBDatabase | null; failed: boolean }> {
  return new Promise((resolve) => {
    let factory: IDBFactory | undefined;
    try {
      factory = globalThis.indexedDB;
    } catch {
      factory = undefined;
    }
    if (!factory) {
      resolve({ db: null, failed: false });
      return;
    }
    let missing = false;
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, version);
    } catch {
      resolve({ db: null, failed: true });
      return;
    }
    request.onupgradeneeded = (event) => {
      missing = event.oldVersion === 0;
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve({ db: request.result, failed: false });
    request.onerror = () => resolve({ db: null, failed: !missing });
    request.onblocked = () => resolve({ db: null, failed: true });
  });
}

async function readMatching(
  name: string,
  version: number,
  storeName: string,
  matches: (value: Record<string, unknown>) => boolean,
): Promise<{ ok: true; records: Record<string, unknown>[] } | { ok: false }> {
  const { db, failed } = await openForReading(name, version);
  if (failed) return { ok: false };
  if (!db) return { ok: true, records: [] };
  try {
    if (!db.objectStoreNames.contains(storeName)) return { ok: true, records: [] };
    return await new Promise((resolve) => {
      const records: Record<string, unknown>[] = [];
      const transaction = db.transaction(storeName, 'readonly');
      const cursorRequest = transaction.objectStore(storeName).openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const value = cursor.value as Record<string, unknown>;
        if (value && typeof value === 'object' && matches(value)) records.push(value);
        cursor.continue();
      };
      transaction.oncomplete = () => resolve({ ok: true, records });
      transaction.onerror = () => resolve({ ok: false });
      transaction.onabort = () => resolve({ ok: false });
    });
  } catch {
    return { ok: false };
  } finally {
    db.close();
  }
}

export interface LocalAccountDrafts {
  /** Beide Entwurfsspeicher ließen sich lesen. */
  ok: boolean;
  invoiceDrafts: Record<string, unknown>[];
  uploadDrafts: Record<string, unknown>[];
}

/**
 * Abschluss 22 (WEISS E-13) — lesend: die Rechnungs- und Upload-Entwürfe dieses Kontos, nach denselben Regeln, nach
 * denen `removeLocalAccountData` sie entfernen würde. Für die Prüfung vor dem Entfernen; nichts wird verändert.
 */
export async function readLocalAccountDrafts(userId: string): Promise<LocalAccountDrafts> {
  const invoice = await readMatching(INVOICE_DRAFT_DB_NAME, INVOICE_DRAFT_DB_VERSION, INVOICE_DRAFT_STORE_NAME, (value) =>
    scopeBelongsTo(value.sourceScopeKey, userId) || (typeof value.recordKey === 'string' && value.recordKey.includes(userId)),
  );
  const upload = await readMatching(UPLOAD_DRAFT_DB_NAME, UPLOAD_DRAFT_DB_VERSION, UPLOAD_DRAFT_STORE_NAME, (value) =>
    value.userId === userId || scopeBelongsTo(value.scopeKey, userId),
  );
  return {
    ok: invoice.ok && upload.ok,
    invoiceDrafts: invoice.ok ? invoice.records : [],
    uploadDrafts: upload.ok ? upload.records : [],
  };
}

export interface LocalAccountRemovalResult {
  storageKeys: number;
  sessionKeys: number;
  indexedDbRecords: number;
  workspaces: string[];
}

/** Entfernt alle lokalen Bestände dieses Kontos auf diesem Gerät; andere Konten bleiben. */
export async function removeLocalAccountData(userId: string): Promise<LocalAccountRemovalResult> {
  if (!UUID.test(userId)) throw new Error('local_account_invalid');
  const inventory = inventoryLocalAccountData(userId);
  const eigeneBetriebe = inventory.workspaces.map((entry) => entry.workspaceId);

  const local = safeStorage('local');
  const session = safeStorage('session');
  let storageKeys = 0;
  for (const key of keysOf(local)) {
    if (key.includes(userId)) {
      try {
        local?.removeItem(key);
        storageKeys += 1;
      } catch {
        // weiter mit den übrigen
      }
    }
  }
  try {
    if (local?.getItem(LAST_ACCOUNT_KEY) === userId) {
      local.removeItem(LAST_ACCOUNT_KEY);
      storageKeys += 1;
    }
  } catch {
    // nichts zu tun
  }
  let sessionKeys = 0;
  for (const key of keysOf(session)) {
    let value: string | null = null;
    try {
      value = session?.getItem(key) ?? null;
    } catch {
      value = null;
    }
    if (key.includes(userId) || (value !== null && value.includes(userId))) {
      try {
        session?.removeItem(key);
        sessionKeys += 1;
      } catch {
        // weiter
      }
    }
  }

  let indexedDbRecords = 0;
  indexedDbRecords += await deleteMatching(DOCUMENT_BLOB_DB_NAME, DOCUMENT_BLOB_DB_VERSION, DOCUMENT_BLOB_STORE_NAME, (value) =>
    scopeBelongsTo(value.scopeKey, userId),
  ).catch(() => 0);
  indexedDbRecords += await deleteMatching(UPLOAD_DRAFT_DB_NAME, UPLOAD_DRAFT_DB_VERSION, UPLOAD_DRAFT_STORE_NAME, (value) =>
    value.userId === userId || scopeBelongsTo(value.scopeKey, userId),
  ).catch(() => 0);
  indexedDbRecords += await deleteMatching(INVOICE_DRAFT_DB_NAME, INVOICE_DRAFT_DB_VERSION, INVOICE_DRAFT_STORE_NAME, (value) =>
    scopeBelongsTo(value.sourceScopeKey, userId) || (typeof value.recordKey === 'string' && value.recordKey.includes(userId)),
  ).catch(() => 0);

  // Logo-Zwischenspeicher nur für Betriebe, die kein anderes Konto auf diesem Gerät führt.
  const nochGefuehrt = new Set(
    keysOf(local)
      .map((key) => WORKSPACE_KEY.exec(key)?.[1])
      .filter((id): id is string => Boolean(id)),
  );
  const freizugeben = eigeneBetriebe.filter((id) => !nochGefuehrt.has(id));
  if (freizugeben.length > 0) {
    indexedDbRecords += await deleteMatching(BRANDING_ASSET_DB_NAME, BRANDING_ASSET_DB_VERSION, BRANDING_ASSET_STORE_NAME, (value) =>
      freizugeben.some((id) => typeof value.key === 'string' && value.key.startsWith(id + '/')),
    ).catch(() => 0);
  }

  return { storageKeys, sessionKeys, indexedDbRecords, workspaces: eigeneBetriebe };
}
