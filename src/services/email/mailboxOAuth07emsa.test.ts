/**
 * E-MAIL-07E-MSA — Microsoft-Postfach per delegiertem OAuth: Start (PKCE,
 * State), Callback (einmaliger State, Code-Tausch, Rechte, Identität,
 * Kontoabgleich), Token-Erneuerung (Rotation, invalid_grant), Graph-Delta für
 * persönliche Konten (Ordner, Datumsfilter, fremde Links), Import-Untergrenze,
 * Abgrenzung zu 07B/07D. Gefälschtes fetch, kein Microsoft, kein Postfach,
 * kein Versand, keine echten Secrets.
 *
 * 07E-PF: läuft jetzt gegen den generischen OAuth-Kern + Microsoft-Adapter
 * (Microsoft-Regressionsschutz). Nur Importpfade, neutrale Feldnamen
 * (Quelle statt Ordner) und die Adapter-Bindung wurden angepasst.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDelegatedTokenProvider as createDelegatedTokenProviderCore,
  exchangeAuthorizationCode as exchangeAuthorizationCodeCore,
  parseDelegatedCredential as parseDelegatedCredentialCore,
  pkceChallengeS256,
  runMailboxOAuthCallback,
  runMailboxOAuthStart,
  sha256HexOf,
  validateMailboxOAuthStart as validateMailboxOAuthStartCore,
  type ConsumedOAuthState,
  type MailboxOAuthCallbackDeps,
  type OAuthTokenResponse as MicrosoftTokenResponse,
} from '../../../supabase/functions/_shared/oauth/mailboxOAuth';
import {
  buildMicrosoftAuthorizeUrl,
  checkMicrosoftGrantedScopes as checkGrantedMailScopes,
  microsoftMailboxOAuth,
  MICROSOFT_MAILBOX_SCOPES as MAILBOX_OAUTH_SCOPES,
  MS_CONSUMER_TENANT_ID,
  readMicrosoftOAuthConfig as readMailboxOAuthConfig,
  validateMicrosoftIdToken,
  type MicrosoftOAuthConfig as MailboxOAuthConfig,
} from '../../../supabase/functions/_shared/oauth/microsoftOAuth';
import {
  createGraphClientCredentialsTokenProvider,
  createGraphInboundProvider,
  InboundProviderError,
  isTrustedGraphLink,
  type InboundMailProvider,
} from '../../../supabase/functions/_shared/inboundMailProvider';
import { runInboundSync, type InboundSyncDeps, type MailboxConnectionRow } from '../../../supabase/functions/_shared/inboundSyncCore';
import * as supabaseLib from '../../lib/supabase';
import { rpcListMailboxConnections, startMailboxOAuth } from './emailMessageCloudService';
import { sha256Hex } from '../delivery/documentDeliveryContract';

const WS = '00000000-0000-4000-8000-00000000a501';
const CLIENT_ID = '11111111-2222-3333-4444-555555555555';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const config: MailboxOAuthConfig = {
  clientId: CLIENT_ID,
  clientSecret: 'test-geheimnis-nur-im-test',
  redirectUri: 'https://projekt.invalid/functions/v1/mailbox-oauth-callback',
  tenant: 'consumers',
  appUrl: 'https://app.invalid',
};
const NOW = new Date('2026-09-27T10:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

afterEach(() => vi.restoreAllMocks());

const MS = microsoftMailboxOAuth;
const parseDelegatedCredential = (raw: string | null) => parseDelegatedCredentialCore(raw, MS.credentialKind);
const exchangeAuthorizationCode = (params: Omit<Parameters<typeof exchangeAuthorizationCodeCore<MailboxOAuthConfig>>[0], 'provider'>) => exchangeAuthorizationCodeCore({ provider: MS, ...params });
const createDelegatedTokenProvider = (params: Omit<Parameters<typeof createDelegatedTokenProviderCore<MailboxOAuthConfig>>[0], 'provider'>) => createDelegatedTokenProviderCore({ provider: MS, ...params });
const validateMailboxOAuthStart = (input: Parameters<typeof validateMailboxOAuthStartCore>[0], now?: Date) => validateMailboxOAuthStartCore(input, now, MS.defaultSourceName);

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function idToken(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    aud: CLIENT_ID,
    iss: `https://login.microsoftonline.com/${MS_CONSUMER_TENANT_ID}/v2.0`,
    tid: MS_CONSUMER_TENANT_ID,
    exp: NOW_S + 3600,
    nbf: NOW_S - 10,
    nonce: 'nonce-1',
    email: 'Schabi82@Hotmail.de',
    sub: 'sub-1',
    ...claims,
  })}.signatur`;
}
function tokens(patch: Partial<MicrosoftTokenResponse> = {}): MicrosoftTokenResponse {
  return {
    accessToken: 'AT-geheim',
    refreshToken: 'RT-geheim',
    expiresInSeconds: 3600,
    scope: 'https://graph.microsoft.com/Mail.Read openid email offline_access',
    idToken: idToken({}),
    ...patch,
  };
}

/** Server-State wie in der DB: nur Hash, einmal verbrauchbar, mit Ablauf. */
function stateStore() {
  const rows = new Map<string, ConsumedOAuthState & { expiresAt: number; consumed: boolean }>();
  return {
    rows,
    add(hash: string, patch: Partial<ConsumedOAuthState> = {}, expiresAt = NOW.getTime() + 600_000) {
      rows.set(hash, { id: `state-${rows.size + 1}`, workspace_id: WS, user_id: 'u-1', code_verifier: 'v'.repeat(64), nonce: 'nonce-1', expected_address: 'schabi82@hotmail.de', provider_type: 'microsoft_graph', source_kind: 'folder', source_name: 'OfficeTakt-Test', expiresAt, consumed: false, ...patch });
    },
    async consume(hash: string) {
      const row = rows.get(hash);
      if (!row) return { ok: false as const, reason: 'unknown' as const };
      if (row.consumed) return { ok: false as const, reason: 'consumed' as const };
      if (row.expiresAt <= NOW.getTime()) return { ok: false as const, reason: 'expired' as const };
      row.consumed = true;
      return { ok: true as const, state: row };
    },
  };
}

