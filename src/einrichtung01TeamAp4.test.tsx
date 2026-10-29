/**
 * EINRICHTUNG-01 (AP4) — Oberfläche für Team, Einladung, Übergabe, Betriebswahl und Plattform (Vitest-Anteile):
 *   U1 (M-02, Vertrag 1.4) Teamseite bietet nur an, was die eigene Rolle erlaubt; Mitglieder ohne E-Mails.
 *   U2 (M-01, M-17.3) Einladen: Rollenwahl nur für den Inhaber, Rollenerklärung, Link zum Kopieren, Mailstatus.
 *   U3 (E16, Z-08.1) Nur-Lesen: Einladen und Aufstufen gesperrt, Entfernen, Herabstufen und Übergabe erreichbar.
 *   U4 (Vertrag 1.11) offline bzw. unbestätigte Rechte: keine Teamaktion.
 *   U5 (P-04.1-Muster) Entfernen fragt nach; „Abbrechen“ ändert nichts; Bestätigen sendet mit Anfrage-ID.
 *   U6 (M-11.1) Verlassen bindet neu.
 *   U7 (Weg C) Einladungsseite ohne und mit Anmeldung; Annahme macht den Betrieb aktiv und bindet neu.
 *   U8 (M-07.4) offene Einladung ohne Betrieb: eigene Ansicht mit Annehmen und Ablehnen.
 *   U9 (M-13.1, P-01.1) Betriebswahl im Benutzermenü; genau ein Plattform-Einstieg.
 *   U10 (P-01.2, P-02.1, P-04.1, P-08.1) Plattform-Verwaltung.
 *   U11 (P-01.1) Plattform-Verwaltung ohne eigenen Betrieb.
 *   U12 (M-10.3) bestätigter Entzug in der App: isolieren, neu binden, Hinweis.
 *   U13 (O-06.1) „Abschließen und Team einladen“.
 *   U14 (N-M2.2) Widerruf nach der Annahme: neu binden mit Hinweis bzw. „bereits abgeschlossen“.
 *   U15 (Weg C, A-12) wartendes Konto: Rücksprung nach der Anmeldung nur zur Einladung.
 *   U16 (M-10.3, M-13) Entzug beim Start erkannt; der Neustart fragt den Server (ensure), keine Neulade-Schleife.
 *   U17 (N1; Vertrag 1.5, Weg C) ohne Betrieb: Die Einladungsadresse prüft genau dieses Token — ungültig, widerrufen,
 *       annehmen —, statt der Hinweisseite; jede andere Adresse zeigt weiter den Hinweis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { AppProvider } from './context/AppContext';
import { BusinessStateGate } from './components/system/BusinessStateGate';
import { TeamSettingsPage } from './pages/settings/TeamSettingsPage';
import { InvitationPage } from './pages/InvitationPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { FirstRunWizard } from './components/setup/FirstRunWizard';
import { AppShell } from './components/layout/AppShell';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import * as teamService from './services/team/teamService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { hydrateWorkspaceStore, resetWorkspaceStore } from './services/workspace/workspaceStore';
import { WORKSPACE_ACCESS_KEY_PREFIX, resetWorkspaceAccessForTests } from './services/workspace/workspaceAccessService';
import { isWorkspaceRevoked, workspaceChangeDeps } from './services/workspace/workspaceMembershipChangeService';
import { isWorkspaceRebindRequested, resetWorkspaceCloudBootstrapForTests } from './services/workspace/workspaceCloudBootstrapService';
import { createSeedState, savePersistedStateToKey } from './services/persistenceService';
import { STORAGE_VERSION } from './services/sync/syncMigrationService';
import { createSyncClient } from './services/sync/syncClientService';
import { resetSyncCoordinatorForTests } from './services/sync/syncCoordinator';
import { resetSyncOutboxForTests } from './services/sync/syncOutboxService';
import { createDefaultSetupWizardDraft } from './types/setup';
import { t } from './i18n';
import { resetTestStores } from './test/resetStores';
import { clearMockRpcHandlers, registerMockRpcHandler } from './test/mockProfileStore';
import { loginAsDefaultAdmin, registerAndApproveUser, registerPendingTestUser, login } from './test/authFixtures';
import { getMockCurrentSession } from './test/mockSupabaseAuth';
import { signOutUser } from './services/auth/supabaseAuthService';

const W1 = '00000000-0000-0000-0000-0000000e5a01';
const W3 = '00000000-0000-0000-0000-0000000e5a03';
const ADMIN_ID = 'konto-ap4-admin';
const MEMBER_ID = 'konto-ap4-member';
const STAMP = '2026-10-01T08:00:00.000Z';
const complete = { ...DEFAULT_SETUP, companyName: 'AP4 GmbH', setupComplete: true, setupVersion: 1 };

type Rolle = 'owner' | 'admin' | 'member';
let me = '';
let calls: Array<{ name: string; args: Record<string, unknown> }> = [];

function record(name: string) {
  return (args: Record<string, unknown>) => {
    calls.push({ name, args });
  };
}

function bindAs(rolle: Rolle): void {
  setActiveStorageScope({ type: 'workspace', workspaceId: W1, account: { userId: me, access: rolle === 'member' ? 'member' : 'full' } });
  hydrateWorkspaceStore({
    workspace: { id: W1, name: 'AP4 GmbH', ownerUserId: rolle === 'owner' ? me : 'konto-ap4-owner', createdAt: STAMP, updatedAt: STAMP, version: 1 },
    workspaceMembers: [{ workspaceId: W1, userId: me, role: rolle, status: 'active', createdAt: STAMP, updatedAt: STAMP }],
  } as never);
}

function teamServer(rolle: Rolle): void {
  const manager = rolle !== 'member';
  registerMockRpcHandler('team_list_members', (args) => {
    record('team_list_members')(args);
    const rows: Array<Record<string, unknown>> = [
      { user_id: rolle === 'owner' ? me : 'konto-ap4-owner', name: 'Olga Eins', role: 'owner', status: 'active', member_since: STAMP, is_self: rolle === 'owner' },
      { user_id: rolle === 'admin' ? me : ADMIN_ID, name: 'Anton Admin', role: 'admin', status: 'active', member_since: STAMP, is_self: rolle === 'admin' },
      { user_id: rolle === 'member' ? me : MEMBER_ID, name: 'Mira Mitglied', role: 'member', status: 'active', member_since: STAMP, is_self: rolle === 'member' },
    ];
    return rows.map((row) => ({
      ...row,
      ...(manager ? { email: `${String(row.name).split(' ')[0].toLowerCase()}@example.invalid` } : {}),
      ...(rolle === 'owner' ? { transfer_eligible: row.role === 'admin' } : {}),
    }));
  });
  registerMockRpcHandler('team_list_invitations', (args) => {
    record('team_list_invitations')(args);
    if (!manager) throw new Error('team_forbidden_role: nein');
    return [
      { invitation_id: 'inv-1', email: 'offen@example.invalid', role: 'member', status: 'open', created_at: STAMP, expires_at: '2026-10-08T08:00:00.000Z', invited_by_name: 'Olga Eins', resend_count: 0, resend_available_at: STAMP, can_manage: true },
    ];
  });
  registerMockRpcHandler('team_open_transfer', () => null);
  registerMockRpcHandler('team_list_events', () => [
    { id: 'ev-1', action: 'invitation_created', actor_name: 'Olga Eins', target_name: null, details: {}, created_at: STAMP },
  ]);
  for (const name of ['team_change_role', 'team_remove_member', 'team_leave', 'team_revoke_invitation', 'team_request_transfer']) {
    registerMockRpcHandler(name, (args) => {
      record(name)(args);
      return { changed: true, transfer_id: 'tr-1' };
    });
  }
  registerMockRpcHandler('team_invite', (args) => {
    record('team_invite')(args);
    return { invitation_id: 'inv-neu', status: 'created', role: args.p_role, email: args.p_email, expires_at: '2026-10-30T08:00:00.000Z', token: 'NeuesToken-0123456789abcdefghijklmnopqrstu' };
  });
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(ui: React.ReactNode): Promise<HTMLDivElement> {
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

async function type(testId: string, value: string): Promise<void> {
  const element = q(testId) as HTMLInputElement | null;
  expect(element, `Feld ${testId} fehlt`).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function teamPage() {
  return (
    <MemoryRouter initialEntries={['/einstellungen/team']}>
      <AuthProvider>
        <AppProvider initialSetup={complete}>
          <Routes>
            <Route path="/einstellungen/team" element={<TeamSettingsPage />} />
            <Route path="/" element={<div data-testid="home" />} />
          </Routes>
        </AppProvider>
      </AuthProvider>
    </MemoryRouter>
  );
}

function readOnlyRecord(rolle: Rolle): void {
  localStorage.setItem(
    `${WORKSPACE_ACCESS_KEY_PREFIX}${me}:${W1}`,
    JSON.stringify({ workspaceId: W1, userId: me, role: rolle, licenseState: 'expired', licenseEffective: false, confirmedAt: STAMP }),
  );
  resetWorkspaceAccessForTests();
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  calls = [];
  clearMockRpcHandlers();
  resetWorkspaceStore();
  resetWorkspaceAccessForTests();
  await loginAsDefaultAdmin();
  me = getMockCurrentSession()?.user.id ?? '';
  vi.spyOn(workspaceChangeDeps, 'reloadTo').mockImplementation(() => undefined);
});

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
  clearMockRpcHandlers();
  setActiveStorageScope({ type: 'guest' });
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('EINRICHTUNG-01 AP4 — Teamseite', () => {
  it('U1: Inhaber — Rollenwechsel, Übergabe an zulässiges Ziel, Entfernen; nie am eigenen Eintrag', async () => {
    bindAs('owner');
    teamServer('owner');
    await mount(teamPage());
    expect(q('settings-team-page')?.getAttribute('data-role')).toBe('owner');
    expect(q(`team-action-make-member-${ADMIN_ID}`)).not.toBeNull();
    expect(q(`team-action-transfer-${ADMIN_ID}`)).not.toBeNull();
    expect(q(`team-action-remove-${ADMIN_ID}`)).not.toBeNull();
    expect(q(`team-action-make-admin-${MEMBER_ID}`)).not.toBeNull();
    expect(q(`team-action-transfer-${MEMBER_ID}`), 'Übergabe an Ziel ohne Lizenz angeboten').toBeNull();
    expect(q(`team-action-remove-${me}`)).toBeNull();
    expect(q(`team-action-make-member-${me}`)).toBeNull();
    expect(q('team-leave-owner-hint')).not.toBeNull();
    expect(q('team-leave-button')).toBeNull();
    expect(host?.textContent).toContain('anton@example.invalid');
    expect(q('team-invitation-inv-1')).not.toBeNull();
    expect(q('team-events')).not.toBeNull();
  });

  it('U1: Admin — entfernt nur Mitglieder, ändert keine Rollen, keine Übergabe', async () => {
    bindAs('admin');
    teamServer('admin');
    await mount(teamPage());
    expect(q(`team-action-remove-${MEMBER_ID}`)).not.toBeNull();
    expect(q(`team-action-make-admin-${MEMBER_ID}`)).toBeNull();
    expect(q(`team-action-remove-konto-ap4-owner`)).toBeNull();
    expect(q('team-transfer-revoke')).toBeNull();
    expect(q('team-leave-button')).not.toBeNull();
    const roleSelect = q('team-invite-role') as HTMLSelectElement;
    expect(Array.from(roleSelect.options).map((option) => option.value)).toEqual(['member']);
  });

  it('U1: Mitglied — Liste ohne E-Mails, keine Aktionen, kein Einladen; Verlassen möglich', async () => {
    bindAs('member');
    teamServer('member');
    await mount(teamPage());
    expect(q('team-member-view')).not.toBeNull();
    expect(host?.textContent).not.toContain('@example.invalid');
    expect(q('team-invite')).toBeNull();
    expect(q('team-invitations')).toBeNull();
    expect(host?.querySelector('[data-testid^="team-action-"]')).toBeNull();
    expect(q('team-leave-button')).not.toBeNull();
    expect(calls.some((call) => call.name === 'team_list_invitations')).toBe(false);
  });

  it('U2: Einladen — Rollenerklärung, Link zum Kopieren, Mail nicht gesendet wird gesagt', async () => {
    bindAs('owner');
    teamServer('owner');
    const mail = vi.spyOn(teamService, 'sendInvitationMail').mockResolvedValue('not_sent');
    await mount(teamPage());
    const select = q('team-invite-role') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['member', 'admin']);
    expect(q('team-invite-role-hint')?.textContent).toBe(t('team.role.member.hint', 'de'));
    await act(async () => {
      select.value = 'admin';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(q('team-invite-role-hint')?.textContent).toBe(t('team.role.admin.hint', 'de'));
    await type('team-invite-email', 'neu@example.invalid');
    await act(async () => {
      (q('team-invite') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    const invite = calls.find((call) => call.name === 'team_invite');
    expect(invite?.args).toMatchObject({ p_workspace_id: W1, p_email: 'neu@example.invalid', p_role: 'admin' });
    expect(typeof invite?.args.p_request_id).toBe('string');
    expect((q('team-invite-link') as HTMLInputElement).value).toContain('/einladung/NeuesToken-');
    expect(mail).toHaveBeenCalledWith(expect.objectContaining({ invitationId: 'inv-neu' }));
    expect(q('team-invite-mail')?.getAttribute('data-state')).toBe('not_sent');
    expect(q('team-invite-mail')?.textContent).toBe(t('team.invite.mailNotSent', 'de'));
    expect(q('team-invite-copy')).not.toBeNull();
  });

  it('U3 (E16): Nur-Lesen — Einladen und Aufstufen gesperrt; Entfernen, Herabstufen, Übergabe, Widerruf erreichbar', async () => {
    bindAs('owner');
    teamServer('owner');
    readOnlyRecord('owner');
    await mount(teamPage());
    expect(q('team-read-only')).not.toBeNull();
    expect((q('team-invite-submit') as HTMLButtonElement).disabled).toBe(true);
    expect((q(`team-action-make-admin-${MEMBER_ID}`) as HTMLButtonElement).disabled).toBe(true);
    expect((q(`team-action-make-member-${ADMIN_ID}`) as HTMLButtonElement).disabled).toBe(false);
    expect((q(`team-action-remove-${MEMBER_ID}`) as HTMLButtonElement).disabled).toBe(false);
    expect((q(`team-action-transfer-${ADMIN_ID}`) as HTMLButtonElement).disabled).toBe(false);
    expect((q('team-invitation-revoke-inv-1') as HTMLButtonElement).disabled).toBe(false);
    expect((q('team-invitation-resend-inv-1') as HTMLButtonElement).disabled).toBe(true);
  });

  it('U4: offline — keine Teamaktion', async () => {
    bindAs('owner');
    teamServer('owner');
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await mount(teamPage());
    expect(q('team-offline')).not.toBeNull();
    expect(host?.querySelector('[data-testid^="team-action-"]')).toBeNull();
    expect((q('team-invite-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('U5: Entfernen fragt nach — Abbrechen ändert nichts, Bestätigen sendet einmal mit Anfrage-ID', async () => {
    bindAs('owner');
    teamServer('owner');
    await mount(teamPage());
    await click(`team-action-remove-${MEMBER_ID}`);
    expect(q('team-confirm-dialog')?.textContent).toContain('Mira Mitglied');
    await click('team-confirm-cancel');
    expect(calls.filter((call) => call.name === 'team_remove_member')).toEqual([]);
    await click(`team-action-remove-${MEMBER_ID}`);
    await click('team-confirm-remove');
    const removes = calls.filter((call) => call.name === 'team_remove_member');
    expect(removes).toHaveLength(1);
    expect(removes[0].args).toMatchObject({ p_workspace_id: W1, p_target_user_id: MEMBER_ID });
    expect(typeof removes[0].args.p_request_id).toBe('string');
  });

  it('U6: Verlassen — bestätigt, dann neu gebunden', async () => {
    bindAs('member');
    teamServer('member');
    await mount(teamPage());
    await click('team-leave-button');
    await click('team-confirm-leave');
    expect(calls.some((call) => call.name === 'team_leave')).toBe(true);
    expect(workspaceChangeDeps.reloadTo).toHaveBeenCalledWith('/');
  });

  it('U14 (N-M2.2): Widerruf kommt zu spät — angenommen: neu binden mit Hinweis; sonst „bereits abgeschlossen“', async () => {
    bindAs('owner');
    teamServer('owner');
    registerMockRpcHandler('team_open_transfer', () => ({ transfer_id: 'tr-1', kind: 'owner', to_user_id: ADMIN_ID, to_name: 'Anton Admin', expires_at: '2026-10-04T08:00:00.000Z', expired: false }));
    let stand = 'accepted';
    registerMockRpcHandler('team_revoke_transfer', (args) => {
      record('team_revoke_transfer')(args);
      return { transfer_id: 'tr-1', status: stand, changed: false };
    });
    await mount(teamPage());
    await click('team-transfer-revoke');
    // EINRICHTUNG-01 (AP8; 1.28) — der Widerruf eines Übergabeantrags läuft erst nach der Rückfrage.
    await click('team-confirm-transfer-revoke');
    expect(calls.filter((call) => call.name === 'team_revoke_transfer')[0]?.args).toMatchObject({ p_transfer_id: 'tr-1' });
    expect(workspaceChangeDeps.reloadTo).toHaveBeenCalledWith('/einstellungen/team');
    expect(JSON.parse(sessionStorage.getItem('officetakt.notice.workspaceChange') ?? 'null')).toEqual({ kind: 'handedOver', workspaceName: 'AP4 GmbH' });
    expect(t('workspaceChange.handedOver', 'tr')).not.toBe('workspaceChange.handedOver');
    expect(t('workspaceChange.handedOver', 'bg')).not.toBe('workspaceChange.handedOver');
    await unmount();

    vi.mocked(workspaceChangeDeps.reloadTo).mockClear();
    sessionStorage.clear();
    stand = 'declined';
    await mount(teamPage());
    await click('team-transfer-revoke');
    // EINRICHTUNG-01 (AP8; 1.28) — der Widerruf eines Übergabeantrags läuft erst nach der Rückfrage.
    await click('team-confirm-transfer-revoke');
    expect(workspaceChangeDeps.reloadTo).not.toHaveBeenCalled();
    expect(host?.textContent).toContain(t('team.transfer.alreadyClosed', 'de'));
    expect(sessionStorage.getItem('officetakt.notice.workspaceChange')).toBeNull();
  });
});

describe('EINRICHTUNG-01 AP4 — Einladung annehmen', () => {
  const TOKEN = 'EinladungsToken-0123456789abcdefghijklmn';

  it('U7: ohne Anmeldung — Anmelden bzw. Registrieren mit Rücksprung und vorbelegter Adresse', async () => {
    await signOutUser();
    await mount(
      <MemoryRouter initialEntries={[`/einladung/${TOKEN}?email=x1%40example.invalid`]}>
        <AuthProvider>
          <Routes>
            <Route path="/einladung/:token" element={<InvitationPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    const loginHref = (q('invitation-login') as HTMLAnchorElement).getAttribute('href') ?? '';
    expect(decodeURIComponent(loginHref)).toContain(`next=/einladung/${TOKEN}`);
    expect(decodeURIComponent(loginHref)).toContain('email=x1@example.invalid');
    expect((q('invitation-register') as HTMLAnchorElement).getAttribute('href')).toContain('/register?');
  });

  it('U7: angemeldet — ansehen, annehmen, Betrieb wird aktiv, neu gebunden', async () => {
    registerMockRpcHandler('invitation_preview', () => ({ ok: true, status: 'open', invitation_id: 'inv-x', workspace_name: 'AP4 GmbH', role: 'member', inviter_name: 'Olga Eins', expires_at: '2026-10-30T08:00:00.000Z' }));
    registerMockRpcHandler('accept_invitation', (args) => {
      record('accept_invitation')(args);
      return { ok: true, status: 'accepted', workspace_id: W1, role: 'member' };
    });
    registerMockRpcHandler('select_active_workspace', (args) => {
      record('select_active_workspace')(args);
      return { workspace_id: args.p_workspace_id };
    });
    await mount(
      <MemoryRouter initialEntries={[`/einladung/${TOKEN}`]}>
        <AuthProvider>
          <Routes>
            <Route path="/einladung/:token" element={<InvitationPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(q('invitation-preview')?.textContent).toContain('AP4 GmbH');
    await click('invitation-accept');
    expect(calls.find((call) => call.name === 'accept_invitation')?.args).toMatchObject({ p_token: TOKEN, p_invitation_id: null });
    expect(calls.find((call) => call.name === 'select_active_workspace')?.args).toEqual({ p_workspace_id: W1 });
    expect(workspaceChangeDeps.reloadTo).toHaveBeenCalledWith('/');
    expect(JSON.parse(sessionStorage.getItem('officetakt.notice.workspaceChange') ?? '{}')).toEqual({ kind: 'accepted', workspaceName: 'AP4 GmbH' });
  });

  it('U15 (Weg C, A-12): wartendes Konto kehrt nach der Anmeldung zur Einladung zurück; andere Ziele führen zur Warteseite', async () => {
    registerMockRpcHandler('invitation_preview', () => ({ ok: true, status: 'open', invitation_id: 'inv-x', workspace_name: 'AP4 GmbH', role: 'member', inviter_name: 'Olga Eins', expires_at: '2026-10-30T08:00:00.000Z' }));
    registerMockRpcHandler('list_my_invitations', () => []);
    await signOutUser();
    await registerPendingTestUser('wartend-ap4@example.invalid');
    await login('wartend-ap4@example.invalid', 'TestPasswort1');
    const app = (eintrag: string) => (
      <MemoryRouter initialEntries={[eintrag]}>
        <AuthProvider>
          <AppProvider initialSetup={complete}>
            <App />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>
    );
    await mount(app(`/login?next=${encodeURIComponent(`/einladung/${TOKEN}?email=wartend-ap4%40example.invalid`)}`));
    expect(q('invitation-preview')?.textContent).toContain('AP4 GmbH');
    await unmount();
    await mount(app('/login?next=%2Feinstellungen%2Ffirma'));
    expect(q('waiting-approval-page')).not.toBeNull();
    expect(q('invitation-preview')).toBeNull();
  });

  it('U7: fremde oder ungültige Einladung — dieselbe übersetzte Meldung, kein Annehmen', async () => {
    registerMockRpcHandler('invitation_preview', () => ({ ok: false, code: 'invitation_invalid' }));
    await mount(
      <MemoryRouter initialEntries={[`/einladung/${TOKEN}`]}>
        <AuthProvider>
          <Routes>
            <Route path="/einladung/:token" element={<InvitationPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(q('invitation-error')?.textContent).toBe(t('team.error.invitation_invalid', 'de'));
    expect(q('invitation-accept')).toBeNull();
  });

  it('U8 (M-07.4): ohne Betrieb mit offener Einladung — eigene Ansicht, Annehmen bindet neu', async () => {
    const konto = await registerAndApproveUser('eingeladen-ap4@example.invalid');
    await signOutUser();
    await login('eingeladen-ap4@example.invalid', 'TestPasswort1');
    expect(getMockCurrentSession()?.user.id).toBe(konto.id);
    registerMockRpcHandler('ensure_personal_workspace', () => ({ workspace: null, member: null, created: false, reason: 'invitation_pending' }));
    registerMockRpcHandler('list_my_invitations', () => [
      { invitation_id: 'inv-p', workspace_id: W1, workspace_name: 'AP4 GmbH', role: 'member', inviter_name: 'Olga Eins', expires_at: '2026-10-30T08:00:00.000Z' },
    ]);
    registerMockRpcHandler('accept_invitation', (args) => {
      record('accept_invitation')(args);
      return { ok: true, status: 'accepted', workspace_id: W1, role: 'member' };
    });
    registerMockRpcHandler('select_active_workspace', () => ({ workspace_id: W1 }));
    resetWorkspaceCloudBootstrapForTests();
    resetSyncCoordinatorForTests();
    resetSyncOutboxForTests();
    localStorage.clear();
    await mount(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <BusinessStateGate>
            <App />
          </BusinessStateGate>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(q('workspace-invitation-pending')).not.toBeNull();
    expect(q('first-run-wizard')).toBeNull();
    expect(q('workspace-invitation-pending-list-item-inv-p')?.textContent).toContain('AP4 GmbH');
    await click('workspace-invitation-pending-list-accept-inv-p');
    expect(calls.find((call) => call.name === 'accept_invitation')?.args).toMatchObject({ p_invitation_id: 'inv-p', p_token: null });
    expect(workspaceChangeDeps.reloadTo).toHaveBeenCalledWith('/');
    resetTestStores();
  });
});

describe('EINRICHTUNG-01 AP0–AP4-Abschluss — Einladungsadresse ohne Betrieb (N1)', () => {
  const FREMD = 'FremdesToken-0123456789abcdefghijklmnop';
  const EIGEN = 'EigenesToken-0123456789abcdefghijklmnop';
  const OFFEN = { ok: true, status: 'open', invitation_id: 'inv-e', workspace_name: 'AP4 GmbH', role: 'member', inviter_name: 'Olga Eins', expires_at: '2026-10-30T08:00:00.000Z' };

  /** Freigegebenes Konto ohne Mitgliedschaft; der Start meldet `no_license` bzw. `invitation_pending` (eigene Einladung inv-p). */
  async function ohneBetrieb(reason: 'no_license' | 'invitation_pending', email: string): Promise<void> {
    const konto = await registerAndApproveUser(email);
    await signOutUser();
    await login(email, 'TestPasswort1');
    expect(getMockCurrentSession()?.user.id).toBe(konto.id);
    registerMockRpcHandler('ensure_personal_workspace', () => ({ workspace: null, member: null, created: false, reason }));
    registerMockRpcHandler('list_my_invitations', () =>
      reason === 'invitation_pending'
        ? [{ invitation_id: 'inv-p', workspace_id: W1, workspace_name: 'AP4 GmbH', role: 'member', inviter_name: 'Olga Eins', expires_at: '2026-10-30T08:00:00.000Z' }]
        : [],
    );
    resetWorkspaceCloudBootstrapForTests();
    resetSyncCoordinatorForTests();
    resetSyncOutboxForTests();
    localStorage.clear();
  }

  /** Vorschau je Token (unbekannt: „ungültig“); Annehmen, Ablehnen und Betriebswahl werden mitgeschrieben. */
  function einladungsServer(vorschau: Record<string, Record<string, unknown>>): void {
    registerMockRpcHandler('invitation_preview', (args) => {
      record('invitation_preview')(args);
      return vorschau[String(args.p_token)] ?? { ok: false, code: 'invitation_invalid' };
    });
    registerMockRpcHandler('accept_invitation', (args) => {
      record('accept_invitation')(args);
      return { ok: true, status: 'accepted', workspace_id: W1, role: 'member' };
    });
    registerMockRpcHandler('decline_invitation', (args) => {
      record('decline_invitation')(args);
      return { ok: true, status: 'declined' };
    });
    registerMockRpcHandler('select_active_workspace', (args) => {
      record('select_active_workspace')(args);
      return { workspace_id: args.p_workspace_id };
    });
  }

  const start = (eintrag: string) => (
    <MemoryRouter initialEntries={[eintrag]}>
      <AuthProvider>
        <BusinessStateGate>
          <App />
        </BusinessStateGate>
      </AuthProvider>
    </MemoryRouter>
  );

  it('U17a (N1): ohne Lizenz, fremder Link — „Einladung ungültig“ statt „Noch kein Betrieb“; nichts angenommen; Startseite zeigt den Hinweis', async () => {
    await ohneBetrieb('no_license', 'n1-fremd-ap4@example.invalid');
    einladungsServer({});
    await mount(start(`/einladung/${FREMD}`));
    expect(q('workspace-no-license')).toBeNull();
    expect(q('invitation-error')?.textContent).toBe(t('team.error.invitation_invalid', 'de'));
    expect(q('invitation-preview')).toBeNull();
    expect(q('invitation-accept')).toBeNull();
    expect(calls).toEqual([{ name: 'invitation_preview', args: { p_token: FREMD } }]);
    await click('invitation-home');
    expect(q('invitation-page')).toBeNull();
    expect(q('workspace-no-license')).not.toBeNull();
    resetTestStores();
  });

  it('U17b (N1): ohne Lizenz, eigener widerrufener Link — „widerrufen“, kein Annehmen', async () => {
    await ohneBetrieb('no_license', 'n1-widerrufen-ap4@example.invalid');
    einladungsServer({ [EIGEN]: { ok: false, code: 'invitation_revoked' } });
    await mount(start(`/einladung/${EIGEN}`));
    expect(q('workspace-no-license')).toBeNull();
    expect(q('invitation-error')?.textContent).toBe(t('team.error.invitation_revoked', 'de'));
    expect(q('invitation-accept')).toBeNull();
    expect(calls.map((call) => call.name)).toEqual(['invitation_preview']);
    resetTestStores();
  });

  it('U17c (N1): ohne Lizenz, eigener gültiger Link — ansehen, annehmen, Betrieb aktiv, neu gebunden', async () => {
    await ohneBetrieb('no_license', 'n1-eigen-ap4@example.invalid');
    einladungsServer({ [EIGEN]: OFFEN });
    await mount(start(`/einladung/${EIGEN}`));
    expect(q('workspace-no-license')).toBeNull();
    expect(q('invitation-preview')?.textContent).toContain('AP4 GmbH');
    await click('invitation-accept');
    expect(calls.find((call) => call.name === 'accept_invitation')?.args).toMatchObject({ p_token: EIGEN, p_invitation_id: null });
    expect(calls.find((call) => call.name === 'select_active_workspace')?.args).toEqual({ p_workspace_id: W1 });
    expect(workspaceChangeDeps.reloadTo).toHaveBeenCalledWith('/');
    expect(JSON.parse(sessionStorage.getItem('officetakt.notice.workspaceChange') ?? '{}')).toEqual({ kind: 'accepted', workspaceName: 'AP4 GmbH' });
    resetTestStores();
  });

  it('U17d (Weg C): eigene offene Einladung, fremder Link — „Einladung ungültig“ statt der eigenen Liste; Startseite zeigt die Liste', async () => {
    await ohneBetrieb('invitation_pending', 'n1-liste-ap4@example.invalid');
    einladungsServer({});
    await mount(start(`/einladung/${FREMD}`));
    expect(q('workspace-invitation-pending')).toBeNull();
    expect(q('invitation-error')?.textContent).toBe(t('team.error.invitation_invalid', 'de'));
    expect(q('invitation-accept')).toBeNull();
    await click('invitation-home');
    expect(q('workspace-invitation-pending')).not.toBeNull();
    expect(q('workspace-invitation-pending-list-item-inv-p')?.textContent).toContain('AP4 GmbH');
    expect(calls.map((call) => call.name)).toEqual(['invitation_preview']);
    resetTestStores();
  });
});

