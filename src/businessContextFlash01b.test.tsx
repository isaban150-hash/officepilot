/**
 * BUSINESS-CONTEXT-FLASH-01B — ein zweiter Bootstrap-Lauf darf den bereits
 * freigegebenen Betrieb nicht verlieren.
 *
 * Realbefund iPhone/Safari: Bei laufender App mit vorhandenem lokalem Betrieb
 * erschien kurz als Vollbild „Für dieses Konto wurde kein abgeschlossener
 * Betrieb gefunden" — und verschwand ohne Nutzereingriff wieder.
 *
 * Analysierte Ursache: `bootstrapBusinessState({ userId })` **ohne**
 * `workspaceId` verlässt beim Zweitlauf den Workspace-Scope, legt im leeren
 * User-Scope einen Seed an (`setupComplete: false`), und der Cloud-Bootstrap
 * stellt den Scope wegen seines Once-Guards nicht wieder her. Das Gate liest
 * den leeren Seed als „kein Betrieb".
 *
 * Geprüft wird der reale Stapel AuthProvider → BusinessStateGate → App.
 * Gestubbt sind nur die Supabase-RPC-Antworten: kein Netzwerk, keine Kosten.
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
import { getCachedSetup } from './services/persistenceService';
import { getActiveStorageScope, buildStorageKey } from './services/storage/storageScopeService';
import {
  getLastSuccessfulWorkspaceBootstrap,
  prepareWorkspaceCloudBootstrapRetry,
  resetWorkspaceCloudBootstrapForTests,
} from './services/workspace/workspaceCloudBootstrapService';
import { resetSyncCoordinatorForTests } from './services/sync/syncCoordinator';
import { resetTestStores } from './test/resetStores';
import { clearMockRpcHandlers, registerMockRpcHandler } from './test/mockProfileStore';
import { login, loginAsDefaultAdmin, registerAndApproveUser } from './test/authFixtures';
import { getMockCurrentSession } from './test/mockSupabaseAuth';

const WORKSPACE_ID = 'flash-01b-ws';
const COMPANY_NAME = 'Cirmak Haustechnik GmbH';

let userId = '';
let ensureAnswer: () => unknown;
let pullAnswer: () => unknown;

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

function registerHandlers(): void {
  registerMockRpcHandler('ensure_personal_workspace', () => ensureAnswer());
  registerMockRpcHandler('pull_workspace_sync_state', () => pullAnswer());
  registerMockRpcHandler('pull_workspace_invoices', () => []);
  registerMockRpcHandler('pull_workspace_order_amendments', () => []);
  registerMockRpcHandler('upsert_workspace_sync_entity', (args) => ({
    row_version: 8,
    payload: args.p_payload ?? {},
  }));
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;
/** Jeder Frame, in dem die Sperrfläche im DOM stand — auch kurzzeitig. */
let notFoundFrames = 0;

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
    if (host?.querySelector('[data-testid="workspace-setup-not-found"]')) {
      notFoundFrames += 1;
    }
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

function workspaceKeys(): string[] {
  return Object.keys(localStorage).filter((key) =>
    key.startsWith('officepilot-state:workspace:'),
  );
}

function userScopeState(): { setupComplete?: boolean } | null {
  const raw = localStorage.getItem(buildStorageKey({ type: 'user', userId }));
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { setup?: { setupComplete?: boolean } }).setup ?? null;
  } catch {
    return null;
  }
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  notFoundFrames = 0;
  clearMockRpcHandlers();
  registerHandlers();
  ensureAnswer = () => ensureRpcData(false);
  pullAnswer = () => pullRpcData();
  // Räumt seit 01C auch die Nutzer-Workspace-Bindung mit.
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
  // Räumt seit 01C auch die Nutzer-Workspace-Bindung mit.
  resetWorkspaceCloudBootstrapForTests();
  localStorage.clear();
});

