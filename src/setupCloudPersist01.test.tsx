/**
 * OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — die im Assistenten eingegebenen
 * Firmendaten müssen noch in derselben Sitzung in der Cloud landen.
 *
 * Geprüft wird der reale Stapel AuthProvider → BusinessStateGate → App plus die
 * Bootstrap-Migration und die lokale Scope-Migration. Gestubbt sind nur die
 * Supabase-RPC-Antworten: kein Netzwerk, keine Kosten.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { BusinessStateGate } from './components/system/BusinessStateGate';
import {
  createSeedState,
  savePersistedStateToKey,
} from './services/persistenceService';
import { STORAGE_VERSION } from './services/sync/syncMigrationService';
import { createSyncClient } from './services/sync/syncClientService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from './services/sync/syncOutboxService';
import { resetWorkspaceCloudBootstrapForTests } from './services/workspace/workspaceCloudBootstrapService';
import { resetSyncCoordinatorForTests } from './services/sync/syncCoordinator';
import { mergeRemoteWorkspacePullIntoState } from './services/workspace/workspaceProvisioningService';
import { migrateUserScopeToWorkspaceScope } from './services/storage/legacyMigrationService';
import { resetTestStores } from './test/resetStores';
import { clearMockRpcHandlers, registerMockRpcHandler } from './test/mockProfileStore';
import { loginAsDefaultAdmin } from './test/authFixtures';
import { getMockCurrentSession } from './test/mockSupabaseAuth';
import { getCompanyProfile } from './services/companyProfileService';
import { getInvoiceNumberSequenceSnapshot } from './services/invoiceNumberService';
import type { AppPersistedState } from './types/models';

const WORKSPACE_ID = 'persist-ws';
const COMPANY_NAME = 'Cirmak Haustechnik GmbH';

let userId = '';

type RpcCall = {
  name: string;
  entity?: string;
  companyName?: string;
  setupComplete?: boolean;
  rowVersion?: number;
  succeeded?: boolean;
};

const rpcLog: RpcCall[] = [];
let ensureAnswer: () => unknown = () => ensureRpcData(false);
let pullAnswer: () => unknown = () => pullRpcData({ empty: true });
let upsertFails = false;

function registerHandlers(): void {
  registerMockRpcHandler('ensure_personal_workspace', () => {
    rpcLog.push({ name: 'ensure_personal_workspace' });
    return ensureAnswer();
  });
  registerMockRpcHandler('pull_workspace_sync_state', () => {
    rpcLog.push({ name: 'pull_workspace_sync_state' });
    return pullAnswer();
  });
  registerMockRpcHandler('pull_workspace_invoices', () => []);
  registerMockRpcHandler('pull_workspace_order_amendments', () => []);
  registerMockRpcHandler('upsert_workspace_sync_entity', (args) => {
    const entity = String(args.p_entity_type ?? '');
    const payload = (args.p_payload ?? {}) as { payload?: Record<string, unknown> };
    const inner = (payload.payload ?? {}) as { companyName?: string; setupComplete?: boolean };
    // Versuch und Erfolg werden getrennt protokolliert.
    const call: RpcCall = {
      name: 'upsert_workspace_sync_entity',
      entity,
      companyName: inner.companyName,
      setupComplete: inner.setupComplete,
      rowVersion: Number(args.p_row_version ?? 0),
      succeeded: false,
    };
    rpcLog.push(call);
    if (upsertFails) throw new Error('Failed to fetch');
    call.succeeded = true;
    return { row_version: 1, payload: args.p_payload ?? {} };
  });
}

function workspaceRow() {
  return {
    id: WORKSPACE_ID,
    name: COMPANY_NAME,
    owner_user_id: userId,
    created_at: '2026-01-05T08:00:00.000Z',
    updated_at: '2026-05-05T08:00:00.000Z',
    version: 3,
  };
}

function ensureRpcData(created: boolean) {
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
    created,
  };
}

function pullRpcData(options: { empty?: boolean } = {}) {
  const base = { workspace: workspaceRow(), members: [], settings: null, vorgaenge: [] };
  if (options.empty) return { ...base, setup: null, company_profile: null };
  return {
    ...base,
    setup: {
      workspace_id: WORKSPACE_ID,
      payload: { ...DEFAULT_SETUP, companyName: COMPANY_NAME, setupComplete: true, setupVersion: 1 },
      row_version: 7,
      updated_at: '2026-05-05T08:00:00.000Z',
    },
    company_profile: {
      workspace_id: WORKSPACE_ID,
      payload: { ...DEFAULT_COMPANY_PROFILE, companyName: COMPANY_NAME },
      row_version: 7,
      updated_at: '2026-05-05T08:00:00.000Z',
    },
  };
}

function completeLocalState(companyName = COMPANY_NAME): AppPersistedState {
  return {
    ...createSeedState({
      ...DEFAULT_SETUP,
      companyName,
      setupComplete: true,
      setupVersion: 1,
    }),
    version: STORAGE_VERSION,
    syncClient: createSyncClient(),
    companyProfile: { ...DEFAULT_COMPANY_PROFILE, companyName, street: 'Hauptstraße 1', email: 'info@cirmak.example' },
    savedAt: '2026-05-05T08:00:00.000Z',
  };
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mountApp(initialEntry = '/'): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[initialEntry]}>
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

function setInputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function clickTestId(container: HTMLElement, testId: string): Promise<void> {
  const element = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
  expect(element, `Schaltfläche ${testId} fehlt`).not.toBeNull();
  await act(async () => {
    element!.click();
  });
  await settle();
}

/** Füllt den Assistenten mit echten Firmendaten und schließt ihn ab. */
async function completeWizard(container: HTMLElement): Promise<void> {
  const field = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;

  await act(async () => {
    setInputValue(field('setup-companyName'), COMPANY_NAME);
    setInputValue(field('setup-contactPerson'), 'Saban Cirmak');
    setInputValue(field('setup-street'), 'Hauptstraße 1');
    setInputValue(field('setup-zip'), '80331');
    setInputValue(field('setup-city'), 'München');
    setInputValue(field('setup-email'), 'info@cirmak.example');
  });
  await clickTestId(container, 'setup-next');
  await act(async () => {
    setInputValue(field('setup-taxNumber'), '123/456/78901');
  });
  await clickTestId(container, 'setup-next');
  await act(async () => {
    setInputValue(field('setup-iban'), 'DE89370400440532013000');
  });
  await clickTestId(container, 'setup-next');
  await act(async () => {
    setInputValue(field('setup-lastInvoiceNumber'), '12');
  });
  await clickTestId(container, 'setup-next');
  await clickTestId(container, 'setup-next');
}

