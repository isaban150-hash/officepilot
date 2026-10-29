/**
 * EINRICHTUNG-01 (AP2) — Anmeldung und Sitzung im echten Stapel AuthProvider → BusinessStateGate → App (Katalog V3,
 * Gruppe A und N-A). Gestubbt sind nur Auth-Server und RPC-Antworten; kein Netzwerk.
 *
 *   A-01.1/A-02.1  Profilabruf scheitert (Netz) bei bekanntem Profil: angemeldet bleiben, Hinweis, Wiederholung.
 *   A-10.2         … ohne bekanntes Profil: keine Anmeldeseite, keine Abmeldung, „Verbindung gestört“.
 *   A-01.3/N-A2.2  Server weist die Sitzung ab (401): Abmeldung mit Hinweis.
 *   A-10.1         Server bestätigt: kein Profil: Abmeldung mit Hinweis.
 *   B3             `session_not_active` aus einer Serverantwort: Anmeldung verlangt.
 *   A-03.1         Abmelden während eines Profilabrufs: bleibt abgemeldet.
 *   N-A1.6         TOKEN_REFRESHED desselben Kontos: kein neuer Abruf.
 *   A-04/A-05/A-06 Abmelden lokal bzw. überall; Warnung bei ungesendeten Änderungen, „Abbrechen“ behält die Sitzung.
 *   A-12.1         abgemeldet eine Seite aufrufen: nach der Anmeldung dorthin.
 *   A-13.3/A-14    Zustimmung fehlt oder ist veraltet: erst die Zustimmungsseite; Ablehnen meldet ab.
 *   A-07.2         unbestätigte E-Mail: eigener Hinweis und „Bestätigung erneut senden“ (60 s gesperrt).
 *   A-09.1         Ausnahme bei der Anmeldung: Meldung, Formular wieder bedienbar.
 *   A-15.1         Warteseite erkennt die Freischaltung ohne Neuladen.
 *   A-11.1         Wiederherstellung in einem anderen Tab: dieser Tab zeigt nur das Formular, kein Bootstrap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { BusinessStateGate } from './components/system/BusinessStateGate';
import { resetWorkspaceCloudBootstrapForTests } from './services/workspace/workspaceCloudBootstrapService';
import { resetSyncCoordinatorForTests } from './services/sync/syncCoordinator';
import { resetWorkspaceAccessForTests } from './services/workspace/workspaceAccessService';
import { clearCloudRightsState, isCloudRightsUnconfirmed } from './services/auth/cloudRightsState';
import { PASSWORD_RECOVERY_SHARED_KEY } from './services/auth/supabaseAuthService';
import { resetTestStores } from './test/resetStores';
import { clearMockRpcHandlers, getMockProfile, patchMockProfile, registerMockRpcHandler } from './test/mockProfileStore';
import { persistAll } from './services/persistenceService';
import { approveUser, login, loginAsDefaultAdmin, registerPendingTestUser } from './test/authFixtures';
import {
  emitMockAuthEvent,
  getMockCurrentSession,
  getMockLastSignOutScope,
  getMockProfileFetchCount,
  releaseMockProfileFetches,
  setMockProfileFetchMode,
  setMockSignInFailure,
} from './test/mockSupabaseAuth';
import { enqueueSyncOutbox, getSyncOutboxSnapshot } from './services/sync/syncOutboxService';

const WORKSPACE_ID = '00000000-0000-4000-8000-00000000a2a2';
let userId = '';
const rpcLog: string[] = [];

function workspaceRow() {
  return { id: WORKSPACE_ID, name: 'Sitzung GmbH', owner_user_id: userId, created_at: '2026-01-05T08:00:00.000Z', updated_at: '2026-05-05T08:00:00.000Z', version: 3 };
}
function memberRow() {
  return { workspace_id: WORKSPACE_ID, user_id: userId, role: 'owner', status: 'active', created_at: '2026-01-05T08:00:00.000Z', updated_at: '2026-01-05T08:00:00.000Z' };
}
function defaultPull(): unknown {
  return {
  workspace: workspaceRow(),
  members: [memberRow()],
  settings: null,
  vorgaenge: [],
  setup: { workspace_id: WORKSPACE_ID, payload: { ...DEFAULT_SETUP, companyName: 'Sitzung GmbH', setupComplete: true, setupVersion: 1 }, row_version: 7, updated_at: '2026-05-05T08:00:00.000Z' },
  company_profile: { workspace_id: WORKSPACE_ID, payload: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Sitzung GmbH' }, row_version: 7, updated_at: '2026-05-05T08:00:00.000Z' },
  };
}
let pullAnswer: () => unknown = defaultPull;

function registerHandlers(): void {
  registerMockRpcHandler('ensure_personal_workspace', () => {
    rpcLog.push('ensure_personal_workspace');
    return { workspace: workspaceRow(), member: memberRow(), created: false };
  });
  registerMockRpcHandler('pull_workspace_sync_state', () => {
    rpcLog.push('pull_workspace_sync_state');
    return pullAnswer();
  });
  registerMockRpcHandler('get_workspace_access', (args) => ({ workspace_id: args.p_workspace_id, role: 'owner', license_state: 'effective', license_effective: true }));
  registerMockRpcHandler('pull_workspace_invoices', () => []);
  registerMockRpcHandler('pull_workspace_order_amendments', () => []);
  registerMockRpcHandler('upsert_workspace_sync_entity', (args) => {
    rpcLog.push(`upsert:${String(args.p_entity_type ?? '')}`);
    return { row_version: 8, payload: args.p_payload ?? {} };
  });
}

const verlauf: string[] = [];
function LocationProbe() {
  const location = useLocation();
  const pfad = `${location.pathname}${location.search}`;
  if (verlauf[verlauf.length - 1] !== pfad) verlauf.push(pfad);
  return <div data-testid="location" data-path={pfad} />;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mountApp(entry = '/'): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[entry]}>
        <AuthProvider>
          <BusinessStateGate>
            <App />
          </BusinessStateGate>
        </AuthProvider>
        <LocationProbe />
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

const q = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);

async function click(c: HTMLElement, id: string): Promise<void> {
  const el = q(c, id) as HTMLElement | null;
  expect(el, id).not.toBeNull();
  await act(async () => {
    el!.click();
  });
  await settle();
}

function setValue(element: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function loginForm(c: HTMLElement, email: string, password: string): Promise<void> {
  await act(async () => {
    setValue(c.querySelector('[data-testid="login-email"] input, input[data-testid="login-email"]') as HTMLInputElement, email);
    setValue(c.querySelector('[data-testid="login-password"] input, input[data-testid="login-password"]') as HTMLInputElement, password);
  });
  await act(async () => {
    (c.querySelector('form.auth-form') as HTMLFormElement).requestSubmit();
  });
  await settle();
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  rpcLog.length = 0;
  pullAnswer = defaultPull;
  clearMockRpcHandlers();
  registerHandlers();
  resetWorkspaceCloudBootstrapForTests();
  resetSyncCoordinatorForTests();
  resetWorkspaceAccessForTests();
  clearCloudRightsState();
  await loginAsDefaultAdmin();
  userId = getMockCurrentSession()?.user.id ?? '';
  expect(userId).not.toBe('');
});

afterEach(async () => {
  await unmountApp();
  setMockProfileFetchMode(null);
  releaseMockProfileFetches();
  setMockSignInFailure(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearMockRpcHandlers();
  resetTestStores();
  resetWorkspaceCloudBootstrapForTests();
  resetWorkspaceAccessForTests();
  clearCloudRightsState();
  localStorage.clear();
  sessionStorage.clear();
});

describe('A-01 / A-10 — Profilabruf scheitert', () => {
  it('A-01.1/A-02.1 bekanntes Profil: angemeldet bleiben mit Hinweis; die Wiederholung bestätigt', async () => {
    const erst = await mountApp('/');
    expect(q(erst, 'app-shell')).not.toBeNull();
    expect(q(erst, 'connection-issue-banner')).toBeNull();
    await unmountApp();

    setMockProfileFetchMode('network');
    const c = await mountApp('/');
    expect(q(c, 'app-shell'), 'App bleibt offen').not.toBeNull();
    expect(q(c, 'login-page')).toBeNull();
    expect(q(c, 'connection-issue-banner')?.textContent).toContain('Sie bleiben angemeldet');
    expect(getMockCurrentSession()).not.toBeNull();

    setMockProfileFetchMode(null);
    await click(c, 'connection-issue-retry');
    expect(q(c, 'connection-issue-banner')).toBeNull();
    expect(q(c, 'app-shell')).not.toBeNull();
  });

  it('A-10.2 ohne bekanntes Profil: keine Abmeldung, keine Anmeldeseite, keine Daten', async () => {
    setMockProfileFetchMode('network');
    const c = await mountApp('/');
    expect(q(c, 'profile-unavailable-page')).not.toBeNull();
    expect(q(c, 'login-page')).toBeNull();
    expect(q(c, 'app-shell')).toBeNull();
    expect(getMockCurrentSession()).not.toBeNull();
    expect(rpcLog).not.toContain('pull_workspace_sync_state');
    setMockProfileFetchMode(null);
    await click(c, 'profile-unavailable-retry');
    expect(q(c, 'app-shell')).not.toBeNull();
  });

  it('A-01.3/N-A2.2 Server weist die Sitzung ab: Abmeldung dieses Geräts mit Hinweis', async () => {
    setMockProfileFetchMode('unauthorized');
    const c = await mountApp('/');
    expect(q(c, 'login-page')).not.toBeNull();
    expect(q(c, 'login-logout-reason')?.getAttribute('data-reason')).toBe('session_invalid');
    expect(getMockLastSignOutScope()).toBe('local');
  });

  it('A-10.1 Server bestätigt: kein Profil — Abmeldung mit Hinweis', async () => {
    setMockProfileFetchMode('missing');
    const c = await mountApp('/');
    expect(q(c, 'login-page')).not.toBeNull();
    expect(q(c, 'login-logout-reason')?.getAttribute('data-reason')).toBe('profile_missing');
    expect(getMockCurrentSession()).toBeNull();
  });

  it('B3 session_not_active aus einer Serverantwort: Anmeldung verlangt, keine fremden Daten', async () => {
    pullAnswer = () => {
      throw new Error('session_not_active: Die Sitzung ist beendet');
    };
    const c = await mountApp('/');
    expect(q(c, 'login-page')).not.toBeNull();
    expect(q(c, 'login-logout-reason')?.getAttribute('data-reason')).toBe('session_invalid');
    expect(q(c, 'app-shell')).toBeNull();
  });
});

describe('A-02 — Offline-Start', () => {
  it('A-02.1/A-02.2/A-02.3 kontogebundener Bestand des letzten Kontos, kein Cloud-Bootstrap, cloudbestätigte Aktionen gesperrt', async () => {
    const online = await mountApp('/');
    expect(q(online, 'app-shell')).not.toBeNull();
    await unmountApp();

    // Neustart ohne Netz: Profilabruf und RPCs scheitern.
    setMockProfileFetchMode('network');
    pullAnswer = () => {
      throw new TypeError('Failed to fetch');
    };
    rpcLog.length = 0;
    resetWorkspaceCloudBootstrapForTests();
    const c = await mountApp('/');
    expect(q(c, 'app-shell'), 'Offline-Start öffnet den Bestand').not.toBeNull();
    expect(q(c, 'workspace-restore-failure')).toBeNull();
    expect(q(c, 'connection-issue-banner')).not.toBeNull();
    expect(c.textContent).toContain('Sitzung GmbH');
    expect(rpcLog.filter((name) => name === 'ensure_personal_workspace' || name === 'pull_workspace_sync_state' || name.startsWith('upsert:'))).toEqual([]);
    expect(isCloudRightsUnconfirmed(userId)).toBe(true);

    // Verbindung zurück: Bestätigung, danach der normale Cloud-Bootstrap.
    setMockProfileFetchMode(null);
    pullAnswer = defaultPull;
    await click(c, 'connection-issue-retry');
    await settle();
    expect(q(c, 'connection-issue-banner')).toBeNull();
    expect(isCloudRightsUnconfirmed(userId)).toBe(false);
    expect(rpcLog).toContain('pull_workspace_sync_state');
    expect(q(c, 'app-shell')).not.toBeNull();
  });
});

describe('A-03 / N-A1 — Reihenfolge der Ereignisse', () => {
  it('A-03.1 Abmelden während eines Profilabrufs: bleibt abgemeldet', async () => {
    const c = await mountApp('/');
    expect(q(c, 'app-shell')).not.toBeNull();
    setMockProfileFetchMode('hold');
    await act(async () => {
      emitMockAuthEvent('USER_UPDATED');
    });
    await click(c, 'user-menu-dropdown-trigger');
    await click(c, 'logout-button');
    setMockProfileFetchMode(null);
    await act(async () => {
      releaseMockProfileFetches();
    });
    await settle();
    expect(q(c, 'app-shell')).toBeNull();
    expect(q(c, 'login-page')).not.toBeNull();
  });

  it('N-A1.6 TOKEN_REFRESHED desselben Kontos: kein neuer Profilabruf, kein Kontowechsel', async () => {
    const c = await mountApp('/');
    const vorher = getMockProfileFetchCount();
    await act(async () => {
      emitMockAuthEvent('TOKEN_REFRESHED');
    });
    await settle();
    expect(getMockProfileFetchCount()).toBe(vorher);
    expect(q(c, 'app-shell')).not.toBeNull();
  });
});

describe('A-04 bis A-06 — Abmelden', () => {
  it('A-06.1/A-06.2 Warnung mit Anzahl; „Abbrechen“ behält die Sitzung; A-06.3 „Trotzdem abmelden“ behält die Aufträge', async () => {
    const c = await mountApp('/');
    await act(async () => {
      // Wie im echten Ablauf: Der Dienst reiht ein und speichert sofort.
      enqueueSyncOutbox({ entityType: 'customer', entityId: 'kunde-ap2', operation: 'update', version: 1 });
      persistAll();
    });
    const offen = getSyncOutboxSnapshot().filter((e) => e.entityId === 'kunde-ap2');
    expect(offen).toHaveLength(1);
    await click(c, 'user-menu-dropdown-trigger');
    await click(c, 'logout-button');
    expect(q(c, 'logout-dialog')?.textContent).toContain('1 Änderungen');
    await click(c, 'logout-dialog-cancel');
    expect(q(c, 'logout-dialog')).toBeNull();
    expect(q(c, 'app-shell')).not.toBeNull();
    expect(getMockCurrentSession()).not.toBeNull();

    await click(c, 'user-menu-dropdown-trigger');
    await click(c, 'logout-button');
    await click(c, 'logout-dialog-confirm');
    expect(q(c, 'app-shell')).toBeNull();
    expect(getMockLastSignOutScope()).toBe('local');
    // Der Auftrag liegt weiter im Bereich des Kontos (mit Herkunft) und ist nicht verloren.
    const gespeichert = Object.keys(localStorage)
      .filter((key) => key.includes(':account:'))
      .map((key) => localStorage.getItem(key) ?? '')
      .join('\n');
    expect(gespeichert).toContain('kunde-ap2');
  });

  it('A-05 „Auf allen Geräten abmelden“ fragt nach und widerruft global', async () => {
    const c = await mountApp('/');
    await click(c, 'user-menu-dropdown-trigger');
    await click(c, 'logout-everywhere-button');
    expect(q(c, 'logout-dialog')?.textContent).toContain('auch auf anderen Geräten');
    await click(c, 'logout-dialog-confirm');
    expect(getMockLastSignOutScope()).toBe('global');
    expect(q(c, 'app-shell')).toBeNull();
  });
});

describe('A-12 / A-07 / A-09 — Anmeldeseite', () => {
  it('A-12.1 abgemeldet eine Seite aufrufen: nach der Anmeldung dorthin', async () => {
    await act(async () => {
      await (await import('./test/mockSupabaseAuth')).createMockSupabaseClient().auth.signOut();
    });
    const c = await mountApp('/einstellungen/firma');
    expect(q(c, 'login-page')).not.toBeNull();
    expect(q(c, 'location')?.getAttribute('data-path')).toBe(`/login?next=${encodeURIComponent('/einstellungen/firma')}`);
    await loginForm(c, 'admin@officepilot.local', (await import('./test/authFixtures')).DEFAULT_ADMIN_PASSWORD);
    await settle();
    const testids = verlauf.join(' > ');
    expect(q(c, 'app-shell'), testids).not.toBeNull();
    expect(q(c, 'settings-company-page'), testids).not.toBeNull();
  });

  it('A-12 / Weg C (AP4): ein wartendes Konto kehrt über das Anmeldeformular zur Einladung zurück, nicht anderswohin', async () => {
    registerMockRpcHandler('invitation_preview', () => ({ ok: true, status: 'open', invitation_id: 'inv-w', workspace_name: 'Weg C GmbH', role: 'member', inviter_name: 'Olga Eins', expires_at: '2026-10-30T08:00:00.000Z' }));
    registerMockRpcHandler('list_my_invitations', () => []);
    await registerPendingTestUser('wartend-weg-c@example.invalid');
    await act(async () => {
      await (await import('./test/mockSupabaseAuth')).createMockSupabaseClient().auth.signOut();
    });
    const ziel = '/einladung/WegCToken-0123456789abcdefghijklmn?email=wartend-weg-c%40example.invalid';
    const c = await mountApp(`/login?next=${encodeURIComponent(ziel)}`);
    await loginForm(c, 'wartend-weg-c@example.invalid', 'TestPasswort1');
    await settle();
    expect(q(c, 'location')?.getAttribute('data-path'), verlauf.join(' > ')).toBe(ziel);
    expect(q(c, 'invitation-preview')?.textContent).toContain('Weg C GmbH');
  });

  it('A-07.2 unbestätigte E-Mail: eigener Hinweis und „Bestätigung erneut senden“ mit Sperre', async () => {
    await act(async () => {
      await (await import('./test/mockSupabaseAuth')).createMockSupabaseClient().auth.signOut();
    });
    setMockSignInFailure({ name: 'AuthApiError', code: 'email_not_confirmed', status: 400, message: 'Email not confirmed' });
    const c = await mountApp('/login');
    await loginForm(c, 'offen@example.invalid', 'TestPasswort1');
    expect(q(c, 'login-error')?.getAttribute('data-code')).toBe('email_not_confirmed');
    await click(c, 'login-resend-confirmation');
    expect(q(c, 'login-resend-info')?.textContent).toContain('Falls zu dieser Adresse');
    expect((q(c, 'login-resend-confirmation') as HTMLButtonElement).disabled).toBe(true);
    expect(q(c, 'login-resend-confirmation')?.textContent).toMatch(/\d+ s/);
  });

  it('A-09.1 eine Ausnahme bei der Anmeldung: Meldung, Formular wieder bedienbar', async () => {
    await act(async () => {
      await (await import('./test/mockSupabaseAuth')).createMockSupabaseClient().auth.signOut();
    });
    setMockSignInFailure('throw');
    const c = await mountApp('/login');
    await loginForm(c, 'egal@example.invalid', 'TestPasswort1');
    expect(q(c, 'login-error')?.getAttribute('data-code')).toBe('network');
    expect((q(c, 'login-submit') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('A-13 / A-14 — Zustimmung', () => {
  it('veraltete Zustimmung: erst die Zustimmungsseite, kein Bootstrap; Zustimmen öffnet die App', async () => {
    patchMockProfile(userId, { accepted_terms_version: '0.9-alt' });
    const c = await mountApp('/');
    expect(q(c, 'legal-consent-page')).not.toBeNull();
    expect(q(c, 'app-shell')).toBeNull();
    expect(rpcLog).not.toContain('pull_workspace_sync_state');
    expect((q(c, 'legal-consent-accept') as HTMLButtonElement).disabled).toBe(true);
    for (const id of ['legal-consent-terms', 'legal-consent-privacy', 'legal-consent-license']) await click(c, id);
    await click(c, 'legal-consent-accept');
    await settle();
    expect(q(c, 'legal-consent-page')).toBeNull();
    expect(q(c, 'app-shell')).not.toBeNull();
    expect(getMockProfile(userId)?.legal_accepted_at).toBeTruthy();
  });

  it('A-14.2 Ablehnen meldet ab', async () => {
    patchMockProfile(userId, { legal_accepted_at: null });
    const c = await mountApp('/');
    await click(c, 'legal-consent-decline');
    expect(q(c, 'login-page')).not.toBeNull();
    expect(getMockCurrentSession()).toBeNull();
  });
});

describe('A-15 — Warteseite', () => {
  it('erkennt die Freischaltung ohne Neuladen (Abfrage alle 30 s)', async () => {
    const wartend = await registerPendingTestUser('warten-ap2@example.invalid');
    await login('warten-ap2@example.invalid', 'TestPasswort1');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const c = await mountApp('/');
    expect(q(c, 'waiting-approval-page')).not.toBeNull();
    await approveUser(wartend.id);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await settle();
    expect(q(c, 'waiting-approval-page')).toBeNull();
  });
});

describe('A-11 — Wiederherstellung in einem anderen Tab', () => {
  it('dieser Tab zeigt nur das Formular; kein Bootstrap, solange sie läuft', async () => {
    const c = await mountApp('/');
    expect(q(c, 'app-shell')).not.toBeNull();
    rpcLog.length = 0;
    await act(async () => {
      localStorage.setItem(PASSWORD_RECOVERY_SHARED_KEY, JSON.stringify({ at: Date.now() }));
      window.dispatchEvent(new StorageEvent('storage', { key: PASSWORD_RECOVERY_SHARED_KEY }));
    });
    await settle();
    expect(q(c, 'reset-password-page')).not.toBeNull();
    expect(q(c, 'app-shell')).toBeNull();
    expect(rpcLog.filter((name) => name === 'ensure_personal_workspace' || name === 'pull_workspace_sync_state')).toEqual([]);
    // A-11.4 Abbrechen: abgemeldet, Merker gelöscht.
    await click(c, 'reset-password-cancel');
    expect(localStorage.getItem(PASSWORD_RECOVERY_SHARED_KEY)).toBeNull();
    expect(getMockCurrentSession()).toBeNull();
  });
});
