/**
 * EINRICHTUNG-01 (AP7; Verträge 1.25, 1.26, 1.28; K1, K3, K7) — Seiten der Löschung.
 *
 *   L-01.1/L-01.6  Konto löschen: E-Mail und Passwort, Rückfrage im Gefahrenstil; nach Erfolg lokal abmelden (Hinweis)
 *                  und die Daten dieses Kontos vom Gerät entfernen; auch von der Warteseite
 *   L-02.1         Inhaber: Liste der Betriebe und Wege (Übergabe, Betrieb löschen)
 *   L-03.2/L-03.4  Betrieb löschen nur für den Inhaber; Export-Hinweis, Aufbewahrungshinweis mit Ankreuzfeld, Folgen
 *   L-04.1/L-04.2/L-04.6  offener Antrag: Stand mit Datum, Widerruf nur im Zustand „beantragt“
 *   N-03.7         Hinweis „Löschung beantragt“ mit Datum; der Inhaber erreicht den Antrag, Admin und Mitglied nicht
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider, useAuth } from '../../context/AuthContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { AccountDeletePage, WAITING_ACCOUNT_DELETE_ROUTE, WaitingAccountDeletePage } from './AccountDeletePage';
import { WorkspaceDeletePage } from './WorkspaceDeletePage';
import { WaitingApprovalPage } from '../WaitingApprovalPage';
import { WorkspaceReadOnlyBanner } from '../../components/system/WorkspaceReadOnlyBanner';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';
import { login, loginAsDefaultAdmin, registerPendingTestUser, resetAuthForTests } from '../../test/authFixtures';
import { resetTestStores } from '../../test/resetStores';
import * as supabaseLib from '../../lib/supabase';
import * as accountDeletion from '../../services/account/accountDeletionService';
import * as workspaceDeletion from '../../services/workspace/workspaceDeletionService';
import * as localAccountData from '../../services/storage/localAccountDataService';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { resetWorkspaceAccessForTests } from '../../services/workspace/workspaceAccessService';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { deviceStorageKey } from '../../services/storage/deviceDataService';

const USER_ID = 'usr-admin';
const WORKSPACE_ID = '00000000-0000-4000-8000-0000000007d1';
const setup = { ...DEFAULT_SETUP, setupComplete: true };
const P = SETTINGS_TARGET_PATHS;

let root: Root | null = null;
let host: HTMLDivElement;

function seedWorkspace(role: 'owner' | 'admin' | 'member'): void {
  hydrateWorkspaceStore({
    workspace: { id: WORKSPACE_ID, name: 'Löschbetrieb', ownerUserId: role === 'owner' ? USER_ID : 'usr-owner', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
    workspaceMembers: [{ workspaceId: WORKSPACE_ID, userId: USER_ID, role, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  });
}

/** Zugriffsauskunft wie vom Server bestätigt (gespeichert je Konto und Betrieb). */
function seedAccess(role: 'owner' | 'admin' | 'member', deletion: { pending: boolean; inProgress?: boolean } = { pending: false }): void {
  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_ID, account: { userId: USER_ID, access: role === 'member' ? 'member' : 'full' } });
  localStorage.setItem(`officetakt-workspace-access:${USER_ID}:${WORKSPACE_ID}`, JSON.stringify({
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    role,
    licenseState: 'effective',
    licenseEffective: true,
    confirmedAt: '2026-10-25T08:00:00.000Z',
    deletionPending: deletion.pending,
    deletionExecuteAfter: deletion.pending ? '2026-11-24T08:00:00.000Z' : null,
    deletionInProgress: deletion.inProgress === true,
  }));
  resetWorkspaceAccessForTests();
}

function AuthProbe() {
  const auth = useAuth();
  const location = useLocation();
  return <div data-testid="probe" data-auth={auth.isAuthenticated ? 'ja' : 'nein'} data-reason={auth.logoutReason ?? ''} data-path={location.pathname} />;
}

