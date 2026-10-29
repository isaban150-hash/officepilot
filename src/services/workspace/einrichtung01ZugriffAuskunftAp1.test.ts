/**
 * EINRICHTUNG-01 (AP1; Verträge 1.1, 1.3, 1.7; E3, E5) — die Betriebslizenz im Client.
 *
 *   L1 Auskunft `get_workspace_access` je Konto und Betrieb; wirksam → schreiben wie bisher.
 *   L2 nicht wirksam → Nur-Lesen für jede Rolle; Rolle und Grund bleiben die der Mitgliedschaft (FC01A- und
 *      GLS01-Prüfungen entscheiden weiter nach der Rolle); Sicherung und Export bleiben für Inhaber und Admins
 *      (Z-05.10, Z-08.2).
 *   L3 die Kenntnis übersteht einen Neustart (Vertrag 1.7) und gilt nie für ein anderes Konto.
 *   L4 späte Antworten (Konto gewechselt) werden verworfen.
 *   L5 Verlängerung: die nächste Abfrage hebt Nur-Lesen auf (Vertrag 1.7, „beim nächsten Pull“).
 *   L6 Fehler und ungültige Antworten ändern nichts — weder Nur-Lesen noch Schreibrecht wird geraten.
 *   L7 unbekannt heißt nicht Nur-Lesen (der Server entscheidet).
 *   E3 die App öffnet sich für jedes freigegebene Konto, unabhängig von der eigenen Lizenz.
 *   Z-03.1 `ensure_personal_workspace` mit `no_license` wird als eigener Fall gemeldet, nichts wird angelegt.
 *
 * Kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as supabaseLib from '../../lib/supabase';
import type { UserAccount } from '../../types/auth';
import { isUserAllowedToUseApp } from '../auth/licenseService';
import { getPostLoginRoute } from '../auth/supabaseAuthService';
import { resetStorageScopeForTests, setActiveStorageScope } from '../storage/storageScopeService';
import { hydrateWorkspaceStore } from './workspaceStore';
import {
  WORKSPACE_ACCESS_KEY_PREFIX,
  getWorkspaceAccessRecord,
  isWorkspaceLicenseReadOnly,
  refreshWorkspaceAccess,
  resetWorkspaceAccessForTests,
} from './workspaceAccessService';
import { resolveWorkspaceDataExportAccess, resolveWorkspaceWriteAccess } from './workspaceRoleService';
import { rpcEnsurePersonalWorkspace } from './workspaceCloudService';
import type { WorkspaceRole } from '../../types/workspace';

const WS = '00000000-0000-4000-8000-0000000000a1';
const KONTO = 'konto-ein01-l1';
const ANDERES_KONTO = 'konto-ein01-m2';

type Antwort = { data: unknown; error: { message: string; code?: string } | null };

function client(antwort: Antwort | (() => Promise<Antwort>)) {
  const aufrufe: Array<{ fn: string; args: unknown }> = [];
  return {
    aufrufe,
    client: {
      rpc: (fn: string, args: unknown) => {
        aufrufe.push({ fn, args });
        return typeof antwort === 'function' ? antwort() : Promise.resolve(antwort);
      },
    } as never,
  };
}

function antwort(role: WorkspaceRole, state: 'effective' | 'expired' | 'inactive', workspaceId = WS): Antwort {
  return { data: { workspace_id: workspaceId, role, license_state: state, license_effective: state === 'effective' }, error: null };
}

function betrieb(role: WorkspaceRole, userId = KONTO): void {
  hydrateWorkspaceStore({
    workspace: { id: WS, name: 'Betrieb L', ownerUserId: role === 'owner' ? userId : 'konto-inhaber', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
    workspaceMembers: [{ workspaceId: WS, userId, role, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  });
}

function konto(userId: string): void {
  setActiveStorageScope({ type: 'workspace', workspaceId: WS, account: { userId, access: 'full' } });
}

beforeEach(() => {
  localStorage.clear();
  resetStorageScopeForTests();
  resetWorkspaceAccessForTests();
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  konto(KONTO);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetStorageScopeForTests();
  resetWorkspaceAccessForTests();
});

describe('L — Betriebslizenz im Client', () => {
  it('L1 wirksam: Auskunft je Konto und Betrieb gespeichert, Schreiben wie bisher', async () => {
    betrieb('admin');
    const s = client(antwort('admin', 'effective'));
    const r = await refreshWorkspaceAccess(s.client);
    expect(s.aufrufe).toEqual([{ fn: 'get_workspace_access', args: { p_workspace_id: WS } }]);
    expect(r).toMatchObject({ ok: true, record: { workspaceId: WS, userId: KONTO, role: 'admin', licenseState: 'effective', licenseEffective: true } });
    expect(isWorkspaceLicenseReadOnly(WS, KONTO)).toBe(false);
    expect(resolveWorkspaceWriteAccess({ userId: KONTO, cloudConfigured: true })).toEqual({ canWrite: true, canIntake: true, role: 'admin', reason: 'owner_or_admin' });
    expect(localStorage.getItem(`${WORKSPACE_ACCESS_KEY_PREFIX}${KONTO}:${WS}`)).toContain('"licenseEffective":true');
  });

  it('L2 nicht wirksam: Nur-Lesen für jede Rolle, Rolle bleibt; Sicherung nur Inhaber und Admin', async () => {
    for (const [rolle, erwartet] of [
      ['owner', { canWrite: false, canIntake: false, role: 'owner', reason: 'owner_or_admin', licenseReadOnly: true }],
      ['admin', { canWrite: false, canIntake: false, role: 'admin', reason: 'owner_or_admin', licenseReadOnly: true }],
      ['member', { canWrite: false, canIntake: false, role: 'member', reason: 'member', licenseReadOnly: true }],
    ] as const) {
      resetWorkspaceAccessForTests();
      localStorage.clear();
      betrieb(rolle);
      await refreshWorkspaceAccess(client(antwort(rolle, 'expired')).client);
      const zugang = resolveWorkspaceWriteAccess({ userId: KONTO, cloudConfigured: true });
      expect(zugang, rolle).toEqual(erwartet);
      expect(resolveWorkspaceDataExportAccess(zugang), rolle).toBe(rolle !== 'member');
    }
    // „inactive“ (nie erteilt, Inhaber gesperrt oder ohne Profil) wirkt genauso.
    resetWorkspaceAccessForTests();
    betrieb('admin');
    await refreshWorkspaceAccess(client(antwort('admin', 'inactive')).client);
    expect(resolveWorkspaceWriteAccess({ userId: KONTO, cloudConfigured: true })).toMatchObject({ canWrite: false, licenseReadOnly: true });
    // Der lokale Betrieb ohne Cloud kennt keine Betriebslizenz.
    expect(resolveWorkspaceWriteAccess({ userId: KONTO, cloudConfigured: false })).toMatchObject({ canWrite: true, reason: 'local_only' });
  });

  it('L3 die Kenntnis übersteht einen Neustart und gilt nie für ein anderes Konto', async () => {
    betrieb('owner');
    await refreshWorkspaceAccess(client(antwort('owner', 'expired')).client);
    resetWorkspaceAccessForTests(); // Neustart: Arbeitsspeicher leer, Gerätespeicher bleibt
    expect(isWorkspaceLicenseReadOnly(WS, KONTO)).toBe(true);
    expect(resolveWorkspaceWriteAccess({ userId: KONTO, cloudConfigured: true })).toMatchObject({ licenseReadOnly: true });

    betrieb('member', ANDERES_KONTO);
    konto(ANDERES_KONTO);
    expect(isWorkspaceLicenseReadOnly(WS, ANDERES_KONTO)).toBe(false);
    expect(getWorkspaceAccessRecord(WS, ANDERES_KONTO)).toBeNull();
    // Ein manipulierter Eintrag für ein anderes Konto zählt nicht.
    localStorage.setItem(
      `${WORKSPACE_ACCESS_KEY_PREFIX}${ANDERES_KONTO}:${WS}`,
      JSON.stringify({ workspaceId: WS, userId: KONTO, role: 'member', licenseState: 'expired', licenseEffective: false, confirmedAt: 'x' }),
    );
    resetWorkspaceAccessForTests();
    expect(isWorkspaceLicenseReadOnly(WS, ANDERES_KONTO)).toBe(false);
  });

  it('L4 eine späte Antwort nach dem Kontowechsel wird verworfen', async () => {
    betrieb('admin');
    let loesen!: (a: Antwort) => void;
    const s = client(() => new Promise<Antwort>((resolve) => { loesen = resolve; }));
    const laufend = refreshWorkspaceAccess(s.client);
    konto(ANDERES_KONTO);
    loesen(antwort('admin', 'expired'));
    expect(await laufend).toEqual({ ok: false, reason: 'stale' });
    expect(getWorkspaceAccessRecord(WS, KONTO)).toBeNull();
    expect(getWorkspaceAccessRecord(WS, ANDERES_KONTO)).toBeNull();
  });

  it('L5 Verlängerung: die nächste Abfrage hebt Nur-Lesen auf', async () => {
    betrieb('owner');
    await refreshWorkspaceAccess(client(antwort('owner', 'expired')).client);
    expect(isWorkspaceLicenseReadOnly(WS, KONTO)).toBe(true);
    await refreshWorkspaceAccess(client(antwort('owner', 'effective')).client);
    expect(isWorkspaceLicenseReadOnly(WS, KONTO)).toBe(false);
    expect(resolveWorkspaceWriteAccess({ userId: KONTO, cloudConfigured: true })).toMatchObject({ canWrite: true, role: 'owner' });
  });

  it('L6 Fehler und ungültige Antworten ändern nichts', async () => {
    betrieb('owner');
    await refreshWorkspaceAccess(client(antwort('owner', 'expired')).client);
    const vorher = getWorkspaceAccessRecord(WS, KONTO);
    const faelle: Array<[Antwort, string]> = [
      [{ data: null, error: { message: 'session_not_active: Die Sitzung ist beendet', code: '42501' } }, 'auth'],
      [{ data: null, error: { message: 'Nicht angemeldet', code: '42501' } }, 'auth'],
      [{ data: null, error: { message: 'Kein Zugriff auf Workspace', code: 'P0001' } }, 'no_access'],
      [{ data: null, error: { message: 'Failed to fetch' } }, 'network'],
      [antwort('owner', 'effective', '00000000-0000-4000-8000-0000000000ff'), 'invalid'],
      [{ data: { workspace_id: WS, role: 'chef', license_state: 'effective', license_effective: true }, error: null }, 'invalid'],
      [{ data: { workspace_id: WS, role: 'owner', license_state: 'effective', license_effective: false }, error: null }, 'invalid'],
      [{ data: { workspace_id: WS, role: 'owner', license_state: 'egal', license_effective: true }, error: null }, 'invalid'],
      [{ data: null, error: null }, 'invalid'],
    ];
    for (const [fall, grund] of faelle) {
      expect(await refreshWorkspaceAccess(client(fall).client), JSON.stringify(fall)).toEqual({ ok: false, reason: grund });
      expect(getWorkspaceAccessRecord(WS, KONTO)).toEqual(vorher);
    }
    // Eine geworfene Ausnahme ist ein Netzproblem, keine Auskunft.
    const wirft = { rpc: () => Promise.reject(new TypeError('Failed to fetch')) } as never;
    expect(await refreshWorkspaceAccess(wirft)).toEqual({ ok: false, reason: 'network' });
    expect(getWorkspaceAccessRecord(WS, KONTO)).toEqual(vorher);
  });

  it('L7 unbekannt heißt nicht Nur-Lesen; ohne Betrieb oder ohne Cloud keine Abfrage', async () => {
    betrieb('member');
    expect(isWorkspaceLicenseReadOnly(WS, KONTO)).toBe(false);
    expect(resolveWorkspaceWriteAccess({ userId: KONTO, cloudConfigured: true })).toEqual({ canWrite: false, canIntake: true, role: 'member', reason: 'member' });
    hydrateWorkspaceStore({ workspace: null, workspaceMembers: [] });
    const s = client(antwort('member', 'expired'));
    expect(await refreshWorkspaceAccess(s.client)).toEqual({ ok: false, reason: 'no_workspace' });
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    expect(await refreshWorkspaceAccess(s.client)).toEqual({ ok: false, reason: 'not_configured' });
    expect(s.aufrufe).toEqual([]);
  });
});

function nutzer(teil: Partial<UserAccount>): UserAccount {
  return {
    id: 'u-1',
    email: 'person@example.invalid',
    firstName: 'P',
    lastName: 'Q',
    role: 'user',
    status: 'approved',
    licenseStatus: 'inactive',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...teil,
  } as UserAccount;
}

describe('E3 — Zugang zur App', () => {
  it('jedes freigegebene Konto, unabhängig von der eigenen Lizenz; wartend und gesperrt nicht', () => {
    for (const licenseStatus of ['inactive', 'expired', 'active'] as const) {
      expect(isUserAllowedToUseApp(nutzer({ licenseStatus })), licenseStatus).toBe(true);
      expect(getPostLoginRoute(nutzer({ licenseStatus })), licenseStatus).toBe('/');
    }
    expect(isUserAllowedToUseApp(nutzer({ status: 'pending' }))).toBe(false);
    expect(getPostLoginRoute(nutzer({ status: 'pending' }))).toBe('/waiting-approval');
    expect(isUserAllowedToUseApp(nutzer({ status: 'blocked' }))).toBe(false);
    expect(getPostLoginRoute(nutzer({ status: 'blocked' }))).toBe('/access-blocked');
    expect(isUserAllowedToUseApp(undefined)).toBe(false);
    // Unbekannter Status: fail-closed.
    expect(isUserAllowedToUseApp(nutzer({ status: 'irgendwas' as never }))).toBe(false);
  });
});

describe('Z-03.1 — ensure ohne Betrieb und ohne Lizenz', () => {
  it('meldet no_license als eigenen Fall, nicht als technischen Fehler', async () => {
    const s = client({ data: { workspace: null, member: null, created: false, reason: 'no_license' }, error: null });
    expect(await rpcEnsurePersonalWorkspace(undefined, s.client)).toEqual({ success: false, error: 'no_license', errorCode: 'no_license' });
    // Eine leere Antwort ohne diesen Grund bleibt ein unbekannter Fehler.
    const leer = client({ data: { workspace: null, member: null, created: false }, error: null });
    expect(await rpcEnsurePersonalWorkspace(undefined, leer.client)).toMatchObject({ success: false, errorCode: 'unknown' });
    // Die Freigabe fehlt: Abweisung des Servers (Z-01.1), keine Neuanlage.
    const wartend = client({ data: null, error: { message: 'account_not_approved: Konto ist nicht freigegeben', code: '42501' } });
    expect(await rpcEnsurePersonalWorkspace(undefined, wartend.client)).toMatchObject({ success: false, errorCode: 'rls' });
  });
});
