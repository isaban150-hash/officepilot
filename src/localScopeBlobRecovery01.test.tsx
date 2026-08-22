/**
 * OFFICEPILOT-LOCAL-SCOPE-BLOB-RECOVERY-01B — Notfallsicherung inklusive Dateien.
 *
 * Die Route /local-recovery bleibt rein lesend: kein Provider, kein Bootstrap,
 * keine RPCs, kein localStorage-Schreibzugriff und keine IndexedDB-Schreib-
 * transaktion. IndexedDB darf erst beim ausdrücklichen Klick geöffnet werden.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import JSZip from 'jszip';
import { RootShell } from './RootShell';
import {
  buildScopeKeyFromStorageKey,
  readScopeBlobRecord,
} from './services/storage/localScopeBlobInventoryService';
import { clearMockRpcHandlers, registerMockRpcHandler } from './test/mockProfileStore';
import { resetTestStores } from './test/resetStores';

const DB_NAME = 'officepilot-document-blobs';
const STORE_NAME = 'document_blobs';

const WORKSPACE_ID = 'ws-blob-recovery';
const OTHER_USER_ID = 'user-blob-recovery';
const WORKSPACE_KEY = `officepilot-state:workspace:${WORKSPACE_ID}`;
const USER_KEY = `officepilot-state:user:${OTHER_USER_ID}`;

const PDF_REF_ID = 'ref-pdf-1';
const PNG_REF_ID = 'ref-png-1';
const MISSING_REF_ID = 'ref-missing-1';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x01]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]);
const FOREIGN_BYTES = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

const rpcCalls: string[] = [];
const transactionModes: string[] = [];
const writeCalls: string[] = [];
let indexedDbOpens = 0;

function buildStateRaw(options: { refs?: unknown[]; companyName?: string } = {}): string {
  return JSON.stringify({
    version: 5,
    setup: {
      companyName: options.companyName ?? 'Beispiel Betrieb GmbH',
      setupComplete: true,
      setupVersion: 1,
      language: 'de',
    },
    companyProfile: { companyName: options.companyName ?? 'Beispiel Betrieb GmbH' },
    syncClient: { deviceId: 'device-1', workspaceId: WORKSPACE_ID, serverWorkspaceId: WORKSPACE_ID },
    inboxItems: [{ id: 'inbox-1' }],
    documentFileRefs: options.refs ?? [
      {
        id: PDF_REF_ID,
        storageType: 'indexeddb',
        localDataKey: 'k1',
        mimeType: 'application/pdf',
        fileSize: PDF_BYTES.byteLength,
        contentHash: 'hash-pdf',
        originalFileName: '../../boeser/pfad.pdf',
      },
      {
        id: PNG_REF_ID,
        storageType: 'indexeddb',
        localDataKey: 'k2',
        mimeType: 'image/png',
        fileSize: PNG_BYTES.byteLength,
        contentHash: 'hash-png',
      },
    ],
    documentFileBlobs: {},
    syncOutbox: [
      { id: 'o1', entityType: 'company_setup', entityId: WORKSPACE_ID, operation: 'update', version: 3, status: 'pending', retryCount: 0, queuedAt: '2026-08-15T13:00:00.000Z' },
    ],
    savedAt: '2026-08-15T13:11:18.373Z',
  });
}

function openRaw(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('scopeKey', 'scopeKey', { unique: false });
        store.createIndex('fileRefId', 'fileRefId', { unique: false });
        store.createIndex('contentHash', 'contentHash', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function seedBlob(scopeKey: string, fileRefId: string, bytes: Uint8Array, mimeType: string) {
  const db = await openRaw(1);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({
      id: `${scopeKey}::${fileRefId}`,
      scopeKey,
      fileRefId,
      blobData: bytes.slice().buffer,
      mimeType,
      fileSize: bytes.byteLength,
      contentHash: `hash-${fileRefId}`,
      createdAt: '2026-08-15T12:00:00.000Z',
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function deleteBlobDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/**
 * Prüft ohne Anlegen, ob der Store existiert: Öffnen ohne Version, bei
 * onupgradeneeded sofort abbrechen.
 */