function callbackDeps(store: ReturnType<typeof stateStore>, overrides: Partial<MailboxOAuthCallbackDeps> = {}) {
  const logs: Array<Record<string, unknown>> = [];
  const completed: Array<{ stateId: string; address: string; subject: string; credential: string }> = [];
  const failed: string[] = [];
  const exchange = vi.fn(async () => tokens());
  const deps: MailboxOAuthCallbackDeps = {
    appUrl: config.appUrl,
    resolve: (providerType) => (providerType === 'microsoft_graph' ? { provider: MS, config } : null),
    consumeState: (hash) => store.consume(hash),
    exchange,
    async complete(stateId, { address, subject }, credential) {
      completed.push({ stateId, address, subject, credential });
      const row = [...store.rows.values()].find((entry) => entry.id === stateId)!;
      return { outcome: row.expected_address === address ? 'connected' : 'confirm_required', stateId };
    },
    async fail(stateId) {
      failed.push(stateId);
    },
    log: (entry) => logs.push(entry),
    now: () => NOW,
    ...overrides,
  };
  return { deps, logs, completed, failed, exchange };
}

async function stateParam(store: ReturnType<typeof stateStore>, raw = 'roher-state-wert', patch: Partial<ConsumedOAuthState> = {}, expiresAt?: number) {
  store.add(await sha256HexOf(raw), patch, expiresAt);
  return raw;
}

