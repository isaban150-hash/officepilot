/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02B — abweichende lokale Firmendaten
 * dürfen beim Start weder überschrieben noch stillschweigend hochgeladen werden.
 *
 * Neutrale Beispieldaten, keine echten Namen oder IDs. Alle Supabase-Antworten
 * sind gestubbt: kein Netzwerk, keine Kosten.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { BusinessStateGate } from './components/system/BusinessStateGate';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { STORAGE_VERSION } from './services/sync/syncMigrationService';
import { resetWorkspaceCloudBootstrapForTests } from './services/workspace/workspaceCloudBootstrapService';
import { resetSyncCoordinatorForTests } from './services/sync/syncCoordinator';
import { resetTestStores } from './test/resetStores';
import { clearMockRpcHandlers, registerMockRpcHandler } from './test/mockProfileStore';
import { loginAsDefaultAdmin } from './test/authFixtures';
import { isLocalRecoveryPath } from './RootShell';
import { getMockCurrentSession } from './test/mockSupabaseAuth';
import {
  buildCompanyProfileCloudPayload,
  buildCompanySetupCloudPayload,
} from './services/workspace/workspaceCloudService';
import { DOCUMENT_WORK_RESULT_SCHEMA_VERSION } from './types/documentWorkResult';
import type { DocumentWorkResult } from './types/documentWorkResult';
import type { DocumentFileRef } from './types/documentFileRef';
import type { CompanyDocument, InboxItem } from './types/models';
import { createMockInboxItemFromUpload } from './services/inboxUploadFactory';
import { isValidDocumentWorkResultEntry } from './services/documentWorkResultStoreService';

const WORKSPACE_ID = 'ws-identity-recovery';
const LOCAL_COMPANY = 'Beispiel Lokalbetrieb GmbH';
const CLOUD_COMPANY = 'Beispiel Cloud Test';
const IBAN = 'DE89370400440532013000';
const TAX_NUMBER = '123/456/78901';

const WORKSPACE_KEY = `officepilot-state:workspace:${WORKSPACE_ID}`;

let userId = '';

type RpcCall = {
  name: string;
  entity?: string;
  companyName?: string;
  rowVersion?: number;
  /** Vom Server zurückgegebene Version — auch wenn sie ungültig ist. */
  returnedRowVersion?: number;
  /** True nur bei fachlich gültiger, positiver Serverantwort. */
  succeeded?: boolean;
};

const rpcLog: RpcCall[] = [];
let cloudSetupVersion = 7;
let cloudProfileVersion = 9;
let cloudSetupCompanyName = CLOUD_COMPANY;
let cloudProfileCompanyName = CLOUD_COMPANY;
let failUpsertFor: string | null = null;
let failPersist = false;
/** Erzwingt eine ungültige row_version in der RPC-Antwort. */
let invalidRowVersionFor: string | null = null;
/** Ereignisprotokoll: RPCs und Workspace-Schreibvorgänge in echter Reihenfolge. */
const eventLog: string[] = [];
let onPullCalled: (() => void) | null = null;

function userKey(): string {
  return `officepilot-state:user:${userId}`;
}

function workspaceRow() {
  return {
    id: WORKSPACE_ID,
    name: LOCAL_COMPANY,
    owner_user_id: userId,
    created_at: '2026-01-05T08:00:00.000Z',
    updated_at: '2026-05-05T08:00:00.000Z',
    version: 3,
  };
}

function registerHandlers(): void {
  registerMockRpcHandler('ensure_personal_workspace', () => {
    rpcLog.push({ name: 'ensure_personal_workspace' });
    return {
      workspace: workspaceRow(),
      member: {
        workspace_id: WORKSPACE_ID,
        user_id: userId,
        role: 'owner',
        status: 'active',
        created_at: '2026-01-05T08:00:00.000Z',
        updated_at: '2026-01-05T08:00:00.000Z',
      },
      created: false,
    };
  });
  registerMockRpcHandler('pull_workspace_sync_state', () => {
    rpcLog.push({ name: 'pull_workspace_sync_state' });
    onPullCalled?.();
    return {
      workspace: workspaceRow(),
      members: [],
      settings: null,
      vorgaenge: [],
      setup: {
        workspace_id: WORKSPACE_ID,
        payload: {
          ...DEFAULT_SETUP,
          companyName: cloudSetupCompanyName,
          setupComplete: true,
          setupVersion: 1,
        },
        row_version: cloudSetupVersion,
        updated_at: '2026-05-05T08:00:00.000Z',
      },
      company_profile: {
        workspace_id: WORKSPACE_ID,
        payload: { ...DEFAULT_COMPANY_PROFILE, companyName: cloudProfileCompanyName },
        row_version: cloudProfileVersion,
        updated_at: '2026-05-05T08:00:00.000Z',
      },
    };
  });
  registerMockRpcHandler('pull_workspace_invoices', () => []);
  registerMockRpcHandler('pull_workspace_order_amendments', () => []);
  registerMockRpcHandler('upsert_workspace_sync_entity', (args) => {
    const entity = String(args.p_entity_type ?? '');
    const payload = (args.p_payload ?? {}) as { payload?: { companyName?: string } };
    const call: RpcCall = {
      name: 'upsert_workspace_sync_entity',
      entity,
      companyName: payload.payload?.companyName,
      rowVersion: Number(args.p_row_version ?? -1),
      succeeded: false,
    };
    rpcLog.push(call);
    if (failUpsertFor === entity) throw new Error('Failed to fetch');
    eventLog.push(`upsert:${entity}`);
    if (invalidRowVersionFor === entity) {
      // Der Versuch bleibt sichtbar, gilt aber nicht als fachlicher Erfolg.
      call.returnedRowVersion = 0;
      return { row_version: 0, payload: args.p_payload ?? {} };
    }
    call.succeeded = true;
    // Ein Setup-Erfolg verändert niemals den Cloud-Profilnamen und umgekehrt.
    if (entity === 'company_setup') {
      cloudSetupVersion += 1;
      cloudSetupCompanyName = payload.payload?.companyName ?? cloudSetupCompanyName;
    }
    if (entity === 'company_profile') {
      cloudProfileVersion += 1;
      cloudProfileCompanyName = payload.payload?.companyName ?? cloudProfileCompanyName;
    }
    const returned = entity === 'company_setup' ? cloudSetupVersion : cloudProfileVersion;
    call.returnedRowVersion = returned;
    return { row_version: returned, payload: args.p_payload ?? {} };
  });
}

/** Schemakonformer DocumentWorkResult — Bezugsschlüssel ist inboxItemId, kein id-Feld. */
function buildWorkResult(): DocumentWorkResult {
  return {
    schemaVersion: DOCUMENT_WORK_RESULT_SCHEMA_VERSION,
    inboxItemId: 'inbox-local-1',
    workspaceId: WORKSPACE_ID,
    analyzedAt: '2026-08-15T12:30:00.000Z',
    analysisVersion: 'test-analysis-1',
    sourceFingerprint: 'fingerprint-inbox-local-1',
    businessInterpretation: null,
    specialistRefs: {},
    overlay: [],
  };
}

/** Vollständiges CompanyDocument nach Typdefinition. */
function buildCompanyDocument(): CompanyDocument {
  return {
    id: 'doc-local-1',
    title: 'Beispielvertrag.pdf',
    category: 'vertrag',
    issuer: 'Beispiel Auftraggeber GmbH',
    recognizedText: 'Rahmenvertrag über Bauleistungen',
    issueDate: '2026-08-01',
    validUntil: null,
    digitalFolder: { path: 'Vertraege/2026' },
    paperFolder: { ordner: 'Vertraege', register: '2026' },
    tags: ['vertrag', 'beispiel'],
    linkedCompany: LOCAL_COMPANY,
    linkedVorgang: null,
    archived: false,
    createdAt: '2026-08-15T12:00:00.000Z',
  };
}