async function storeExists(): Promise<boolean> {
  return new Promise((resolve) => {
    let created = false;
    const request = indexedDB.open(DB_NAME);
    request.onupgradeneeded = () => {
      created = true;
      try {
        request.transaction?.abort();
      } catch {
        /* ignore */
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const has = !created && db.objectStoreNames.contains(STORE_NAME);
      db.close();
      resolve(has);
    };
    request.onerror = () => resolve(false);
    request.onblocked = () => resolve(false);
  });
}

async function databaseExists(): Promise<boolean> {
  const factory = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
  if (typeof factory.databases !== 'function') return false;
  const list = await factory.databases();
  return list.some((entry) => entry.name === DB_NAME);
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function snapshotStorage(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key) entries[key] = localStorage.getItem(key) ?? '';
  }
  return entries;
}

async function tick(times = 25): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderRecovery(): Promise<HTMLDivElement> {
  window.history.pushState({}, '', '/local-recovery');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<RootShell />);
  });
  await tick(5);
  return host;
}

interface CapturedDownload {
  blob: Blob;
  download: string;
  rel: string;
  wasInBody: boolean;
}

async function clickAndCapture(
  container: HTMLElement,
  testId: string,
): Promise<CapturedDownload | null> {
  const captured: CapturedDownload[] = [];
  const originalCreate = URL.createObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  let lastBlob: Blob | null = null;

  URL.createObjectURL = ((blob: Blob) => {
    lastBlob = blob;
    return 'blob:mock-emergency';
  }) as typeof URL.createObjectURL;
  HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement) {
    captured.push({
      blob: lastBlob!,
      download: this.download,
      rel: this.rel,
      wasInBody: document.body.contains(this),
    });
  };

  try {
    const button = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
    expect(button, `Schaltfläche ${testId} fehlt`).not.toBeNull();
    await act(async () => {
      button!.click();
    });
    await tick(40);
  } finally {
    URL.createObjectURL = originalCreate;
    HTMLAnchorElement.prototype.click = originalClick;
  }

  return captured[0] ?? null;
}

