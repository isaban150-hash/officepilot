/**
 * EINRICHTUNG-01 (AP7; Verträge 1.25, 1.25a, 1.26, 1.29) — die Löschdienste der App.
 *
 *   1.25a  Nachweis: Passwort nur an die Edge Function (TLS), Antwortcodes ohne Rohtext, Anfrage-ID als UUID v4
 *   1.25   Kontolöschung: Nachweis, dann Auftrag; dieselbe Anfrage-ID je Sitzung; „wird abgeschlossen“; Inhaberliste
 *   1.26   Betriebslöschung: Antrag mit Firmenname und Hinweisfassung, Widerruf; Zugriffsauskunft wird erneuert
 *   1.29   lokale Bestände genau eines Kontos entfernen; andere Konten bleiben (auch deren Logo-Zwischenspeicher)
 */
import { useDocumentBlobDatabaseReset } from '../../test/documentBlobTestReset';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as supabaseLib from '../../lib/supabase';
import * as accessService from '../workspace/workspaceAccessService';
import { newRequestId, requestDestructiveConfirmation } from './destructiveActionService';
import { accountDeletionRequestId, deleteOwnAccount, forgetAccountDeletionRequestId, resumeOwnAccountDeletion } from './accountDeletionService';
import { requestWorkspaceDeletion, revokeWorkspaceDeletion, WORKSPACE_DELETION_NOTICE_VERSION } from '../workspace/workspaceDeletionService';
import { inventoryLocalAccountData, removeLocalAccountData } from '../storage/localAccountDataService';
import { readDocumentBlob, saveDocumentBlob } from '../storage/documentBlobIndexedDbService';
import { getCachedBrandingAsset, putCachedBrandingAsset } from '../branding/brandingAssetCacheService';
import type { StorageScope } from '../storage/storageScopeService';

useDocumentBlobDatabaseReset();

const BASE = 'https://projekt.example.invalid';
const PASSWORT = 'Geheimes-Passwort-7';
const U1 = '0a7a0000-0000-4000-8000-000000000001';
const U2 = '0a7a0000-0000-4000-8000-000000000002';
const WS1 = '0a7b0000-0000-4000-8000-000000000001';
const WS2 = '0a7b0000-0000-4000-8000-000000000002';

type Antwort = { status?: number; body: unknown };

function client(rpc: ReturnType<typeof vi.fn> = vi.fn()) {
  return { auth: { getSession: async () => ({ data: { session: { access_token: 'nutzer-token' } } }) }, rpc } as never;
}

