/**
 * FINANZ-CORE-01A (WEISS-Recheck 21d, P2 T8-02) — Mitarbeiter-Erstzugang, Clientvertrag.
 *
 * Seit 20261124120000_fc01a_mitglied_erstzugang.sql liefert `ensure_personal_workspace` einem Konto ohne
 * eigenen Betrieb die bestehende aktive Mitgliedschaft (admin/member) mit `created = false`, statt einen
 * neuen Betrieb anzulegen. Geprüft wird, dass der reale Stapel AuthProvider → BusinessStateGate → App diese
 * Antwort als Erstzugang in den Betrieb des Arbeitgebers behandelt: kein Einrichtungsassistent, die Rolle
 * bleibt member (keine Schreibrechte in der Oberfläche) und beim Erstzugang wird nichts gesendet, was ein
 * Mitglied nicht senden darf. Gestubbt sind nur die Supabase-RPC-Antworten.
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
import { resetWorkspaceCloudBootstrapForTests } from './services/workspace/workspaceCloudBootstrapService';
import { resetSyncCoordinatorForTests } from './services/sync/syncCoordinator';
import { getSyncOutboxSnapshot } from './services/sync/syncOutboxService';
import { getWorkspaceStoreSnapshot } from './services/workspace/workspaceStore';
import { resolveWorkspaceWriteAccess } from './services/workspace/workspaceRoleService';
import { resetTestStores } from './test/resetStores';
import { clearMockRpcHandlers, registerMockRpcHandler } from './test/mockProfileStore';
import { loginAsDefaultAdmin } from './test/authFixtures';
import { getMockCurrentSession } from './test/mockSupabaseAuth';

const WORKSPACE_ID = 'arbeitgeber-ws';
const OWNER_ID = 'inhaber-des-arbeitgebers';
const COMPANY_NAME = 'Arbeitgeber Haustechnik GmbH';

let userId = '';
const rpcLog: Array<{ name: string; entity?: string }> = [];

function workspaceRow() {
  return {
    id: WORKSPACE_ID,
    name: COMPANY_NAME,
    owner_user_id: OWNER_ID,
    created_at: '2026-01-05T08:00:00.000Z',
    updated_at: '2026-05-05T08:00:00.000Z',
    version: 3,
  };
}

function memberRow(user: string, role: 'owner' | 'member') {
  return {
    workspace_id: WORKSPACE_ID,
    user_id: user,
    role,
    status: 'active',
    created_at: '2026-06-01T08:00:00.000Z',
    updated_at: '2026-06-01T08:00:00.000Z',
  };
}

function registerHandlers(): void {
  // Antwort der korrigierten Serverfunktion: bestehende member-Mitgliedschaft, nichts angelegt.
  registerMockRpcHandler('ensure_personal_workspace', () => {
    rpcLog.push({ name: 'ensure_personal_workspace' });
    return { workspace: workspaceRow(), member: memberRow(userId, 'member'), created: false };
  });
  registerMockRpcHandler('pull_workspace_sync_state', () => {
    rpcLog.push({ name: 'pull_workspace_sync_state' });
    return {
      workspace: workspaceRow(),
      members: [memberRow(OWNER_ID, 'owner'), memberRow(userId, 'member')],
      settings: null,
      vorgaenge: [],
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
  });
  registerMockRpcHandler('pull_workspace_invoices', () => []);
  registerMockRpcHandler('pull_workspace_order_amendments', () => []);
  registerMockRpcHandler('upsert_workspace_sync_entity', (args) => {
    rpcLog.push({ name: 'upsert_workspace_sync_entity', entity: String(args.p_entity_type ?? '') });
    throw new Error('Keine Schreibberechtigung');
  });
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

const countOf = (name: string): number => rpcLog.filter((entry) => entry.name === name).length;
const offeneOderAbgewieseneAuftraege = () =>
  getSyncOutboxSnapshot().filter((entry) => entry.status !== 'completed');

describe('FINANZ-CORE-01A — Mitarbeiter-Erstzugang (Clientvertrag zu 20261124)', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    rpcLog.length = 0;
    clearMockRpcHandlers();
    registerHandlers();
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

  it('E-C1: das Mitglied erreicht beim ersten Login den Betrieb des Arbeitgebers ohne Assistenten', async () => {
    const container = await mountApp();

    expect(countOf('ensure_personal_workspace')).toBe(1);
    expect(container.querySelector('[data-testid="workspace-restore-failure"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-setup-not-found"]')).toBeNull();
    expect(container.querySelector('[data-testid="first-run-wizard"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]'), 'App nicht geöffnet').not.toBeNull();

    expect(getWorkspaceStoreSnapshot()?.id).toBe(WORKSPACE_ID);
    expect(getWorkspaceStoreSnapshot()?.ownerUserId).toBe(OWNER_ID);
    const raw = localStorage.getItem(`officepilot-state:workspace:${WORKSPACE_ID}`);
    expect(raw, 'Zustand des Arbeitgeberbetriebs fehlt').not.toBeNull();
    const stored = JSON.parse(raw!) as { setup?: { companyName?: string; setupComplete?: boolean } };
    expect(stored.setup?.companyName).toBe(COMPANY_NAME);
    expect(stored.setup?.setupComplete).toBe(true);
  });

  it('E-C2: die Rolle bleibt member — keine Schreibrechte in der Oberfläche, keine künstliche Inhaberrolle', async () => {
    await mountApp();

    const access = resolveWorkspaceWriteAccess({ userId, cloudConfigured: true });
    expect(access).toEqual({ canWrite: false, canIntake: true, role: 'member', reason: 'member' });
  });

  it('E-C3: beim Erstzugang sendet das Mitglied nichts, was ein Mitglied nicht senden darf', async () => {
    await mountApp();

    expect(rpcLog.filter((entry) => entry.name === 'upsert_workspace_sync_entity')).toEqual([]);
    expect(offeneOderAbgewieseneAuftraege()).toEqual([]);
  });

  it('E-C4: nach dem Neuladen bleibt es derselbe Betrieb mit derselben Rolle', async () => {
    await mountApp();
    await unmountApp();
    // Neuladen: Speicher bleibt, Laufzeitzustand und Einmalschutz beginnen neu.
    resetTestStores();
    resetWorkspaceCloudBootstrapForTests();
    resetSyncCoordinatorForTests();

    const container = await mountApp();

    expect(container.querySelector('[data-testid="first-run-wizard"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-restore-failure"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]'), 'App nach Neuladen nicht geöffnet').not.toBeNull();
    expect(getWorkspaceStoreSnapshot()?.id).toBe(WORKSPACE_ID);
    expect(resolveWorkspaceWriteAccess({ userId, cloudConfigured: true }).role).toBe('member');
    expect(rpcLog.filter((entry) => entry.name === 'upsert_workspace_sync_entity')).toEqual([]);
  });
});