const companyUpsertAttempts = (): RpcCall[] =>
  rpcLog.filter(
    (entry) =>
      entry.name === 'upsert_workspace_sync_entity' &&
      (entry.entity === 'company_setup' || entry.entity === 'company_profile'),
  );
const successfulUpserts = (entity: string): RpcCall[] =>
  companyUpsertAttempts().filter((entry) => entry.entity === entity && entry.succeeded === true);
const pendingCompanyOutbox = () =>
  getSyncOutboxSnapshot().filter(
    (entry) =>
      (entry.entityType === 'company_setup' || entry.entityType === 'company_profile') &&
      (entry.status === 'pending' || entry.status === 'error'),
  );

describe('OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — Assistent sichert in die Cloud', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    rpcLog.length = 0;
    upsertFails = false;
    clearMockRpcHandlers();
    registerHandlers();
    ensureAnswer = () => ensureRpcData(true);
    pullAnswer = () => pullRpcData({ empty: true });
    resetSyncOutboxForTests();
    resetWorkspaceCloudBootstrapForTests();
    resetSyncCoordinatorForTests();
    await loginAsDefaultAdmin();
    userId = getMockCurrentSession()?.user.id ?? '';
    expect(userId, 'Testanmeldung fehlgeschlagen').not.toBe('');
    localStorage.clear();
  });

  afterEach(async () => {
    await unmountApp();
    clearMockRpcHandlers();
    resetTestStores();
    resetWorkspaceCloudBootstrapForTests();
    localStorage.clear();
  });

  it('P1: Firmendaten werden ohne Neustart und ohne Sync-Seite hochgeladen', async () => {
    const container = await mountApp('/setup');
    expect(container.querySelector('[data-testid="first-run-wizard"]')).not.toBeNull();

    await completeWizard(container);

    const entities = companyUpsertAttempts().map((entry) => entry.entity);
    expect(entities).toContain('company_setup');
    expect(entities).toContain('company_profile');
  });

  it('P2: Reihenfolge — Workspace ermitteln, Cloud pullen, danach Firmendaten pushen', async () => {
    const container = await mountApp('/setup');
    await completeWizard(container);

    const order = rpcLog.map((entry) => entry.name);
    const firstEnsure = order.indexOf('ensure_personal_workspace');
    const firstPull = order.indexOf('pull_workspace_sync_state');
    const firstCompanyUpsert = rpcLog.findIndex(
      (entry) =>
        entry.name === 'upsert_workspace_sync_entity' &&
        (entry.entity === 'company_setup' || entry.entity === 'company_profile'),
    );
    expect(firstEnsure).toBe(0);
    expect(firstPull).toBeGreaterThan(firstEnsure);
    expect(firstCompanyUpsert, 'kein Firmendaten-Upsert').toBeGreaterThan(firstPull);
  });

  it('P3: das Cloud-Payload trägt den Firmennamen und setupComplete:true', async () => {
    const container = await mountApp('/setup');
    await completeWizard(container);

    const setupUpsert = companyUpsertAttempts().find((entry) => entry.entity === 'company_setup');
    expect(setupUpsert, 'company_setup fehlt').toBeDefined();
    expect(setupUpsert?.companyName).toBe(COMPANY_NAME);
    expect(setupUpsert?.setupComplete).toBe(true);
    const profileUpsert = companyUpsertAttempts().find((entry) => entry.entity === 'company_profile');
    expect(profileUpsert?.companyName).toBe(COMPANY_NAME);
  });

  it('P4: ein Netzwerkfehler beim Push löscht keine lokale Eingabe', async () => {
    upsertFails = true;
    const container = await mountApp('/setup');
    await completeWizard(container);

    const stored = Object.keys(localStorage)
      .map((key) => localStorage.getItem(key) ?? '')
      .join('\n');
    expect(stored).toContain(COMPANY_NAME);
    expect(stored).toContain('"setupComplete":true');
  });

  it('P5: nach Push-Fehler bleibt ein retryfähiger Outbox-Eintrag erhalten', async () => {
    upsertFails = true;
    const container = await mountApp('/setup');
    await completeWizard(container);

    expect(companyUpsertAttempts().length, 'kein Upsert versucht').toBeGreaterThan(0);
    const pending = pendingCompanyOutbox();
    expect(pending.map((entry) => entry.entityType)).toContain('company_setup');
    expect(pending.map((entry) => entry.entityType)).toContain('company_profile');
  });

  it('P6: nach Push-Fehler landet der Nutzer nicht erneut im leeren Assistenten', async () => {
    upsertFails = true;
    const container = await mountApp('/setup');
    await completeWizard(container);

    expect(companyUpsertAttempts().length, 'kein Upsert versucht').toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="first-run-wizard"]')).toBeNull();
    expect(container.querySelector('[data-testid="setup-companyName"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    expect(container.textContent).toContain(COMPANY_NAME);
  });

  it('P7: ein sichtbarer Hinweis meldet die ausstehende Cloud-Sicherung', async () => {
    upsertFails = true;
    const container = await mountApp('/setup');
    await completeWizard(container);

    const banner = container.querySelector('[data-testid="cloud-backup-pending-banner"]');
    expect(banner, 'Hinweis fehlt').not.toBeNull();
    expect(banner?.textContent).toContain('lokal gespeichert');
  });

  it('P8: ein Retry überträgt genau einmal je Entität, ohne zweiten Workspace', async () => {
    upsertFails = true;
    const container = await mountApp('/setup');
    await completeWizard(container);

    // Erster Lauf: beide Entitäten versucht, beide gescheitert.
    expect(successfulUpserts('company_setup')).toEqual([]);
    expect(successfulUpserts('company_profile')).toEqual([]);
    expect(pendingCompanyOutbox().length).toBe(2);
    const ensureCallsBefore = rpcLog.filter(
      (entry) => entry.name === 'ensure_personal_workspace',
    ).length;

    upsertFails = false;
    const { retrySyncFromUi } = await import('./services/sync/syncUiService');
    await act(async () => {
      await retrySyncFromUi();
    });
    await settle();

    expect(successfulUpserts('company_setup').length, 'company_setup nicht genau einmal').toBe(1);
    expect(successfulUpserts('company_profile').length, 'company_profile nicht genau einmal').toBe(1);
    expect(successfulUpserts('company_setup')[0]?.companyName).toBe(COMPANY_NAME);
    expect(pendingCompanyOutbox(), 'offene Einträge nach Retry').toEqual([]);
    expect(
      rpcLog.filter((entry) => entry.name === 'ensure_personal_workspace').length,
    ).toBe(ensureCallsBefore);
    expect(
      Object.keys(localStorage).filter((key) => key.startsWith('officepilot-state:workspace:')),
    ).toEqual([`officepilot-state:workspace:${WORKSPACE_ID}`]);
    expect(
      container.querySelector('[data-testid="cloud-backup-pending-banner"]'),
      'Hinweis bleibt trotz Erfolg sichtbar',
    ).toBeNull();
  });

  it('P9: lokal vollständig, Cloud leer, keine Outbox → Migration meldet beide Entitäten nach', async () => {
    savePersistedStateToKey({ type: 'user', userId }, completeLocalState());
    resetSyncOutboxForTests();
    ensureAnswer = () => ensureRpcData(false);

    await mountApp();

    const entities = companyUpsertAttempts().map((entry) => entry.entity);
    expect(entities).toContain('company_setup');
    expect(entities).toContain('company_profile');
  });

  it('P10: ein lokaler Defaultzustand erzeugt keine Firmendaten-Upserts', async () => {
    ensureAnswer = () => ensureRpcData(false);

    await mountApp();

    expect(companyUpsertAttempts()).toEqual([]);
  });

  it('P11: vollständige Cloud-Daten werden nicht durch lokale Defaults überschrieben', async () => {
    ensureAnswer = () => ensureRpcData(false);
    pullAnswer = () => pullRpcData();

    const container = await mountApp();

    expect(companyUpsertAttempts()).toEqual([]);
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    const raw = localStorage.getItem(`officepilot-state:workspace:${WORKSPACE_ID}`) ?? '';
    expect(raw).toContain(COMPANY_NAME);
  });
});

