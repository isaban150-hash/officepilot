/**
 * EINRICHTUNG-01 (AP4) — Dienste ohne Oberfläche (Katalog V3, Vitest-Anteile):
 *   T1 (P-08.1, Vertrag 1.4) Fehlercodes des Servers werden übersetzt; nie der Servertext.
 *   T2 (M-18.1, M-18.2) kein Schreibrecht ohne bekannte aktive Mitgliedschaft, auch für owner_user_id.
 *   T3 (M-10.3, M-10.4) bestätigter Entzug isoliert und bindet neu; offline (Netzfehler) keine behauptete Sofortwirkung.
 *   T4 (M-10.3, M-13.5) Seiten-Cache und anderer Tab: veraltete Bindung lädt neu.
 *   T5 (M-09.3, M-11.3) Abweisung nach Herabstufung bzw. Verlassen: endgültig, nicht wiederholt.
 *   T6 (M-17.1, M-17.3, M-17.4) Einladungsmail: Linkbasis, Anbieterfehler = nicht gesendet, Token nie im Protokoll.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teamErrorKey, listTeamMembers, inviteMember, acceptInvitation } from './teamService';
import { clearMockRpcHandlers, registerMockRpcHandler } from '../../test/mockProfileStore';
import { resolveWorkspaceWriteAccess } from '../workspace/workspaceRoleService';
import { hydrateWorkspaceStore, resetWorkspaceStore, setWorkspaceMembers } from '../workspace/workspaceStore';
import { setActiveStorageScope } from '../storage/storageScopeService';
import {
  handleConfirmedWorkspaceRevocation,
  isWorkspaceRevoked,
  takeWorkspaceChangeNotice,
  workspaceChangeDeps,
} from '../workspace/workspaceMembershipChangeService';
import { refreshWorkspaceAccess, resetWorkspaceAccessForTests, subscribeWorkspaceAccessRevoked } from '../workspace/workspaceAccessService';
import { pageCacheWorkspaceDeps, watchPageCacheWorkspace, workspaceBindingOutdated } from '../workspace/pageCacheWorkspaceGuard';
import { readRememberedWorkspaceBinding, setLastSuccessfulWorkspaceBootstrap } from '../workspace/workspaceCloudBootstrapService';
import { isFinalPermissionDenialMessage } from '../sync/syncRoleDenial';
import { createStubEmailProvider } from '../../../supabase/functions/_shared/emailProvider';
import { isAllowedLinkBase, runSendTeamInvitation } from '../../../supabase/functions/_shared/teamInvitationCore';
import { loginAsDefaultAdmin } from '../../test/authFixtures';
import { getMockCurrentSession } from '../../test/mockSupabaseAuth';
import { t } from '../../i18n';

const W1 = 'ws-ap4-w1';
const W3 = 'ws-ap4-w3';
const TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';

function workspace(id: string, owner: string) {
  return { id, name: 'Betrieb', ownerUserId: owner, createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z', version: 1 };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearMockRpcHandlers();
  resetWorkspaceStore();
  resetWorkspaceAccessForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearMockRpcHandlers();
  setActiveStorageScope({ type: 'guest' });
});

describe('T1 — Fehlerzuordnung (P-08.1)', () => {
  it('bekannte Codes haben eigene Texte in de, tr und bg; Unbekanntes wird allgemein, nie roh', async () => {
    await loginAsDefaultAdmin();
    for (const code of ['team_forbidden_role', 'team_owner_protected', 'license_not_effective', 'invitation_expired']) {
      const key = teamErrorKey(code);
      expect(key).toBe(`team.error.${code}`);
      for (const lang of ['de', 'tr', 'bg'] as const) {
        expect(t(key, lang)).not.toContain(code);
        expect(t(key, lang).length).toBeGreaterThan(10);
      }
    }
    expect(teamErrorKey('irgendwas_neues')).toBe('team.error.unknown');

    registerMockRpcHandler('team_list_members', () => {
      throw new Error('team_forbidden_role: interner Text mit Details 42501');
    });
    const result = await listTeamMembers(W1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorKey).toBe('team.error.team_forbidden_role');
      expect(t(result.errorKey, 'de')).not.toContain('interner Text');
    }
  });

  it('Netzfehler und beendete Sitzung haben eigene Texte', async () => {
    await loginAsDefaultAdmin();
    registerMockRpcHandler('team_invite', () => {
      throw new Error('Failed to fetch');
    });
    const netz = await inviteMember(W1, 'a@example.invalid', 'member');
    expect(netz.ok === false && netz.errorKey).toBe('team.error.network');
    registerMockRpcHandler('team_invite', () => {
      throw new Error('session_not_active: Die Sitzung ist beendet');
    });
    const sitzung = await inviteMember(W1, 'a@example.invalid', 'member');
    expect(sitzung.ok === false && sitzung.errorKey).toBe('team.error.session');
  });

  it('Weg C antwortet mit {ok:false, code} — auch das wird übersetzt', async () => {
    await loginAsDefaultAdmin();
    registerMockRpcHandler('accept_invitation', () => ({ ok: false, code: 'invitation_invalid' }));
    const result = await acceptInvitation({ token: TOKEN });
    expect(result.ok === false && result.errorKey).toBe('team.error.invitation_invalid');
  });
});

describe('T2 — kein Inhaber-Rückfall (M-18.1, M-18.2)', () => {
  it('Mitgliedschaft unbekannt bzw. noch nicht geladen: kein Schreibrecht, auch für owner_user_id', () => {
    hydrateWorkspaceStore({ workspace: workspace(W1, 'konto-o1'), workspaceMembers: [] } as never);
    expect(resolveWorkspaceWriteAccess({ userId: 'konto-o1', cloudConfigured: true })).toEqual({
      canWrite: false,
      canIntake: false,
      role: null,
      reason: 'membership_unknown',
    });
  });

  it('Mitgliedschaft entzogen, owner_user_id zeigt noch auf das Konto: kein Schreibrecht', () => {
    hydrateWorkspaceStore({ workspace: workspace(W1, 'konto-o1'), workspaceMembers: [] } as never);
    setWorkspaceMembers([
      { workspaceId: W1, userId: 'konto-o1', role: 'owner', status: 'removed', createdAt: '', updatedAt: '' } as never,
    ]);
    expect(resolveWorkspaceWriteAccess({ userId: 'konto-o1', cloudConfigured: true }).canWrite).toBe(false);
    setWorkspaceMembers([
      { workspaceId: W1, userId: 'konto-o1', role: 'owner', status: 'active', createdAt: '', updatedAt: '' } as never,
    ]);
    expect(resolveWorkspaceWriteAccess({ userId: 'konto-o1', cloudConfigured: true })).toMatchObject({ canWrite: true, role: 'owner' });
  });
});

describe('T3 — Entzug (M-10.3, M-10.4)', () => {
  it('bestätigter Entzug: markiert, Bindung vergessen, Hinweis gemerkt, neu geladen', () => {
    const reload = vi.spyOn(workspaceChangeDeps, 'reloadTo').mockImplementation(() => undefined);
    setLastSuccessfulWorkspaceBootstrap({ userId: 'konto-m1', workspaceId: W1 });
    expect(readRememberedWorkspaceBinding('konto-m1')?.workspaceId).toBe(W1);

    handleConfirmedWorkspaceRevocation({ userId: 'konto-m1', workspaceId: W1, workspaceName: 'Arbeitgeber GmbH' });

    expect(isWorkspaceRevoked('konto-m1', W1)).toBe(true);
    expect(isWorkspaceRevoked('konto-m1', W3)).toBe(false);
    expect(isWorkspaceRevoked('konto-andere', W1)).toBe(false);
    expect(readRememberedWorkspaceBinding('konto-m1')).toBeNull();
    expect(reload).toHaveBeenCalledWith('/');
    expect(takeWorkspaceChangeNotice()).toEqual({ kind: 'revoked', workspaceName: 'Arbeitgeber GmbH' });
    expect(takeWorkspaceChangeNotice()).toBeNull();
  });

  it('die Zugriffsauskunft meldet einen Entzug nur bei bestätigter fehlender Mitgliedschaft, nie bei Netzfehlern', async () => {
    await loginAsDefaultAdmin();
    const konto = getMockCurrentSession()!.user.id;
    setActiveStorageScope({ type: 'workspace', workspaceId: W1, account: { userId: konto, access: 'member' } });
    hydrateWorkspaceStore({ workspace: workspace(W1, 'konto-o1'), workspaceMembers: [] } as never);
    const gemeldet: string[] = [];
    const abmelden = subscribeWorkspaceAccessRevoked(({ workspaceId }) => gemeldet.push(workspaceId));

    registerMockRpcHandler('get_workspace_access', () => {
      throw new Error('Failed to fetch');
    });
    expect((await refreshWorkspaceAccess()).ok).toBe(false);
    expect(gemeldet, 'M-10.4 offline als Entzug gewertet').toEqual([]);

    registerMockRpcHandler('get_workspace_access', () => {
      throw new Error('Kein Zugriff auf Workspace');
    });
    const result = await refreshWorkspaceAccess();
    expect(result.ok === false && result.reason).toBe('no_access');
    expect(gemeldet).toEqual([W1]);
    abmelden();
  });
});

describe('T4 — Seiten-Cache und anderer Tab (M-10.3, M-13.5)', () => {
  it('veraltet: anderer gemerkter Betrieb oder entzogen; sonst nicht', () => {
    setLastSuccessfulWorkspaceBootstrap({ userId: 'konto-d1', workspaceId: W3 });
    expect(workspaceBindingOutdated('konto-d1', W3)).toBe(false);
    setLastSuccessfulWorkspaceBootstrap({ userId: 'konto-d1', workspaceId: W1 });
    expect(workspaceBindingOutdated('konto-d1', W3)).toBe(true);
    vi.spyOn(workspaceChangeDeps, 'reloadTo').mockImplementation(() => undefined);
    handleConfirmedWorkspaceRevocation({ userId: 'konto-d1', workspaceId: W1, workspaceName: 'W1' });
    expect(workspaceBindingOutdated('konto-d1', W1)).toBe(true);
  });

  it('Rückkehr aus dem Seiten-Cache bzw. Wechsel in einem anderen Tab lädt neu', () => {
    const reload = vi.spyOn(pageCacheWorkspaceDeps, 'reload').mockImplementation(() => undefined);
    setLastSuccessfulWorkspaceBootstrap({ userId: 'konto-d1', workspaceId: W3 });
    const stop = watchPageCacheWorkspace(() => 'konto-d1', () => W3);
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(reload).not.toHaveBeenCalled();

    // Ein anderer Tab wechselt nach W1: die gemerkte Bindung dieses Kontos ändert sich.
    setLastSuccessfulWorkspaceBootstrap({ userId: 'konto-d1', workspaceId: W1 });
    window.dispatchEvent(new StorageEvent('storage', { key: 'officetakt-workspace-binding:konto-d1' }));
    expect(reload).toHaveBeenCalledTimes(1);
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(reload).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('T5 — Abweisung nach Herabstufung bzw. Verlassen (M-09.3, M-11.3)', () => {
  it('Rolle entzogen, Mitgliedschaft beendet: endgültig; gleichzeitige Änderung und beendete Sitzung nicht', () => {
    expect(isFinalPermissionDenialMessage('workspace_forbidden_role: Keine Schreibberechtigung')).toBe(true);
    expect(isFinalPermissionDenialMessage('workspace_not_member: Kein Zugriff auf Workspace')).toBe(true);
    expect(isFinalPermissionDenialMessage('team_not_member: Kein Zugriff auf Workspace')).toBe(true);
    expect(isFinalPermissionDenialMessage('workspace_access_changed: Die Rechte wurden gleichzeitig geaendert')).toBe(false);
    expect(isFinalPermissionDenialMessage('session_not_active: Die Sitzung ist beendet')).toBe(false);
  });
});

describe('EINRICHTUNG-01 (AP6; E-03.9, E-03.11) — Antwortadresse der Einladungsmail', () => {
  it('ohne bestätigte Adresse vom Server: nicht gesendet (reply_to_unavailable), kein Anbieteraufruf', async () => {
    const provider = createStubEmailProvider();
    const send = vi.spyOn(provider, 'sendTransactionalEmail');
    const outcome = await runSendTeamInvitation(
      { invitationId: '00000000-0000-0000-0000-0000000e4e01', token: TOKEN, language: 'de', linkBase: 'http://127.0.0.1:5232' },
      {
        senderEmail: 'einladung@officetakt.test',
        allowedOrigins: null,
        testRecipientAllowlist: { mode: 'off' },
        provider,
        loadContext: async () => ({ ok: true, context: { email: 'x1@example.invalid', role: 'member', workspaceName: 'AP4 Betrieb', inviterName: 'Olga Eins', expiresAt: '2026-10-30T10:00:00.000Z' } }),
        resolveReplyTo: async () => ({ ok: false }),
        log: () => undefined,
      },
    );
    expect(outcome).toEqual({ ok: true, sent: false, reason: 'reply_to_unavailable' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('T6 — Einladungsmail (M-17)', () => {
  const context = { email: 'x1@example.invalid', role: 'member' as const, workspaceName: 'AP4 Betrieb', inviterName: 'Olga Eins', expiresAt: '2026-10-30T10:00:00.000Z' };

  it('Linkbasis: ohne Angabe nur lokal; mit Angabe nur genau die erlaubten Adressen', () => {
    expect(isAllowedLinkBase('http://127.0.0.1:5232', null)).toBe(true);
    expect(isAllowedLinkBase('http://localhost:5173', '')).toBe(true);
    expect(isAllowedLinkBase('https://evil.example', null)).toBe(false);
    expect(isAllowedLinkBase('https://app.officetakt.de', 'https://app.officetakt.de')).toBe(true);
    expect(isAllowedLinkBase('https://app.officetakt.de/pfad', 'https://app.officetakt.de')).toBe(false);
    expect(isAllowedLinkBase('http://127.0.0.1:5232', 'https://app.officetakt.de')).toBe(false);
  });

  it('M-17.1: Mail mit Link (stub); M-17.4: das Token steht nie im Protokoll', async () => {
    const logs: string[] = [];
    const provider = createStubEmailProvider();
    const send = vi.spyOn(provider, 'sendTransactionalEmail');
    const outcome = await runSendTeamInvitation(
      { invitationId: '00000000-0000-0000-0000-0000000e4e01', token: TOKEN, language: 'de', linkBase: 'http://127.0.0.1:5232' },
      {
        senderEmail: 'einladung@officetakt.test',
        allowedOrigins: null,
        testRecipientAllowlist: { mode: 'off' },
        provider,
        loadContext: async () => ({ ok: true, context }),
        // EINRICHTUNG-01 (AP6; E18) — Antwortadresse vom Server (Einladungsweg mit dem Token der einladenden Person).
        resolveReplyTo: async () => ({ ok: true, email: 'inhaber@ap4.invalid' }),
        log: (entry) => logs.push(JSON.stringify(entry)),
      },
    );
    expect(outcome).toEqual({ ok: true, sent: true });
    const mail = send.mock.calls[0][0];
    expect(mail.replyTo).toEqual({ email: 'inhaber@ap4.invalid', name: 'OfficeTakt' });
    expect(mail.text).toContain(`http://127.0.0.1:5232/einladung/${TOKEN}?email=x1%40example.invalid`);
    expect(mail.subject).toContain('AP4 Betrieb');
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('x1@example.invalid');
  });

  it('M-17.3: Anbieterfehler -> nicht gesendet (kein „gesendet“); abgelehnter Kontext -> Fehler ohne Versand', async () => {
    const provider = createStubEmailProvider();
    const outcome = await runSendTeamInvitation(
      { invitationId: '00000000-0000-0000-0000-0000000e4e01', token: TOKEN, language: 'tr', linkBase: 'http://127.0.0.1:5232' },
      {
        senderEmail: 'einladung@officetakt.test',
        allowedOrigins: null,
        testRecipientAllowlist: { mode: 'off' },
        provider,
        loadContext: async () => ({ ok: true, context: { ...context, email: 'x1@provider.invalid' } }),
        resolveReplyTo: async () => ({ ok: true, email: 'inhaber@ap4.invalid' }),
        log: () => undefined,
      },
    );
    expect(outcome).toEqual({ ok: true, sent: false, reason: 'provider' });

    const send = vi.spyOn(provider, 'sendTransactionalEmail');
    const verweigert = await runSendTeamInvitation(
      { invitationId: '00000000-0000-0000-0000-0000000e4e01', token: TOKEN, language: 'de', linkBase: 'http://127.0.0.1:5232' },
      {
        senderEmail: 'einladung@officetakt.test',
        allowedOrigins: null,
        testRecipientAllowlist: { mode: 'off' },
        provider,
        loadContext: async () => ({ ok: false, error: 'forbidden' }),
        resolveReplyTo: async () => ({ ok: true, email: 'inhaber@ap4.invalid' }),
        log: () => undefined,
      },
    );
    expect(verweigert).toEqual({ ok: false, error: 'forbidden' });
    expect(send).not.toHaveBeenCalled();
  });

  it('fremde Linkbasis und ungültige Eingaben werden vor jedem Serveraufruf abgewiesen', async () => {
    const loadContext = vi.fn(async () => ({ ok: true as const, context }));
    const deps = { senderEmail: 'e@officetakt.test', allowedOrigins: null, testRecipientAllowlist: { mode: 'off' as const }, provider: createStubEmailProvider(), loadContext, resolveReplyTo: async () => ({ ok: true as const, email: 'inhaber@ap4.invalid' }), log: () => undefined };
    expect(await runSendTeamInvitation({ invitationId: 'kein-uuid', token: TOKEN, language: 'de', linkBase: 'http://127.0.0.1:5232' }, deps)).toEqual({ ok: false, error: 'invalid_request' });
    expect(await runSendTeamInvitation({ invitationId: '00000000-0000-0000-0000-0000000e4e01', token: TOKEN, language: 'de', linkBase: 'https://evil.example' }, deps)).toEqual({ ok: false, error: 'link_not_allowed' });
    expect(loadContext).not.toHaveBeenCalled();
  });
});