async function settle(rounds = 8): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function renderAt(entry: string, extra?: ReactNode): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[entry]}>
        <AuthProvider>
          <AppProvider initialSetup={setup}>
            <WorkspaceReadOnlyBanner />
            <Routes>
              <Route path={P['account-delete']} element={<AccountDeletePage />} />
              <Route path={P['workspace-delete']} element={<WorkspaceDeletePage />} />
              <Route path={P['team-members']} element={<div data-testid="team-stub" />} />
              <Route path="/waiting-approval" element={<WaitingApprovalPage />} />
              <Route path={WAITING_ACCOUNT_DELETE_ROUTE} element={<WaitingAccountDeletePage />} />
              <Route path={P.export} element={<div data-testid="export-stub" />} />
            </Routes>
            <AuthProbe />
            {extra}
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function type(id: string, value: string): Promise<void> {
  const element = q(id) as HTMLInputElement | null;
  expect(element, id).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(id: string): Promise<void> {
  const element = q(id);
  expect(element, id).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

beforeEach(async () => {
  resetTestStores();
  resetAuthForTests();
  localStorage.clear();
  sessionStorage.clear();
  setActiveStorageScope({ type: 'guest' });
  resetWorkspaceAccessForTests();
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  await loginAsDefaultAdmin();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  resetWorkspaceAccessForTests();
  resetTestStores();
});

describe('EINRICHTUNG-01 AP7 — Konto löschen (1.25)', { timeout: 30_000 }, () => {
  it('L-01.1: E-Mail und Passwort, Rückfrage; danach lokal abgemeldet mit Hinweis und Gerätedaten entfernt', async () => {
    seedWorkspace('member');
    const loeschen = vi.spyOn(accountDeletion, 'deleteOwnAccount').mockResolvedValue({ ok: true, state: 'completed' });
    const entfernen = vi.spyOn(localAccountData, 'removeLocalAccountData').mockResolvedValue({ storageKeys: 1, sessionKeys: 0, indexedDbRecords: 0, workspaces: [] });
    await renderAt(P['account-delete']);
    expect((q('account-delete-submit') as HTMLButtonElement).disabled).toBe(true);
    await type('account-delete-email', 'admin@example.invalid');
    await type('account-delete-password', 'Passwort-1');
    expect((q('account-delete-submit') as HTMLButtonElement).disabled).toBe(false);
    await click('account-delete-submit');
    expect(q('account-delete-dialog')).not.toBeNull();
    expect(loeschen).not.toHaveBeenCalled();
    await click('account-delete-confirm');
    expect(loeschen).toHaveBeenCalledWith({ userId: USER_ID, email: 'admin@example.invalid', password: 'Passwort-1' });
    expect(entfernen).toHaveBeenCalledWith(USER_ID);
    expect(q('probe')?.getAttribute('data-auth')).toBe('nein');
    expect(q('probe')?.getAttribute('data-reason')).toBe('account_deleted');
    // Das Passwort steht nicht mehr im Formular.
    expect((q('account-delete-password') as HTMLInputElement | null)?.value ?? '').toBe('');
  });

  it('„Abbrechen“ in der Rückfrage sendet nichts', async () => {
    const loeschen = vi.spyOn(accountDeletion, 'deleteOwnAccount');
    await renderAt(P['account-delete']);
    await type('account-delete-email', 'admin@example.invalid');
    await type('account-delete-password', 'Passwort-1');
    await click('account-delete-submit');
    await click('account-delete-cancel');
    expect(loeschen).not.toHaveBeenCalled();
    expect(q('probe')?.getAttribute('data-auth')).toBe('ja');
  });

  it('L-02.1: Inhaber — Liste der Betriebe mit Wegen; keine Abmeldung', async () => {
    vi.spyOn(accountDeletion, 'deleteOwnAccount').mockResolvedValue({ ok: false, reason: 'owner', workspaces: [{ id: WORKSPACE_ID, name: 'Löschbetrieb' }] });
    const entfernen = vi.spyOn(localAccountData, 'removeLocalAccountData');
    await renderAt(P['account-delete']);
    await type('account-delete-email', 'admin@example.invalid');
    await type('account-delete-password', 'Passwort-1');
    await click('account-delete-submit');
    await click('account-delete-confirm');
    expect(q('account-delete-owner')?.textContent).toContain('Löschbetrieb');
    expect(q('account-delete-owner-transfer')?.getAttribute('href')).toBe(P['team-members']);
    expect(q('account-delete-owner-delete')?.getAttribute('href')).toBe(P['workspace-delete']);
    expect(entfernen).not.toHaveBeenCalled();
    expect(q('probe')?.getAttribute('data-auth')).toBe('ja');
  });

  it('L-01.5: falsches Passwort — Fehlermeldung, keine Abmeldung', async () => {
    vi.spyOn(accountDeletion, 'deleteOwnAccount').mockResolvedValue({ ok: false, reason: 'password_invalid' });
    await renderAt(P['account-delete']);
    await type('account-delete-email', 'admin@example.invalid');
    await type('account-delete-password', 'falsch');
    await click('account-delete-submit');
    await click('account-delete-confirm');
    expect(q('account-delete-error')).not.toBeNull();
    expect(q('probe')?.getAttribute('data-auth')).toBe('ja');
  });

  it('L-01.6: die Warteseite führt zur Kontolöschung (eigene Route, ohne Betrieb)', async () => {
    resetAuthForTests();
    await registerPendingTestUser('wartend-ap7@example.invalid');
    await login('wartend-ap7@example.invalid', 'TestPasswort1');
    await renderAt('/waiting-approval');
    const link = q('waiting-approval-delete-account');
    expect(link?.getAttribute('href')).toBe(WAITING_ACCOUNT_DELETE_ROUTE);
    await click('waiting-approval-delete-account');
    expect(q('probe')?.getAttribute('data-path')).toBe(WAITING_ACCOUNT_DELETE_ROUTE);
    expect(q('waiting-account-delete-page')).not.toBeNull();
    expect(q('waiting-account-delete-email')).not.toBeNull();
    expect(q('waiting-account-delete-back')?.getAttribute('href')).toBe('/waiting-approval');
  });
});

/**
 * Abschluss 23 (Entscheidung zu Bericht 22) — Warnhinweis vor der Kontolöschung bei nicht abgeglichenen Gerätedaten.
 *   KW-1  eigener Bestand mit offener Änderung → deutlicher Hinweis (mit Betrieb) und Satz in der Rückfrage; die Löschung
 *         bleibt möglich und läuft wie bisher (Server, lokale Abmeldung, Gerätedaten)
 *   KW-2  eigener Bestand ohne Offenes, nur kein Abgleichnachweis → keine Warnung, nur sachlicher Hinweis mit Weg zur
 *         Prüfung (Abschluss 24); kein Verlustsatz in der Rückfrage
 *   KW-3  nur ein anderes Konto hat offene Änderungen → weder Warnung noch Hinweis, kein fremder Betriebsname
 *   KW-4  kein Bestand dieses Kontos auf dem Gerät → weder Warnung noch Hinweis
 */
describe('Abschluss 23 — Warnhinweis vor der Kontolöschung', { timeout: 30_000 }, () => {
  const ANDERES_KONTO = '0a8a0000-0000-4000-8000-0000000000f2';
  function bestand(konto: string, name: string, offen: boolean, workspaceId = WORKSPACE_ID): void {
    localStorage.setItem(deviceStorageKey(workspaceId, konto, 'full'), JSON.stringify({
      version: 6, savedAt: '2026-10-27T08:00:00.000Z', setup: {}, inboxItems: [], vorgaenge: [], tasks: [],
      workspace: { id: workspaceId, name },
      syncOutbox: offen ? [{ id: 'o-1', entityType: 'customer', entityId: 'k1', operation: 'update', version: 1, queuedAt: '2026-10-27T08:00:00.000Z', retryCount: 0, status: 'pending', sequence: 1 }] : [],
    }));
  }

  it('KW-1: offene Änderung → Hinweis mit Betrieb und in der Rückfrage; die Löschung bleibt möglich', async () => {
    bestand(USER_ID, 'Warnbetrieb', true);
    const loeschen = vi.spyOn(accountDeletion, 'deleteOwnAccount').mockResolvedValue({ ok: true, state: 'completed' });
    const entfernen = vi.spyOn(localAccountData, 'removeLocalAccountData').mockResolvedValue({ storageKeys: 1, sessionKeys: 0, indexedDbRecords: 0, workspaces: [WORKSPACE_ID] });
    await renderAt(P['account-delete']);
    await settle(20);
    const hinweis = q('account-delete-device-warning');
    expect(hinweis).not.toBeNull();
    expect(hinweis?.getAttribute('role')).toBe('alert');
    expect(hinweis?.textContent).toContain('unwiederbringlich verloren');
    expect(q('account-delete-device-note')).toBeNull();
    expect(q(`account-delete-device-warning-${WORKSPACE_ID}`)?.textContent).toBe('Warnbetrieb');
    expect(q('account-delete-device-warning-sync')?.getAttribute('href')).toBe(P.sync);
    await type('account-delete-email', 'admin@example.invalid');
    await type('account-delete-password', 'Passwort-1');
    expect((q('account-delete-submit') as HTMLButtonElement).disabled).toBe(false);
    await click('account-delete-submit');
    expect(q('account-delete-dialog')?.textContent).toContain('gehen dabei unwiederbringlich verloren');
    await click('account-delete-confirm');
    expect(loeschen).toHaveBeenCalledTimes(1);
    expect(entfernen).toHaveBeenCalledWith(USER_ID);
    expect(q('probe')?.getAttribute('data-reason')).toBe('account_deleted');
  });

  it('KW-2: nichts Offenes, nur kein Abgleichnachweis → keine Warnung, nur sachlicher Hinweis mit Weg zur Prüfung', async () => {
    bestand(USER_ID, 'Ruhebetrieb', false);
    await renderAt(P['account-delete']);
    await settle(20);
    expect(q('account-delete-device-warning')).toBeNull();
    const hinweis = q('account-delete-device-note');
    expect(hinweis?.getAttribute('role')).toBe('note');
    expect(hinweis?.textContent).not.toContain('unwiederbringlich');
    expect(q('account-delete-device-note-link')?.getAttribute('href')).toBe(P.device);
    await type('account-delete-email', 'admin@example.invalid');
    await type('account-delete-password', 'Passwort-1');
    await click('account-delete-submit');
    expect(q('account-delete-dialog')?.textContent).not.toContain('unwiederbringlich verloren');
  });

  it('KW-3: offene Änderungen nur bei einem anderen Konto → kein Hinweis, kein fremder Betriebsname', async () => {
    bestand(ANDERES_KONTO, 'Fremdbetrieb', true, '00000000-0000-4000-8000-0000000007d2');
    await renderAt(P['account-delete']);
    await settle(20);
    expect(q('account-delete-device-warning')).toBeNull();
    expect(q('account-delete-device-note')).toBeNull();
    expect(host.textContent).not.toContain('Fremdbetrieb');
  });

  it('KW-4: kein Bestand dieses Kontos → weder Warnung noch Hinweis', async () => {
    await renderAt(P['account-delete']);
    await settle(20);
    expect(q('account-delete-device-warning')).toBeNull();
    expect(q('account-delete-device-note')).toBeNull();
  });
});

describe('EINRICHTUNG-01 AP7 — Betrieb löschen (1.26)', { timeout: 30_000 }, () => {
  it('L-03.2: Admin und Mitglied sehen nur den Rollenhinweis', async () => {
    for (const role of ['admin', 'member'] as const) {
      seedWorkspace(role);
      seedAccess(role);
      await renderAt(P['workspace-delete']);
      expect(q('settings-workspace-delete-not-allowed'), role).not.toBeNull();
      expect(q('settings-workspace-delete-form'), role).toBeNull();
      if (root) await act(async () => root!.unmount());
      root = null;
      host.remove();
    }
  });

  it('L-03.4/L-03.1: Inhaber — Export-Hinweis, Aufbewahrungshinweis mit Ankreuzfeld, Folgen; Antrag erst nach Rückfrage', async () => {
    seedWorkspace('owner');
    seedAccess('owner');
    const antrag = vi.spyOn(workspaceDeletion, 'requestWorkspaceDeletion').mockResolvedValue({ ok: true, executeAfter: '2026-11-24T08:00:00.000Z' });
    await renderAt(P['workspace-delete']);
    expect(q('settings-workspace-delete-export-link')?.getAttribute('href')).toBe(P.export);
    expect(q('settings-workspace-delete-retention')?.textContent?.length ?? 0).toBeGreaterThan(20);
    expect(q('settings-workspace-delete-consequences')).not.toBeNull();
    await type('settings-workspace-delete-name', 'Löschbetrieb');
    await type('settings-workspace-delete-password', 'Passwort-1');
    expect((q('settings-workspace-delete-submit') as HTMLButtonElement).disabled).toBe(true);
    await click('settings-workspace-delete-retention-confirm');
    expect((q('settings-workspace-delete-submit') as HTMLButtonElement).disabled).toBe(false);
    await click('settings-workspace-delete-submit');
    expect(antrag).not.toHaveBeenCalled();
    await click('settings-workspace-delete-confirm');
    expect(antrag).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID, typedName: 'Löschbetrieb', password: 'Passwort-1' }));
    expect(q('settings-workspace-delete-info')).not.toBeNull();
  });

  it('L-04.1/L-04.2/N-03.7: offener Antrag — Hinweis mit Datum, Inhaber widerruft; Banner führt zum Antrag', async () => {
    seedWorkspace('owner');
    seedAccess('owner', { pending: true });
    const widerruf = vi.spyOn(workspaceDeletion, 'revokeWorkspaceDeletion').mockResolvedValue({ ok: true });
    await renderAt(P['workspace-delete']);
    expect(q('settings-workspace-delete-status')?.getAttribute('data-state')).toBe('open');
    expect(q('settings-workspace-delete-status')?.textContent).toContain('24.11.2026');
    expect(q('workspace-read-only-banner')?.getAttribute('data-reason')).toBe('deletion');
    expect(q('workspace-read-only-banner')?.textContent).toContain('24.11.2026');
    expect(q('workspace-read-only-banner-manage')?.getAttribute('href')).toBe(P['workspace-delete']);
    await click('settings-workspace-delete-revoke');
    await click('settings-workspace-delete-revoke-confirm');
    expect(widerruf).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it('L-04.6: in der Ausführung kein Widerruf', async () => {
    seedWorkspace('owner');
    seedAccess('owner', { pending: true, inProgress: true });
    await renderAt(P['workspace-delete']);
    expect(q('settings-workspace-delete-status')?.getAttribute('data-state')).toBe('deleting');
    expect(q('settings-workspace-delete-revoke')).toBeNull();
    expect(q('workspace-read-only-banner-manage')).toBeNull();
  });

  it('N-03.7: Admin und Mitglied sehen den Grund „Löschung beantragt“, aber keinen Weg zum Antrag', async () => {
    for (const role of ['admin', 'member'] as const) {
      seedWorkspace(role);
      seedAccess(role, { pending: true });
      await renderAt(P['workspace-delete']);
      expect(q('workspace-read-only-banner')?.getAttribute('data-reason'), role).toBe('deletion');
      expect(q('workspace-read-only-banner-manage'), role).toBeNull();
      expect(q('settings-workspace-delete-revoke'), role).toBeNull();
      if (root) await act(async () => root!.unmount());
      root = null;
      host.remove();
    }
  });
});