describe('EINRICHTUNG-01 AP4 — Betriebswahl und Plattform-Einstieg', () => {
  it('U9 (M-13.1): mehrere Mitgliedschaften — Wahl im Benutzermenü, Wechsel bindet neu; genau ein Plattform-Einstieg', async () => {
    bindAs('owner');
    registerMockRpcHandler('list_own_memberships', () => [
      { workspace_id: W1, workspace_name: 'AP4 GmbH', role: 'owner', status: 'active', member_since: STAMP },
      { workspace_id: W3, workspace_name: 'Dora GmbH', role: 'member', status: 'active', member_since: STAMP },
    ]);
    registerMockRpcHandler('select_active_workspace', (args) => {
      record('select_active_workspace')(args);
      return { workspace_id: args.p_workspace_id };
    });
    await mount(
      <MemoryRouter initialEntries={['/einstellungen']}>
        <AuthProvider>
          <AppProvider initialSetup={complete}>
            <App />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    // Der Einstellungs-Hub führt zum Team, nicht zur Plattform-Verwaltung.
    expect(q('settings-entry-team-members')).not.toBeNull();
    expect(host?.querySelector('a[href="/admin/users"]')).toBeNull();
    await click('user-menu-dropdown-trigger');
    expect(q(`user-menu-workspace-${W1}`)?.textContent).toContain(t('workspaceSwitch.current', 'de'));
    expect(q(`user-menu-workspace-${W3}`)?.textContent).toContain('Dora GmbH');
    expect(q('user-menu-admin')?.textContent).toBe(t('platform.entry', 'de'));
    expect(host?.querySelectorAll('a[href="/admin/users"]').length).toBe(1);
    await click(`user-menu-workspace-${W3}`);
    expect(calls.find((call) => call.name === 'select_active_workspace')?.args).toEqual({ p_workspace_id: W3 });
    expect(workspaceChangeDeps.reloadTo).toHaveBeenCalledWith('/');
  });
});

describe('EINRICHTUNG-01 AP4 — Plattform-Verwaltung', () => {
  const ZIEL = 'konto-ap4-ziel';

  function adminServer(): void {
    registerMockRpcHandler('admin_list_profiles', () => [
      { id: me, company_name: 'Plattform', first_name: 'System', last_name: 'Administrator', email: 'admin@officepilot.local', role: 'admin', status: 'approved', license_status: 'inactive', license_expires_at: null, created_at: STAMP, updated_at: STAMP },
      { id: ZIEL, company_name: 'Ziel GmbH', first_name: 'Zora', last_name: 'Ziel', email: 'zora@example.invalid', role: 'user', status: 'approved', license_status: 'active', license_expires_at: '2026-12-01T00:00:00.000Z', created_at: STAMP, updated_at: STAMP },
    ]);
    registerMockRpcHandler('admin_list_events', () => []);
    registerMockRpcHandler('admin_list_ownership_repair_cases', () => []);
  }

  function platformPage() {
    return (
      <MemoryRouter initialEntries={['/admin/users']}>
        <AuthProvider>
          <Routes>
            <Route path="/admin/users" element={<AdminUsersPage />} />
            <Route path="/" element={<div data-testid="home" />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );
  }

  it('U10 (P-01.2): ohne Plattformrolle leitet die Adresse um', async () => {
    const konto = await registerAndApproveUser('kein-admin-ap4@example.invalid');
    await signOutUser();
    await login('kein-admin-ap4@example.invalid', 'TestPasswort1');
    expect(getMockCurrentSession()?.user.id).toBe(konto.id);
    await mount(platformPage());
    expect(q('home')).not.toBeNull();
    expect(q('admin-users-page')).toBeNull();
  });

  it('U10 (P-02.1, P-04.1): kein Knopf am eigenen Konto; Sperren fragt mit dem richtigen Ziel nach; Abbrechen ändert nichts', async () => {
    adminServer();
    registerMockRpcHandler('admin_block_user', (args) => {
      record('admin_block_user')(args);
      return { id: ZIEL, status: 'blocked', role: 'user', email: 'zora@example.invalid', first_name: 'Zora', last_name: 'Ziel', company_name: 'Ziel GmbH', license_status: 'active', created_at: STAMP, updated_at: STAMP };
    });
    await mount(platformPage());
    expect(q(`admin-user-self-${me}`)).not.toBeNull();
    expect(q(`block-${me}`)).toBeNull();
    await click(`block-${ZIEL}`);
    expect(q('admin-confirm-dialog')?.textContent).toContain('zora@example.invalid');
    await click('admin-confirm-cancel');
    expect(calls.filter((call) => call.name === 'admin_block_user')).toEqual([]);
    await click(`block-${ZIEL}`);
    await click(`confirm-block-${ZIEL}`);
    const blocks = calls.filter((call) => call.name === 'admin_block_user');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].args.p_user_id).toBe(ZIEL);
    expect(typeof blocks[0].args.p_request_id).toBe('string');
  });

  it('U10 (P-08.1, P-06): Fehler übersetzt, nie roh; Verlängerung mit dem gesehenen Ablauf', async () => {
    adminServer();
    registerMockRpcHandler('admin_extend_license', (args) => {
      record('admin_extend_license')(args);
      throw new Error('admin_license_conflict: Der Ablauf hat sich inzwischen geaendert (intern 40001)');
    });
    await mount(platformPage());
    await click(`extend-${ZIEL}`);
    expect(calls.find((call) => call.name === 'admin_extend_license')?.args).toMatchObject({ p_user_id: ZIEL, p_seen_expires_at: '2026-12-01T00:00:00.000Z' });
    expect(q('admin-users-error')?.textContent).toBe(t('platform.error.conflict', 'de'));
    expect(host?.textContent).not.toContain('intern 40001');
    for (const lang of ['tr', 'bg'] as const) expect(t('platform.error.conflict', lang)).not.toContain('admin_license_conflict');
  });

  it('U11 (P-01.1): Plattform-Admin ohne Betrieb und Lizenz erreicht die Verwaltung über den Hinweis', async () => {
    registerMockRpcHandler('ensure_personal_workspace', () => ({ workspace: null, member: null, created: false, reason: 'no_license' }));
    adminServer();
    resetWorkspaceCloudBootstrapForTests();
    resetSyncCoordinatorForTests();
    localStorage.clear();
    await mount(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <BusinessStateGate>
            <App />
          </BusinessStateGate>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(q('workspace-no-license')).not.toBeNull();
    await click('workspace-open-platform');
    expect(q('admin-users-page')).not.toBeNull();
    expect(q('admin-users-table')).not.toBeNull();
    await click('admin-users-close');
    expect(q('workspace-no-license')).not.toBeNull();
    resetTestStores();
  });
});

describe('EINRICHTUNG-01 AP4 — Entzug beim Start (M-10.3)', () => {
  it('U16: gespeicherter Betrieb, Abzug meldet „Kein Zugriff“ — Entzug statt Fehlerseite; der Neustart fragt den Server', async () => {
    // Stand wie nach einer früheren Bindung: Nutzerbereich mit gespeicherter Provisionierung von W1.
    savePersistedStateToKey(
      { type: 'user', userId: me },
      {
        ...createSeedState({ ...complete }),
        version: STORAGE_VERSION,
        invoiceEntries: [],
        syncClient: { ...createSyncClient(), workspaceId: W1, serverWorkspaceId: W1, cloudProvisionedAt: STAMP, syncPolicy: 'cloud_ready' },
        workspace: { id: W1, name: 'AP4 GmbH', ownerUserId: 'konto-ap4-owner', createdAt: STAMP, updatedAt: STAMP, version: 1 },
        savedAt: STAMP,
      },
    );
    let ensureAufrufe = 0;
    registerMockRpcHandler('ensure_personal_workspace', () => {
      ensureAufrufe += 1;
      return { workspace: null, member: null, created: false, reason: 'no_license' };
    });
    registerMockRpcHandler('pull_workspace_sync_state', () => {
      throw new Error('Kein Zugriff auf Workspace');
    });
    const start = () => (
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <BusinessStateGate>
            <App />
          </BusinessStateGate>
        </AuthProvider>
      </MemoryRouter>
    );
    resetWorkspaceCloudBootstrapForTests();
    resetSyncCoordinatorForTests();
    await mount(start());
    // Erster Start: ohne ensure (gespeicherte Provisionierung), der Abzug meldet den Entzug.
    expect(ensureAufrufe).toBe(0);
    expect(isWorkspaceRevoked(me, W1)).toBe(true);
    expect(isWorkspaceRebindRequested(me)).toBe(true);
    expect(workspaceChangeDeps.reloadTo).toHaveBeenCalledWith('/');
    expect(JSON.parse(sessionStorage.getItem('officetakt.notice.workspaceChange') ?? 'null')).toEqual({ kind: 'revoked', workspaceName: 'AP4 GmbH' });
    expect(q('workspace-restore-failure')).toBeNull();
    await unmount();

    // „Nach dem Neuladen“: Die Markierung zwingt ensure; ohne Betrieb und ohne Lizenz die Hinweisseite mit dem Entzug.
    resetWorkspaceCloudBootstrapForTests();
    resetSyncCoordinatorForTests();
    await mount(start());
    expect(ensureAufrufe).toBe(1);
    expect(q('workspace-no-license')).not.toBeNull();
    expect(q('workspace-change-notice')?.getAttribute('data-kind')).toBe('revoked');
    expect(q('workspace-restore-failure')).toBeNull();
    resetTestStores();
  });

  it('U16b: bestätigt ensure den Betrieb im selben Lauf und der Abzug widerspricht — keine Neulade-Schleife, Fehlerseite', async () => {
    registerMockRpcHandler('ensure_personal_workspace', () => ({
      workspace: { id: W1, name: 'AP4 GmbH', owner_user_id: 'konto-ap4-owner', created_at: STAMP, updated_at: STAMP, version: 1 },
      member: { workspace_id: W1, user_id: me, role: 'member', status: 'active', created_at: STAMP, updated_at: STAMP },
      created: false,
    }));
    registerMockRpcHandler('pull_workspace_sync_state', () => {
      throw new Error('Kein Zugriff auf Workspace');
    });
    resetWorkspaceCloudBootstrapForTests();
    resetSyncCoordinatorForTests();
    await mount(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <BusinessStateGate>
            <App />
          </BusinessStateGate>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(workspaceChangeDeps.reloadTo).not.toHaveBeenCalled();
    expect(isWorkspaceRevoked(me, W1)).toBe(false);
    expect(q('workspace-restore-failure')).not.toBeNull();
    resetTestStores();
  });
});

describe('EINRICHTUNG-01 AP4 — Entzug in der App (M-10.3)', () => {
  it('U12: Zugriffsauskunft meldet fehlende Mitgliedschaft — Betrieb markiert, neu gebunden; danach der Hinweis', async () => {
    bindAs('member');
    registerMockRpcHandler('get_workspace_access', () => {
      throw new Error('Kein Zugriff auf Workspace');
    });
    await mount(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <AppProvider initialSetup={complete}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="/" element={<div data-testid="home" />} />
              </Route>
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(isWorkspaceRevoked(me, W1)).toBe(true);
    expect(workspaceChangeDeps.reloadTo).toHaveBeenCalledWith('/');
    await unmount();
    // „Nach dem Neuladen“: der Hinweis erscheint genau einmal.
    clearMockRpcHandlers();
    await mount(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <AppProvider initialSetup={complete}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="/" element={<div data-testid="home" />} />
              </Route>
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(q('workspace-change-notice')?.getAttribute('data-kind')).toBe('revoked');
    expect(q('workspace-change-notice')?.textContent).toContain(t('workspaceAccess.revoked.title', 'de'));
  });
});

describe('EINRICHTUNG-01 AP4 — Abschluss mit Team (O-06.1)', () => {
  it('U13: „Abschließen und Team einladen“ schließt ab und nennt die Teamseite als Ziel; der normale Abschluss bleibt', async () => {
    const zuege: string[] = [];
    const draft = {
      ...createDefaultSetupWizardDraft(DEFAULT_SETUP, { ...DEFAULT_COMPANY_PROFILE, companyName: 'Team GmbH', contactPerson: 'T', street: 'S 1', zip: '1', city: 'O', email: 'e@example.invalid', taxNumber: '1/2/3', iban: 'DE89370400440532013000' }),
    };
    await mount(
      <MemoryRouter>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: false }}>
          <FirstRunWizard
            initialDraft={draft}
            initialStepIndex={4}
            teamInvite
            onComplete={(_draft, next) => {
              zuege.push(next);
              return { success: false, errorKey: 'persist.banner.message' };
            }}
          />
        </AppProvider>
      </MemoryRouter>,
    );
    expect(q('setup-team-invite')).not.toBeNull();
    await click('setup-finish-team');
    await click('setup-next');
    expect(zuege).toEqual(['team', 'home']);
  });
});