describe('OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — Merge und Outbox', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSyncOutboxForTests();
    resetTestStores();
  });

  it('P12: echter lokaler Stand gegen abweichenden Cloud-Stand bleibt ein Konflikt', () => {
    const local: AppPersistedState = {
      ...completeLocalState('Alte Firma GmbH'),
      setupSync: {
        version: 4,
        updatedAt: '2026-04-04T08:00:00.000Z',
        deleted: false,
        deviceId: 'device-a',
        workspaceId: WORKSPACE_ID,
      },
      syncClient: { ...createSyncClient(), serverWorkspaceId: WORKSPACE_ID },
    };

    const merged = mergeRemoteWorkspacePullIntoState(local, {
      workspace: null,
      members: [],
      settings: null,
      setupPayload: { ...DEFAULT_SETUP, companyName: COMPANY_NAME, setupComplete: true },
      setupRowVersion: 9,
      setupUpdatedAt: '2026-05-05T08:00:00.000Z',
      companyProfilePayload: null,
      companyProfileRowVersion: 0,
      companyProfileUpdatedAt: null,
      vorgaenge: [],
    });

    expect(merged.conflicts).toContain('company_setup');
    expect(merged.state.setup.companyName).toBe('Alte Firma GmbH');
  });

  it('P13: nachgemeldete Outbox-Einträge bleiben im zurückgegebenen Zustand erhalten', () => {
    const local: AppPersistedState = {
      ...completeLocalState(),
      syncOutbox: [],
      syncClient: { ...createSyncClient(), serverWorkspaceId: WORKSPACE_ID },
    };

    const merged = mergeRemoteWorkspacePullIntoState(local, {
      workspace: null,
      members: [],
      settings: null,
      setupPayload: null,
      setupRowVersion: 0,
      setupUpdatedAt: null,
      companyProfilePayload: null,
      companyProfileRowVersion: 0,
      companyProfileUpdatedAt: null,
      vorgaenge: [],
    });

    const queued = (merged.state.syncOutbox ?? []).map((entry) => entry.entityType);
    expect(queued, 'Outbox-Einträge fehlen im Zustand').toContain('company_setup');
    expect(queued).toContain('company_profile');
  });
});

