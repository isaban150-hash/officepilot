/**
 * EINRICHTUNG-01 (AP9; Verträge 1.30, 1.31) — Qualität auf den B2-Flächen.
 *
 *   Q1 (Q-01.3) Speicherfehler bleiben als Hinweis an der Aktion stehen (`role="alert"`), kein Toast; Verwerfen löscht
 *      den Hinweis.
 *   Q2 (Q-01.3) Betriebswechsel scheitert: bleibender Hinweis mit Betrieb, in dem weitergearbeitet wird, und „Erneut
 *      versuchen“; kein Toast. Gelingt der zweite Versuch, bindet die App neu.
 *   Q3 (Q-02.3, Q-03.1) Warte- und Lizenzseite ohne App-Rahmen in der Sprache des Kontos, samt Rechtslinks und
 *      `<html lang>`.
 *   Q4 (Q-03.1) Ansichten vor dem Rahmen: Fußzeile und `<html lang>` folgen der Sprache der Ansicht; die Bestätigung der
 *      Antwortadresse folgt der Browsersprache.
 *   Q5 (1.31) Rechtsseiten: Rahmen in der Oberflächensprache, Hinweis „nur auf Deutsch“ außerhalb von de, Text mit
 *      `lang="de"`.
 *   Q6 (Q-01.2) unbekannter Code oder Ausnahme: allgemeiner Text mit Kurzreferenz (4 Zeichen), nie der Rohtext — Team,
 *      Plattform, Anmeldung, Betriebslöschung, Anzeige in der Einladungsliste; bekannte Codes behalten ihren Text.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { AuthLayout } from './components/auth/AuthLayout';
import { UserMenu } from './components/layout/UserMenu';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { DEFAULT_SETUP } from './data/mockData';
import { failureText, t } from './i18n';
import * as supabaseLib from './lib/supabase';
import { ImpressumPage } from './pages/legal/ImpressumPage';
import { LicenseExpiredPage } from './pages/LicenseExpiredPage';
import { ReplyToConfirmPage } from './pages/ReplyToConfirmPage';
import { WaitingApprovalPage } from './pages/WaitingApprovalPage';
import { CompanySettingsPage } from './pages/settings/CompanySettingsPage';
import { ServerErrorPage } from './pages/system/ServerErrorPage';
import { PendingInvitationsPanel } from './components/team/PendingInvitationsPanel';
import { listTeamMembers } from './services/team/teamService';
import { adminFailure } from './services/auth/profileAdminService';
import { getLoginErrorMessage } from './services/auth/supabaseAuthService';
import { revokeWorkspaceDeletion } from './services/workspace/workspaceDeletionService';
import { writePersonalUiLanguage } from './services/auth/personalUiLanguage';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { resetUiSessionLiveState } from './services/uiSession/uiSessionLiveState';
import { clearUiSessionSnapshot } from './services/uiSession/uiSessionStore';
import { workspaceChangeDeps } from './services/workspace/workspaceMembershipChangeService';
import { hydrateWorkspaceStore, resetWorkspaceStore } from './services/workspace/workspaceStore';
import { loginAsDefaultAdmin, login, registerPendingTestUser, resetAuthForTests } from './test/authFixtures';
import { clearMockRpcHandlers, registerMockRpcHandler } from './test/mockProfileStore';
import { getMockCurrentSession } from './test/mockSupabaseAuth';
import { resetTestStores } from './test/resetStores';

const W1 = '00000000-0000-0000-0000-0000000e9a01';
const W3 = '00000000-0000-0000-0000-0000000e9a03';
const STAMP = '2026-10-01T08:00:00.000Z';
const complete = { ...DEFAULT_SETUP, companyName: 'AP9 GmbH', setupComplete: true, setupVersion: 1 };

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(runden = 30): Promise<void> {
  for (let i = 0; i < runden; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function mount(ui: ReactNode): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(ui);
  });
  await settle();
  return host;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
}

function q(testId: string): HTMLElement | null {
  return host?.querySelector(`[data-testid="${testId}"]`) ?? null;
}

async function click(testId: string): Promise<void> {
  const element = q(testId) as HTMLButtonElement | null;
  expect(element, `Element ${testId} fehlt`).not.toBeNull();
  await act(async () => {
    element!.click();
  });
  await settle();
}

/** Zeigt den Toast des App-Rahmens, damit ein Test „kein Toast“ prüfen kann. */
function ToastProbe() {
  const { toast } = useApp();
  return <div data-testid="toast-probe" data-toast={toast ?? ''} />;
}