describe('BUSINESS-CONTEXT-FLASH-01B — Erstlauf', () => {
  it('R1: ein vorhandener Cloud-Workspace öffnet die normale App', async () => {
    const container = await mountApp();

    expect(container.querySelector('[data-testid="workspace-setup-not-found"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]'), 'App nicht offen').not.toBeNull();
    expect(getCachedSetup().setupComplete).toBe(true);
    expect(getActiveStorageScope()).toEqual({ type: 'workspace', workspaceId: WORKSPACE_ID });
  });

  it('R12: ohne vorbekannten Workspace läuft der normale Cloud-Bootstrap', async () => {
    await mountApp();

    // Der Workspace entstand erst über den RPC-Weg, nicht aus einer geratenen ID.
    expect(workspaceKeys()).toEqual([`officepilot-state:workspace:${WORKSPACE_ID}`]);
  });
});

describe('BUSINESS-CONTEXT-FLASH-01B — Zweitlauf für denselben Nutzer', () => {
  /*
   * Der Kernregressionstest.
   *
   * Reproduziert wird die analysierte Sequenz: erfolgreicher Erstlauf, danach
   * ein weiterer Gate-Lauf, **ohne** den Cloud-Once-Guard zurückzusetzen. Genau
   * dort fiel der bisherige Code auf den leeren User-Scope zurück.
   */
  async function secondGateRun(): Promise<HTMLDivElement> {
    await mountApp();
    expect(getCachedSetup().setupComplete, 'Erstlauf schon fehlgeschlagen').toBe(true);
    await unmountApp();
    notFoundFrames = 0;
    // Kein resetWorkspaceCloudBootstrapForTests: der Once-Guard bleibt gesetzt.
    return mountApp();
  }

  it('R2/R5: der Zweitlauf zeigt die Sperrfläche zu keinem Zeitpunkt', async () => {
    const container = await secondGateRun();

    expect(notFoundFrames, 'Die Sperrfläche blitzte auf').toBe(0);
    expect(container.querySelector('[data-testid="workspace-setup-not-found"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
  });

  it('R3/R11: der Zweitlauf bleibt im Workspace-Scope', async () => {
    await secondGateRun();

    expect(getActiveStorageScope()).toEqual({ type: 'workspace', workspaceId: WORKSPACE_ID });
  });

  it('R10: das abgeschlossene Setup bleibt erhalten', async () => {
    await secondGateRun();

    expect(getCachedSetup().setupComplete).toBe(true);
    expect(getCachedSetup().companyName).toBe(COMPANY_NAME);
  });

  it('R4: der Zweitlauf legt keinen leeren User-Seed als Ersatz an', async () => {
    await secondGateRun();

    const userSetup = userScopeState();
    // Entweder gar kein User-Scope-Eintrag — oder jedenfalls kein leerer Ersatz.
    expect(userSetup?.setupComplete ?? true, 'leerer User-Seed entstanden').toBe(true);
    expect(workspaceKeys()).toEqual([`officepilot-state:workspace:${WORKSPACE_ID}`]);
  });
});

describe('BUSINESS-CONTEXT-FLASH-01C — Testreset trennt sauber', () => {
  /*
   * R13/R14 — die Bindung überdauert produktiv einen Remount, aber niemals den
   * gemeinsamen Testreset.
   *
   * Ohne diese Trennung wären die bestehenden Setup- und Recovery-Suiten nur
   * deshalb grün, weil ein Workspace aus dem vorherigen Test weiterlebte. Genau
   * das prüfen diese beiden Tests direkt an der Bindung.
   */
  it('R14: ohne Testreset überlebt die Bindung — das ist der produktive Remount-Schutz', async () => {
    await mountApp();
    expect(getLastSuccessfulWorkspaceBootstrap()).toEqual({ userId, workspaceId: WORKSPACE_ID });
    await unmountApp();

    // Ein Remount allein löscht nichts.
    expect(getLastSuccessfulWorkspaceBootstrap()).toEqual({ userId, workspaceId: WORKSPACE_ID });
  });

  it('R13: der gemeinsame Testreset löscht die Bindung', async () => {
    await mountApp();
    expect(getLastSuccessfulWorkspaceBootstrap()).not.toBeNull();
    await unmountApp();

    resetTestStores();

    expect(
      getLastSuccessfulWorkspaceBootstrap(),
      'Ein Workspace überlebte den Testreset — alte Suiten wären nur zufällig grün',
    ).toBeNull();
  });

  it('R13b: auch der Wiederholversuch löst die Bindung', async () => {
    await mountApp();
    expect(getLastSuccessfulWorkspaceBootstrap()).not.toBeNull();

    prepareWorkspaceCloudBootstrapRetry();

    expect(getLastSuccessfulWorkspaceBootstrap()).toBeNull();
  });
});

describe('BUSINESS-CONTEXT-FLASH-01B — Kontowechsel', () => {
  /*
   * R8 — die Sicherheitsregression.
   *
   * Der erhaltene Workspace ist an den Nutzer gebunden. Wechselt das Konto,
   * darf die bekannte ID nicht weiterverwendet werden — auch dann nicht, wenn
   * sie noch im Speicher steht.
   */
  it('R8: ein anderes Konto übernimmt den Workspace des vorherigen Nutzers nicht', async () => {
    await mountApp();
    expect(getActiveStorageScope()).toEqual({ type: 'workspace', workspaceId: WORKSPACE_ID });
    const firstUserId = userId;
    await unmountApp();

    // Zweites, freigeschaltetes Konto — eigener Workspace in der Cloud.
    const secondUser = await registerAndApproveUser('zweiter@officepilot.local');
    await login('zweiter@officepilot.local', 'TestPasswort1');
    userId = getMockCurrentSession()?.user.id ?? '';
    expect(userId, 'Kontowechsel fehlgeschlagen').not.toBe(firstUserId);
    expect(secondUser.id).toBe(userId);

    const otherWorkspaceId = 'flash-01b-ws-b';
    ensureAnswer = () => ({
      ...ensureRpcData(false),
      workspace: { ...workspaceRow(), id: otherWorkspaceId },
    });
    pullAnswer = () => {
      const data = pullRpcData();
      return {
        ...data,
        workspace: { ...workspaceRow(), id: otherWorkspaceId },
        setup: { ...data.setup!, workspace_id: otherWorkspaceId },
        company_profile: { ...data.company_profile!, workspace_id: otherWorkspaceId },
      };
    };

    await mountApp();

    const scope = getActiveStorageScope();
    expect(scope, 'Workspace des Vorgängers wurde übernommen').not.toEqual({
      type: 'workspace',
      workspaceId: WORKSPACE_ID,
    });
  });
});

describe('BUSINESS-CONTEXT-FLASH-01B — Schutzfläche bleibt', () => {
  /*
   * R6/R7 — der echte Fall darf nicht verschwinden: Der Server bestätigt einen
   * bestehenden Workspace, der aber kein abgeschlossenes Setup trägt.
   */
  it('R6/R7: ohne abgeschlossenen Betrieb erscheint die Sperrfläche und kein Assistent', async () => {
    pullAnswer = () => pullRpcData({ empty: true });

    const container = await mountApp();

    expect(
      container.querySelector('[data-testid="workspace-setup-not-found"]'),
      'Schutzfläche verschwunden',
    ).not.toBeNull();
    // Keine automatische Einrichtung: der Assistent bleibt zu.
    expect(container.querySelector('[data-testid="first-run-wizard"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();
    // Die ausdrückliche Nutzeraktion ist weiterhin angeboten, aber nicht ausgeführt.
    expect(container.querySelector('[data-testid="workspace-setup-continue"]')).not.toBeNull();
  });
});