describe('E-MAIL-07E-MSA — Start (A–H)', () => {
  it('A: delegierter Start → Microsoft v2 „consumers", Code + PKCE S256, minimale Rechte, Kontohinweis', async () => {
    const created: Array<Record<string, unknown>> = [];
    const result = await runMailboxOAuthStart(
      { workspaceId: WS, expectedAddress: ' Schabi82@Hotmail.de ', sourceName: 'OfficeTakt-Test', importDays: 7 },
      { provider: MS, config, userId: 'u-1', canWrite: async () => true, createState: async (row) => void created.push(row), now: () => NOW },
    );
    expect(result.ok).toBe(true);
    const url = new URL((result as { authorizeUrl: string }).authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('response_mode')).toBe('query');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(config.redirectUri);
    expect(p.get('login_hint')).toBe('schabi82@hotmail.de');
    expect(p.get('prompt')).toBe('select_account');
    expect(p.get('scope')).toBe('openid email offline_access https://graph.microsoft.com/Mail.Read');
    // Kein Client-Secret, kein Verifier im Browser-Link.
    expect(url.toString()).not.toContain(config.clientSecret);
    expect(url.toString()).not.toContain(String(created[0].codeVerifier));
    // State nur als Hash gespeichert.
    expect(created[0].stateHash).toBe(await sha256HexOf(p.get('state')!));
    expect(created[0].stateHash).not.toBe(p.get('state'));
    expect(created[0]).toMatchObject({ workspaceId: WS, userId: 'u-1', providerType: 'microsoft_graph', expectedAddress: 'schabi82@hotmail.de', sourceKind: 'folder', sourceName: 'OfficeTakt-Test', ttlSeconds: 600 });
    expect(created[0].importFrom).toBe('2026-09-20T00:00:00.000Z');
    expect(String(created[0].nonce)).toBe(p.get('nonce'));
  });

  it('B: App-only (Firmenmandant) bleibt: /users/{postfach}/…/inbox, Client-Credentials; 401 erneuert Token genau einmal', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ value: [], '@odata.deltaLink': `${GRAPH}/users/x/delta?$deltatoken=1` }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = createGraphInboundProvider({ mailbox: 'info@firma.invalid', getAccessToken: async () => 't', fetchImpl });
    await provider.listChanges(null, 10);
    expect(urls[0]).toContain('/users/info%40firma.invalid/mailFolders/inbox/messages/delta');
    expect(urls[0]).not.toContain('$filter');

    const tokenFetch = vi.fn(async () => new Response(JSON.stringify({ access_token: `t${tokenFetch.mock.calls.length}`, expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch & { mock: { calls: unknown[] } };
    const app = createGraphClientCredentialsTokenProvider(JSON.stringify({ tenantId: 'firma', clientId: 'c', clientSecret: 's' }), tokenFetch);
    await app();
    await app();
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    await app(true);
    expect(tokenFetch).toHaveBeenCalledTimes(2);
    const source = readFileSync('supabase/functions/_shared/inboundSyncServer.ts', 'utf8');
    expect(source).toContain("authMode: 'application'");
    expect(source).toContain("connection.auth_mode === 'delegated'");
  });

  it('C: PKCE S256 nach RFC 7636 (Prüfvektor), Verifier-Format', async () => {
    expect(await pkceChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const created: Array<{ codeVerifier: string }> = [];
    const result = await runMailboxOAuthStart({ workspaceId: WS, expectedAddress: 'a@b.de' }, { provider: MS, config, userId: 'u', canWrite: async () => true, createState: async (row) => void created.push(row) });
    const verifier = created[0].codeVerifier;
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]{43,128}$/);
    expect(new URL((result as { authorizeUrl: string }).authorizeUrl).searchParams.get('code_challenge')).toBe(await pkceChallengeS256(verifier));
  });

  it('D/E/F: State korrekt genau einmal; abgelaufen und wiederverwendet → abgelehnt ohne Code-Tausch', async () => {
    const store = stateStore();
    const good = await stateParam(store, 'state-gut');
    const first = callbackDeps(store);
    const ok = await runMailboxOAuthCallback(new URLSearchParams({ state: good, code: 'code-1' }), first.deps);
    expect(ok.outcome).toBe('connected');
    expect(first.exchange).toHaveBeenCalledWith(expect.objectContaining({ provider: MS }), 'code-1', 'v'.repeat(64));

    const again = callbackDeps(store);
    const reused = await runMailboxOAuthCallback(new URLSearchParams({ state: good, code: 'code-1' }), again.deps);
    expect(reused).toMatchObject({ outcome: 'error', code: 'state_used' });
    expect(again.exchange).not.toHaveBeenCalled();

    const old = await stateParam(store, 'state-alt', {}, NOW.getTime() - 1);
    const expired = callbackDeps(store);
    expect(await runMailboxOAuthCallback(new URLSearchParams({ state: old, code: 'c' }), expired.deps)).toMatchObject({ code: 'state_expired' });
    expect(expired.exchange).not.toHaveBeenCalled();

    const unknown = callbackDeps(store);
    expect(await runMailboxOAuthCallback(new URLSearchParams({ state: 'erfunden', code: 'c' }), unknown.deps)).toMatchObject({ code: 'state_unknown' });
    expect(await runMailboxOAuthCallback(new URLSearchParams({ code: 'c' }), unknown.deps)).toMatchObject({ code: 'state_missing' });
    expect(unknown.exchange).not.toHaveBeenCalled();
  });

  it('G/H: fremder Workspace / fehlendes Schreibrecht → kein State, keine Anmelde-URL; Eingaben geprüft', async () => {
    const createState = vi.fn(async () => undefined);
    const canWrite = vi.fn(async (workspaceId: string) => workspaceId === WS);
    expect(await runMailboxOAuthStart({ workspaceId: '00000000-0000-4000-8000-00000000a502', expectedAddress: 'a@b.de' }, { provider: MS, config, userId: 'u', canWrite, createState })).toEqual({ ok: false, error: 'forbidden' });
    expect(await runMailboxOAuthStart({ workspaceId: WS, expectedAddress: 'a@b.de' }, { provider: MS, config, userId: 'u', canWrite: async () => false, createState })).toEqual({ ok: false, error: 'forbidden' });
    expect(createState).not.toHaveBeenCalled();
    expect(validateMailboxOAuthStart({ workspaceId: WS, expectedAddress: 'kein-at' })).toEqual({ ok: false, error: 'invalid_address' });
    expect(validateMailboxOAuthStart({ workspaceId: WS, expectedAddress: 'a@b.de', sourceName: 'Inbox/../x' })).toEqual({ ok: false, error: 'invalid_source' });
    expect(validateMailboxOAuthStart({ workspaceId: WS, expectedAddress: 'a@b.de', importDays: 365 })).toEqual({ ok: false, error: 'invalid_import_window' });
    expect(validateMailboxOAuthStart({ workspaceId: 'x', expectedAddress: 'a@b.de' })).toEqual({ ok: false, error: 'invalid_workspace' });
    const now = validateMailboxOAuthStart({ workspaceId: WS, expectedAddress: 'a@b.de' }, NOW);
    expect(now).toMatchObject({ ok: true, sourceName: 'OfficeTakt-Test', importFrom: NOW.toISOString() });
  });

  it('Server-Konfiguration: fehlende Werte nur mit Namen; Standard-Mandant „consumers"', () => {
    const missing = readMailboxOAuthConfig(() => undefined);
    expect(missing).toEqual({ ok: false, missing: ['MS_OAUTH_CLIENT_ID', 'MS_OAUTH_CLIENT_SECRET', 'MS_OAUTH_REDIRECT_URI', 'OFFICETAKT_APP_URL'] });
    const env: Record<string, string> = { MS_OAUTH_CLIENT_ID: CLIENT_ID, MS_OAUTH_CLIENT_SECRET: 'x', MS_OAUTH_REDIRECT_URI: config.redirectUri, OFFICETAKT_APP_URL: 'https://app.invalid/' };
    const ok = readMailboxOAuthConfig((name) => env[name]);
    expect(ok).toMatchObject({ ok: true, config: { tenant: 'consumers', appUrl: 'https://app.invalid' } });
    expect(readMailboxOAuthConfig((name) => ({ ...env, MS_OAUTH_REDIRECT_URI: 'http://boese.invalid/cb' })[name])).toMatchObject({ ok: false, missing: ['MS_OAUTH_REDIRECT_URI'] });
  });
});

describe('E-MAIL-07E-MSA — Callback, Tokens, Rechte (I–R)', () => {
  it('I: Callback ohne Code → abgebrochen, State verbraucht, kein Tausch', async () => {
    const store = stateStore();
    const state = await stateParam(store);
    const run = callbackDeps(store);
    const result = await runMailboxOAuthCallback(new URLSearchParams({ state }), run.deps);
    expect(result).toMatchObject({ outcome: 'error', code: 'code_missing' });
    expect(run.failed).toEqual(['state-1']);
    expect(run.exchange).not.toHaveBeenCalled();
    expect(result.redirectTo).toBe('https://app.invalid/einstellungen/kommunikation?postfach=fehler&grund=code_missing');
  });

  it('J: Anbieterfehler (Zustimmung abgelehnt / sonstiger Fehler) → sichere Codes, keine Microsoft-Fehlertexte', async () => {
    const store = stateStore();
    const denied = callbackDeps(store);
    const r1 = await runMailboxOAuthCallback(new URLSearchParams({ state: await stateParam(store, 's1'), error: 'access_denied', error_description: 'AADSTS65004: User declined' }), denied.deps);
    expect(r1.code).toBe('consent_denied');
    expect(r1.redirectTo).not.toContain('AADSTS');
    const other = callbackDeps(store);
    expect((await runMailboxOAuthCallback(new URLSearchParams({ state: await stateParam(store, 's2'), error: 'server_error' }), other.deps)).code).toBe('provider_error');
    const failingExchange = callbackDeps(store, { exchange: async () => { throw new InboundProviderError('reauthorize', 'oauth_invalid_grant'); } });
    expect((await runMailboxOAuthCallback(new URLSearchParams({ state: await stateParam(store, 's3'), code: 'c' }), failingExchange.deps)).code).toBe('token_exchange_failed');
  });

  it('K/L: Refresh-Token nur serverseitig — Rückleitung/Log ohne Token, Code oder Adresse; Client erhält nie ein Token', async () => {
    const store = stateStore();
    const run = callbackDeps(store);
    const result = await runMailboxOAuthCallback(new URLSearchParams({ state: await stateParam(store), code: 'code-geheim' }), run.deps);
    expect(result.redirectTo).toBe('https://app.invalid/einstellungen/kommunikation?postfach=verbunden');
    for (const secret of ['RT-geheim', 'AT-geheim', 'code-geheim', 'schabi82', 'roher-state-wert']) {
      expect(result.redirectTo).not.toContain(secret);
      expect(JSON.stringify(run.logs)).not.toContain(secret);
    }
    // Der Zugang geht nur an den Server-Speicher (Vault-RPC).
    const credential = parseDelegatedCredential(run.completed[0].credential)!;
    expect(credential).toMatchObject({ kind: 'ms_delegated', refresh_token: 'RT-geheim' });

    // Client: nur die Microsoft-Anmelde-URL, nichts sonst; fremde URL wird verworfen.
    vi.spyOn(supabaseLib, 'getSupabaseUrl').mockReturnValue('https://projekt.invalid');
    const client = { auth: { getSession: async () => ({ data: { session: { access_token: 'sitzung' } } }) } } as never;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1', refresh_token: 'darf-nicht' }), { status: 200 }));
    const started = await startMailboxOAuth({ workspaceId: WS, provider: 'microsoft_graph', expectedAddress: 'a@b.de', sourceName: 'F', importDays: 0 }, client);
    expect(started).toEqual({ ok: true, authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1' });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://projekt.invalid/functions/v1/mailbox-oauth-start');
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, authorizeUrl: 'https://boese.invalid/phish' }), { status: 200 }));
    expect((await startMailboxOAuth({ workspaceId: WS, provider: 'microsoft_graph', expectedAddress: 'a@b.de', sourceName: 'F', importDays: 0 }, client)).ok).toBe(false);
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'oauth_not_configured' }), { status: 503 }));
    expect(await startMailboxOAuth({ workspaceId: WS, provider: 'microsoft_graph', expectedAddress: 'a@b.de', sourceName: 'F', importDays: 0 }, client)).toEqual({ ok: false, error: 'oauth_not_configured' });
    const rpc = { rpc: async () => ({ data: [{ id: 'c', provider_type: 'microsoft_graph', auth_mode: 'delegated', mailbox_address: 'schabi82@hotmail.de', status: 'connected', has_credentials: true, mailbox_source_kind: 'folder', mailbox_source_name: 'OfficeTakt-Test', refresh_token: 'darf-nicht' }], error: null }) } as never;
    const listed = await rpcListMailboxConnections({ workspaceId: WS }, rpc);
    expect(listed.ok && listed.connections[0]).toMatchObject({ authMode: 'delegated', mailboxSourceKind: 'folder', mailboxSourceName: 'OfficeTakt-Test' });
    expect(JSON.stringify(listed)).not.toContain('darf-nicht');
  });

  it('Code-Tausch: serverseitig mit PKCE-Verifier und Client-Secret an den Token-Endpunkt', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ token_type: 'Bearer', access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'https://graph.microsoft.com/Mail.Read', id_token: idToken({}) }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await exchangeAuthorizationCode({ config, code: 'code-1', codeVerifier: 'v'.repeat(64), fetchImpl });
    expect(result).toMatchObject({ accessToken: 'AT', refreshToken: 'RT' });
    expect((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0][0]).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    const form = new URLSearchParams(bodies[0]);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code_verifier')).toBe('v'.repeat(64));
    expect(form.get('redirect_uri')).toBe(config.redirectUri);
    expect(form.get('client_secret')).toBe(config.clientSecret);
  });

  function refreshHarness(responses: Array<{ status: number; body: Record<string, unknown> }>, credential: Record<string, unknown>) {
    const saved: string[] = [];
    const forms: URLSearchParams[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      forms.push(new URLSearchParams(String(init?.body)));
      const next = responses.shift()!;
      return new Response(JSON.stringify(next.body), { status: next.status });
    }) as unknown as typeof fetch;
    const provider = createDelegatedTokenProvider({
      config,
      loadCredential: async () => JSON.stringify({ v: 1, kind: 'ms_delegated', scope: 'https://graph.microsoft.com/Mail.Read', updated_at: NOW.toISOString(), ...credential }),
      saveCredential: async (value) => void saved.push(value),
      fetchImpl,
      now: () => NOW,
    });
    return { provider, saved, forms, fetchImpl };
  }

  it('M: Refresh vor Ablauf serverseitig; gültiges Token wird ohne Anfrage weiterverwendet', async () => {
    const valid = refreshHarness([], { refresh_token: 'RT-1', access_token: 'AT-gueltig', access_expires_at: new Date(NOW.getTime() + 30 * 60_000).toISOString() });
    expect(await valid.provider()).toBe('AT-gueltig');
    expect(valid.fetchImpl).not.toHaveBeenCalled();

    const soon = refreshHarness([{ status: 200, body: { access_token: 'AT-neu', expires_in: 3600, scope: 'https://graph.microsoft.com/Mail.Read' } }], { refresh_token: 'RT-1', access_token: 'AT-alt', access_expires_at: new Date(NOW.getTime() + 60_000).toISOString() });
    expect(await soon.provider()).toBe('AT-neu');
    expect(soon.forms[0].get('grant_type')).toBe('refresh_token');
    expect(soon.forms[0].get('refresh_token')).toBe('RT-1');
    expect(soon.forms[0].get('scope')).toBe('offline_access https://graph.microsoft.com/Mail.Read');
    // Kein rotiertes Token geliefert → bisheriges bleibt gespeichert.
    expect(parseDelegatedCredential(soon.saved[0])).toMatchObject({ refresh_token: 'RT-1', access_token: 'AT-neu' });
    // Nach 401: erzwungene Erneuerung trotz gültigem Token.
    const forced = refreshHarness([{ status: 200, body: { access_token: 'AT-401', expires_in: 3600 } }], { refresh_token: 'RT-1', access_token: 'AT-gueltig', access_expires_at: new Date(NOW.getTime() + 30 * 60_000).toISOString() });
    expect(await forced.provider(true)).toBe('AT-401');
  });

  it('N: rotiertes Refresh-Token wird sofort gespeichert und weiterverwendet', async () => {
    const run = refreshHarness(
      [
        { status: 200, body: { access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 3600 } },
        { status: 200, body: { access_token: 'AT-3', refresh_token: 'RT-3', expires_in: 3600 } },
      ],
      { refresh_token: 'RT-1' },
    );
    expect(await run.provider()).toBe('AT-2');
    expect(parseDelegatedCredential(run.saved[0])!.refresh_token).toBe('RT-2');
    expect(await run.provider(true)).toBe('AT-3');
    expect(run.forms[1].get('refresh_token')).toBe('RT-2');
    expect(parseDelegatedCredential(run.saved[1])!.refresh_token).toBe('RT-3');
  });

  it('O: invalid_grant → „neu verbinden"; nie ein Passwort-Rückfall', async () => {
    const run = refreshHarness([{ status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70000' } }], { refresh_token: 'RT-abgelaufen' });
    await expect(run.provider()).rejects.toMatchObject({ category: 'reauthorize', code: 'oauth_invalid_grant' });
    expect(run.saved).toEqual([]);
    expect(run.forms.every((form) => form.get('grant_type') !== 'password' && !form.has('password') && !form.has('username'))).toBe(true);
    const missing = createDelegatedTokenProvider({ config, loadCredential: async () => null, saveCredential: async () => undefined });
    await expect(missing()).rejects.toMatchObject({ category: 'reauthorize', code: 'credential_missing' });
    const sources = ['supabase/functions/_shared/oauth/mailboxOAuth.ts', 'supabase/functions/_shared/oauth/microsoftOAuth.ts', 'supabase/functions/mailbox-oauth-start/index.ts', 'supabase/functions/mailbox-oauth-callback/index.ts'].map((file) => readFileSync(file, 'utf8'));
    expect(sources.some((source) => /grant_type:\s*'password'|ropc/i.test(source))).toBe(false);
  });

  it('P/Q/R: Mail.Read erforderlich; Mail.Send und Mail.ReadWrite werden abgelehnt (Callback verbindet dann nicht)', async () => {
    expect(MAILBOX_OAUTH_SCOPES).toEqual(['openid', 'email', 'offline_access', 'https://graph.microsoft.com/Mail.Read']);
    expect(checkGrantedMailScopes('https://graph.microsoft.com/Mail.Read offline_access')).toEqual({ ok: true });
    expect(checkGrantedMailScopes('Mail.Read')).toEqual({ ok: true });
    expect(checkGrantedMailScopes('openid offline_access')).toEqual({ ok: false, error: 'scope_missing_mail_read' });
    expect(checkGrantedMailScopes('https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send')).toEqual({ ok: false, error: 'scope_excessive' });
    expect(checkGrantedMailScopes('Mail.Read Mail.ReadWrite')).toEqual({ ok: false, error: 'scope_excessive' });
    expect(checkGrantedMailScopes('Mail.ReadBasic')).toEqual({ ok: false, error: 'scope_missing_mail_read' });
    for (const [scope, code] of [
      ['https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send', 'scope_excessive'],
      ['https://graph.microsoft.com/Mail.ReadWrite', 'scope_excessive'],
      ['openid', 'scope_missing_mail_read'],
    ] as const) {
      const store = stateStore();
      const run = callbackDeps(store, { exchange: async () => tokens({ scope }) });
      expect((await runMailboxOAuthCallback(new URLSearchParams({ state: await stateParam(store), code: 'c' }), run.deps)).code).toBe(code);
      expect(run.completed).toEqual([]);
    }
    const source = readFileSync('supabase/functions/_shared/oauth/microsoftOAuth.ts', 'utf8');
    expect(source).not.toMatch(/scope[^\n]*User\.Read/);
  });
});

describe('E-MAIL-07E-MSA — persönliches Konto: Delta, Identität, Import (S–AB)', () => {
  function graph(routes: Array<{ match: RegExp; status?: number; body?: unknown | ((url: string) => unknown); bytes?: Uint8Array }>) {
    const calls: Array<{ url: string; auth: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: String((init?.headers as Record<string, string>)?.Authorization ?? '') });
      const route = routes.find((entry) => entry.match.test(url));
      if (!route) return new Response(JSON.stringify({ error: { code: 'notFound' } }), { status: 404 });
      if (route.bytes) return new Response(route.bytes as BodyInit, { status: 200 });
      const body = typeof route.body === 'function' ? (route.body as (url: string) => unknown)(url) : route.body;
      return new Response(JSON.stringify(body ?? {}), { status: route.status ?? 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }
  /** 07E-MSA-FIX1: Graph-Systemordner (well-known → echte ID) und die gespeicherte Ordner-ID als Test-Routen. */
  const WELL_KNOWN = ['msgfolderroot', 'inbox', 'sentitems', 'drafts', 'deleteditems', 'junkemail', 'archive', 'outbox', 'conversationhistory', 'scheduled', 'clutter', 'recoverableitemsdeletions', 'searchfolders', 'syncissues', 'conflicts', 'localfailures', 'serverfailures'];
  const folderRoutes = (folder: { id: string; displayName: string; parentFolderId: string } = { id: 'ID', displayName: 'OfficeTakt-Test', parentFolderId: 'WK-msgfolderroot' }) => [
    { match: new RegExp(`/me/mailFolders/(${WELL_KNOWN.join('|')})\\?\\$select=id$`), body: (url: string) => ({ id: `WK-${/mailFolders\/([a-z]+)\?/.exec(url)![1]}` }) },
    { match: new RegExp(`/me/mailFolders/${folder.id}\\?\\$select=id,displayName,parentFolderId$`), body: folder },
  ];
  const message = (id: string, received: string, extra: Record<string, unknown> = {}) => ({
    id, internetMessageId: `<${id}@x>`, conversationId: 'k', subject: `S ${id}`, from: { emailAddress: { address: 'kunde@kunde.invalid' } },
    toRecipients: [{ emailAddress: { address: 'schabi82@hotmail.de' } }], body: { contentType: 'text', content: 'Hallo' }, receivedDateTime: received, hasAttachments: false, ...extra,
  });

  it('S: persönliches Konto → /me, nur der Ordner (per Name gefunden, Kennung gemerkt), Datumsfilter im ersten Delta-Aufruf', async () => {
    const { fetchImpl, calls } = graph([
      { match: /\/me\/mailFolders\?\$filter=/, body: { value: [{ id: 'ORDNER-1', displayName: 'OfficeTakt-Test', parentFolderId: 'WK-msgfolderroot' }] } },
      { match: /\/me\/mailFolders\/inbox\/childFolders\?/, body: { value: [] } },
      { match: /\/me\/mailFolders\/ORDNER-1\/messages\/delta\?/, body: { value: [message('m1', '2026-09-27T09:00:00Z')], '@odata.deltaLink': `${GRAPH}/me/mailFolders('ORDNER-1')/messages/delta?$deltatoken=abc` } },
      { match: /deltatoken=abc/, body: { value: [], '@odata.deltaLink': `${GRAPH}/me/mailFolders('ORDNER-1')/messages/delta?$deltatoken=def` } },
      ...folderRoutes(),
    ]);
    const resolved: string[] = [];
    const provider = createGraphInboundProvider({
      mailbox: 'schabi82@hotmail.de', authMode: 'delegated', getAccessToken: async () => 'AT', fetchImpl,
      folder: { name: 'OfficeTakt-Test', onResolved: async (id) => void resolved.push(id) }, importFrom: '2026-09-27T00:00:00.000Z',
    });
    const page = await provider.listChanges(null, 10);
    expect(resolved).toEqual(['ORDNER-1']);
    expect(decodeURIComponent(calls[0].url)).toContain("/me/mailFolders?$filter=displayName eq 'OfficeTakt-Test'");
    const delta = calls.find((call) => call.url.includes('/messages/delta'))!.url;
    expect(delta.startsWith(`${GRAPH}/me/mailFolders/ORDNER-1/messages/delta?`)).toBe(true);
    // 07E-Realtest: kein Graph-$filter mehr — die Untergrenze gilt allein serverseitig (skippedOld).
    expect(decodeURIComponent(delta)).not.toContain('$filter');
    expect(calls.some((call) => /\/users\/|mailFolders\/inbox\/messages/.test(call.url))).toBe(false);
    expect(page.items[0]).toMatchObject({ providerMessageId: 'm1', receivedAt: '2026-09-27T09:00:00Z' });
    // 07E-MSA-FIX1: Stand ist an den geprüften Ordner gebunden.
    expect(page.nextCursor).toEqual({ deltaLink: `${GRAPH}/me/mailFolders('ORDNER-1')/messages/delta?$deltatoken=abc`, folderId: 'ORDNER-1', queryKey: 'q3|2026-09-27T00:00:00Z' });
    // Folgeabruf nur über den gespeicherten Graph-Link.
    await provider.listChanges(page.nextCursor, 10);
    expect(calls.at(-1)!.url).toContain('$deltatoken=abc');

    // Ordner fehlt / mehrdeutig → klarer Fehler statt ganzem Postfach.
    const none = graph([{ match: /mailFolders/, body: { value: [] } }]);
    await expect(createGraphInboundProvider({ mailbox: 'x@y.de', authMode: 'delegated', getAccessToken: async () => 't', fetchImpl: none.fetchImpl, folder: { name: 'OfficeTakt-Test' } }).listChanges(null, 5)).rejects.toMatchObject({ code: 'graph_folder_not_found' });
    expect(none.calls.some((call) => call.url.includes('/delta'))).toBe(false);
    const two = graph([
      { match: /\/me\/mailFolders\?/, body: { value: [{ id: 'A', displayName: 'OfficeTakt-Test' }] } },
      { match: /childFolders/, body: { value: [{ id: 'B', displayName: 'officetakt-test' }] } },
    ]);
    await expect(createGraphInboundProvider({ mailbox: 'x@y.de', authMode: 'delegated', getAccessToken: async () => 't', fetchImpl: two.fetchImpl, folder: { name: 'OfficeTakt-Test' } }).listChanges(null, 5)).rejects.toMatchObject({ code: 'graph_folder_ambiguous' });
    // Anführungszeichen im Namen werden OData-sicher maskiert.
    const quoted = graph([{ match: /mailFolders/, body: { value: [] } }]);
    await createGraphInboundProvider({ mailbox: 'x@y.de', authMode: 'delegated', getAccessToken: async () => 't', fetchImpl: quoted.fetchImpl, folder: { name: "O'Test", allowedNames: null } }).listChanges(null, 5).catch(() => undefined);
    expect(decodeURIComponent(quoted.calls[0].url)).toContain("displayName eq 'O''Test'");
  });

  it('S: 401 → Token einmal erneuern und genau einmal wiederholen', async () => {
    let n = 0;
    const tokensSeen: Array<boolean | undefined> = [];
    const routes = graph([...folderRoutes(), { match: /messages\/delta/, body: { value: [], '@odata.deltaLink': `${GRAPH}/me/mailFolders('ID')/messages/delta?$deltatoken=1` } }]);
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      n += 1;
      return n === 1 ? new Response('{}', { status: 401 }) : routes.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const provider = createGraphInboundProvider({ mailbox: 'x@y.de', authMode: 'delegated', folder: { name: 'OfficeTakt-Test', id: 'ID' }, getAccessToken: async (force) => { tokensSeen.push(force); return force ? 'neu' : 'alt'; }, fetchImpl });
    await provider.listChanges(null, 5);
    // Erster Aufruf 401 → genau eine erzwungene Erneuerung, danach normal weiter.
    expect(tokensSeen.slice(0, 2)).toEqual([false, true]);
    expect(tokensSeen.filter((force) => force === true)).toHaveLength(1);
    const always401 = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await expect(createGraphInboundProvider({ mailbox: 'x@y.de', authMode: 'delegated', folder: { name: 'OfficeTakt-Test', id: 'ID' }, getAccessToken: async () => 't', fetchImpl: always401 }).listChanges(null, 5)).rejects.toMatchObject({ category: 'auth' });
    expect(always401).toHaveBeenCalledTimes(2);
  });

  it('T: manipulierter nextLink/deltaLink wird abgelehnt — das Token geht nie an einen fremden Host', async () => {
    for (const link of ['https://boese.invalid/v1.0/me/delta', 'https://graph.microsoft.com.boese.invalid/v1.0/x', 'http://graph.microsoft.com/v1.0/me/delta', 'https://nutzer:pw@graph.microsoft.com/v1.0/me/delta', 'https://graph.microsoft.com/beta/me/delta', 'javascript:alert(1)']) {
      expect(isTrustedGraphLink(link)).toBe(false);
    }
    expect(isTrustedGraphLink(`${GRAPH}/me/mailFolders('A')/messages/delta?$skiptoken=x`)).toBe(true);
    const { fetchImpl, calls } = graph([...folderRoutes(), { match: /./, body: { value: [], '@odata.nextLink': 'https://boese.invalid/v1.0/steal' } }]);
    const provider = createGraphInboundProvider({ mailbox: 'x@y.de', authMode: 'delegated', folder: { name: 'OfficeTakt-Test', id: 'ID' }, getAccessToken: async () => 'AT-geheim', fetchImpl });
    await expect(provider.listChanges({ nextLink: 'https://boese.invalid/v1.0/steal' }, 5)).rejects.toMatchObject({ category: 'cursor_expired', code: 'graph_cursor_foreign' });
    await expect(provider.listChanges({ deltaLink: 42 }, 5)).rejects.toMatchObject({ code: 'graph_cursor_foreign' });
    // Antwort mit fremdem Link wird nicht als Cursor übernommen.
    await expect(provider.listChanges(null, 5)).rejects.toMatchObject({ code: 'graph_link_foreign' });
    expect(calls.every((call) => call.url.startsWith(`${GRAPH}/`))).toBe(true);
  });

  it('U: Kontoadresse aus dem ID-Token geprüft (Empfänger, Aussteller, Mandant, Ablauf, Nonce)', () => {
    const expected = { clientId: CLIENT_ID, nonce: 'nonce-1', tenant: 'consumers', nowSeconds: NOW_S };
    expect(validateMicrosoftIdToken(idToken({}), expected)).toEqual({ ok: true, address: 'schabi82@hotmail.de', subject: 'sub-1' });
    expect(validateMicrosoftIdToken(idToken({ email: undefined, preferred_username: 'Schabi82@Hotmail.de' }), expected)).toMatchObject({ ok: true, address: 'schabi82@hotmail.de' });
    expect(validateMicrosoftIdToken(null, expected)).toEqual({ ok: false, error: 'id_token_missing' });
    expect(validateMicrosoftIdToken('kaputt', expected)).toEqual({ ok: false, error: 'id_token_invalid' });
    expect(validateMicrosoftIdToken(idToken({ aud: 'andere-app' }), expected)).toEqual({ ok: false, error: 'id_token_audience' });
    expect(validateMicrosoftIdToken(idToken({ iss: 'https://boese.invalid/v2.0' }), expected)).toEqual({ ok: false, error: 'id_token_issuer' });
    const orgTid = '72f988bf-86f1-41af-91ab-2d7cd011db47';
    expect(validateMicrosoftIdToken(idToken({ tid: orgTid, iss: `https://login.microsoftonline.com/${orgTid}/v2.0` }), expected)).toEqual({ ok: false, error: 'id_token_tenant' });
    expect(validateMicrosoftIdToken(idToken({ exp: NOW_S - 3600 }), expected)).toEqual({ ok: false, error: 'id_token_expired' });
    expect(validateMicrosoftIdToken(idToken({ nonce: 'fremd' }), expected)).toEqual({ ok: false, error: 'id_token_nonce' });
    expect(validateMicrosoftIdToken(idToken({ email: undefined, preferred_username: 'kein-at' }), expected)).toEqual({ ok: false, error: 'id_token_no_address' });
  });

  it('V: anderes Konto wird nicht still verbunden — nur „bestätigen" mit Kennung, ohne Adresse in der URL', async () => {
    const store = stateStore();
    const run = callbackDeps(store, { exchange: async () => tokens({ idToken: idToken({ email: 'Anderes@Outlook.com' }) }) });
    const result = await runMailboxOAuthCallback(new URLSearchParams({ state: await stateParam(store), code: 'c' }), run.deps);
    expect(result).toMatchObject({ outcome: 'confirm_required' });
    expect(result.redirectTo).toBe('https://app.invalid/einstellungen/kommunikation?postfach=bestaetigen&oauth=state-1');
    expect(run.completed[0].address).toBe('anderes@outlook.com');
    // Ungültige Identität → gar nichts gespeichert.
    const store2 = stateStore();
    const bad = callbackDeps(store2, { exchange: async () => tokens({ idToken: idToken({ nonce: 'fremd' }) }) });
    expect((await runMailboxOAuthCallback(new URLSearchParams({ state: await stateParam(store2), code: 'c' }), bad.deps)).code).toBe('id_token_nonce');
    expect(bad.completed).toEqual([]);
    const noRefresh = callbackDeps(stateStore());
    const store3 = stateStore();
    const nr = callbackDeps(store3, { exchange: async () => tokens({ refreshToken: null }) });
    expect((await runMailboxOAuthCallback(new URLSearchParams({ state: await stateParam(store3), code: 'c' }), nr.deps)).code).toBe('oauth_no_refresh_token');
    expect(noRefresh.completed).toEqual([]);
  });

  function syncHarness(connection: Partial<MailboxConnectionRow>) {
    const row: MailboxConnectionRow = { id: 'conn', workspace_id: WS, provider_type: 'microsoft_graph', auth_mode: 'delegated', mailbox_address: 'schabi82@hotmail.de', status: 'connected', sync_cursor: null, mailbox_source_kind: 'folder', mailbox_source_name: 'OfficeTakt-Test', import_from: '2026-09-27T00:00:00.000Z', ...connection };
    const imported: Array<Record<string, unknown>> = [];
    const stored = new Map<string, Uint8Array>();
    let lease = 0;
    const make = (provider: InboundMailProvider): InboundSyncDeps => ({
      async claim() { lease += 1; row.sync_lease_token = `lease-${lease}`; return { claimed: true, connection: { ...row } }; },
      createProvider: async () => provider,
      async advanceCursor(_id, _lease, cursor) { row.sync_cursor = cursor; },
      async finish() { row.sync_lease_token = null; },
      async importMessage(_id, _lease, message, attachments) {
        if (imported.some((entry) => entry.provider_message_id === message.provider_message_id)) return { outcome: 'duplicate' };
        imported.push({ ...message, attachments });
        return { outcome: 'imported' };
      },
      async recordFailure() {},
      async storeAttachment(path, bytes) { stored.set(path, bytes); return true; },
      sha256Hex,
      log: () => undefined,
    });
    return { row, imported, stored, make };
  }

  it('W/X: Test-Import begrenzt — ältere Nachrichten (auch Delta-Ereignisse trotz Filter) nie importiert; 07E-Dedup bleibt', async () => {
    const { fetchImpl } = graph([
      { match: /messages\/delta\?\$select/, body: { value: [
        message('neu-1', '2026-09-27T08:00:00Z'),
        // Gelesen-Status-Änderung einer alten Mail: Graph liefert sie trotz $filter.
        message('alt-1', '2025-01-01T08:00:00Z'),
        message('neu-2', '2026-09-27T09:30:00Z'),
      ], '@odata.deltaLink': `${GRAPH}/me/mailFolders('ID')/messages/delta?$deltatoken=1` } },
      { match: /deltatoken=1/, body: { value: [message('neu-1', '2026-09-27T08:00:00Z'), message('alt-2', '2020-05-05T00:00:00Z')], '@odata.deltaLink': `${GRAPH}/me/mailFolders('ID')/messages/delta?$deltatoken=2` } },
      ...folderRoutes(),
    ]);
    const harness = syncHarness({ mailbox_source_id: 'ID' });
    const provider = createGraphInboundProvider({ mailbox: 'x', authMode: 'delegated', folder: { name: 'OfficeTakt-Test', id: 'ID' }, importFrom: harness.row.import_from, getAccessToken: async () => 't', fetchImpl });
    const first = await runInboundSync('conn', harness.make(provider));
    expect(first).toMatchObject({ ok: true, imported: 2, skippedOld: 1 });
    expect(harness.imported.map((entry) => entry.provider_message_id)).toEqual(['neu-1', 'neu-2']);
    const second = await runInboundSync('conn', harness.make(provider));
    expect(second).toMatchObject({ ok: true, imported: 0, duplicates: 1, skippedOld: 1 });
  });

  it('Y: Anhänge über /me geladen und privat abgelegt ({workspace}/{sha}.pdf)', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4 Angebot');
    const { fetchImpl, calls } = graph([
      { match: /messages\/delta\?\$select/, body: { value: [message('a-1', '2026-09-27T09:00:00Z', { hasAttachments: true })], '@odata.deltaLink': `${GRAPH}/me/x/delta?$deltatoken=1` } },
      { match: /\/me\/messages\/a-1\/attachments\?/, body: { value: [{ id: 'att', name: 'Angebot.pdf', contentType: 'application/pdf', size: pdf.byteLength, '@odata.type': '#microsoft.graph.fileAttachment' }] } },
      { match: /\/me\/messages\/a-1\/attachments\/att\/\$value/, bytes: pdf },
      ...folderRoutes(),
    ]);
    const harness = syncHarness({ mailbox_source_id: 'ID' });
    const provider = createGraphInboundProvider({ mailbox: 'x', authMode: 'delegated', folder: { name: 'OfficeTakt-Test', id: 'ID' }, importFrom: harness.row.import_from, getAccessToken: async () => 't', fetchImpl });
    expect(await runInboundSync('conn', harness.make(provider))).toMatchObject({ imported: 1 });
    const path = [...harness.stored.keys()][0];
    expect(path).toMatch(new RegExp(`^${WS}/[0-9a-f]{64}\\.pdf$`));
    expect(calls.some((call) => call.url.includes('/users/'))).toBe(false);
  });

  it('Z/AA/AB: keine automatische Antwort; 07D-Ausgang und 07B-Dokumentversand unberührt', () => {
    const read = (file: string) => readFileSync(file, 'utf8');
    const oauthSources = [
      'supabase/functions/_shared/oauth/mailboxOAuth.ts',
      'supabase/functions/_shared/oauth/microsoftOAuth.ts',
      'supabase/functions/_shared/oauth/providers.ts',
      'supabase/functions/_shared/inboundMailProvider.ts',
      'supabase/functions/_shared/inboundSyncCore.ts',
      'supabase/functions/mailbox-oauth-start/index.ts',
      'supabase/functions/mailbox-oauth-callback/index.ts',
      'supabase/functions/sync-mailbox/index.ts',
      'supabase/functions/_shared/inboundSyncServer.ts',
      'supabase/functions/_shared/mailboxAutoSyncCore.ts',
      'supabase/functions/mailbox-auto-sync/index.ts',
    ].map(read);
    for (const source of oauthSources) {
      expect(source).not.toMatch(/sendMail|\/reply|createReply|runSendEmail|runSendDocument|emailProvider/);
      expect(source).not.toMatch(/method:\s*'(PATCH|DELETE|PUT)'/);
    }
    for (const file of ['supabase/functions/send-email/index.ts', 'supabase/functions/_shared/sendEmailCore.ts', 'supabase/functions/send-document/index.ts', 'supabase/functions/_shared/sendDocumentCore.ts', 'supabase/functions/_shared/emailProvider.ts']) {
      expect(read(file)).not.toMatch(/mailboxOAuth|inboundMailProvider|MS_OAUTH|mailbox-oauth/);
    }
  });
});