/** Vollständiger DocumentFileRef nach Typdefinition. */
function buildFileRef(
  id: string,
  originalFileName: string,
  mimeType: string,
): DocumentFileRef {
  return {
    id,
    originalFileName,
    mimeType,
    fileSize: 8,
    contentHash: `hash-${id}`,
    storageType: 'indexeddb',
    localDataKey: `local-${id}`,
    createdAt: '2026-08-15T12:00:00.000Z',
    lifecycleStatus: 'committed',
  };
}

/** Vollständiger Inbox-Eintrag über die bestehende Produktions-Factory. */
function buildInboxItem(): InboxItem {
  const base = createMockInboxItemFromUpload({
    sourceFileName: 'Beispielvertrag.pdf',
    recognizedText: 'Rahmenvertrag über Bauleistungen',
  });
  return {
    ...base,
    id: 'inbox-local-1',
    title: 'Beispielvertrag',
    status: 'offen',
    priority: 'mittel',
    recognizedData: {
      ...base.recognizedData,
      documentType: 'Werkvertrag',
      auftraggeber: 'Beispiel Auftraggeber GmbH',
      auftragnehmer: LOCAL_COMPANY,
      netto: '1234.56',
    },
    digitalFolder: { ...base.digitalFolder, path: 'Vertraege/2026' },
  };
}

/** Vollständiger lokaler Workspace-Bestand mit eigener Firma. */
function workspaceStateRaw(): string {
  return JSON.stringify({
    version: STORAGE_VERSION,
    setup: {
      ...DEFAULT_SETUP,
      companyName: LOCAL_COMPANY,
      setupComplete: true,
      setupVersion: 1,
      language: 'de',
    },
    companyProfile: {
      ...DEFAULT_COMPANY_PROFILE,
      companyName: LOCAL_COMPANY,
      street: 'Musterweg 5',
      iban: IBAN,
      taxNumber: TAX_NUMBER,
    },
    syncClient: {
      deviceId: 'device-local',
      workspaceId: WORKSPACE_ID,
      serverWorkspaceId: WORKSPACE_ID,
      cloudProvisionedAt: '2026-08-01T08:00:00.000Z',
      syncPolicy: 'cloud_ready',
    },
    workspace: {
      id: WORKSPACE_ID,
      name: LOCAL_COMPANY,
      ownerUserId: userId,
      createdAt: '2026-01-05T08:00:00.000Z',
      updatedAt: '2026-08-15T13:11:18.373Z',
      version: 3,
    },
    setupSync: { version: 2, updatedAt: '2026-08-15T13:00:00.000Z', deleted: false, deviceId: 'device-local', workspaceId: WORKSPACE_ID },
    companyProfileSync: { version: 2, updatedAt: '2026-08-15T13:00:00.000Z', deleted: false, deviceId: 'device-local', workspaceId: WORKSPACE_ID },
    inboxItems: [buildInboxItem()],
    vorgaenge: [],
    tasks: [],
    documents: [buildCompanyDocument()],
    documentWorkResults: [buildWorkResult()],
    expenses: [],
    documentFileRefs: [
      buildFileRef('ref-1', 'Beispielvertrag.pdf', 'application/pdf'),
      buildFileRef('ref-2', 'Seite1.png', 'image/png'),
    ],
    documentFileBlobs: {},
    syncOutbox: [
      { id: 'ob-1', entityType: 'company_setup', entityId: WORKSPACE_ID, operation: 'update', version: 2, status: 'pending', retryCount: 0, queuedAt: '2026-08-15T13:00:00.000Z' },
      { id: 'ob-2', entityType: 'company_profile', entityId: WORKSPACE_ID, operation: 'update', version: 2, status: 'pending', retryCount: 0, queuedAt: '2026-08-15T13:00:00.000Z' },
      { id: 'ob-3', entityType: 'inbox_item', entityId: 'inbox-local-1', operation: 'create', version: 1, status: 'pending', retryCount: 0, queuedAt: '2026-08-15T13:00:00.000Z' },
    ],
    savedAt: '2026-08-15T13:11:18.373Z',
  });
}

/** Alter User-Scope mit der Cloud-Firma und einem offenen Profilauftrag. */
function userStateRaw(): string {
  return JSON.stringify({
    version: STORAGE_VERSION,
    setup: { ...DEFAULT_SETUP, companyName: CLOUD_COMPANY, setupComplete: true, setupVersion: 1 },
    companyProfile: { ...DEFAULT_COMPANY_PROFILE, companyName: CLOUD_COMPANY },
    syncClient: {
      deviceId: 'device-user',
      workspaceId: WORKSPACE_ID,
      serverWorkspaceId: WORKSPACE_ID,
      cloudProvisionedAt: '2026-08-01T08:00:00.000Z',
      syncPolicy: 'cloud_ready',
    },
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    expenses: [],
    syncOutbox: [
      { id: 'ob-user-1', entityType: 'company_profile', entityId: WORKSPACE_ID, operation: 'update', version: 41, status: 'pending', retryCount: 0, queuedAt: '2026-08-14T10:00:00.000Z' },
    ],
    savedAt: '2026-08-14T10:00:00.000Z',
  });
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function storageKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key) keys.push(key);
  }
  return keys;
}

function snapshotStorage(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key) entries[key] = localStorage.getItem(key) ?? '';
  }
  return entries;
}

async function settle(times = 40): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountApp(): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <BusinessStateGate>
            <App />
          </BusinessStateGate>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
  return host;
}

async function unmountApp(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  host = null;
  root = null;
}

async function click(container: HTMLElement, testId: string): Promise<void> {
  const element = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
  expect(element, `Schaltfläche ${testId} fehlt`).not.toBeNull();
  await act(async () => {
    element!.click();
  });
  await settle();
}

/** Setzt die eigene Bestätigungscheckbox. */
async function tickAcknowledge(container: HTMLElement): Promise<void> {
  const box = container.querySelector(
    '[data-testid="workspace-company-conflict-ack"]',
  ) as HTMLInputElement | null;
  expect(box, 'Bestätigungscheckbox fehlt').not.toBeNull();
  await act(async () => {
    box!.click();
  });
  await settle();
}

/** Vollständige, ausdrückliche Abschlussbestätigung: Checkbox + Endknopf. */
async function confirmFinal(container: HTMLElement): Promise<void> {
  const box = container.querySelector(
    '[data-testid="workspace-company-conflict-ack"]',
  ) as HTMLInputElement | null;
  if (box && !box.checked) {
    await act(async () => {
      box.click();
    });
    await settle();
  }
  await click(container, 'workspace-company-conflict-confirm');
}

const countOf = (name: string): number => rpcLog.filter((entry) => entry.name === name).length;
const upsertsFor = (entity: string): RpcCall[] =>
  rpcLog.filter((entry) => entry.name === 'upsert_workspace_sync_entity' && entry.entity === entity);
const successfulUpserts = (entity: string): RpcCall[] =>
  upsertsFor(entity).filter((entry) => entry.succeeded === true);


// --- K1-Hilfen: IndexedDB-Wächter, Blob-Seeding und Persistenzfehler ---------
const BLOB_DB_NAME = 'officepilot-document-blobs';
const BLOB_STORE_NAME = 'document_blobs';
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const idbWriteCalls: string[] = [];
let restoreIdbGuards: (() => void) | null = null;

function openBlobDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BLOB_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BLOB_STORE_NAME)) {
        db.createObjectStore(BLOB_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function seedBlob(fileRefId: string, bytes: Uint8Array, mimeType: string): Promise<void> {
  const db = await openBlobDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE_NAME, 'readwrite');
    tx.objectStore(BLOB_STORE_NAME).put({
      id: `workspace:${WORKSPACE_ID}::${fileRefId}`,
      scopeKey: `workspace:${WORKSPACE_ID}`,
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

async function readSeededBlob(fileRefId: string): Promise<Uint8Array | null> {
  const db = await openBlobDb();
  const record = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE_NAME, 'readonly');
    const request = tx.objectStore(BLOB_STORE_NAME).get(`workspace:${WORKSPACE_ID}::${fileRefId}`);
    request.onsuccess = () => resolve(request.result as Record<string, unknown> | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  const data = record?.blobData;
  return data instanceof ArrayBuffer ? new Uint8Array(data) : null;
}

/** Ab jetzt gilt jeder Schreibzugriff auf den Blob-Store als Verstoß. */
function installIndexedDbGuards(): void {
  const originalPut = IDBObjectStore.prototype.put;
  const originalAdd = IDBObjectStore.prototype.add;
  const originalDelete = IDBObjectStore.prototype.delete;
  const originalClear = IDBObjectStore.prototype.clear;
  IDBObjectStore.prototype.put = function guarded(this: IDBObjectStore, ...args: unknown[]) {
    if (this.name === BLOB_STORE_NAME) idbWriteCalls.push('put');
    return (originalPut as (...a: unknown[]) => IDBRequest).apply(this, args);
  } as IDBObjectStore['put'];
  IDBObjectStore.prototype.add = function guarded(this: IDBObjectStore, ...args: unknown[]) {
    if (this.name === BLOB_STORE_NAME) idbWriteCalls.push('add');
    return (originalAdd as (...a: unknown[]) => IDBRequest).apply(this, args);
  } as IDBObjectStore['add'];
  IDBObjectStore.prototype.delete = function guarded(this: IDBObjectStore, ...args: unknown[]) {
    if (this.name === BLOB_STORE_NAME) idbWriteCalls.push('delete');
    return (originalDelete as (...a: unknown[]) => IDBRequest).apply(this, args);
  } as IDBObjectStore['delete'];
  IDBObjectStore.prototype.clear = function guarded(this: IDBObjectStore) {
    if (this.name === BLOB_STORE_NAME) idbWriteCalls.push('clear');
    return originalClear.call(this);
  } as IDBObjectStore['clear'];
  restoreIdbGuards = () => {
    IDBObjectStore.prototype.put = originalPut;
    IDBObjectStore.prototype.add = originalAdd;
    IDBObjectStore.prototype.delete = originalDelete;
    IDBObjectStore.prototype.clear = originalClear;
    restoreIdbGuards = null;
  };
}

/** Fachliche Bestände des Workspace-Zustands, ohne Sync-Felder. */
function readWorkspaceParts(): Record<string, unknown> {
  const raw = localStorage.getItem(WORKSPACE_KEY);
  if (!raw) return {};
  const state = JSON.parse(raw) as Record<string, unknown>;
  return {
    inboxItems: state.inboxItems,
    documentFileRefs: state.documentFileRefs,
    documentWorkResults: state.documentWorkResults,
    documents: state.documents,
    documentFileBlobs: state.documentFileBlobs,
  };
}

/** Persistenzfehler gezielt für den Workspace-Schlüssel erzwingen. */
function installStorageFailureHook(): () => void {
  const realStorage = globalThis.localStorage;
  const patched = {
    getItem: (key: string) => realStorage.getItem(key),
    setItem: (key: string, value: string) => {
      if (key === WORKSPACE_KEY) {
        if (failPersist) {
          eventLog.push('persist-failed');
          throw new Error('QuotaExceeded');
        }
        eventLog.push('persist-ok');
      }
      realStorage.setItem(key, value);
    },
    removeItem: (key: string) => realStorage.removeItem(key),
    clear: () => realStorage.clear(),
    key: (index: number) => realStorage.key(index),
    get length() {
      return realStorage.length;
    },
  } as unknown as Storage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => patched });
  return () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => realStorage,
    });
  };
}

let restoreStorageHook: (() => void) | null = null;