beforeEach(async () => {
  resetTestStores();
  resetAuthForTests();
  localStorage.clear();
  sessionStorage.clear();
  clearMockRpcHandlers();
  resetWorkspaceStore();
  resetUiSessionLiveState();
  clearUiSessionSnapshot();
  setActiveStorageScope({ type: 'guest' });
  document.documentElement.lang = 'de';
  vi.spyOn(workspaceChangeDeps, 'reloadTo').mockImplementation(() => undefined);
});

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
  clearMockRpcHandlers();
  setActiveStorageScope({ type: 'guest' });
  document.documentElement.lang = 'de';
  resetTestStores();
});

describe('EINRICHTUNG-01 AP9 — bleibende Fehlerhinweise (1.30)', { timeout: 30_000 }, () => {
  it('Q1: Firmendaten — Speicherfehler als Hinweis an der Speicherleiste, kein Toast; Verwerfen löscht ihn', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Bestand GmbH', email: 'info@example.invalid' });
    await loginAsDefaultAdmin();
    await mount(
      <MemoryRouter initialEntries={['/einstellungen/firma']}>
        <AuthProvider>
          <AppProvider initialSetup={complete}>
            <Routes>
              <Route path="/einstellungen/firma" element={<CompanySettingsPage />} />
            </Routes>
            <ToastProbe />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    const name = q('settings-company-companyName') as HTMLInputElement;
    expect(name).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = host!.querySelector('form.settings-form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();

    const hinweis = q('settings-company-save-error');
    expect(hinweis?.getAttribute('role')).toBe('alert');
    expect(hinweis?.textContent).toBe(t('settings.company.validationSummary', 'de'));
    expect(q('toast-probe')?.getAttribute('data-toast')).toBe('');
    // Bleibt stehen, solange nichts Neues geschieht (kein Zeitablauf wie beim Toast).
    await settle(60);
    expect(q('settings-company-save-error')?.textContent).toBe(t('settings.company.validationSummary', 'de'));

    await click('settings-company-discard');
    expect(q('settings-company-save-error')).toBeNull();
  });

  it('Q2: Betriebswechsel scheitert — bleibender Hinweis mit „Erneut versuchen“; der zweite Versuch bindet neu', async () => {
    await loginAsDefaultAdmin();
    const me = getMockCurrentSession()?.user.id ?? '';
    setActiveStorageScope({ type: 'workspace', workspaceId: W1, account: { userId: me, access: 'full' } });
    hydrateWorkspaceStore({
      workspace: { id: W1, name: 'AP9 GmbH', ownerUserId: me, createdAt: STAMP, updatedAt: STAMP, version: 1 },
      workspaceMembers: [{ workspaceId: W1, userId: me, role: 'owner', status: 'active', createdAt: STAMP, updatedAt: STAMP }],
    } as never);
    registerMockRpcHandler('list_own_memberships', () => [
      { workspace_id: W1, workspace_name: 'AP9 GmbH', role: 'owner', status: 'active', member_since: STAMP },
      { workspace_id: W3, workspace_name: 'Dora GmbH', role: 'member', status: 'active', member_since: STAMP },
    ]);
    let versuche = 0;
    registerMockRpcHandler('select_active_workspace', (args) => {
      versuche += 1;
      if (versuche < 3) throw new Error('select_active_workspace: connection reset by peer');
      return { workspace_id: args.p_workspace_id };
    });
    await mount(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <AppProvider initialSetup={complete}>
            <UserMenu />
            <ToastProbe />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(q('user-menu-dropdown-trigger')?.getAttribute('aria-label')).toBe(t('userMenu.label', 'de'));
    await click('user-menu-dropdown-trigger');
    await click(`user-menu-workspace-${W3}`);

    expect(q('user-menu-workspace-switch-dialog')).not.toBeNull();
    const hinweis = q('user-menu-workspace-switch-error');
    expect(hinweis?.getAttribute('role')).toBe('alert');
    expect(hinweis?.textContent).toBe(t('workspaceSwitch.failed', 'de'));
    expect(q('user-menu-workspace-switch-dialog')?.textContent).toContain(
      t('workspaceSwitch.failedStay', 'de', { workspace: 'AP9 GmbH' }),
    );
    // Kein Rohtext, kein Toast, kein Umbinden.
    expect(host!.textContent).not.toContain('connection reset');
    expect(q('toast-probe')?.getAttribute('data-toast')).toBe('');
    expect(workspaceChangeDeps.reloadTo).not.toHaveBeenCalled();

    await click('user-menu-workspace-switch-retry');
    expect(q('simple-confirm-error')?.textContent).toBe(t('workspaceSwitch.retryFailed', 'de'));
    expect(q('user-menu-workspace-switch-error')).not.toBeNull();
    expect(workspaceChangeDeps.reloadTo).not.toHaveBeenCalled();

    await click('user-menu-workspace-switch-retry');
    expect(versuche).toBe(3);
    expect(workspaceChangeDeps.reloadTo).toHaveBeenCalledWith('/');
    expect(q('user-menu-workspace-switch-dialog')).toBeNull();
  });

  it('Q2: „Schließen“ lässt den bisherigen Betrieb unverändert', async () => {
    await loginAsDefaultAdmin();
    const me = getMockCurrentSession()?.user.id ?? '';
    setActiveStorageScope({ type: 'workspace', workspaceId: W1, account: { userId: me, access: 'full' } });
    hydrateWorkspaceStore({
      workspace: { id: W1, name: 'AP9 GmbH', ownerUserId: me, createdAt: STAMP, updatedAt: STAMP, version: 1 },
      workspaceMembers: [{ workspaceId: W1, userId: me, role: 'owner', status: 'active', createdAt: STAMP, updatedAt: STAMP }],
    } as never);
    registerMockRpcHandler('list_own_memberships', () => [
      { workspace_id: W1, workspace_name: 'AP9 GmbH', role: 'owner', status: 'active', member_since: STAMP },
      { workspace_id: W3, workspace_name: 'Dora GmbH', role: 'member', status: 'active', member_since: STAMP },
    ]);
    registerMockRpcHandler('select_active_workspace', () => {
      throw new Error('nein');
    });
    await mount(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <AppProvider initialSetup={complete}>
            <UserMenu />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    await click('user-menu-dropdown-trigger');
    await click(`user-menu-workspace-${W3}`);
    await click('user-menu-workspace-switch-close');
    expect(q('user-menu-workspace-switch-dialog')).toBeNull();
    expect(workspaceChangeDeps.reloadTo).not.toHaveBeenCalled();
  });
});

describe('EINRICHTUNG-01 AP9 — Sprache der Seiten vor und neben dem App-Rahmen (1.31)', { timeout: 30_000 }, () => {
  it('Q3: Warteseite ohne Rahmen in der Kontosprache (tr) — Texte, Rechtslinks, <html lang>', async () => {
    const user = await registerPendingTestUser('ap9-warten@example.invalid');
    await login('ap9-warten@example.invalid', 'TestPasswort1');
    writePersonalUiLanguage('tr', user.id);
    await mount(
      <MemoryRouter initialEntries={['/waiting-approval']}>
        <AuthProvider>
          <Routes>
            <Route path="/waiting-approval" element={<WaitingApprovalPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    const seite = q('waiting-approval-page');
    expect(seite).not.toBeNull();
    expect(seite?.querySelector('h1')?.textContent).toBe(t('auth.waitingApproval.title', 'tr'));
    expect(seite?.textContent).toContain(t('auth.waitingApproval.subtitle', 'tr'));
    expect(seite?.textContent).toContain(t('auth.waitingApproval.info', 'tr'));
    expect(q('waiting-approval-recheck')?.textContent).toBe(t('auth.waitingApproval.recheck', 'tr'));
    expect(q('waiting-approval-logout')?.textContent).toBe(t('auth.logout.action', 'tr'));
    expect(q('legal-link-datenschutz')?.textContent).toBe(t('legal.footer.privacy', 'tr'));
    expect(q('legal-footer-links')?.getAttribute('aria-label')).toBe(t('legal.footer.label', 'tr'));
    expect(document.documentElement.lang).toBe('tr');
    for (const fest of ['Freischaltung ausstehend', 'Jetzt prüfen', 'Abmelden', 'Rechtliche Informationen']) {
      expect(seite?.textContent ?? '').not.toContain(fest);
    }
  });

  it('Q3: Lizenzseite in der Kontosprache (bg), Lizenz des Betriebs (E3)', async () => {
    await loginAsDefaultAdmin();
    const me = getMockCurrentSession()?.user.id ?? '';
    writePersonalUiLanguage('bg', me);
    setActiveStorageScope({ type: 'workspace', workspaceId: W1, account: { userId: me, access: 'full' } });
    await mount(
      <MemoryRouter initialEntries={['/license-expired']}>
        <AuthProvider>
          <Routes>
            <Route path="/license-expired" element={<LicenseExpiredPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    const seite = q('license-expired-page');
    expect(seite?.querySelector('h1')?.textContent).toBe(t('auth.licenseExpired.title', 'bg'));
    expect(seite?.textContent).toContain(t('auth.licenseExpired.subtitle', 'bg'));
    expect(seite?.textContent).toContain(t('auth.licenseExpired.contact', 'bg'));
    expect(q('license-expired-logout')?.textContent).toBe(t('auth.logout.action', 'bg'));
    expect(document.documentElement.lang).toBe('bg');
    expect(t('auth.licenseExpired.subtitle', 'de')).toContain('Betriebs');
  });

  it('Q4: AuthLayout vor dem Rahmen — Fußzeile und <html lang> in der Sprache der Ansicht', async () => {
    await mount(
      <MemoryRouter>
        <AuthLayout title="—" language="bg" testId="ap9-layout">
          <p />
        </AuthLayout>
      </MemoryRouter>,
    );
    expect(q('legal-link-impressum')?.textContent).toBe(t('legal.footer.imprint', 'bg'));
    expect(q('legal-link-agb')?.textContent).toBe(t('legal.footer.terms', 'bg'));
    expect(document.documentElement.lang).toBe('bg');
  });

  it('Q4: Bestätigung der Antwortadresse ohne Rahmen — Browsersprache, auch für <html lang>', async () => {
    Object.defineProperty(navigator, 'language', { value: 'tr-TR', configurable: true });
    try {
      await mount(
        <MemoryRouter initialEntries={['/antwortadresse-bestaetigen']}>
          <ReplyToConfirmPage />
        </MemoryRouter>,
      );
      expect(q('reply-to-confirm-page')?.querySelector('h1')?.textContent).toBe(t('replyToConfirm.title', 'tr'));
      expect(document.documentElement.lang).toBe('tr');
    } finally {
      Object.defineProperty(navigator, 'language', { value: 'de-DE', configurable: true });
    }
  });

  // Nacharbeit AP5–AP10: die Fehlergrenze ist nach 1.14 B2 (vorher fest deutsch, außerhalb aller Provider).
  it('Q4: Fehlergrenze ohne Rahmen in der persönlichen Sprache (bg), ohne gespeicherte Sprache Deutsch', async () => {
    await loginAsDefaultAdmin();
    const me = getMockCurrentSession()?.user.id ?? '';
    setActiveStorageScope({ type: 'workspace', workspaceId: W1, account: { userId: me, access: 'full' } });
    writePersonalUiLanguage('bg', me);
    await mount(<ServerErrorPage />);
    expect(q('server-error-page')?.querySelector('h1')?.textContent).toBe(t('serverError.title', 'bg'));
    expect(q('server-error-page')?.textContent).toContain(t('serverError.text', 'bg'));
    expect(q('server-error-retry')?.textContent).toBe(t('serverError.retry', 'bg'));
    expect(document.documentElement.lang).toBe('bg');
    expect(q('server-error-page')?.textContent ?? '').not.toContain('Etwas ist schiefgelaufen');
    await unmount();

    localStorage.clear();
    setActiveStorageScope({ type: 'guest' });
    await mount(<ServerErrorPage />);
    expect(q('server-error-page')?.querySelector('h1')?.textContent).toBe('Etwas ist schiefgelaufen');
    expect(q('server-error-retry')?.textContent).toBe('Erneut versuchen');
  });

  it('Q5: Rechtsseite in tr — Rahmen übersetzt, Hinweis „nur auf Deutsch“, Text mit lang="de"', async () => {
    await mount(
      <MemoryRouter initialEntries={['/impressum']}>
        <AuthProvider>
          <AppProvider initialSetup={{ ...complete, language: 'tr' }}>
            <ImpressumPage />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(q('legal-draft-notice')?.textContent).toBe(t('legal.draftNotice', 'tr'));
    expect(q('legal-german-only')?.textContent).toBe(t('legal.germanOnly', 'tr'));
    expect(host!.querySelector('.legal-page__body')?.getAttribute('lang')).toBe('de');
    expect(document.documentElement.lang).toBe('tr');
  });

  it('Q5: Rechtsseite in de — kein Hinweis „nur auf Deutsch“', async () => {
    await mount(
      <MemoryRouter initialEntries={['/impressum']}>
        <AuthProvider>
          <AppProvider initialSetup={complete}>
            <ImpressumPage />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(q('legal-draft-notice')?.textContent).toBe('Entwurf – muss rechtlich geprüft werden.');
    expect(q('legal-german-only')).toBeNull();
  });
});

describe('EINRICHTUNG-01 AP9 — unbekannte Codes mit Kurzreferenz (1.30, Q-01.2)', { timeout: 30_000 }, () => {
  const REF = /^[0-9A-Z]{4}$/;
  const mitReferenz = (text: string | null | undefined, ref: string) => {
    expect(text).toBe(t('errors.genericWithReference', 'de', { ref }));
  };

  it('Q6: Team — unbekannter Code mit Referenz und ohne Rohtext; bekannter Code mit eigenem Text', async () => {
    await loginAsDefaultAdmin();
    registerMockRpcHandler('team_list_members', () => {
      throw new Error('relation "workspace_members" does not exist');
    });
    const unbekannt = await listTeamMembers(W1);
    expect(unbekannt.ok).toBe(false);
    if (unbekannt.ok) return;
    expect(unbekannt.errorKey).toBe('team.error.unknown');
    expect(unbekannt.ref).toMatch(REF);
    mitReferenz(failureText('de', unbekannt), unbekannt.ref!);
    expect(failureText('tr', unbekannt)).toBe(t('errors.genericWithReference', 'tr', { ref: unbekannt.ref! }));
    expect(failureText('de', unbekannt)).not.toContain('workspace_members');

    registerMockRpcHandler('team_list_members', () => {
      throw new Error('team_forbidden_role: nur Inhaber');
    });
    const bekannt = await listTeamMembers(W1);
    expect(bekannt.ok).toBe(false);
    if (bekannt.ok) return;
    expect(bekannt.ref).toBeUndefined();
    expect(failureText('de', bekannt)).toBe(t('team.error.team_forbidden_role', 'de'));
  });

  it('Q6: Einladungsliste zeigt den unbekannten Annahmefehler als allgemeinen Text mit Referenz', async () => {
    await loginAsDefaultAdmin();
    const me = getMockCurrentSession()?.user.id ?? '';
    registerMockRpcHandler('list_my_invitations', () => [
      { invitation_id: 'inv-ap9', workspace_id: W3, workspace_name: 'Dora GmbH', role: 'member', inviter_name: 'Dora', expires_at: '2026-11-01T08:00:00.000Z' },
    ]);
    registerMockRpcHandler('accept_invitation', () => {
      throw new Error('deadlock detected while locking tuple (0,7)');
    });
    await mount(
      <MemoryRouter>
        <PendingInvitationsPanel userId={me} language="de" testId="ap9-einladungen" />
      </MemoryRouter>,
    );
    await click('ap9-einladungen-accept-inv-ap9');
    const hinweis = q('ap9-einladungen-error');
    expect(hinweis?.getAttribute('role')).toBe('alert');
    const ref = /Referenz: ([0-9A-Z]{4})$/.exec(hinweis?.textContent ?? '')?.[1] ?? '';
    expect(ref).toMatch(REF);
    mitReferenz(hinweis?.textContent, ref);
    expect(hinweis?.textContent).not.toContain('deadlock');
    expect(workspaceChangeDeps.reloadTo).not.toHaveBeenCalled();
  });

  it('Q6: Plattform — unbekannte Meldung mit Referenz; bekannte behält ihren Text', () => {
    const unbekannt = adminFailure('FEHLER: Spalte "license_until" existiert nicht');
    expect(unbekannt.errorKey).toBe('platform.error.unknown');
    expect(unbekannt.ref).toMatch(REF);
    mitReferenz(failureText('de', unbekannt), unbekannt.ref!);
    const bekannt = adminFailure('admin_last_admin: der letzte Admin');
    expect(bekannt).toEqual({ errorKey: 'platform.error.lastAdmin' });
    // Gleiche Ursache, gleiche Referenz — so lässt sich ein gemeldeter Fall zuordnen.
    expect(adminFailure('FEHLER: Spalte "license_until" existiert nicht').ref).toBe(unbekannt.ref);
  });

  it('Q6: Anmeldung — unbekannter Fehler mit Referenz in der Oberflächensprache; bekannte Fehler unverändert', () => {
    expect(getLoginErrorMessage('unknown', 'bg', 'K7Q2')).toBe(t('errors.genericWithReference', 'bg', { ref: 'K7Q2' }));
    expect(getLoginErrorMessage('unknown', 'de')).toBe(t('auth.error.unknown', 'de'));
    expect(getLoginErrorMessage('invalid_credentials', 'de', 'K7Q2')).toBe(t('auth.error.invalidCredentials', 'de'));
  });

  it('Q6: Betriebslöschung — unbekannter Serverfehler beim Widerruf mit Referenz, bekannter Code mit eigenem Grund', async () => {
    await loginAsDefaultAdmin();
    registerMockRpcHandler('workspace_revoke_deletion', () => {
      throw new Error('could not serialize access due to concurrent update');
    });
    const unbekannt = await revokeWorkspaceDeletion(W1);
    expect(unbekannt).toEqual({ ok: false, reason: 'unavailable', ref: expect.stringMatching(REF) });
    registerMockRpcHandler('workspace_revoke_deletion', () => {
      throw new Error('deletion_in_progress: läuft');
    });
    expect(await revokeWorkspaceDeletion(W1)).toEqual({ ok: false, reason: 'in_progress' });
  });
});