describe('OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — Scope-Migration ohne Datenverlust', () => {
  const USER = 'scope-user';
  const WS = 'scope-ws';
  const userKey = `officepilot-state:user:${USER}`;
  const workspaceKey = `officepilot-state:workspace:${WS}`;

  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('S1: vollständiger User-Scope, leerer Workspace-Scope → Daten werden übernommen', () => {
    localStorage.setItem(userKey, JSON.stringify(completeLocalState()));

    migrateUserScopeToWorkspaceScope(USER, WS);

    expect(localStorage.getItem(workspaceKey) ?? '').toContain(COMPANY_NAME);
  });

  it('S2: beide Scopes vollständig → nichts wird still gelöscht', () => {
    localStorage.setItem(userKey, JSON.stringify(completeLocalState('User Kopie GmbH')));
    localStorage.setItem(workspaceKey, JSON.stringify(completeLocalState('Workspace Kopie GmbH')));

    migrateUserScopeToWorkspaceScope(USER, WS);

    expect(localStorage.getItem(workspaceKey) ?? '').toContain('Workspace Kopie GmbH');
    expect(localStorage.getItem(userKey), 'User-Kopie wurde gelöscht').not.toBeNull();
    expect(localStorage.getItem(userKey) ?? '').toContain('User Kopie GmbH');
  });

  it('S3: Default im User-Scope, vollständiger Workspace-Scope → Workspace bleibt unverändert', () => {
    const defaultState = {
      ...createSeedState({ ...DEFAULT_SETUP, setupComplete: false }),
      version: STORAGE_VERSION,
      syncClient: createSyncClient(),
      savedAt: '2026-05-05T08:00:00.000Z',
    };
    localStorage.setItem(userKey, JSON.stringify(defaultState));
    const before = JSON.stringify(completeLocalState());
    localStorage.setItem(workspaceKey, before);

    migrateUserScopeToWorkspaceScope(USER, WS);

    expect(localStorage.getItem(workspaceKey)).toBe(before);
  });

  it('S4: die alte Kopie verschwindet erst nach erfolgreichem Schreiben und Rücklesen', () => {
    const raw = JSON.stringify(completeLocalState());
    localStorage.setItem(userKey, raw);

    const result = migrateUserScopeToWorkspaceScope(USER, WS);

    expect(result.action).toBe('moved');
    expect(localStorage.getItem(workspaceKey)).toBe(raw);
    expect(localStorage.getItem(userKey), 'alte Kopie zu früh entfernt').toBeNull();
  });

  it('S5: bei Speicherfehler bleiben beide Kopien bestehen', () => {
    const raw = JSON.stringify(completeLocalState());
    localStorage.setItem(userKey, raw);
    const realStorage = globalThis.localStorage;
    const failingStorage = {
      getItem: (key: string) => realStorage.getItem(key),
      setItem: (key: string, value: string) => {
        if (key === workspaceKey) throw new Error('QuotaExceeded');
        realStorage.setItem(key, value);
      },
      removeItem: (key: string) => realStorage.removeItem(key),
      clear: () => realStorage.clear(),
      key: (index: number) => realStorage.key(index),
      get length() {
        return realStorage.length;
      },
    } as unknown as Storage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => failingStorage,
    });

    try {
      expect(() => migrateUserScopeToWorkspaceScope(USER, WS)).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: () => realStorage,
      });
    }

    expect(localStorage.getItem(userKey), 'User-Kopie verloren').not.toBeNull();
    expect(localStorage.getItem(userKey)).toBe(raw);
  });
});