function fetchFolge(...antworten: Antwort[]) {
  const aufrufe: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    aufrufe.push({ url, init });
    const antwort = antworten.shift() ?? { status: 500, body: null };
    return new Response(JSON.stringify(antwort.body), { status: antwort.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return aufrufe;
}

beforeEach(() => {
  vi.spyOn(supabaseLib, 'getSupabaseUrl').mockReturnValue(BASE);
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('EINRICHTUNG-01 AP7 — Nachweis (1.25a)', { timeout: 30_000 }, () => {
  it('Passwort geht nur an confirm-destructive-action, mit dem Token der Person; Codes ohne Rohtext', async () => {
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(client());
    const aufrufe = fetchFolge(
      { body: { ok: true, confirmationToken: 'T'.repeat(43), expiresAt: '2026-10-25T10:05:00.000Z' } },
      { status: 401, body: { ok: false, error: 'password_invalid' } },
      { status: 429, body: { ok: false, error: 'confirmation_rate_limited' } },
      { status: 500, body: { ok: false, error: 'interner Fehler: Details' } },
    );
    const request = { action: 'account_delete' as const, workspaceId: null, requestId: newRequestId(), password: PASSWORT };
    expect(await requestDestructiveConfirmation(request)).toEqual({ ok: true, confirmationToken: 'T'.repeat(43), expiresAt: '2026-10-25T10:05:00.000Z' });
    expect(aufrufe[0].url).toBe(`${BASE}/functions/v1/confirm-destructive-action`);
    expect((aufrufe[0].init.headers as Record<string, string>).Authorization).toBe('Bearer nutzer-token');
    expect(JSON.parse(String(aufrufe[0].init.body))).toEqual({ action: 'account_delete', workspaceId: null, requestId: request.requestId, password: PASSWORT });
    expect(await requestDestructiveConfirmation(request)).toEqual({ ok: false, reason: 'password_invalid' });
    expect(await requestDestructiveConfirmation(request)).toEqual({ ok: false, reason: 'rate_limited' });
    // EINRICHTUNG-01 (AP9; 1.30) — unbekannter Servertext: allgemeiner Fall mit Kurzreferenz, der Text selbst bleibt verborgen.
    const unbekannt = await requestDestructiveConfirmation(request);
    expect(unbekannt).toEqual({ ok: false, reason: 'unavailable', ref: expect.stringMatching(/^[0-9A-Z]{4}$/) });
    expect(JSON.stringify(unbekannt)).not.toContain('interner');
  });

  it('ohne Client bzw. ohne Sitzung kein Aufruf', async () => {
    const aufrufe = fetchFolge();
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(null);
    expect(await requestDestructiveConfirmation({ action: 'account_delete', workspaceId: null, requestId: newRequestId(), password: PASSWORT })).toEqual({ ok: false, reason: 'unavailable' });
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({ auth: { getSession: async () => ({ data: { session: null } }) } } as never);
    expect(await requestDestructiveConfirmation({ action: 'account_delete', workspaceId: null, requestId: newRequestId(), password: PASSWORT })).toEqual({ ok: false, reason: 'session' });
    expect(aufrufe).toHaveLength(0);
  });

  it('Anfrage-ID: UUID v4, auch ohne crypto.randomUUID (nie Math.random)', () => {
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(newRequestId()).toMatch(v4);
    const random = vi.spyOn(Math, 'random');
    vi.spyOn(crypto, 'randomUUID').mockImplementation(undefined as never);
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      expect(newRequestId()).toMatch(v4);
      expect(random).not.toHaveBeenCalled();
    } finally {
      delete (crypto as unknown as Record<string, unknown>).randomUUID;
    }
  });
});

describe('EINRICHTUNG-01 AP7 — Kontolöschung (1.25)', { timeout: 30_000 }, () => {
  it('Nachweis, dann Auftrag mit derselben Anfrage-ID und der eingegebenen E-Mail; Ergebnisse', async () => {
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(client());
    const nachweis = { body: { ok: true, confirmationToken: 'N'.repeat(43), expiresAt: 'x' } };
    const aufrufe = fetchFolge(
      nachweis,
      { body: { ok: true, state: 'completed' } },
      nachweis,
      { body: { ok: true, state: 'sql_done', completing: true } },
      nachweis,
      { status: 409, body: { ok: false, error: 'account_owner', workspaces: [{ workspace_id: WS1, name: 'Betrieb Eins' }, { name: 'ohne Kennung' }] } },
      nachweis,
      { status: 409, body: { ok: false, error: 'last_platform_admin' } },
    );
    expect(await deleteOwnAccount({ userId: U1, email: ' person@example.invalid ', password: PASSWORT })).toEqual({ ok: true, state: 'completed' });
    const requestId = accountDeletionRequestId(U1);
    expect(JSON.parse(String(aufrufe[0].init.body)).requestId).toBe(requestId);
    expect(aufrufe[1].url).toBe(`${BASE}/functions/v1/delete-account`);
    expect(JSON.parse(String(aufrufe[1].init.body))).toEqual({ requestId, confirmationToken: 'N'.repeat(43), email: ' person@example.invalid ' });
    expect(String(aufrufe[1].init.body)).not.toContain(PASSWORT);
    expect(await deleteOwnAccount({ userId: U1, email: 'p', password: PASSWORT })).toEqual({ ok: true, state: 'completing' });
    expect(await deleteOwnAccount({ userId: U1, email: 'p', password: PASSWORT })).toEqual({ ok: false, reason: 'owner', workspaces: [{ id: WS1, name: 'Betrieb Eins' }] });
    expect(await deleteOwnAccount({ userId: U1, email: 'p', password: PASSWORT })).toEqual({ ok: false, reason: 'last_platform_admin' });
  });

  it('falsches Passwort: kein Auftrag; Fortsetzen ohne neuen Nachweis mit derselben Anfrage-ID', async () => {
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(client());
    const aufrufe = fetchFolge({ status: 401, body: { ok: false, error: 'password_invalid' } }, { body: { ok: true, state: 'completed' } });
    expect(await deleteOwnAccount({ userId: U1, email: 'p', password: 'falsch' })).toEqual({ ok: false, reason: 'password_invalid' });
    expect(aufrufe).toHaveLength(1);
    const requestId = accountDeletionRequestId(U1);
    expect(await resumeOwnAccountDeletion(U1)).toEqual({ ok: true, state: 'completed' });
    expect(JSON.parse(String(aufrufe[1].init.body))).toEqual({ requestId, confirmationToken: null, email: '' });
  });

  it('Anfrage-ID je Konto für diese Sitzung; „vergessen“ erzeugt eine neue', () => {
    const erste = accountDeletionRequestId(U1);
    expect(accountDeletionRequestId(U1)).toBe(erste);
    expect(accountDeletionRequestId(U2)).not.toBe(erste);
    forgetAccountDeletionRequestId(U1);
    expect(accountDeletionRequestId(U1)).not.toBe(erste);
  });
});

describe('EINRICHTUNG-01 AP7 — Betriebslöschung (1.26)', { timeout: 30_000 }, () => {
  it('Antrag mit Firmenname, Hinweisfassung, Nachweis und Anfrage-ID; Erfolg erneuert die Zugriffsauskunft', async () => {
    const rpc = vi.fn(async () => ({ data: { ok: true, state: 'open', execute_after: '2026-11-24T10:00:00.000Z' }, error: null }));
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(client(rpc));
    const refresh = vi.spyOn(accessService, 'requestWorkspaceAccessRefresh').mockImplementation(() => undefined);
    const aufrufe = fetchFolge({ body: { ok: true, confirmationToken: 'W'.repeat(43), expiresAt: 'x' } });
    const requestId = newRequestId();
    expect(await requestWorkspaceDeletion({ workspaceId: WS1, typedName: 'Betrieb Eins', password: PASSWORT, requestId })).toEqual({ ok: true, executeAfter: '2026-11-24T10:00:00.000Z' });
    expect(JSON.parse(String(aufrufe[0].init.body))).toMatchObject({ action: 'workspace_delete_request', workspaceId: WS1, requestId });
    expect(rpc).toHaveBeenCalledWith('workspace_request_deletion', {
      p_workspace_id: WS1, p_typed_name: 'Betrieb Eins', p_retention_notice_version: WORKSPACE_DELETION_NOTICE_VERSION, p_confirmation_token: 'W'.repeat(43), p_request_id: requestId,
    });
    expect(refresh).toHaveBeenCalledWith({ force: true });
  });

  it('Abweisungen: Name, Fassung, Rolle, Nachweis; Widerruf während der Ausführung', async () => {
    const antworten = [
      { data: { ok: false, code: 'name_mismatch' }, error: null },
      { data: { ok: false, code: 'notice_outdated' }, error: null },
      { data: null, error: { message: 'team_forbidden_role: nur der Inhaber' } },
      { data: null, error: { message: 'confirmation_invalid: Nachweis' } },
    ];
    const rpc = vi.fn(async () => antworten.shift());
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(client(rpc));
    vi.spyOn(accessService, 'requestWorkspaceAccessRefresh').mockImplementation(() => undefined);
    const nachweis = { body: { ok: true, confirmationToken: 'W'.repeat(43), expiresAt: 'x' } };
    fetchFolge(nachweis, nachweis, nachweis, nachweis);
    const antrag = () => requestWorkspaceDeletion({ workspaceId: WS1, typedName: 'x', password: PASSWORT });
    expect(await antrag()).toEqual({ ok: false, reason: 'name_mismatch' });
    expect(await antrag()).toEqual({ ok: false, reason: 'notice_outdated' });
    expect(await antrag()).toEqual({ ok: false, reason: 'forbidden' });
    expect(await antrag()).toEqual({ ok: false, reason: 'confirmation_invalid' });

    const widerruf = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'deletion_in_progress: laeuft' } })
      .mockResolvedValueOnce({ data: { ok: false, code: 'deletion_not_requested' }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, state: 'revoked' }, error: null });
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(client(widerruf));
    expect(await revokeWorkspaceDeletion(WS1)).toEqual({ ok: false, reason: 'in_progress' });
    expect(await revokeWorkspaceDeletion(WS1)).toEqual({ ok: false, reason: 'not_requested' });
    expect(await revokeWorkspaceDeletion(WS1)).toEqual({ ok: true });
  });
});