describe('OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02B', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    rpcLog.length = 0;
    cloudSetupVersion = 7;
    cloudProfileVersion = 9;
    cloudSetupCompanyName = CLOUD_COMPANY;
    cloudProfileCompanyName = CLOUD_COMPANY;
    failUpsertFor = null;
    failPersist = false;
    invalidRowVersionFor = null;
    eventLog.length = 0;
    onPullCalled = null;
    clearMockRpcHandlers();
    registerHandlers();
    resetWorkspaceCloudBootstrapForTests();
    resetSyncCoordinatorForTests();
    await loginAsDefaultAdmin();
    userId = getMockCurrentSession()?.user.id ?? '';
    expect(userId).not.toBe('');
    localStorage.clear();
    localStorage.setItem(WORKSPACE_KEY, workspaceStateRaw());
    localStorage.setItem(userKey(), userStateRaw());
    idbWriteCalls.length = 0;
    restoreStorageHook = installStorageFailureHook();
  });

  afterEach(async () => {
    restoreStorageHook?.();
    restoreStorageHook = null;
    restoreIdbGuards?.();
    await unmountApp();
    clearMockRpcHandlers();
    resetTestStores();
    resetWorkspaceCloudBootstrapForTests();
    localStorage.clear();
  });

  it('C1: abweichende Firmendaten führen zur Konfliktansicht ohne jeden Upsert', async () => {
    const workspaceBefore = localStorage.getItem(WORKSPACE_KEY);
    const userBefore = localStorage.getItem(userKey());

    const container = await mountApp();

    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();
    expect(container.querySelector('[data-testid="first-run-wizard"]')).toBeNull();

    // Genau ein ensure, mindestens ein Pull, kein einziger Upsert.
    expect(countOf('ensure_personal_workspace')).toBeLessThanOrEqual(1);
    expect(countOf('pull_workspace_sync_state')).toBeGreaterThan(0);
    expect(countOf('upsert_workspace_sync_entity')).toBe(0);

    // Beide Firmennamen sichtbar, keine vertraulichen Felder.
    const text = container.textContent ?? '';
    expect(text).toContain(LOCAL_COMPANY);
    expect(text).toContain(CLOUD_COMPANY);
    expect(text).not.toContain(IBAN);
    expect(text).not.toContain(TAX_NUMBER);
    expect(text).not.toContain('Musterweg 5');

    // Die lokale Workspace-Kopie bleibt bytegenau unverändert.
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe(workspaceBefore);
    // Die User-Kopie wird vom regulären Bootstrap neu serialisiert, behält aber
    // Firma und offenen Auftrag — nichts geht verloren, nichts wird gesendet.
    expect(userBefore).toContain(CLOUD_COMPANY);
    const userAfter = localStorage.getItem(userKey()) ?? '';
    expect(userAfter).toContain(CLOUD_COMPANY);
    expect(userAfter).toContain('ob-user-1');
    expect(
      storageKeys().filter((key) => key.startsWith('officepilot-state:workspace:')),
    ).toEqual([WORKSPACE_KEY]);
  });

  /*
   * WORKSPACE-COMPANY-CONFLICT-SAFE-EXIT-01 — Abbrechen ließ den Nutzer bisher
   * auf der Sperrfläche stehen; der einzige sichtbare Ausweg war der
   * cloud-überschreibende Knopf. Die beiden Sicherheitsinvarianten (kein
   * Upsert, gespeicherter Bestand unangetastet) bleiben unverändert; die zwei
   * Assertions, die das Steckenbleiben festschrieben, werden ersetzt.
   */
  it('C2: Abbrechen meldet ab, ohne gespeicherte Daten oder die Cloud zu verändern', async () => {
    const container = await mountApp();
    const workspaceBefore = localStorage.getItem(WORKSPACE_KEY);
    const workspaceScopeKeysBefore = storageKeys().filter((key) =>
      key.startsWith('officepilot-state:workspace:'),
    );

    await click(container, 'workspace-company-conflict-cancel');

    // Sicherheitsinvariante: kein einziger Cloud-Schreibvorgang.
    expect(countOf('upsert_workspace_sync_entity')).toBe(0);

    // Sicherheitsinvariante: der gespeicherte Workspace-Bestand bleibt vollständig.
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe(workspaceBefore);
    // Keine zusätzliche Workspace-Scope-Kopie.
    expect(
      storageKeys().filter((key) => key.startsWith('officepilot-state:workspace:')),
    ).toEqual(workspaceScopeKeysBefore);

    // Neu: die Sperre ist verlassen und der abgemeldete Zustand erreichbar.
    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();
  });

  it('C2a: nach dem Abbrechen erscheint derselbe Konflikt bei erneuter Anmeldung', async () => {
    const container = await mountApp();
    const workspaceBefore = localStorage.getItem(WORKSPACE_KEY);

    await click(container, 'workspace-company-conflict-cancel');
    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).toBeNull();
    await unmountApp();

    // Derselbe unveränderte lokale Bestand trifft auf denselben Cloud-Stand.
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe(workspaceBefore);
    resetWorkspaceCloudBootstrapForTests();
    await loginAsDefaultAdmin();

    const again = await mountApp();
    expect(
      again.querySelector('[data-testid="workspace-company-conflict"]'),
      'Konflikt wurde durch Abbrechen vorgetäuscht gelöst',
    ).not.toBeNull();
    expect(again.querySelector('[data-testid="workspace-company-conflict-cloud"]')?.textContent).toBe(
      CLOUD_COMPANY,
    );
    // Auch der zweite Durchlauf schreibt nichts.
    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
  });

  it('C2b: die Sperrfläche nennt den Rettungsweg, ohne etwas zu senden', async () => {
    const container = await mountApp();

    const hint = container.querySelector(
      '[data-testid="workspace-company-conflict-local-recovery"]',
    );
    expect(hint, 'Hinweis auf den Rettungsweg fehlt').not.toBeNull();
    const link = container.querySelector(
      '[data-testid="workspace-company-conflict-local-recovery-link"]',
    ) as HTMLAnchorElement | null;
    expect(link?.getAttribute('href')).toBe('/local-recovery');

    // Fachlich korrekt: sichern, nicht auflösen.
    expect(hint?.textContent).toContain('/local-recovery');
    expect(hint?.textContent?.toLowerCase()).not.toContain('wiederherstell');

    // Die Route bleibt trotz Sperre erreichbar — geprüft an der Erkennung selbst.
    expect(isLocalRecoveryPath('/local-recovery')).toBe(true);

    // Reines Anzeigen sendet nichts.
    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
  });

  it('C2c: ein ungelöster Konflikt gibt den Merge-/Sync-Pfad nicht frei', async () => {
    const container = await mountApp();

    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).not.toBeNull();
    // Kein Fachbestand wird abgeglichen oder gesendet, solange der Konflikt steht.
    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
    expect(upsertsFor('vorgang')).toEqual([]);
    expect(upsertsFor('inbox_item')).toEqual([]);
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();

    // Auch das Abbrechen gibt ihn nicht frei.
    await click(container, 'workspace-company-conflict-cancel');
    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
    expect(upsertsFor('vorgang')).toEqual([]);
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();
  });

  it('C3: erst der zweite Klick überträgt genau je einen Upsert mit aktueller Serverversion', async () => {
    const container = await mountApp();

    await click(container, 'workspace-company-conflict-use-local');
    expect(countOf('upsert_workspace_sync_entity'), 'erster Klick hat gesendet').toBe(0);
    expect(
      container.querySelector('[data-testid="workspace-company-conflict-confirm"]'),
      'zweite Bestätigung fehlt',
    ).not.toBeNull();

    const pullsBefore = countOf('pull_workspace_sync_state');
    await confirmFinal(container);

    // Vor dem Push wurde erneut nur lesend geprüft.
    expect(countOf('pull_workspace_sync_state')).toBeGreaterThan(pullsBefore);
    expect(successfulUpserts('company_setup').length).toBe(1);
    expect(successfulUpserts('company_profile').length).toBe(1);
    expect(upsertsFor('company_setup')[0]?.companyName).toBe(LOCAL_COMPANY);
    expect(upsertsFor('company_profile')[0]?.companyName).toBe(LOCAL_COMPANY);
    expect(upsertsFor('company_setup')[0]?.rowVersion).toBe(7);
    expect(upsertsFor('company_profile')[0]?.rowVersion).toBe(9);
    expect(upsertsFor('inbox_item')).toEqual([]);
    expect(countOf('ensure_personal_workspace')).toBeLessThanOrEqual(1);

    // Danach ist die App frei und zeigt den lokalen Betrieb.
    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    expect(container.textContent).toContain(LOCAL_COMPANY);
    expect(
      storageKeys().filter((key) => key.startsWith('officepilot-state:workspace:')),
    ).toEqual([WORKSPACE_KEY]);
  });

  it('C4: ändert sich die Cloud zwischen Anzeige und Bestätigung, wird nicht gesendet', async () => {
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');

    // Fremder Schreibzugriff zwischen Anzeige und Bestätigung.
    cloudSetupVersion = 42;
    cloudProfileVersion = 43;

    await confirmFinal(container);

    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="workspace-company-conflict-changed"]'),
      'Hinweis auf geänderten Stand fehlt',
    ).not.toBeNull();
  });

  it('C5: Teilfehler — erfolgreiches setup wird beim Retry nicht erneut gesendet', async () => {
    failUpsertFor = 'company_profile';
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');
    await confirmFinal(container);

    expect(successfulUpserts('company_setup').length).toBe(1);
    expect(successfulUpserts('company_profile').length).toBe(0);
    expect(container.textContent).toContain(LOCAL_COMPANY);

    // Retry nach behobenem Fehler: nur noch das Profil.
    failUpsertFor = null;
    await confirmFinal(container);

    expect(successfulUpserts('company_setup').length, 'setup doppelt gesendet').toBe(1);
    expect(successfulUpserts('company_profile').length).toBe(1);
    expect(countOf('ensure_personal_workspace')).toBeLessThanOrEqual(1);
  });

  it('C6: nach Erfolg zeigt ein Neustart keinen Konflikt und sendet keine Firmendaten', async () => {
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');
    await confirmFinal(container);
    await unmountApp();

    rpcLog.length = 0;
    resetWorkspaceCloudBootstrapForTests();
    resetSyncCoordinatorForTests();
    const second = await mountApp();

    expect(second.querySelector('[data-testid="workspace-company-conflict"]')).toBeNull();
    expect(second.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    expect(second.textContent).toContain(LOCAL_COMPANY);
    expect(upsertsFor('company_setup')).toEqual([]);
    expect(upsertsFor('company_profile')).toEqual([]);
    // Der alte User-Scope wird nicht gepusht.
    expect(rpcLog.filter((entry) => entry.companyName === CLOUD_COMPANY)).toEqual([]);
  });

  it('C7: gleiche Firma lokal und in der Cloud startet ohne Konflikt', async () => {
    cloudSetupCompanyName = LOCAL_COMPANY;
    cloudProfileCompanyName = LOCAL_COMPANY;

    const container = await mountApp();

    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    expect(container.textContent).toContain(LOCAL_COMPANY);
  });

  it('C8: ohne Workspace-Kopie bleibt der bisherige sichere Weg bestehen', async () => {
    localStorage.removeItem(WORKSPACE_KEY);
    cloudSetupCompanyName = CLOUD_COMPANY;
    cloudProfileCompanyName = CLOUD_COMPANY;

    const container = await mountApp();

    // Kein Konflikt: es gibt keinen echten lokalen Workspace-Bestand.
    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    expect(container.textContent).toContain(CLOUD_COMPANY);
  });

  it('K1: eine lokale Änderung nach dem ersten Klick verhindert jeden Upsert', async () => {
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');

    // Nur ein Profilfeld und savedAt ändern sich.
    const raw = JSON.parse(localStorage.getItem(WORKSPACE_KEY)!) as Record<string, unknown>;
    const profile = raw.companyProfile as Record<string, unknown>;
    raw.companyProfile = { ...profile, phone: '030 111111' };
    raw.savedAt = '2026-08-16T09:00:00.000Z';
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(raw));

    await confirmFinal(container);

    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).not.toBeNull();
    // Zweistufige Bestätigung beginnt von vorne.
    expect(
      container.querySelector('[data-testid="workspace-company-conflict-use-local"]'),
      'zweistufige Bestätigung nicht zurückgesetzt',
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="workspace-company-conflict-confirm"]')).toBeNull();
  });

  it('K2: row_version 0 führt zu null Upserts und sichtbarem Fehler', async () => {
    cloudSetupVersion = 0;
    cloudProfileVersion = 0;

    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');
    await confirmFinal(container);

    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
    expect(
      rpcLog.some((entry) => entry.rowVersion === 0),
      'p_row_version 0 gesendet',
    ).toBe(false);
    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workspace-company-conflict-error"]')).not.toBeNull();
  });

  it('K3: der alte User-Eintrag bleibt pending und wird nie gesendet', async () => {
    const container = await mountApp();
    const userAfterConflict = localStorage.getItem(userKey());
    expect(userAfterConflict).toContain('ob-user-1');

    await click(container, 'workspace-company-conflict-use-local');
    await confirmFinal(container);

    expect(localStorage.getItem(userKey()), 'User-Scope wurde verändert').toBe(userAfterConflict);
    expect(rpcLog.filter((entry) => entry.companyName === CLOUD_COMPANY)).toEqual([]);
    expect(successfulUpserts('company_setup').length).toBe(1);
    expect(successfulUpserts('company_profile').length).toBe(1);
  });

  it('K4: Profil erfolgreich, Setup fehlgeschlagen — Retry sendet nur das Setup', async () => {
    failUpsertFor = 'company_setup';
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');
    await confirmFinal(container);

    expect(successfulUpserts('company_profile').length).toBe(1);
    expect(successfulUpserts('company_setup').length).toBe(0);
    // Der Cloud-Profilname änderte sich, der Setup-Name nicht.
    expect(cloudProfileCompanyName).toBe(LOCAL_COMPANY);
    expect(cloudSetupCompanyName).toBe(CLOUD_COMPANY);

    failUpsertFor = null;
    await confirmFinal(container);

    expect(successfulUpserts('company_profile').length, 'Profil doppelt gesendet').toBe(1);
    expect(successfulUpserts('company_setup').length).toBe(1);
  });

  it('K5: fehlender Workspace-Eigentümer blockiert jeden Push', async () => {
    const raw = JSON.parse(localStorage.getItem(WORKSPACE_KEY)!) as Record<string, unknown>;
    delete raw.workspace;
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(raw));
    // Gleiche Firma: ohne Eigentümer darf trotzdem nichts laufen.
    cloudSetupCompanyName = LOCAL_COMPANY;
    cloudProfileCompanyName = LOCAL_COMPANY;
    registerMockRpcHandler('ensure_personal_workspace', () => {
      rpcLog.push({ name: 'ensure_personal_workspace' });
      return {
        workspace: { ...workspaceRow(), owner_user_id: null },
        member: {
          workspace_id: WORKSPACE_ID,
          user_id: userId,
          role: 'owner',
          status: 'active',
          created_at: '2026-01-05T08:00:00.000Z',
          updated_at: '2026-01-05T08:00:00.000Z',
        },
        created: false,
      };
    });

    const container = await mountApp();

    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
    // Gesperrt: keine normale App, kein Cloud-Test als Firma.
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="workspace-restore-failure"]') ??
        container.querySelector('[data-testid="workspace-company-conflict"]'),
      'weder Konflikt- noch Fehleransicht',
    ).not.toBeNull();
    expect(container.textContent).not.toContain(CLOUD_COMPANY);
    expect(JSON.parse(localStorage.getItem(WORKSPACE_KEY)!).setup.companyName).toBe(LOCAL_COMPANY);
  });

  it('K6: Dokumentdaten und IndexedDB bleiben unverändert', async () => {
    // Die Fixture muss fachlich gültig sein, sonst prüft der Test nichts.
    expect(isValidDocumentWorkResultEntry(buildWorkResult())).toBe(true);
    await seedBlob('ref-1', PDF_BYTES, 'application/pdf');
    await seedBlob('ref-2', PNG_BYTES, 'image/png');
    installIndexedDbGuards();

    const container = await mountApp();
    const before = readWorkspaceParts();

    await click(container, 'workspace-company-conflict-use-local');
    await confirmFinal(container);

    const after = readWorkspaceParts();
    /**
     * Vollständiger Vergleich: jedes fachliche Feld, das vorher vorhanden war,
     * muss danach unverändert vorhanden sein — Anzahl und Reihenfolge inklusive.
     */
    /**
     * Rekursiver Erhaltungsvergleich: jeder vorher vorhandene Pfad existiert
     * nachher mit identischem Wert. Zusätzliche Felder sind erlaubt, Arrays
     * müssen Länge und Reihenfolge behalten.
     */
    const containsDeep = (previous: unknown, current: unknown, path = ''): string | null => {
      if (Array.isArray(previous)) {
        if (!Array.isArray(current)) return `${path}: kein Array mehr`;
        if (current.length !== previous.length) return `${path}: Länge ${previous.length} → ${current.length}`;
        for (let index = 0; index < previous.length; index += 1) {
          const inner = containsDeep(previous[index], current[index], `${path}[${index}]`);
          if (inner) return inner;
        }
        return null;
      }
      if (previous && typeof previous === 'object') {
        if (!current || typeof current !== 'object') return `${path}: Objekt entfernt`;
        for (const key of Object.keys(previous as Record<string, unknown>)) {
          const inner = containsDeep(
            (previous as Record<string, unknown>)[key],
            (current as Record<string, unknown>)[key],
            path ? `${path}.${key}` : key,
          );
          if (inner) return inner;
        }
        return null;
      }
      return JSON.stringify(previous) === JSON.stringify(current)
        ? null
        : `${path}: ${JSON.stringify(previous)} → ${JSON.stringify(current)}`;
    };
    const containsAllFields = (previous: unknown, current: unknown): string | null =>
      containsDeep(previous, current);

    expect(containsAllFields(before.inboxItems, after.inboxItems), 'inboxItems').toBeNull();
    expect(containsAllFields(before.documentFileRefs, after.documentFileRefs), 'documentFileRefs').toBeNull();
    expect(
      containsAllFields(before.documentWorkResults, after.documentWorkResults),
      'documentWorkResults',
    ).toBeNull();
    expect(containsAllFields(before.documents, after.documents), 'documents').toBeNull();
    expect(after.documentFileBlobs ?? {}).toEqual(before.documentFileBlobs ?? {});
    expect(idbWriteCalls, 'IndexedDB-Schreibzugriff').toEqual([]);

    const pdf = await readSeededBlob('ref-1');
    const png = await readSeededBlob('ref-2');
    expect(Array.from(pdf ?? [])).toEqual(Array.from(PDF_BYTES));
    expect(Array.from(png ?? [])).toEqual(Array.from(PNG_BYTES));
  });

  it('K7: geänderter Cloud-Stand verlangt erneut zwei Schritte', async () => {
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');
    cloudSetupVersion = 55;

    await confirmFinal(container);
    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
    expect(container.querySelector('[data-testid="workspace-company-conflict-changed"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workspace-company-conflict-confirm"]')).toBeNull();

    // Ein einzelner weiterer Klick darf nicht senden.
    await click(container, 'workspace-company-conflict-use-local');
    expect(countOf('upsert_workspace_sync_entity')).toBe(0);

    await confirmFinal(container);
    expect(successfulUpserts('company_setup').length).toBe(1);
    expect(upsertsFor('company_setup')[0]?.rowVersion).toBe(55);
  });

  it('K8: scheitert die lokale Verbuchung, bleibt die Ansicht stehen und sendet nichts weiter', async () => {
    failPersist = true;
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');
    await confirmFinal(container);

    // Höchstens eine Entität wurde gesendet, die zweite nicht mehr.
    expect(successfulUpserts('company_setup').length).toBe(1);
    expect(successfulUpserts('company_profile').length).toBe(0);
    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();

    failPersist = false;
    await confirmFinal(container);

    expect(successfulUpserts('company_setup').length, 'Setup doppelt gesendet').toBe(1);
    expect(successfulUpserts('company_profile').length).toBe(1);
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
  });

  it('K9: leere Cloud-Firmendaten erzeugen keinen Konflikt', async () => {
    cloudSetupCompanyName = '';
    cloudProfileCompanyName = '';

    const container = await mountApp();

    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).toBeNull();
    // Der leere Cloud-Stand überschreibt den echten lokalen Bestand nicht.
    const stored = JSON.parse(localStorage.getItem(WORKSPACE_KEY)!) as {
      setup: { companyName: string; setupComplete: boolean };
      companyProfile: { companyName: string };
    };
    expect(stored.setup.companyName).toBe(LOCAL_COMPANY);
    expect(stored.setup.setupComplete).toBe(true);
    expect(stored.companyProfile.companyName).toBe(LOCAL_COMPANY);
    expect(container.textContent).toContain(LOCAL_COMPANY);
    expect(
      storageKeys().filter((key) => key.startsWith('officepilot-state:workspace:')),
    ).toEqual([WORKSPACE_KEY]);
    // Kein Payload des alten User-Scopes.
    expect(rpcLog.filter((entry) => entry.companyName === CLOUD_COMPANY)).toEqual([]);
    // Eindeutig: genau ein Upsert je Firmenentität, lokaler Name, positive Version.
    for (const entity of ['company_setup', 'company_profile']) {
      const sent = successfulUpserts(entity);
      expect(sent.length, `${entity} nicht genau einmal`).toBe(1);
      expect(sent[0]?.companyName).toBe(LOCAL_COMPANY);
      expect(sent[0]?.rowVersion).toBeGreaterThan(0);
    }
  });

  it('K10: ein Netzwerkfehler beim Pull überschreibt nichts', async () => {
    const workspaceBefore = localStorage.getItem(WORKSPACE_KEY);
    registerMockRpcHandler('pull_workspace_sync_state', () => {
      rpcLog.push({ name: 'pull_workspace_sync_state' });
      throw new Error('Failed to fetch');
    });

    const container = await mountApp();

    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe(workspaceBefore);
    // Gesperrt statt normaler App: es gibt einen konkurrierenden echten Bestand.
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="workspace-restore-failure"]'),
      'Fehleransicht fehlt',
    ).not.toBeNull();
    expect(container.textContent).not.toContain(CLOUD_COMPANY);
  });


  it('K11: erst verbuchen, dann die nächste Entität senden', async () => {
    failPersist = true;
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');
    await confirmFinal(container);

    expect(successfulUpserts('company_setup').length).toBe(1);
    expect(successfulUpserts('company_profile').length, 'Profil trotz Persistenzfehler').toBe(0);

    // Zweiter Versuch bei weiterhin kaputter Persistenz: weiterhin kein Profil.
    await confirmFinal(container);
    expect(successfulUpserts('company_setup').length).toBe(1);
    expect(successfulUpserts('company_profile').length).toBe(0);

    failPersist = false;
    await confirmFinal(container);

    expect(successfulUpserts('company_setup').length, 'Setup erneut gesendet').toBe(1);
    expect(successfulUpserts('company_profile').length).toBe(1);

    // Reihenfolge: die Verbuchung steht vor dem Profil-Upsert.
    const persistIndex = eventLog.indexOf('persist-ok');
    const profileIndex = eventLog.indexOf('upsert:company_profile');
    expect(persistIndex, 'keine erfolgreiche Verbuchung protokolliert').toBeGreaterThan(-1);
    expect(profileIndex).toBeGreaterThan(persistIndex);
  });

  it('K12: lokale Änderung nach Teilerfolg startet einen neuen Vergleich', async () => {
    failUpsertFor = 'company_profile';
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');
    await confirmFinal(container);
    expect(successfulUpserts('company_setup').length).toBe(1);

    // Lokale Änderung nach dem Teilerfolg.
    failUpsertFor = null;
    const raw = JSON.parse(localStorage.getItem(WORKSPACE_KEY)!) as Record<string, unknown>;
    raw.companyProfile = { ...(raw.companyProfile as object), phone: '030 222222' };
    raw.savedAt = '2026-08-16T10:00:00.000Z';
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(raw));

    const upsertsBefore = countOf('upsert_workspace_sync_entity');
    await confirmFinal(container);

    expect(countOf('upsert_workspace_sync_entity'), 'trotz Änderung gesendet').toBe(upsertsBefore);
    // Zweistufige Bestätigung beginnt von vorne, echter Cloud-Name wird gezeigt.
    expect(container.querySelector('[data-testid="workspace-company-conflict-confirm"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="workspace-company-conflict-cloud"]')?.textContent,
    ).toBe(LOCAL_COMPANY);

    await click(container, 'workspace-company-conflict-use-local');
    await confirmFinal(container);

    expect(successfulUpserts('company_profile').length).toBe(1);
    for (const call of upsertsFor('company_profile')) {
      expect(call.rowVersion).toBeGreaterThan(0);
    }
  });

  it('K13: eine ungültige Serverantwort gilt nicht als Erfolg', async () => {
    invalidRowVersionFor = 'company_setup';
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');
    await confirmFinal(container);

    // Setup wurde versucht, gilt aber nicht als verbucht; Profil folgt nicht.
    expect(upsertsFor('company_setup').length).toBe(1);
    expect(upsertsFor('company_profile').length).toBe(0);
    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();

    const stored = JSON.parse(localStorage.getItem(WORKSPACE_KEY)!) as {
      syncOutbox: { entityType: string; status: string }[];
    };
    expect(
      stored.syncOutbox.filter((entry) => entry.entityType === 'company_setup')[0]?.status,
    ).toBe('pending');
  });


  it('A1: geändertes lokales Setup nach Teilerfolg wird nicht übersprungen', async () => {
    failUpsertFor = 'company_profile';
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');
    await confirmFinal(container);
    expect(successfulUpserts('company_setup').length).toBe(1);

    // Ausdrückliche Änderung des lokalen Setups nach dem Teilerfolg.
    failUpsertFor = null;
    const changedName = 'Beispiel Lokalbetrieb GmbH & Co KG';
    const raw = JSON.parse(localStorage.getItem(WORKSPACE_KEY)!) as Record<string, unknown>;
    raw.setup = { ...(raw.setup as object), companyName: changedName };
    raw.savedAt = '2026-08-16T11:00:00.000Z';
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(raw));

    const before = countOf('upsert_workspace_sync_entity');
    await confirmFinal(container);

    expect(countOf('upsert_workspace_sync_entity'), 'trotz Änderung gesendet').toBe(before);
    expect(container.querySelector('[data-testid="workspace-company-conflict-confirm"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="workspace-company-conflict-local"]')?.textContent,
    ).toBe(changedName);

    await click(container, 'workspace-company-conflict-use-local');
    await confirmFinal(container);

    // Das geänderte Setup muss erneut gesendet werden — der alte Fortschritt gilt nicht.
    const setupCalls = successfulUpserts('company_setup');
    expect(setupCalls.length, 'geändertes Setup übersprungen').toBe(2);
    expect(setupCalls[1]?.companyName).toBe(changedName);
    expect(setupCalls[1]?.rowVersion).toBeGreaterThan(0);
    expect(successfulUpserts('company_profile').length).toBe(1);
  });

  it('A2: ein Fehler bereits beim Provisioning sperrt die App', async () => {
    const workspaceBefore = localStorage.getItem(WORKSPACE_KEY);
    registerMockRpcHandler('ensure_personal_workspace', () => {
      rpcLog.push({ name: 'ensure_personal_workspace' });
      throw new Error('Failed to fetch');
    });

    const container = await mountApp();

    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="workspace-restore-failure"]'),
      'Fehleransicht fehlt',
    ).not.toBeNull();
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe(workspaceBefore);
    expect(container.textContent).not.toContain(CLOUD_COMPANY);
  });

  it('A3: scheitert der Kontroll-Pull, bleibt der zuletzt bestätigte Cloud-Name stehen', async () => {
    const container = await mountApp();
    expect(
      container.querySelector('[data-testid="workspace-company-conflict-cloud"]')?.textContent,
    ).toBe(CLOUD_COMPANY);
    await click(container, 'workspace-company-conflict-use-local');

    // Lokale Änderung plus fehlgeschlagener Kontroll-Pull.
    const raw = JSON.parse(localStorage.getItem(WORKSPACE_KEY)!) as Record<string, unknown>;
    raw.savedAt = '2026-08-16T12:00:00.000Z';
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(raw));
    registerMockRpcHandler('pull_workspace_sync_state', () => {
      rpcLog.push({ name: 'pull_workspace_sync_state' });
      throw new Error('Failed to fetch');
    });

    await confirmFinal(container);

    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();
    const cloudText =
      container.querySelector('[data-testid="workspace-company-conflict-cloud"]')?.textContent ?? '';
    expect(cloudText, 'leerer Cloud-Name angezeigt').not.toBe('');
    expect(cloudText).toBe(CLOUD_COMPANY);
  });

  it('A4: ungültige Profilantwort hält den Setup-Fortschritt und sperrt die App', async () => {
    invalidRowVersionFor = 'company_profile';
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');
    await confirmFinal(container);

    // Genau ein Setup-Versuch, fachlich erfolgreich.
    expect(upsertsFor('company_setup').length, 'Setup-Versuche').toBe(1);
    expect(successfulUpserts('company_setup').length).toBe(1);
    // Genau ein Profilversuch, ungültige Antwort — kein fachlicher Erfolg.
    expect(upsertsFor('company_profile').length, 'Profilversuche').toBe(1);
    expect(successfulUpserts('company_profile').length).toBe(0);
    expect(upsertsFor('company_profile')[0]?.returnedRowVersion).toBe(0);
    // App bleibt gesperrt, solange das Profil offen ist.
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).not.toBeNull();

    invalidRowVersionFor = null;
    await confirmFinal(container);

    // Setup wird beim Retry nicht erneut gesendet.
    expect(upsertsFor('company_setup').length, 'Setup erneut gesendet').toBe(1);
    expect(successfulUpserts('company_setup').length).toBe(1);
    // Zwei Profilversuche insgesamt, davon genau einer gültig.
    expect(upsertsFor('company_profile').length, 'Profilversuche gesamt').toBe(2);
    expect(successfulUpserts('company_profile').length, 'gültige Profil-Erfolge').toBe(1);
    expect(upsertsFor('company_profile')[1]?.returnedRowVersion).toBeGreaterThan(0);
    // Erst jetzt ist die App frei.
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
  });

  it('L1: erster Klick allein überträgt nichts und ersetzt den Knopf nicht', async () => {
    const container = await mountApp();

    await click(container, 'workspace-company-conflict-use-local');

    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
    // Der ursprüngliche Knopf bleibt an seiner Stelle stehen.
    expect(
      container.querySelector('[data-testid="workspace-company-conflict-use-local"]'),
      'erster Knopf verschwunden',
    ).not.toBeNull();
    // Der Bestätigungsbereich ist räumlich getrennt und zeigt beide Namen erneut.
    const area = container.querySelector('[data-testid="workspace-company-conflict-final-area"]');
    expect(area, 'Bestätigungsbereich fehlt').not.toBeNull();
    expect(area?.textContent).toContain(LOCAL_COMPANY);
    expect(area?.textContent).toContain(CLOUD_COMPANY);
    // Der endgültige Knopf ist zunächst deaktiviert.
    const finalButton = container.querySelector(
      '[data-testid="workspace-company-conflict-confirm"]',
    ) as HTMLButtonElement | null;
    expect(finalButton, 'Endknopf fehlt').not.toBeNull();
    expect(finalButton!.disabled, 'Endknopf nicht deaktiviert').toBe(true);
  });

  it('L2: ein direktes zweites Klickereignis überträgt nichts', async () => {
    const container = await mountApp();

    await click(container, 'workspace-company-conflict-use-local');
    // Sofortiger zweiter Klick auf denselben Punkt bzw. auf den Endknopf.
    const finalButton = container.querySelector(
      '[data-testid="workspace-company-conflict-confirm"]',
    ) as HTMLButtonElement;
    await act(async () => {
      finalButton.click();
    });
    await settle();

    expect(countOf('upsert_workspace_sync_entity'), 'ohne Checkbox gesendet').toBe(0);
  });

  it('L3: die Checkbox allein überträgt nichts', async () => {
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');

    await tickAcknowledge(container);

    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
    const finalButton = container.querySelector(
      '[data-testid="workspace-company-conflict-confirm"]',
    ) as HTMLButtonElement;
    expect(finalButton.disabled, 'Endknopf bleibt gesperrt').toBe(false);
  });

  it('L4: ein Sichtbarkeitswechsel verwirft die Bestätigungsstufe', async () => {
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');
    await tickAcknowledge(container);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();

    expect(container.querySelector('[data-testid="workspace-company-conflict-final-area"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-company-conflict-use-local"]')).not.toBeNull();
    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
  });

  it('L5: pagehide und pageshow verwerfen die Bestätigungsstufe', async () => {
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await settle();
    expect(container.querySelector('[data-testid="workspace-company-conflict-final-area"]')).toBeNull();

    await click(container, 'workspace-company-conflict-use-local');
    await act(async () => {
      window.dispatchEvent(new Event('pageshow'));
    });
    await settle();
    expect(container.querySelector('[data-testid="workspace-company-conflict-final-area"]')).toBeNull();
    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
  });

  it('L6: erst die vollständige getrennte Folge überträgt genau einmal je Entität', async () => {
    const container = await mountApp();

    await click(container, 'workspace-company-conflict-use-local');
    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
    await tickAcknowledge(container);
    expect(countOf('upsert_workspace_sync_entity')).toBe(0);
    await click(container, 'workspace-company-conflict-confirm');

    expect(successfulUpserts('company_setup').length).toBe(1);
    expect(successfulUpserts('company_profile').length).toBe(1);
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
  });

  it('L7: schnelles Doppelauslösen des Endknopfes überträgt trotzdem nur einmal', async () => {
    const container = await mountApp();
    await click(container, 'workspace-company-conflict-use-local');
    await tickAcknowledge(container);

    const finalButton = container.querySelector(
      '[data-testid="workspace-company-conflict-confirm"]',
    ) as HTMLButtonElement;
    await act(async () => {
      finalButton.click();
      finalButton.click();
    });
    await settle();

    expect(successfulUpserts('company_setup').length).toBe(1);
    expect(successfulUpserts('company_profile').length).toBe(1);
  });


  /**
   * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02M2 — vollständiger Produktionsablauf
   * mit zustandsbehaftetem Server: Konflikt → bestätigte Übernahme → Bootstrap →
   * Sync → mehrfacher Neustart. Keine Produktionsstufe wird im Test ersetzt.
   */
  it('M2: kein weiterer Firmen-Upsert nach der bestätigten Übernahme', async () => {
    // --- exakter Profilfeldbestand (ohne logoDataUrl) ------------------------
    const realProfile = {
      companyName: LOCAL_COMPANY,
      legalForm: 'GmbH',
      street: 'Hafenstraße 17',
      zip: '21079',
      city: 'Hamburg',
      country: 'Deutschland',
      contactPerson: 'Jana Petersen',
      phone: '040 1234567',
      email: 'info@nordtal.example',
      website: 'https://nordtal.example',
      taxNumber: '22/333/44444',
      vatId: 'DE123456789',
      bankName: 'Nordbank',
      iban: 'DE02120300000000202051',
      bic: 'NOLADE21XXX',
      defaultPaymentDays: 14,
      defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
      defaultSkonto: '',
      skontoEnabled: false,
      skontoPercent: 0,
      skontoDays: 0,
      managingDirector: 'Jana Petersen',
      taxFreeNotice: '',
      invoiceFooterNotes: '',
    };

    /**
     * Zustandsbehafteter Server. Er speichert das VOLLSTÄNDIGE p_payload, wie es
     * die Produktionsfunktionen erzeugen, und liefert es beim Pull unverändert
     * zurück. Unbekannte Entity-Typen berühren die Firmenversionen nie.
     */
    const server = {
      setupVersion: 3,
      profileVersion: 41,
      setupPayload: buildCompanySetupCloudPayload({
        ...DEFAULT_SETUP,
        companyName: CLOUD_COMPANY,
        setupComplete: true,
        setupVersion: 1,
      } as never) as Record<string, unknown>,
      profilePayload: buildCompanyProfileCloudPayload({
        ...realProfile,
        companyName: CLOUD_COMPANY,
      } as never) as Record<string, unknown>,
    };
    const rejected: { entity: string; sent: number }[] = [];
    const otherEntityUpserts: string[] = [];

    clearMockRpcHandlers();
    registerMockRpcHandler('ensure_personal_workspace', () => {
      rpcLog.push({ name: 'ensure_personal_workspace' });
      return {
        workspace: workspaceRow(),
        member: {
          workspace_id: WORKSPACE_ID,
          user_id: userId,
          role: 'owner',
          status: 'active',
          created_at: '2026-01-05T08:00:00.000Z',
          updated_at: '2026-01-05T08:00:00.000Z',
        },
        created: false,
      };
    });
    /**
     * Die Spalte speichert wie im SQL `coalesce(p_payload->'payload', p_payload)`
     * — der Pull liefert also den inneren Datensatz, nicht die Hülle.
     */
    const storedColumn = (full: Record<string, unknown>): Record<string, unknown> =>
      (full.payload as Record<string, unknown> | undefined) ?? full;

    registerMockRpcHandler('pull_workspace_sync_state', () => {
      rpcLog.push({ name: 'pull_workspace_sync_state' });
      return {
        workspace: workspaceRow(),
        members: [],
        settings: null,
        vorgaenge: [],
        setup: {
          workspace_id: WORKSPACE_ID,
          payload: storedColumn(server.setupPayload),
          row_version: server.setupVersion,
          updated_at: '2026-08-16T20:00:00.000Z',
        },
        company_profile: {
          workspace_id: WORKSPACE_ID,
          payload: storedColumn(server.profilePayload),
          row_version: server.profileVersion,
          updated_at: '2026-08-16T20:00:00.000Z',
        },
      };
    });
    registerMockRpcHandler('pull_workspace_invoices', () => []);
    registerMockRpcHandler('pull_workspace_order_amendments', () => []);
    registerMockRpcHandler('upsert_workspace_sync_entity', (args) => {
      const entity = String(args.p_entity_type ?? '');
      const sent = Number(args.p_row_version ?? -1);
      const fullPayload = (args.p_payload ?? {}) as Record<string, unknown>;
      const inner = (fullPayload.payload ?? {}) as Record<string, unknown>;

      if (entity !== 'company_setup' && entity !== 'company_profile') {
        // Fremde Typen dürfen die Firmenversionen niemals verändern.
        otherEntityUpserts.push(entity);
        rpcLog.push({ name: 'upsert_workspace_sync_entity', entity, rowVersion: sent });
        return { row_version: 1, payload: fullPayload };
      }

      const current = entity === 'company_setup' ? server.setupVersion : server.profileVersion;
      rpcLog.push({
        name: 'upsert_workspace_sync_entity',
        entity,
        companyName: typeof inner.companyName === 'string' ? inner.companyName : undefined,
        rowVersion: sent,
      });
      if (sent !== current) {
        rejected.push({ entity, sent });
        throw new Error(`Versionskonflikt ${entity}:${current}`);
      }
      const next = current + 1;
      if (entity === 'company_setup') {
        server.setupVersion = next;
        server.setupPayload = fullPayload;
      } else {
        server.profileVersion = next;
        server.profilePayload = fullPayload;
      }
      const call = rpcLog[rpcLog.length - 1]!;
      call.succeeded = true;
      call.returnedRowVersion = next;
      return { row_version: next, payload: fullPayload };
    });

    // --- lokaler Ausgangszustand mit exakter Profilform ----------------------
    const localRaw = JSON.parse(workspaceStateRaw()) as Record<string, unknown>;
    localRaw.companyProfile = { ...realProfile };
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(localRaw));
    const originalProfileEntryId = (
      (localRaw.syncOutbox as { id: string; entityType: string }[]) ?? []
    ).find((entry) => entry.entityType === 'company_profile')?.id;
    expect(originalProfileEntryId, 'ursprünglicher Profil-Eintrag fehlt').toBeTruthy();

    const setupRpcs = () =>
      rpcLog.filter((e) => e.name === 'upsert_workspace_sync_entity' && e.entity === 'company_setup');
    const profileRpcs = () =>
      rpcLog.filter((e) => e.name === 'upsert_workspace_sync_entity' && e.entity === 'company_profile');
    const storedState = () =>
      JSON.parse(localStorage.getItem(WORKSPACE_KEY) ?? '{}') as {
        setup?: { companyName?: string };
        companyProfile?: { companyName?: string };
        setupSync?: { version?: number };
        companyProfileSync?: { version?: number };
        syncOutbox?: { id: string; entityType: string; status: string; version: number }[];
      };
    const profileOutbox = () =>
      (storedState().syncOutbox ?? []).filter((entry) => entry.entityType === 'company_profile');

    /** Vollständige Zusicherung für jeden Kontrollpunkt nach der Übernahme. */
    const assertStable = (label: string) => {
      const state = storedState();
      expect(state.setupSync?.version, `${label}: setupSync`).toBe(4);
      expect(state.companyProfileSync?.version, `${label}: companyProfileSync`).toBe(42);
      expect(state.setup?.companyName, `${label}: setup.companyName`).toBe(LOCAL_COMPANY);
      expect(state.companyProfile?.companyName, `${label}: profile.companyName`).toBe(LOCAL_COMPANY);

      const entries = profileOutbox();
      expect(entries.length, `${label}: Anzahl Profil-Einträge`).toBe(1);
      expect(entries[0]?.id, `${label}: ID des Profil-Eintrags`).toBe(originalProfileEntryId);
      expect(entries[0]?.status, `${label}: Status`).toBe('completed');
      expect(
        entries.some((entry) => [42, 43, 44].includes(entry.version)),
        `${label}: Eintrag mit Version 42/43/44`,
      ).toBe(false);

      expect(setupRpcs().length, `${label}: Setup-RPCs`).toBe(1);
      expect(profileRpcs().length, `${label}: Profil-RPCs`).toBe(1);
      expect(server.setupVersion, `${label}: Cloud-Setup`).toBe(4);
      expect(server.profileVersion, `${label}: Cloud-Profil`).toBe(42);
      expect(rejected, `${label}: abgelehnte Firmenversuche`).toEqual([]);
      expect(otherEntityUpserts, `${label}: fremde Entitäten gesendet`).toEqual([]);
    };

    // --- A: vor der Abschlussbestätigung ------------------------------------
    const container = await mountApp();
    expect(container.querySelector('[data-testid="workspace-company-conflict"]')).not.toBeNull();
    expect(setupRpcs().length, 'A: Setup-RPCs').toBe(0);
    expect(profileRpcs().length, 'A: Profil-RPCs').toBe(0);
    expect(server.setupVersion).toBe(3);
    expect(server.profileVersion).toBe(41);
    expect(profileOutbox().length, 'A: Profil-Einträge').toBe(1);
    expect(profileOutbox()[0]?.status, 'A: Status').toBe('pending');

    // --- B: bestätigte Übernahme --------------------------------------------
    await click(container, 'workspace-company-conflict-use-local');
    await tickAcknowledge(container);
    await click(container, 'workspace-company-conflict-confirm');

    expect(setupRpcs()[0]?.rowVersion, 'B: p_row_version Setup').toBe(3);
    expect(setupRpcs()[0]?.returnedRowVersion, 'B: Antwort Setup').toBe(4);
    expect(profileRpcs()[0]?.rowVersion, 'B: p_row_version Profil').toBe(41);
    expect(profileRpcs()[0]?.returnedRowVersion, 'B: Antwort Profil').toBe(42);
    assertStable('B');

    // --- C: nach Bootstrap und Sync ------------------------------------------
    await settle();
    assertStable('C');

    // --- D: zweimaliger Neustart --------------------------------------------
    for (const round of [1, 2]) {
      await unmountApp();
      resetWorkspaceCloudBootstrapForTests();
      resetSyncCoordinatorForTests();
      const again = await mountApp();
      expect(again.querySelector('[data-testid="workspace-company-conflict"]')).toBeNull();
      expect(again.querySelector('[data-testid="app-shell"]')).not.toBeNull();
      assertStable(`D${round}`);
    }
  });
});
