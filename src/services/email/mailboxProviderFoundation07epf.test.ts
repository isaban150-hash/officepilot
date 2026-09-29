/**
 * E-MAIL-07E-PF — providerneutrale Postfach-Grundlage: Anbieter-Register
 * (Server ↔ Datenbank), generischer OAuth-Kern mit einem zweiten
 * (Test-)Anbieter, Trennung der Zugangsdaten je Anbieter, Einstiege für einen
 * späteren anbieterunabhängigen Mail-Eingang, Client-Schutz je Anbieter.
 * Gefälschtes fetch, kein Google, kein Microsoft, kein Postfach, kein Versand.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDelegatedTokenProvider,
  parseDelegatedCredential,
  runMailboxOAuthCallback,
  runMailboxOAuthStart,
  serializeDelegatedCredential,
  sha256HexOf,
  validateOidcIdToken,
  type ConsumedOAuthState,
  type MailboxOAuthBaseConfig,
  type MailboxOAuthProvider,
  type MailboxOAuthStateRow,
} from '../../../supabase/functions/_shared/oauth/mailboxOAuth';
import { getMailboxOAuthProvider, listMailboxOAuthProviders, resolveMailboxOAuthBinding } from '../../../supabase/functions/_shared/oauth/providers';
import { microsoftMailboxOAuth } from '../../../supabase/functions/_shared/oauth/microsoftOAuth';
import { rawMessageToNormalized } from '../../../supabase/functions/_shared/inboundMailProvider';
import { importInboundMessage, type InboundSyncDeps } from '../../../supabase/functions/_shared/inboundSyncCore';
import * as supabaseLib from '../../lib/supabase';
import { MAILBOX_AUTHORIZE_PREFIXES, rpcGetMailboxOAuthPending, startMailboxOAuth } from './emailMessageCloudService';
import { sha256Hex } from '../delivery/documentDeliveryContract';

const WS = '00000000-0000-4000-8000-00000000f001';
const NOW = new Date('2026-09-27T10:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const read = (file: string) => readFileSync(file, 'utf8');

afterEach(() => vi.restoreAllMocks());

/** Zweiter Anbieter NUR für Tests: Label-Quelle, eigener Aussteller, verifizierte Adresse. */
const fakeProvider: MailboxOAuthProvider<MailboxOAuthBaseConfig> = {
  providerType: 'google_gmail',
  sourceKind: 'label',
  defaultSourceName: 'OfficeTakt',
  credentialKind: 'test_label_provider',
  authorizeScopes: ['openid', 'email', 'test.read'],
  refreshScopes: ['test.read'],
  readConfig: () => ({ ok: false, missing: ['TEST'] }),
  authorizeEndpoint: () => 'https://auth.test.invalid/authorize',
  tokenEndpoint: () => 'https://auth.test.invalid/token',
  extraAuthorizeParams: ({ loginHint }) => ({ access_type: 'offline', prompt: 'consent', ...(loginHint ? { login_hint: loginHint } : {}) }),
  checkGrantedScopes: (scope) => (scope.split(' ').includes('test.read') ? { ok: true } : { ok: false, error: 'scope_missing_required' }),
  validateIdToken: (idToken, expected) =>
    validateOidcIdToken(idToken, {
      clientId: expected.config.clientId,
      nonce: expected.nonce,
      nowSeconds: expected.nowSeconds,
      addressClaims: ['email'],
      subjectClaims: ['sub'],
      requireVerifiedEmail: true,
      checkIssuer: (claims) => (claims.iss === 'https://auth.test.invalid' ? null : 'id_token_issuer'),
    }),
};
const fakeConfig: MailboxOAuthBaseConfig = { clientId: 'test-client', clientSecret: 'test-geheim', redirectUri: 'https://projekt.invalid/functions/v1/mailbox-oauth-callback', appUrl: 'https://app.invalid' };
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const idToken = (claims: Record<string, unknown>) =>
  `${b64url({ alg: 'RS256' })}.${b64url({ aud: 'test-client', iss: 'https://auth.test.invalid', exp: NOW_S + 3600, nonce: 'n-1', email: 'Pilot@Test.invalid', email_verified: true, sub: 'fake-sub-1', ...claims })}.sig`;