/**
 * OFFICEPILOT-SETUP-CLOUD-PERSIST-01C — die Restlücken: vorhandener leerer
 * Workspace-Schlüssel, lokaler Persistenzfehler und paralleler Sync-Aufruf.
 */
describe('OFFICEPILOT-SETUP-CLOUD-PERSIST-01C', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    rpcLog.length = 0;
    upsertFails = false;
    clearMockRpcHandlers();
    registerHandlers();
    ensureAnswer = () => ensureRpcData(false);
    pullAnswer = () => pullRpcData({ empty: true });
    resetSyncOutboxForTests();
    resetWorkspaceCloudBootstrapForTests();
    resetSyncCoordinatorForTests();
    await loginAsDefaultAdmin();
    userId = getMockCurrentSession()?.user.id ?? '';
    localStorage.clear();
  });

  afterEach(async () => {
    await unmountApp();
    clearMockRpcHandlers();
    resetTestStores();
    resetWorkspaceCloudBootstrapForTests();
    localStorage.clear();
  });

  it('S6: vollständiger User-Scope neben vorhandenem leerem Workspace-Scope wird gerettet', async () => {
    savePersistedStateToKey({ type: 'user', userId }, completeLocalState());
    // Der gefährliche Fall: der Workspace-Schlüssel existiert bereits — leer.
    savePersistedStateToKey(
      { type: 'workspace', workspaceId: WORKSPACE_ID },
      {
        ...createSeedState({ ...DEFAULT_SETUP, setupComplete: false }),
        version: STORAGE_VERSION,
        syncClient: { ...createSyncClient(), serverWorkspaceId: WORKSPACE_ID },
        savedAt: '2026-05-01T08:00:00.000Z',
      },
    );
    resetSyncOutboxForTests();

    const container = await mountApp();

    const raw = localStorage.getItem(`officepilot-state:workspace:${WORKSPACE_ID}`);
    expect(raw, 'Workspace-Zustand fehlt').not.toBeNull();
    const stored = JSON.parse(raw!) as {
      setup?: { companyName?: string; setupComplete?: boolean };
      companyProfile?: { companyName?: string };
      syncClient?: { serverWorkspaceId?: string };
    };
    expect(stored.setup?.companyName, 'Firmendaten verloren').toBe(COMPANY_NAME);
    expect(stored.setup?.setupComplete).toBe(true);
    expect(stored.companyProfile?.companyName).toBe(COMPANY_NAME);
    // Workspace- und Serveridentität bleiben erhalten.
    expect(stored.syncClient?.serverWorkspaceId).toBe(WORKSPACE_ID);

    const entities = companyUpsertAttempts().map((entry) => entry.entity);
    expect(entities, 'company_setup nicht zur Cloud angemeldet').toContain('company_setup');
    expect(entities).toContain('company_profile');
    // Genau einmal je Entität, danach nichts mehr offen.
    expect(successfulUpserts('company_setup').length, 'company_setup nicht genau einmal').toBe(1);
    expect(successfulUpserts('company_profile').length, 'company_profile nicht genau einmal').toBe(1);
    expect(pendingCompanyOutbox(), 'offene Firmen-Outbox').toEqual([]);
    // Kein zweiter Workspace-Schlüssel.
    expect(
      Object.keys(localStorage).filter((key) => key.startsWith('officepilot-state:workspace:')),
    ).toEqual([`officepilot-state:workspace:${WORKSPACE_ID}`]);
    expect(container.querySelector('[data-testid="first-run-wizard"]')).toBeNull();
  });

  it('S7: zwei echte, widersprüchliche Kopien werden beide bewahrt', () => {
    const userKey = `officepilot-state:user:${userId}`;
    const workspaceKey = `officepilot-state:workspace:${WORKSPACE_ID}`;
    const userRaw = JSON.stringify(completeLocalState('User Betrieb GmbH'));
    const workspaceRaw = JSON.stringify(completeLocalState('Workspace Betrieb GmbH'));
    localStorage.setItem(userKey, userRaw);
    localStorage.setItem(workspaceKey, workspaceRaw);

    const result = migrateUserScopeToWorkspaceScope(userId, WORKSPACE_ID);

    expect(result.action, 'Konflikt nicht gemeldet').toBe('conflict');
    expect(localStorage.getItem(userKey)).toBe(userRaw);
    expect(localStorage.getItem(workspaceKey)).toBe(workspaceRaw);
  });

  it('S8: bei Schreibfehler während der Rettung bleiben beide Kopien bytegenau', () => {
    const userKey = `officepilot-state:user:${userId}`;
    const workspaceKey = `officepilot-state:workspace:${WORKSPACE_ID}`;
    const userRaw = JSON.stringify(completeLocalState());
    localStorage.setItem(userKey, userRaw);
    localStorage.setItem(
      workspaceKey,
      JSON.stringify({
        ...createSeedState({ ...DEFAULT_SETUP, setupComplete: false }),
        version: STORAGE_VERSION,
        syncClient: { ...createSyncClient(), serverWorkspaceId: WORKSPACE_ID },
        savedAt: '2026-05-01T08:00:00.000Z',
      }),
    );
    // Rohwerte beider Seiten vor dem Fehler festhalten.
    const userRawBefore = localStorage.getItem(userKey);
    const workspaceRawBefore = localStorage.getItem(workspaceKey);

    const realStorage = globalThis.localStorage;
    const failingStorage = {
      getItem: (key: string) => realStorage.getItem(key),
      setItem: (key: string, value: string) => {
        if (key === workspaceKey) throw new Error('QuotaExceeded');
        realStorage.setItem(key, value);
      },
      removeItem: (key: string) => realStorage.removeItem(key),
      clear: () => realStorage.clear(),
      key: (index: number) => realStorage.key(index),
      get length() {
        return realStorage.length;
      },
    } as unknown as Storage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => failingStorage,
    });

    let result: ReturnType<typeof migrateUserScopeToWorkspaceScope> | null = null;
    try {
      expect(() => {
        result = migrateUserScopeToWorkspaceScope(userId, WORKSPACE_ID);
      }).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: () => realStorage,
      });
    }

    expect(result?.action, 'Schreibfehler nicht gemeldet').toBe('write_failed');
    expect(localStorage.getItem(userKey), 'User-Kopie verändert').toBe(userRawBefore);
    expect(localStorage.getItem(workspaceKey), 'Workspace-Kopie verändert').toBe(
      workspaceRawBefore,
    );
  });

  it('P14: scheitert das lokale Speichern, startet kein Cloud-Sync und der Assistent bleibt', async () => {
    // Neuer Workspace: der Assistent ist der reguläre Weg.
    ensureAnswer = () => ensureRpcData(true);
    const container = await mountApp('/setup');
    expect(container.querySelector('[data-testid="first-run-wizard"]')).not.toBeNull();
    const profileBefore = getCompanyProfile().companyName;
    const sequenceBefore = getInvoiceNumberSequenceSnapshot().lastIssuedNumber;
    rpcLog.length = 0;

    const realStorage = globalThis.localStorage;
    const failingStorage = {
      getItem: (key: string) => realStorage.getItem(key),
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: (key: string) => realStorage.removeItem(key),
      clear: () => realStorage.clear(),
      key: (index: number) => realStorage.key(index),
      get length() {
        return realStorage.length;
      },
    } as unknown as Storage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => failingStorage,
    });

    try {
      await completeWizard(container);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: () => realStorage,
      });
    }

    expect(companyUpsertAttempts(), 'trotz Speicherfehler gesendet').toEqual([]);
    expect(rpcLog.filter((entry) => entry.name === 'ensure_personal_workspace')).toEqual([]);
    expect(
      container.querySelector('[data-testid="first-run-wizard"]'),
      'Assistent verschwunden',
    ).not.toBeNull();
    // Eine Fehlerstruktur ist sichtbar.
    expect(container.querySelector('[role="alert"]'), 'keine Fehlerstruktur').not.toBeNull();
    expect(container.querySelector('[data-testid="setup-form-error"]')).not.toBeNull();
    // Die Eingaben stehen weiterhin im Assistenten: zurückblättern zeigt sie.
    for (let step = 0; step < 4; step += 1) {
      await clickTestId(container, 'setup-back');
    }
    expect(
      (container.querySelector('[data-testid="setup-companyName"]') as HTMLInputElement | null)
        ?.value,
    ).toBe(COMPANY_NAME);
    // Stores dürfen nicht als abgeschlossen zurückbleiben.
    expect(getCompanyProfile().companyName).toBe(profileBefore);
    expect(getInvoiceNumberSequenceSnapshot().lastIssuedNumber).toBe(sequenceBefore);
  });

  it('P16: paralleler Fehlerfall — ein Versuch je Entität, Promise wird auch nach Fehler frei', async () => {
    savePersistedStateToKey({ type: 'user', userId }, completeLocalState());
    await mountApp();
    rpcLog.length = 0;
    resetSyncOutboxForTests();

    const { syncCompanyDataAfterSetup } = await import('./services/sync/syncUiService');
    const { enqueueSyncOutbox } = await import('./services/sync/syncOutboxService');
    enqueueSyncOutbox({
      entityType: 'company_setup',
      entityId: WORKSPACE_ID,
      operation: 'create',
      version: 1,
    });
    enqueueSyncOutbox({
      entityType: 'company_profile',
      entityId: WORKSPACE_ID,
      operation: 'create',
      version: 1,
    });

    // Erster Durchgang: zwei gleichzeitige Aufrufe, jeder Upsert scheitert.
    upsertFails = true;
    let outcomes: { pending: boolean }[] = [];
    await act(async () => {
      outcomes = await Promise.all([syncCompanyDataAfterSetup(), syncCompanyDataAfterSetup()]);
    });
    await settle();

    const attemptsSetup = companyUpsertAttempts().filter(
      (entry) => entry.entity === 'company_setup',
    );
    const attemptsProfile = companyUpsertAttempts().filter(
      (entry) => entry.entity === 'company_profile',
    );
    expect(attemptsSetup.length, 'company_setup mehrfach versucht').toBe(1);
    expect(attemptsProfile.length, 'company_profile mehrfach versucht').toBe(1);
    expect(successfulUpserts('company_setup')).toEqual([]);
    expect(successfulUpserts('company_profile')).toEqual([]);
    expect(outcomes.every((outcome) => outcome.pending)).toBe(true);
    expect(pendingCompanyOutbox().map((entry) => entry.entityType).sort()).toEqual([
      'company_profile',
      'company_setup',
    ]);

    // Zweiter Durchgang: das interne Promise muss nach dem Fehler frei sein.
    upsertFails = false;
    let retryOutcome: { pending: boolean } | null = null;
    await act(async () => {
      retryOutcome = await syncCompanyDataAfterSetup();
    });
    await settle();

    expect(retryOutcome?.pending, 'Sync lief nach Fehler nicht erneut').toBe(false);
    expect(successfulUpserts('company_setup').length).toBe(1);
    expect(successfulUpserts('company_profile').length).toBe(1);
    expect(pendingCompanyOutbox()).toEqual([]);
  });

  it('P15: zwei gleichzeitige Aufrufe erzeugen genau einen erfolgreichen Upsert je Entität', async () => {
    savePersistedStateToKey({ type: 'user', userId }, completeLocalState());
    await mountApp();
    rpcLog.length = 0;
    resetSyncOutboxForTests();

    const { syncCompanyDataAfterSetup } = await import('./services/sync/syncUiService');
    const { enqueueSyncOutbox } = await import('./services/sync/syncOutboxService');
    enqueueSyncOutbox({
      entityType: 'company_setup',
      entityId: WORKSPACE_ID,
      operation: 'create',
      version: 1,
    });
    enqueueSyncOutbox({
      entityType: 'company_profile',
      entityId: WORKSPACE_ID,
      operation: 'create',
      version: 1,
    });

    await act(async () => {
      await Promise.all([syncCompanyDataAfterSetup(), syncCompanyDataAfterSetup()]);
    });
    await settle();

    expect(successfulUpserts('company_setup').length, 'company_setup nicht genau einmal').toBe(1);
    expect(successfulUpserts('company_profile').length, 'company_profile nicht genau einmal').toBe(1);
    expect(pendingCompanyOutbox()).toEqual([]);

    // Nach Abschluss ist das interne Promise wieder frei: ein neuer Aufruf läuft erneut.
    const outcome = await syncCompanyDataAfterSetup();
    expect(outcome.pending).toBe(false);
  });
});