describe('EINRICHTUNG-01 AP7 — lokale Bestände eines Kontos (1.25, 1.29)', { timeout: 30_000 }, () => {
  const scope = (workspaceId: string, userId: string): StorageScope => ({ type: 'workspace', workspaceId, account: { userId, access: 'full' } });

  async function blob(fileRefId: string, s: StorageScope) {
    await saveDocumentBlob({ fileRefId, blob: new Blob(['%PDF']), mimeType: 'application/pdf', fileSize: 4, contentHash: 'c'.repeat(64), createdAt: '2026-10-25T00:00:00.000Z', scope: s });
  }

  it('Bestandsübersicht: eigene Betriebe mit Größe, andere Konten nur als Anzahl', () => {
    localStorage.setItem(`officepilot-state:workspace:${WS1}:account:${U1}:full`, '{"a":1}');
    localStorage.setItem(`officepilot-state:workspace:${WS2}:account:${U2}:member`, '{}');
    localStorage.setItem(`officepilot-state:user:${U2}`, '{}');
    const inventar = inventoryLocalAccountData(U1);
    expect(inventar.workspaces).toEqual([{ workspaceId: WS1, storageKey: `officepilot-state:workspace:${WS1}:account:${U1}:full`, bytes: 14 }]);
    expect(inventar.otherAccounts).toBe(1);
    expect(JSON.stringify(inventar)).not.toContain(U2);
  });

  it('entfernt Schlüssel, Sitzungswerte, Dokumentdateien und Logos dieses Kontos; andere Konten bleiben', async () => {
    localStorage.setItem(`officepilot-state:workspace:${WS1}:account:${U1}:full`, '{}');
    localStorage.setItem(`officepilot-state:workspace:${WS2}:account:${U2}:full`, '{}');
    localStorage.setItem(`officetakt-workspace-access:${U1}:${WS1}`, '{}');
    localStorage.setItem('officetakt-auth-last-account', U1);
    localStorage.setItem('unbeteiligte-einstellung', 'bleibt');
    sessionStorage.setItem(`officetakt.accountDeletion.requestId:${U1}`, 'x');
    sessionStorage.setItem('zwischenstand', JSON.stringify({ userId: U1 }));
    sessionStorage.setItem('fremd', JSON.stringify({ userId: U2 }));
    await blob('f-eigen', scope(WS1, U1));
    await blob('f-fremd', scope(WS2, U2));
    await putCachedBrandingAsset(WS1, 'a'.repeat(64), new Blob(['logo-1']));
    await putCachedBrandingAsset(WS2, 'b'.repeat(64), new Blob(['logo-2']));

    const result = await removeLocalAccountData(U1);
    expect(result.workspaces).toEqual([WS1]);
    expect(localStorage.getItem(`officepilot-state:workspace:${WS1}:account:${U1}:full`)).toBeNull();
    expect(localStorage.getItem(`officetakt-workspace-access:${U1}:${WS1}`)).toBeNull();
    expect(localStorage.getItem('officetakt-auth-last-account')).toBeNull();
    expect(localStorage.getItem(`officepilot-state:workspace:${WS2}:account:${U2}:full`)).toBe('{}');
    expect(localStorage.getItem('unbeteiligte-einstellung')).toBe('bleibt');
    expect(sessionStorage.getItem(`officetakt.accountDeletion.requestId:${U1}`)).toBeNull();
    expect(sessionStorage.getItem('zwischenstand')).toBeNull();
    expect(sessionStorage.getItem('fremd')).not.toBeNull();
    expect(await readDocumentBlob('f-eigen', scope(WS1, U1))).toBeNull();
    expect(await readDocumentBlob('f-fremd', scope(WS2, U2))).not.toBeNull();
    expect(await getCachedBrandingAsset(WS1, 'a'.repeat(64))).toBeNull();
    expect(await getCachedBrandingAsset(WS2, 'b'.repeat(64))).not.toBeNull();
  });

  it('ein Betrieb, den noch ein anderes Konto auf diesem Gerät führt, behält seinen Logo-Zwischenspeicher', async () => {
    localStorage.setItem(`officepilot-state:workspace:${WS1}:account:${U1}:full`, '{}');
    localStorage.setItem(`officepilot-state:workspace:${WS1}:account:${U2}:member`, '{}');
    await putCachedBrandingAsset(WS1, 'a'.repeat(64), new Blob(['logo-1']));
    await removeLocalAccountData(U1);
    expect(await getCachedBrandingAsset(WS1, 'a'.repeat(64))).not.toBeNull();
    expect(localStorage.getItem(`officepilot-state:workspace:${WS1}:account:${U2}:member`)).toBe('{}');
  });

  it('nur gültige Kontokennungen; ohne Bestände bleibt alles unverändert', async () => {
    await expect(removeLocalAccountData('kein-konto')).rejects.toThrow('local_account_invalid');
    localStorage.setItem('unbeteiligte-einstellung', 'bleibt');
    const result = await removeLocalAccountData(U1);
    expect(result).toEqual({ storageKeys: 0, sessionKeys: 0, indexedDbRecords: 0, workspaces: [] });
    expect(localStorage.getItem('unbeteiligte-einstellung')).toBe('bleibt');
  });
});