describe('E-MAIL-07E-PF — Anbieter-Register', () => {
  it('Server: nur Microsoft ist OAuth-fähig; google_gmail vorbereitet, aber nicht startbar; fremde Schlüssel abgelehnt', () => {
    expect(listMailboxOAuthProviders()).toEqual(['microsoft_graph']);
    expect(getMailboxOAuthProvider('microsoft_graph')).toBe(microsoftMailboxOAuth);
    for (const key of ['google_gmail', 'inbound_channel', 'gmail', 'unbekannt', '__proto__', 'constructor', '']) {
      expect(getMailboxOAuthProvider(key)).toBeNull();
      expect(resolveMailboxOAuthBinding(key, () => 'x')).toEqual({ ok: false, error: 'provider_not_available' });
    }
    expect(resolveMailboxOAuthBinding('microsoft_graph', () => undefined)).toEqual({ ok: false, error: 'oauth_not_configured', missing: ['MS_OAUTH_CLIENT_ID', 'MS_OAUTH_CLIENT_SECRET', 'MS_OAUTH_REDIRECT_URI', 'OFFICETAKT_APP_URL'] });
  });

  it('Server-Register ↔ Datenbank-Register stimmen überein (keine zweite Konstantenliste)', () => {
    const migration = read('supabase/migrations/20261015120000_workspace_mailbox_oauth.sql');
    const rows = [...migration.matchAll(/\('([a-z_]+)', array\[[^\]]*\](?:::text\[\])?, array\[([^\]]*)\](?:::text\[\])?, '(pull|push)', (true|false),/g)].map((m) => ({ provider: m[1], sources: m[2], channel: m[3], oauth: m[4] === 'true' }));
    expect(rows.map((row) => row.provider).sort()).toEqual(['google_gmail', 'imap', 'inbound_channel', 'microsoft_graph', 'stub']);
    expect(rows.filter((row) => row.oauth).map((row) => row.provider)).toEqual(listMailboxOAuthProviders());
    expect(rows.find((row) => row.provider === 'google_gmail')).toMatchObject({ sources: "'label'", channel: 'pull', oauth: false });
    expect(rows.find((row) => row.provider === 'inbound_channel')).toMatchObject({ channel: 'push', oauth: false });
    expect(rows.find((row) => row.provider === 'microsoft_graph')).toMatchObject({ sources: "'folder'", oauth: true });
    // Quellart des Server-Adapters passt zum DB-Register.
    expect(microsoftMailboxOAuth.sourceKind).toBe('folder');
    // Die allgemeinen Tabellen tragen keine Anbieterliste mehr (Fremdschlüssel bzw. Format).
    expect(migration).toMatch(/workspace_mailbox_connections_provider_fk\s+foreign key \(provider_type\) references public\.mailbox_provider_types/);
    expect(migration).toMatch(/direction = 'inbound' and provider ~ '\^\[a-z\]\[a-z0-9_\]\{1,40\}\$'/);
    expect(read('supabase/migrations/20261014120000_workspace_inbound_email.sql')).not.toMatch(/'gmail'/);
  });

  it('Edge Functions sind anbieterneutral; Abruf-Adapter nur für Microsoft/Stub', () => {
    const start = read('supabase/functions/mailbox-oauth-start/index.ts');
    const callback = read('supabase/functions/mailbox-oauth-callback/index.ts');
    for (const source of [start, callback]) {
      expect(source).toContain("from '../_shared/oauth/providers.ts'");
      expect(source).not.toMatch(/microsoftOAuth|MS_OAUTH_|login\.microsoftonline/);
    }
    // Anbieter kommt im Callback nur aus dem gespeicherten Zustand, nie aus der URL.
    expect(callback).not.toMatch(/searchParams\.get\('provider'\)|query\.get\('provider'\)/);
    // 07E-AUTO-SYNC: Adapter liegen gemeinsam für manuellen und automatischen Abruf in _shared/inboundSyncServer.ts.
    const sync = read('supabase/functions/_shared/inboundSyncServer.ts');
    const adapters = sync.slice(sync.indexOf('const INBOUND_ADAPTERS'), sync.indexOf('export function availableInboundProviders'));
    expect(adapters).toMatch(/async microsoft_graph\(/);
    expect(adapters).toMatch(/async stub\(/);
    expect(adapters).not.toMatch(/google_gmail|inbound_channel|imap/);
  });
});

describe('E-MAIL-07E-PF — generischer OAuth-Kern mit zweitem Anbieter', () => {
  it('Start: Endpunkt, Rechte und Zusatzparameter kommen vom Anbieter; Zustand trägt Anbieter + Label', async () => {
    const created: MailboxOAuthStateRow[] = [];
    const result = await runMailboxOAuthStart(
      { workspaceId: WS, expectedAddress: 'Pilot@Test.invalid', importDays: 30 },
      { provider: fakeProvider, config: fakeConfig, userId: 'u-1', canWrite: async () => true, createState: async (row) => void created.push(row), now: () => NOW },
    );
    const url = new URL((result as { authorizeUrl: string }).authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.test.invalid/authorize');
    expect(url.searchParams.get('scope')).toBe('openid email test.read');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(created[0]).toMatchObject({ providerType: 'google_gmail', sourceKind: 'label', sourceName: 'OfficeTakt', expectedAddress: 'pilot@test.invalid', importFrom: '2026-08-28T00:00:00.000Z' });
    expect(created[0].stateHash).toBe(await sha256HexOf(url.searchParams.get('state')!));
  });

  function callback(stateRow: Partial<ConsumedOAuthState>, resolveTo: 'fake' | 'none' = 'fake', tokens: Record<string, unknown> = {}) {
    const consumed = { id: 'state-1', workspace_id: WS, user_id: 'u-1', provider_type: 'google_gmail', code_verifier: 'v'.repeat(64), nonce: 'n-1', expected_address: 'pilot@test.invalid', source_kind: 'label', source_name: 'OfficeTakt', ...stateRow };
    const completed: Array<{ address: string; subject: string; credential: string }> = [];
    const failed: string[] = [];
    const resolve = vi.fn((providerType: string) => (resolveTo === 'fake' && providerType === 'google_gmail' ? { provider: fakeProvider, config: fakeConfig } : null));
    const deps = {
      appUrl: 'https://app.invalid',
      resolve,
      consumeState: async () => ({ ok: true as const, state: consumed }),
      exchange: vi.fn(async () => ({ accessToken: 'AT', refreshToken: 'RT', expiresInSeconds: 3600, scope: 'openid email test.read', idToken: idToken({}), ...tokens })),
      complete: async (_id: string, identity: { address: string; subject: string }, credential: string) => {
        completed.push({ ...identity, credential });
        return { outcome: 'connected' as const, stateId: 'state-1' };
      },
      fail: async (id: string) => void failed.push(id),
      log: () => undefined,
      now: () => NOW,
    };
    return { deps, completed, failed, resolve };
  }

  it('Callback: Anbieter aus dem gespeicherten Zustand (URL-Parameter wirkungslos); Identität mit stabiler Kennung', async () => {
    const run = callback({});
    const result = await runMailboxOAuthCallback(new URLSearchParams({ state: 'x', code: 'c', provider: 'microsoft_graph' }), run.deps);
    expect(result.outcome).toBe('connected');
    expect(run.resolve).toHaveBeenCalledWith('google_gmail');
    expect(run.resolve).not.toHaveBeenCalledWith('microsoft_graph');
    expect(run.completed[0]).toMatchObject({ address: 'pilot@test.invalid', subject: 'fake-sub-1' });
    expect(parseDelegatedCredential(run.completed[0].credential, 'test_label_provider')).toMatchObject({ refresh_token: 'RT' });
  });

  it('Callback: nicht verfügbarer Anbieter → kein Code-Tausch, Zustand verworfen; anbieterspezifische Prüfungen greifen', async () => {
    const none = callback({}, 'none');
    expect(await runMailboxOAuthCallback(new URLSearchParams({ state: 'x', code: 'c' }), none.deps)).toMatchObject({ outcome: 'error', code: 'oauth_not_configured' });
    expect(none.deps.exchange).not.toHaveBeenCalled();
    expect(none.failed).toEqual(['state-1']);
    const scope = callback({}, 'fake', { scope: 'openid email' });
    expect((await runMailboxOAuthCallback(new URLSearchParams({ state: 'x', code: 'c' }), scope.deps)).code).toBe('scope_missing_required');
    const unverified = callback({}, 'fake', { idToken: idToken({ email_verified: false }) });
    expect((await runMailboxOAuthCallback(new URLSearchParams({ state: 'x', code: 'c' }), unverified.deps)).code).toBe('id_token_unverified_email');
    const noSubject = callback({}, 'fake', { idToken: idToken({ sub: undefined }) });
    expect((await runMailboxOAuthCallback(new URLSearchParams({ state: 'x', code: 'c' }), noSubject.deps)).code).toBe('id_token_no_subject');
    const foreignIssuer = callback({}, 'fake', { idToken: idToken({ iss: 'https://login.microsoftonline.com/x/v2.0' }) });
    expect((await runMailboxOAuthCallback(new URLSearchParams({ state: 'x', code: 'c' }), foreignIssuer.deps)).code).toBe('id_token_issuer');
    for (const run of [scope, unverified, noSubject, foreignIssuer]) expect(run.completed).toEqual([]);
  });

  it('Zugangsdaten je Anbieter getrennt: Microsoft-Zugang wird vom Test-Anbieter nie verwendet (und umgekehrt)', async () => {
    const tokens = { accessToken: 'AT', refreshToken: 'RT', expiresInSeconds: 3600, scope: 'x', idToken: null };
    const ms = serializeDelegatedCredential(microsoftMailboxOAuth.credentialKind, tokens, NOW);
    expect(parseDelegatedCredential(ms, 'ms_delegated')).not.toBeNull();
    expect(parseDelegatedCredential(ms, 'test_label_provider')).toBeNull();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = createDelegatedTokenProvider({ provider: fakeProvider, config: fakeConfig, loadCredential: async () => ms, saveCredential: async () => undefined, fetchImpl });
    await expect(provider()).rejects.toMatchObject({ category: 'reauthorize', code: 'credential_missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('E-MAIL-07E-PF — Einstiege für einen späteren anbieterunabhängigen Mail-Eingang', () => {
  const raw = [
    'From: "Kunde" <kunde@kunde.invalid>',
    'To: eingang@betrieb.invalid',
    'Subject: Anfrage',
    'Date: Mon, 01 Jan 2024 08:00:00 +0000',
    'Message-ID: <push-1@kunde.invalid>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hallo',
  ].join('\r\n');

  it('Rohnachricht → normalisiert; Zustellzeit statt fälschbarer Date-Kopfzeile, wenn gewünscht', () => {
    const header = rawMessageToNormalized({ providerMessageId: 'p-1', raw, receivedAt: '2026-09-27T09:00:00.000Z' });
    expect(header).toMatchObject({ providerMessageId: 'p-1', internetMessageId: '<push-1@kunde.invalid>', subject: 'Anfrage', bodyText: 'Hallo', from: { address: 'kunde@kunde.invalid' } });
    expect(header.receivedAt.startsWith('2024-01-01')).toBe(true);
    const envelope = rawMessageToNormalized({ providerMessageId: 'p-1', raw, receivedAt: '2026-09-27T09:00:00.000Z' }, { receivedAtSource: 'envelope' });
    expect(envelope.receivedAt).toBe('2026-09-27T09:00:00.000Z');
  });

  it('Einzelimport: Untergrenze, Dedup und Anhänge wie beim Abruf — ohne Anbieter-Wissen', async () => {
    const imported: string[] = [];
    const deps: Pick<InboundSyncDeps, 'importMessage' | 'storeAttachment' | 'sha256Hex'> = {
      async importMessage(_id, _lease, message) {
        const id = String(message.provider_message_id);
        if (imported.includes(id)) return { outcome: 'duplicate' };
        imported.push(id);
        return { outcome: 'imported' };
      },
      storeAttachment: async () => true,
      sha256Hex,
    };
    const connection = { id: 'conn', workspace_id: WS, import_from: '2026-09-27T00:00:00.000Z' };
    // Date-Kopfzeile 2024 würde die Untergrenze reißen …
    expect(await importInboundMessage(connection, 'lease', rawMessageToNormalized({ providerMessageId: 'p-1', raw }), deps)).toBe('skipped_old');
    // … maßgeblich ist bei push die Zustellzeit.
    const message = rawMessageToNormalized({ providerMessageId: 'p-1', raw, receivedAt: '2026-09-27T09:00:00.000Z' }, { receivedAtSource: 'envelope' });
    expect(await importInboundMessage(connection, 'lease', message, deps)).toBe('imported');
    expect(await importInboundMessage(connection, 'lease', message, deps)).toBe('duplicate');
    expect(imported).toEqual(['p-1']);
  });
});

describe('E-MAIL-07E-PF — Client', () => {
  it('Anmelde-URL wird nur akzeptiert, wenn sie zum gewählten Anbieter gehört; google_gmail serverseitig noch gesperrt', async () => {
    expect(MAILBOX_AUTHORIZE_PREFIXES).toEqual({ microsoft_graph: 'https://login.microsoftonline.com/', google_gmail: 'https://accounts.google.com/o/oauth2/v2/auth?' });
    vi.spyOn(supabaseLib, 'getSupabaseUrl').mockReturnValue('https://projekt.invalid');
    const client = { auth: { getSession: async () => ({ data: { session: { access_token: 'sitzung' } } }) } } as never;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const input = { workspaceId: WS, expectedAddress: 'a@b.de', sourceName: 'OfficeTakt', importDays: 0 };
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1' }), { status: 200 }));
    expect((await startMailboxOAuth({ ...input, provider: 'google_gmail' }, client)).ok).toBe(false);
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }), { status: 200 }));
    expect((await startMailboxOAuth({ ...input, provider: 'microsoft_graph' }, client)).ok).toBe(false);
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'provider_not_available' }), { status: 400 }));
    expect(await startMailboxOAuth({ ...input, provider: 'google_gmail' }, client)).toEqual({ ok: false, error: 'provider_not_available' });
    expect(JSON.parse(String(fetchSpy.mock.calls[2][1]?.body))).toMatchObject({ provider: 'google_gmail', sourceName: 'OfficeTakt' });
  });

  it('Ausstehende Bestätigung: Grund, Anbieter und Quelle; keine Konto-Kennung', async () => {
    const rpc = { rpc: async () => ({ data: { state_id: 's', provider_type: 'google_gmail', reason: 'account_changed', expected_address: 'a@b.de', detected_address: 'a@b.de', source_kind: 'label', source_name: 'OfficeTakt', pending_until: 'x', detected_subject: 'darf-nicht' }, error: null }) } as never;
    const result = await rpcGetMailboxOAuthPending({ workspaceId: WS, stateId: 's' }, rpc);
    expect(result.ok && result.pending).toEqual({ stateId: 's', providerType: 'google_gmail', reason: 'account_changed', expectedAddress: 'a@b.de', detectedAddress: 'a@b.de', sourceKind: 'label', sourceName: 'OfficeTakt', pendingUntil: 'x' });
  });
});
