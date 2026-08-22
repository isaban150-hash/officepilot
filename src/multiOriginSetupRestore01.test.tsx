/**
 * OFFICEPILOT-MULTI-ORIGIN-SETUP-01B2/01B3 — ein Bestandskunde öffnet OfficePilot
 * auf einer neuen Adresse oder einem neuen Gerät. Sein lokaler Speicher ist leer.
 *
 * Geprüft wird der reale Stapel AuthProvider → BusinessStateGate → App mit echtem
 * Routing und echtem Abmelden. Gestubbt sind nur die Supabase-RPC-Antworten:
 * kein Netzwerk, keine Kosten.
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
import { createSeedState, savePersistedStateToKey } from './services/persistenceService';
import { STORAGE_VERSION } from './services/sync/syncMigrationService';
import { createSyncClient } from './services/sync/syncClientService';
import { resetWorkspaceCloudBootstrapForTests } from './services/workspace/workspaceCloudBootstrapService';
import { resetSyncCoordinatorForTests } from './services/sync/syncCoordinator';
import { resetTestStores } from './test/resetStores';
import { clearMockRpcHandlers, registerMockRpcHandler } from './test/mockProfileStore';
import { loginAsDefaultAdmin } from './test/authFixtures';
import { getMockCurrentSession } from './test/mockSupabaseAuth';

const WORKSPACE_ID = 'multi-origin-ws';
const COMPANY_NAME = 'Cirmak Haustechnik GmbH';

let userId = '';

// --- Supabase-Seam: der gemeinsame Test-Client beantwortet die RPCs ---------
type RpcCall = { name: string; entity?: string; companyName?: string; setupComplete?: boolean };

const rpcLog: RpcCall[] = [];
let ensureAnswer: () => unknown = () => ensureRpcData(false);
let pullAnswer: () => unknown = () => pullRpcData();

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
    rpcLog.push({
      name: 'upsert_workspace_sync_entity',
      entity,
      companyName: inner.companyName,
      setupComplete: inner.setupComplete,
    });
    return { row_version: 8, payload: args.p_payload ?? {} };
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

/** Die Cloud kennt den Betrieb bereits — Setup und Firmenprofil sind gefüllt. */
function pullRpcData(options: { empty?: boolean } = {}) {
  const base = {
    workspace: workspaceRow(),
    members: [],
    settings: null,
    vorgaenge: [],
  };
  if (options.empty) {
    return { ...base, setup: null, company_profile: null };
  }
  return {
    ...base,
    setup: {
      workspace_id: WORKSPACE_ID,
      payload: {
        ...DEFAULT_SETUP,
        companyName: COMPANY_NAME,
        setupComplete: true,
        setupVersion: 1,
      },
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

function networkErrorAnswer(): unknown {
  throw new Error('Failed to fetch');
}

function rlsErrorAnswer(): unknown {
  throw new Error('permission denied');
}

function seedCompleteLocalState(): void {
  savePersistedStateToKey(
    { type: 'user', userId },
    {
      ...createSeedState({
        ...DEFAULT_SETUP,
        companyName: COMPANY_NAME,
        setupComplete: true,
        setupVersion: 1,
      }),
      version: STORAGE_VERSION,
      syncClient: createSyncClient(),
      savedAt: '2026-05-05T08:00:00.000Z',
    },
  );
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

async function click(container: HTMLElement, testId: string): Promise<void> {
  const element = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
  expect(element, `Schaltfläche ${testId} fehlt`).not.toBeNull();
  await act(async () => {
    element!.click();
  });
  await settle();
}

const names = (): string[] => rpcLog.map((entry) => entry.name);
const countOf = (name: string): number => names().filter((entry) => entry === name).length;
const companyUpserts = (): RpcCall[] =>
  rpcLog.filter(
    (entry) =>
      entry.name === 'upsert_workspace_sync_entity' &&
      (entry.entity === 'company_setup' || entry.entity === 'company_profile'),
  );

describe('OFFICEPILOT-MULTI-ORIGIN-SETUP-01B2/01B3', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    rpcLog.length = 0;
    clearMockRpcHandlers();
    registerHandlers();
    ensureAnswer = () => ensureRpcData(false);
    pullAnswer = () => pullRpcData();
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

  it('F1: bestehender Cloud-Workspace stellt die Firmendaten ohne Assistenten her', async () => {
    const container = await mountApp();

    expect(container.querySelector('[data-testid="workspace-restore-failure"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-setup-not-found"]')).toBeNull();
    expect(container.querySelector('[data-testid="first-run-wizard"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="app-shell"]'),
      'App nicht geöffnet',
    ).not.toBeNull();
  });

  it('F2: der erste Pull steht vor jedem Upsert von Firmendaten', async () => {
    await mountApp();

    const order = names();
    expect(order[0]).toBe('ensure_personal_workspace');
    const firstPull = order.indexOf('pull_workspace_sync_state');
    expect(firstPull, 'kein Pull ausgeführt').toBeGreaterThan(-1);

    const firstCompanyUpsert = rpcLog.findIndex(
      (entry) =>
        entry.name === 'upsert_workspace_sync_entity' &&
        (entry.entity === 'company_setup' || entry.entity === 'company_profile'),
    );
    if (firstCompanyUpsert > -1) {
      expect(firstCompanyUpsert).toBeGreaterThan(firstPull);
    }
    // Kein Upsert darf einen leeren Firmennamen oder setupComplete:false tragen.
    for (const entry of companyUpserts()) {
      expect(entry.companyName ?? COMPANY_NAME).not.toBe('');
      expect(entry.setupComplete ?? true).not.toBe(false);
    }
  });

  it('F3: nach erfolgreichem Pull bleiben Firmenname und setupComplete erhalten', async () => {
    await mountApp();

    const raw = localStorage.getItem(`officepilot-state:workspace:${WORKSPACE_ID}`);
    expect(raw, 'Workspace-Zustand fehlt').not.toBeNull();
    const stored = JSON.parse(raw!) as { setup?: { companyName?: string; setupComplete?: boolean } };
    expect(stored.setup?.companyName).toBe(COMPANY_NAME);
    expect(stored.setup?.setupComplete).toBe(true);
  });

  it('F4: Bootstrap-Fehler bei leerem lokalen Speicher zeigt die Wiederherstellungsansicht', async () => {
    ensureAnswer = networkErrorAnswer;
    const container = await mountApp();

    expect(container.querySelector('[data-testid="workspace-restore-failure"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="first-run-wizard"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();
    expect(container.textContent).toContain('Ihre Firmendaten konnten nicht geladen werden');
    expect(container.textContent).toContain('OfficePilot startet deshalb keine neue Einrichtung');
    expect(container.textContent).not.toContain('nicht verloren');
  });

  it('F4b: bei fehlgeschlagenem Pull wird kein lokales Default-Setup hochgeladen', async () => {
    pullAnswer = networkErrorAnswer;
    const container = await mountApp();

    expect(container.querySelector('[data-testid="workspace-restore-failure"]')).not.toBeNull();
    expect(countOf('pull_workspace_sync_state')).toBeGreaterThan(0);
    expect(companyUpserts()).toEqual([]);
  });

  it('F5: "Erneut versuchen" führt RPC und Pull wirklich erneut aus', async () => {
    ensureAnswer = networkErrorAnswer;
    const container = await mountApp();
    expect(countOf('ensure_personal_workspace')).toBe(1);
    expect(countOf('pull_workspace_sync_state')).toBe(0);

    // Netz ist wieder da.
    ensureAnswer = () => ensureRpcData(false);
    await click(container, 'workspace-restore-retry');

    expect(countOf('ensure_personal_workspace')).toBe(2);
    expect(countOf('pull_workspace_sync_state')).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
  });

  it('F6: vollständiges lokales Setup bleibt bei Netzfehler offline nutzbar', async () => {
    seedCompleteLocalState();
    ensureAnswer = networkErrorAnswer;

    const container = await mountApp();

    expect(container.querySelector('[data-testid="workspace-restore-failure"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
  });

  it('F7: ein serverseitig bestätigter neuer Workspace führt direkt in den Assistenten', async () => {
    ensureAnswer = () => ensureRpcData(true);
    pullAnswer = () => pullRpcData({ empty: true });

    const container = await mountApp();

    expect(container.querySelector('[data-testid="workspace-restore-failure"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-setup-not-found"]')).toBeNull();
    expect(container.querySelector('[data-testid="first-run-wizard"]')).not.toBeNull();
  });

  it('F8: "Mit anderem Konto anmelden" meldet ab und öffnet die Login-Seite', async () => {
    ensureAnswer = rlsErrorAnswer;
    const container = await mountApp();
    // Ausgangslage: angemeldet, keine Login-Seite.
    expect(getMockCurrentSession()).not.toBeNull();
    expect(container.querySelector('[data-testid="login-submit"]')).toBeNull();

    await click(container, 'workspace-restore-switch-account');

    expect(getMockCurrentSession(), 'Sitzung besteht weiter').toBeNull();
    expect(container.querySelector('[data-testid="workspace-restore-failure"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="login-submit"]'),
      'LoginPage fehlt',
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="first-run-wizard"]')).toBeNull();
  });

  it('F8b: derselbe Kontowechsel funktioniert auf der SetupPage', async () => {
    ensureAnswer = () => ensureRpcData(true);
    pullAnswer = () => pullRpcData({ empty: true });
    const container = await mountApp('/setup');
    expect(container.querySelector('[data-testid="setup-existing-customer"]')).not.toBeNull();

    await click(container, 'setup-switch-account');

    expect(getMockCurrentSession(), 'Sitzung besteht weiter').toBeNull();
    expect(
      container.querySelector('[data-testid="login-submit"]'),
      'LoginPage fehlt',
    ).not.toBeNull();
    // Kein Rücksprung auf /setup.
    expect(container.querySelector('[data-testid="first-run-wizard"]')).toBeNull();
  });

  it('F9: ein Retry legt keinen zweiten Workspace an', async () => {
    await mountApp();
    await unmountApp();
    resetWorkspaceCloudBootstrapForTests();
    await mountApp();

    expect(countOf('ensure_personal_workspace')).toBeGreaterThan(1);
    expect(
      rpcLog.filter(
        (entry) => entry.name === 'upsert_workspace_sync_entity' && entry.entity === 'workspace',
      ),
    ).toEqual([]);
    const workspaceKeys = Object.keys(localStorage).filter((key) =>
      key.startsWith('officepilot-state:workspace:'),
    );
    expect(workspaceKeys).toEqual([`officepilot-state:workspace:${WORKSPACE_ID}`]);
  });

  it('F10: ein technischer Fehler löscht keine lokalen Daten', async () => {
    seedCompleteLocalState();
    ensureAnswer = networkErrorAnswer;

    await mountApp();

    const raw = localStorage.getItem(`officepilot-state:user:${userId}`);
    expect(raw, 'lokaler Zustand wurde entfernt').not.toBeNull();
    expect(raw).toContain(COMPANY_NAME);
  });

  /**
   * OFFICEPILOT-MULTI-ORIGIN-SETUP-01B3 — bestehender Workspace ohne
   * abgeschlossenes Cloud-Setup: kein automatischer Assistent.
   */
  it('F11: bestehender Workspace ohne Cloud-Setup öffnet den Assistenten erst nach bewusster Aktion', async () => {
    ensureAnswer = () => ensureRpcData(false);
    pullAnswer = () => pullRpcData({ empty: true });

    const container = await mountApp();

    expect(container.querySelector('[data-testid="first-run-wizard"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="workspace-setup-not-found"]'),
      'Zwischenansicht fehlt',
    ).not.toBeNull();
    expect(container.textContent).toContain(
      'Für dieses Konto wurde kein abgeschlossener Betrieb gefunden',
    );
    expect(container.querySelector('[data-testid="workspace-setup-recheck"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workspace-setup-switch-account"]')).not.toBeNull();

    await click(container, 'workspace-setup-continue');

    expect(container.querySelector('[data-testid="workspace-setup-not-found"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="first-run-wizard"]'),
      'Assistent fehlt',
    ).not.toBeNull();
  });
});