describe('OFFICEPILOT-LOCAL-SCOPE-BLOB-RECOVERY-01B', () => {
  let originalTransaction: IDBDatabase['transaction'];
  let originalOpen: IDBFactory['open'];
  let originalPut: IDBObjectStore['put'];
  let originalAdd: IDBObjectStore['add'];
  let originalDelete: IDBObjectStore['delete'];
  let originalClear: IDBObjectStore['clear'];

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    rpcCalls.length = 0;
    transactionModes.length = 0;
    writeCalls.length = 0;
    indexedDbOpens = 0;
    clearMockRpcHandlers();
    for (const name of [
      'ensure_personal_workspace',
      'pull_workspace_sync_state',
      'upsert_workspace_sync_entity',
    ]) {
      registerMockRpcHandler(name, () => {
        rpcCalls.push(name);
        return null;
      });
    }

    await deleteBlobDatabase();
    await seedBlob(`workspace:${WORKSPACE_ID}`, PDF_REF_ID, PDF_BYTES, 'application/pdf');
    await seedBlob(`workspace:${WORKSPACE_ID}`, PNG_REF_ID, PNG_BYTES, 'image/png');
    // Gleiche Ref-ID in einem fremden Scope — darf niemals verwendet werden.
    await seedBlob(`user:${OTHER_USER_ID}`, PDF_REF_ID, FOREIGN_BYTES, 'application/pdf');

    localStorage.setItem(WORKSPACE_KEY, buildStateRaw());
    localStorage.setItem(USER_KEY, JSON.stringify({ version: 5, setup: { companyName: '' }, savedAt: '2026-08-01T08:00:00.000Z' }));
    localStorage.setItem('sb-projekt-auth-token', '{"access_token":"geheim"}');

    // Zähler und Wächter erst nach dem Seeding aktivieren.
    originalOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = ((name: string, version?: number) => {
      indexedDbOpens += 1;
      return version === undefined ? originalOpen(name) : originalOpen(name, version);
    }) as IDBFactory['open'];

    originalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function patched(
      this: IDBDatabase,
      names: string | string[],
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      transactionModes.push(mode ?? 'readonly');
      return originalTransaction.call(this, names, mode, options);
    } as IDBDatabase['transaction'];

    originalPut = IDBObjectStore.prototype.put;
    originalAdd = IDBObjectStore.prototype.add;
    originalDelete = IDBObjectStore.prototype.delete;
    originalClear = IDBObjectStore.prototype.clear;
    IDBObjectStore.prototype.put = function blocked() {
      writeCalls.push('put');
      throw new Error('put verboten');
    } as IDBObjectStore['put'];
    IDBObjectStore.prototype.add = function blocked() {
      writeCalls.push('add');
      throw new Error('add verboten');
    } as IDBObjectStore['add'];
    IDBObjectStore.prototype.delete = function blocked() {
      writeCalls.push('delete');
      throw new Error('delete verboten');
    } as IDBObjectStore['delete'];
    IDBObjectStore.prototype.clear = function blocked() {
      writeCalls.push('clear');
      throw new Error('clear verboten');
    } as IDBObjectStore['clear'];
  });

  afterEach(async () => {
    indexedDB.open = originalOpen;
    IDBDatabase.prototype.transaction = originalTransaction;
    IDBObjectStore.prototype.put = originalPut;
    IDBObjectStore.prototype.add = originalAdd;
    IDBObjectStore.prototype.delete = originalDelete;
    IDBObjectStore.prototype.clear = originalClear;
    await act(async () => {
      root?.unmount();
    });
    host?.remove();
    host = null;
    root = null;
    clearMockRpcHandlers();
    resetTestStores();
    localStorage.clear();
    window.history.pushState({}, '', '/');
  });

  /** Seedet Testdaten und stellt danach die Lese-Wächter wieder her. */
  async function withWriteAccess(action: () => Promise<void>): Promise<void> {
    const guardedPut = IDBObjectStore.prototype.put;
    const guardedTransaction = IDBDatabase.prototype.transaction;
    const guardedOpen = indexedDB.open;
    IDBObjectStore.prototype.put = originalPut;
    IDBDatabase.prototype.transaction = originalTransaction;
    indexedDB.open = originalOpen;
    try {
      await action();
    } finally {
      IDBObjectStore.prototype.put = guardedPut;
      IDBDatabase.prototype.transaction = guardedTransaction;
      indexedDB.open = guardedOpen;
      transactionModes.length = 0;
      writeCalls.length = 0;
      indexedDbOpens = 0;
    }
  }

  /** Schreibt einen Rohdatensatz mit frei wählbaren Feldern. */
  async function seedRawRecord(record: Record<string, unknown>): Promise<void> {
    await withWriteAccess(async () => {
      const db = await openRaw(1);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
  }

  it('B1: das Rendern öffnet IndexedDB nicht und verändert nichts', async () => {
    const before = snapshotStorage();

    const container = await renderRecovery();

    expect(container.querySelector('[data-testid="local-recovery-page"]')).not.toBeNull();
    expect(indexedDbOpens, 'IndexedDB beim Rendern geöffnet').toBe(0);
    expect(transactionModes).toEqual([]);
    expect(writeCalls).toEqual([]);
    expect(rpcCalls).toEqual([]);
    expect(snapshotStorage()).toEqual(before);
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();
    expect(container.querySelector('[data-testid="login-submit"]')).toBeNull();
  });

  it('B2: die Dateisicherung exportiert genau die Blobs des gewählten Scopes', async () => {
    const rawBefore = localStorage.getItem(WORKSPACE_KEY);
    const container = await renderRecovery();

    const captured = await clickAndCapture(
      container,
      `local-recovery-download-files-${WORKSPACE_KEY}`,
    );
    expect(captured, 'kein Download ausgelöst').not.toBeNull();
    expect(captured!.blob.type).toBe('application/zip');
    expect(captured!.wasInBody).toBe(true);
    expect(captured!.rel).toContain('noopener');
    expect(captured!.download.endsWith('.zip')).toBe(true);
    expect(captured!.download).not.toContain(WORKSPACE_ID);
    expect(captured!.download).not.toContain(OTHER_USER_ID);
    expect(captured!.download.toLowerCase()).not.toContain('beispiel');

    const zip = await JSZip.loadAsync(await captured!.blob.arrayBuffer());
    const names = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir).sort();
    expect(names).toEqual([
      'README.txt',
      'files-manifest.json',
      'files/file-1.bin',
      'files/file-2.bin',
      'raw-state.json',
    ]);

    // Rohzustand bytegenau, inklusive Outbox.
    const rawInZip = await zip.files['raw-state.json']!.async('string');
    expect(rawInZip).toBe(rawBefore);
    expect(rawInZip).toContain('"syncOutbox"');
    expect(rawInZip).toContain('company_setup');

    // Dateien bytegenau — und niemals die Fremd-Scope-Bytes.
    const file1 = await zip.files['files/file-1.bin']!.async('uint8array');
    const file2 = await zip.files['files/file-2.bin']!.async('uint8array');
    expect(Array.from(file1)).toEqual(Array.from(PDF_BYTES));
    expect(Array.from(file2)).toEqual(Array.from(PNG_BYTES));
    expect(Array.from(file1)).not.toEqual(Array.from(FOREIGN_BYTES));

    const manifest = JSON.parse(await zip.files['files-manifest.json']!.async('string')) as {
      formatVersion: number;
      storageKey: string;
      scopeKey: string;
      origin: string;
      entries: { fileRefId: string; path: string; status: string }[];
      summary: { refs: number; found: number; missing: number; readError: number; invalid: number };
    };
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.storageKey).toBe(WORKSPACE_KEY);
    expect(manifest.scopeKey).toBe(`workspace:${WORKSPACE_ID}`);
    expect(manifest.origin).toBe(window.location.origin);
    expect(manifest.entries.find((entry) => entry.fileRefId === PDF_REF_ID)?.path).toBe(
      'files/file-1.bin',
    );
    expect(manifest.entries.find((entry) => entry.fileRefId === PNG_REF_ID)?.path).toBe(
      'files/file-2.bin',
    );
    expect(manifest.entries.every((entry) => entry.status === 'found')).toBe(true);
    expect(manifest.summary).toMatchObject({ refs: 2, found: 2, missing: 0 });

    // Keine Auth-Token, kein Fremdinhalt.
    const readme = await zip.files['README.txt']!.async('string');
    expect(readme).toContain(window.location.origin);
    expect(JSON.stringify(manifest) + readme + rawInZip).not.toContain('geheim');

    // Keine Schreibzugriffe, keine RPCs, Adresse unverändert.
    expect(transactionModes.every((mode) => mode === 'readonly')).toBe(true);
    expect(writeCalls).toEqual([]);
    expect(rpcCalls).toEqual([]);
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe(rawBefore);
    expect(window.location.pathname).toBe('/local-recovery');
    expect(document.querySelectorAll('a[download]').length).toBe(0);
    expect(container.textContent).toContain('2');
  });

  it('B3: eine fehlende Datei verhindert die ZIP nicht und wird gemeldet', async () => {
    localStorage.setItem(
      WORKSPACE_KEY,
      buildStateRaw({
        refs: [
          {
            id: PDF_REF_ID,
            storageType: 'indexeddb',
            localDataKey: 'k1',
            mimeType: 'application/pdf',
            fileSize: PDF_BYTES.byteLength,
          },
          {
            id: MISSING_REF_ID,
            storageType: 'indexeddb',
            localDataKey: 'k9',
            mimeType: 'application/pdf',
            fileSize: 123,
          },
        ],
      }),
    );

    const container = await renderRecovery();
    const captured = await clickAndCapture(
      container,
      `local-recovery-download-files-${WORKSPACE_KEY}`,
    );
    expect(captured).not.toBeNull();

    const zip = await JSZip.loadAsync(await captured!.blob.arrayBuffer());
    const manifest = JSON.parse(await zip.files['files-manifest.json']!.async('string')) as {
      entries: { fileRefId: string; status: string; path?: string }[];
      summary: { found: number; missing: number };
    };
    const missing = manifest.entries.find((entry) => entry.fileRefId === MISSING_REF_ID);
    expect(missing?.status).toBe('missing');
    expect(missing?.path).toBeUndefined();
    expect(manifest.summary).toMatchObject({ found: 1, missing: 1 });
    expect(zip.files['raw-state.json']).toBeDefined();
    expect(zip.files['files/file-1.bin']).toBeDefined();
    // Sichtbare Warnung für den Nutzer.
    expect(container.querySelector('[data-testid="local-recovery-file-summary"]')?.textContent)
      .toContain('1');
  });

  it('B4: ungültige Refs und Legacy-Refs werden ehrlich gekennzeichnet', async () => {
    localStorage.setItem(
      WORKSPACE_KEY,
      buildStateRaw({
        refs: [
          { id: PDF_REF_ID, storageType: 'indexeddb', mimeType: 'application/pdf' },
          { id: PDF_REF_ID, storageType: 'indexeddb', mimeType: 'application/pdf' },
          { storageType: 'indexeddb' },
          { id: 'legacy-1', storageType: 'local_data_url', localDataKey: 'legacyKey' },
        ],
      }),
    );

    const container = await renderRecovery();
    const captured = await clickAndCapture(
      container,
      `local-recovery-download-files-${WORKSPACE_KEY}`,
    );
    const zip = await JSZip.loadAsync(await captured!.blob.arrayBuffer());
    const manifest = JSON.parse(await zip.files['files-manifest.json']!.async('string')) as {
      entries: { fileRefId?: string; status: string; duplicateOf?: string; path?: string }[];
    };

    expect(manifest.entries.filter((entry) => entry.status === 'found').length).toBe(1);
    expect(manifest.entries.some((entry) => entry.duplicateOf === 'files/file-1.bin')).toBe(true);
    expect(manifest.entries.some((entry) => entry.status === 'invalid_ref')).toBe(true);
    // Legacy-Daten liegen nicht im Rohzustand → ehrlich als missing.
    expect(
      manifest.entries.find((entry) => entry.fileRefId === 'legacy-1')?.status,
    ).toBe('missing');
    const names = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir);
    expect(names.every((name) => !name.includes('..'))).toBe(true);
    expect(names.filter((name) => name.startsWith('files/')).length).toBe(1);
  });

  it('B5: fehlende Datenbank legt keine nutzbare Datenbank an', async () => {
    // Wächter kurz lösen, damit deleteDatabase möglich ist.
    indexedDB.open = originalOpen;
    await deleteBlobDatabase();
    indexedDB.open = ((name: string, version?: number) => {
      indexedDbOpens += 1;
      return version === undefined ? originalOpen(name) : originalOpen(name, version);
    }) as IDBFactory['open'];

    const result = await readScopeBlobRecord(`workspace:${WORKSPACE_ID}`, PDF_REF_ID);

    expect(result.status).toBe('database_missing');
    expect(result.bytes).toBeUndefined();
    expect(writeCalls).toEqual([]);
    expect(transactionModes.every((mode) => mode === 'readonly')).toBe(true);
    expect(await databaseExists(), 'Datenbank wurde angelegt').toBe(false);
    expect(await storeExists(), 'Store wurde angelegt').toBe(false);
  });

  it('B6: der Scope wird streng aus dem Storage-Key abgeleitet', () => {
    expect(buildScopeKeyFromStorageKey(WORKSPACE_KEY)).toBe(`workspace:${WORKSPACE_ID}`);
    expect(buildScopeKeyFromStorageKey(USER_KEY)).toBe(`user:${OTHER_USER_ID}`);
    expect(buildScopeKeyFromStorageKey('officepilot-state:guest')).toBe('guest');
    expect(buildScopeKeyFromStorageKey('officepilot-setup')).toBeNull();
    expect(buildScopeKeyFromStorageKey('officepilot-state')).toBeNull();
    expect(buildScopeKeyFromStorageKey('officepilot-legacy-state:1750000000000')).toBeNull();
  });

  it('B7: ohne documentFileRefs erscheint keine Dateisicherung, Rohdaten-ZIP bleibt', async () => {
    localStorage.setItem(WORKSPACE_KEY, buildStateRaw({ refs: [] }));

    const container = await renderRecovery();

    expect(
      container.querySelector(`[data-testid="local-recovery-download-files-${WORKSPACE_KEY}"]`),
    ).toBeNull();
    expect(
      container.querySelector(`[data-testid="local-recovery-download-${WORKSPACE_KEY}"]`),
    ).not.toBeNull();
    expect(indexedDbOpens).toBe(0);
  });

  it('B8: eine beschädigte Kopie bleibt ohne Dateisicherung und ohne Absturz', async () => {
    localStorage.setItem('officepilot-state:workspace:kaputt', '{ kein json');

    const container = await renderRecovery();

    expect(container.querySelector('[data-testid="local-recovery-page"]')).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="local-recovery-download-files-officepilot-state:workspace:kaputt"]',
      ),
    ).toBeNull();
    expect(indexedDbOpens).toBe(0);
  });

  it('B9: ohne databases()-API greift der Fallback und legt nichts an', async () => {
    await withWriteAccess(async () => {
      await deleteBlobDatabase();
    });

    const factory = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
    const originalDatabases = factory.databases?.bind(indexedDB);
    // Safari-Fall: die API existiert schlicht nicht (sie liegt auf dem Prototyp).
    Object.defineProperty(indexedDB, 'databases', { configurable: true, value: undefined });
    expect(typeof (indexedDB as { databases?: unknown }).databases).toBe('undefined');

    let result: Awaited<ReturnType<typeof readScopeBlobRecord>>;
    try {
      result = await readScopeBlobRecord(`workspace:${WORKSPACE_ID}`, PDF_REF_ID);
    } finally {
      delete (indexedDB as { databases?: unknown }).databases;
      if (typeof (indexedDB as { databases?: unknown }).databases !== 'function' && originalDatabases) {
        Object.defineProperty(indexedDB, 'databases', {
          configurable: true,
          value: originalDatabases,
        });
      }
    }

    expect(result.status).toBe('database_missing');
    expect(result.bytes).toBeUndefined();
    // Der Fallback musste wirklich öffnen — sonst wäre nichts zu erkennen gewesen.
    expect(indexedDbOpens).toBeGreaterThan(0);
    expect(writeCalls).toEqual([]);
    // Nur die abgebrochene versionchange-Transaktion des Fallbacks darf auftauchen.
    expect(transactionModes.filter((mode) => mode === 'readwrite')).toEqual([]);
    expect(typeof (indexedDB as { databases?: unknown }).databases).toBe('function');
    expect(await databaseExists(), 'Datenbank blieb zurück').toBe(false);
    expect(await storeExists(), 'Store blieb zurück').toBe(false);
  });

  it('B10: beschädigtes blobData wird als read_error gemeldet, ZIP entsteht trotzdem', async () => {
    await seedRawRecord({
      id: `workspace:${WORKSPACE_ID}::${PNG_REF_ID}`,
      scopeKey: `workspace:${WORKSPACE_ID}`,
      fileRefId: PNG_REF_ID,
      blobData: 'das ist kein binaerinhalt',
      mimeType: 'image/png',
      fileSize: 9,
      contentHash: 'hash-broken',
      createdAt: '2026-08-15T12:00:00.000Z',
    });
    const rawBefore = localStorage.getItem(WORKSPACE_KEY);
    const storageBefore = snapshotStorage();

    const container = await renderRecovery();
    const captured = await clickAndCapture(
      container,
      `local-recovery-download-files-${WORKSPACE_KEY}`,
    );
    expect(captured, 'kein Download ausgelöst').not.toBeNull();

    const zip = await JSZip.loadAsync(await captured!.blob.arrayBuffer());
    expect(await zip.files['raw-state.json']!.async('string')).toBe(rawBefore);

    const manifest = JSON.parse(await zip.files['files-manifest.json']!.async('string')) as {
      entries: { fileRefId?: string; status: string; path?: string }[];
      summary: { found: number; readError: number };
    };
    const broken = manifest.entries.find((entry) => entry.fileRefId === PNG_REF_ID);
    expect(broken?.status).toBe('read_error');
    expect(broken?.path).toBeUndefined();
    expect(manifest.summary.readError).toBe(1);
    expect(manifest.summary.found).toBe(1);

    const files = Object.keys(zip.files).filter(
      (name) => name.startsWith('files/') && !zip.files[name]!.dir,
    );
    expect(files).toEqual(['files/file-1.bin']);
    expect(
      container.querySelector('[data-testid="local-recovery-file-summary"]')?.textContent,
    ).toContain('1');
    expect(writeCalls).toEqual([]);
    expect(rpcCalls).toEqual([]);
    expect(snapshotStorage()).toEqual(storageBefore);
  });

  it('B11: widersprüchliche Record-Identität wird nicht exportiert', async () => {
    await seedRawRecord({
      id: `workspace:${WORKSPACE_ID}::${PNG_REF_ID}`,
      // Interne Felder widersprechen dem angeforderten Scope bzw. Ref.
      scopeKey: `user:${OTHER_USER_ID}`,
      fileRefId: 'ganz-anderer-ref',
      blobData: FOREIGN_BYTES.slice().buffer,
      mimeType: 'image/png',
      fileSize: FOREIGN_BYTES.byteLength,
      contentHash: 'hash-fremd',
      createdAt: '2026-08-15T12:00:00.000Z',
    });

    const direct = await readScopeBlobRecord(`workspace:${WORKSPACE_ID}`, PNG_REF_ID);
    expect(direct.status).toBe('read_error');
    expect(direct.bytes).toBeUndefined();

    const container = await renderRecovery();
    const captured = await clickAndCapture(
      container,
      `local-recovery-download-files-${WORKSPACE_KEY}`,
    );
    const zip = await JSZip.loadAsync(await captured!.blob.arrayBuffer());
    const manifest = JSON.parse(await zip.files['files-manifest.json']!.async('string')) as {
      entries: { fileRefId?: string; status: string }[];
      summary: { readError: number };
    };
    expect(manifest.entries.find((entry) => entry.fileRefId === PNG_REF_ID)?.status).toBe(
      'read_error',
    );
    expect(manifest.summary.readError).toBe(1);

    const files = Object.keys(zip.files).filter(
      (name) => name.startsWith('files/') && !zip.files[name]!.dir,
    );
    expect(files).toEqual(['files/file-1.bin']);
    const exported = await zip.files['files/file-1.bin']!.async('uint8array');
    expect(Array.from(exported)).toEqual(Array.from(PDF_BYTES));
    expect(Array.from(exported)).not.toEqual(Array.from(FOREIGN_BYTES));
    expect(writeCalls).toEqual([]);
  });

});
