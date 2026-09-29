/**
 * E-MAIL 07E-AUTO-SYNC 01A — serverseitiger automatischer Postfachabruf.
 *
 * Auswahl der Postfächer, Lease zwischen automatischem und manuellem Abruf,
 * Backoff, Retry-After, Token-Refresh/Rotation, invalid_grant → „neu
 * verbinden", Ordner-Schutz, inkrementeller Cursor, Duplikatschutz,
 * content-freie Logs, Scheduler-Migration und OAuth-State-Bereinigung.
 *
 * Datenbank als In-Memory-Nachbildung der SQL-Semantik (claim/finish/cursor/
 * import), Graph und Token-Endpunkt als gefälschtes fetch — kein Microsoft,
 * kein Postfach, kein Versand, keine echten Secrets.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { GRAPH_WELL_KNOWN_FOLDERS } from '../../../supabase/functions/_shared/graphFolderGuard';
import { createGraphInboundProvider, InboundProviderError, type InboundMailProvider } from '../../../supabase/functions/_shared/inboundMailProvider';
import { runInboundSync, type InboundSyncDeps, type MailboxConnectionRow } from '../../../supabase/functions/_shared/inboundSyncCore';
import {
  AUTO_SYNC_INTERVAL_MINUTES,
  AUTO_SYNC_MAX_BACKOFF_SECONDS,
  AUTO_SYNC_MIN_GAP_SECONDS,
  autoSyncBackoffSeconds,
  classifyAutoSyncCandidate,
  runMailboxAutoSync,
  type AutoSyncCandidateRow,
} from '../../../supabase/functions/_shared/mailboxAutoSyncCore';
import { createDelegatedTokenProvider, parseDelegatedCredential } from '../../../supabase/functions/_shared/oauth/mailboxOAuth';
import { microsoftMailboxOAuth, type MicrosoftOAuthConfig } from '../../../supabase/functions/_shared/oauth/microsoftOAuth';
import { sha256Hex } from '../delivery/documentDeliveryContract';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const WS = '00000000-0000-4000-8000-0000000a5e01';
const CONN = '00000000-0000-4000-8000-0000000a5c01';
const T0 = Date.parse('2026-09-28T08:00:00Z');
const MIN = 60_000;
const PROVIDERS = new Set(['microsoft_graph']);
const read = (file: string) => readFileSync(file, 'utf8');

/* ------------------------------------------------------------------------ */
/* Nachbildung der Datenbank (Semantik wie 20261014/20261016)                */
/* ------------------------------------------------------------------------ */

type DbRow = MailboxConnectionRow & {
  sync_lease_until: number | null;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  consecutive_failures: number;
  error_category: string | null;
  error_code: string | null;
  has_credential: boolean;
};

function memoryDb(initial: Partial<DbRow> = {}) {
  let clock = T0;
  let leaseSeq = 0;
  const row: DbRow = {
    id: CONN, workspace_id: WS, provider_type: 'microsoft_graph', auth_mode: 'delegated', mailbox_address: 'schabi82@hotmail.de',
    status: 'connected', sync_cursor: null, sync_lease_token: null, mailbox_source_kind: 'folder', mailbox_source_name: 'OfficeTakt-Test',
    mailbox_source_id: 'F1', import_from: '2026-09-27T14:29:20Z',
    sync_lease_until: null, next_attempt_at: null, last_attempt_at: null, consecutive_failures: 0, error_category: null, error_code: null, has_credential: true,
    ...initial,
  };
  const messages = new Map<string, Record<string, unknown>>();
  const finishes: Array<Record<string, unknown>> = [];
  const leaseValid = (lease: string) => row.sync_lease_token === lease && row.sync_lease_until !== null && row.sync_lease_until > clock;
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

  function deps(provider: () => InboundMailProvider, log: InboundSyncDeps['log'] = () => undefined): InboundSyncDeps & { providerCreated: number } {
    const result: InboundSyncDeps & { providerCreated: number } = {
      providerCreated: 0,
      async claim() {
        // = claim_workspace_mailbox_sync
        if (row.status !== 'disconnected' && (row.sync_lease_until === null || row.sync_lease_until < clock) && (row.next_attempt_at === null || row.next_attempt_at <= clock)) {
          leaseSeq += 1;
          Object.assign(row, { status: 'syncing', sync_lease_token: `lease-${leaseSeq}`, sync_lease_until: clock + 300_000, last_attempt_at: clock });
          return { claimed: true, connection: { ...row } };
        }
        return { claimed: false, connection: { ...row, sync_lease_token: null } };
      },
      async createProvider() {
        result.providerCreated += 1;
        return provider();
      },
      async advanceCursor(_id, lease, cursor) {
        if (!leaseValid(lease)) throw new Error('cursor_failed');
        row.sync_cursor = cursor;
      },
      async finish(_id, lease, outcome) {
        // = finish_workspace_mailbox_sync (inkl. consecutive_failures aus 20261016)
        if (row.sync_lease_token !== lease) throw new Error('Sync-Lease ungueltig');
        finishes.push(outcome);
        Object.assign(row, {
          status: outcome.status,
          error_category: outcome.status === 'connected' ? null : outcome.category ?? null,
          error_code: outcome.status === 'connected' ? null : outcome.code ?? null,
          next_attempt_at: outcome.retryAfterSeconds && outcome.retryAfterSeconds > 0 ? clock + Math.min(outcome.retryAfterSeconds, 86400) * 1000 : null,
          consecutive_failures: outcome.status === 'error' ? row.consecutive_failures + 1 : 0,
          sync_lease_token: null,
          sync_lease_until: null,
        });
      },
      async importMessage(_id, lease, message) {
        if (!leaseValid(lease)) throw new Error('lease_lost');
        const key = String(message.provider_message_id);
        if (messages.has(key)) return { outcome: 'duplicate' };
        messages.set(key, message);
        return { outcome: 'imported' };
      },
      async recordFailure() {},
      async storeAttachment() { return true; },
      sha256Hex,
      log,
    };
    return result;
  }

  return {
    row,
    messages,
    finishes,
    deps,
    advance(ms: number) { clock += ms; },
    now: () => clock,
    /** = list_workspace_mailbox_auto_sync_candidates (nur Steuerdaten) */
    candidates(): AutoSyncCandidateRow[] {
      if (row.status === 'disconnected') return [];
      return [{
        id: row.id, provider_type: row.provider_type, auth_mode: row.auth_mode, status: row.status, error_category: row.error_category,
        has_credential: row.has_credential, lease_active: row.sync_lease_until !== null && row.sync_lease_until > clock,
        next_attempt_at: iso(row.next_attempt_at), last_attempt_at: iso(row.last_attempt_at), consecutive_failures: row.consecutive_failures,
      }];
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Gefälschtes Graph (nur „OfficeTakt-Test" = F1) und Token-Endpunkt         */
/* ------------------------------------------------------------------------ */

type GraphOptions = {
  pages?: Array<Array<{ id: string; receivedDateTime: string }>>;
  deltaStatus?: { status: number; headers?: Record<string, string> };
  token?: { status: number; body: Record<string, unknown> };
};

function fakeGraph(options: GraphOptions = {}) {
  const calls: string[] = [];
  const pages = options.pages ?? [[{ id: 'm1', receivedDateTime: '2026-09-28T07:55:00Z' }]];
  const fetchImpl = vi.fn(async (input: string) => {
    const url = String(input);
    calls.push(url);
    if (/oauth2\/v2\.0\/token/.test(url)) {
      const token = options.token ?? { status: 200, body: { access_token: 'AT-neu', refresh_token: 'RT-rotiert', expires_in: 3600, scope: 'https://graph.microsoft.com/Mail.Read' } };
      return new Response(JSON.stringify(token.body), { status: token.status });
    }
    const wellKnown = /\/me\/mailFolders\/([a-z]+)\?\$select=id$/.exec(url);
    if (wellKnown && (GRAPH_WELL_KNOWN_FOLDERS as readonly string[]).includes(wellKnown[1])) return new Response(JSON.stringify({ id: `WK-${wellKnown[1]}` }), { status: 200 });
    if (/\/me\/mailFolders\/F1\?\$select=id,displayName,parentFolderId$/.test(url)) return new Response(JSON.stringify({ id: 'F1', displayName: 'OfficeTakt-Test', parentFolderId: 'WK-msgfolderroot' }), { status: 200 });
    if (/\/messages\/delta/.test(url)) {
      if (options.deltaStatus) return new Response(JSON.stringify({ error: { code: 'TooManyRequests' } }), { status: options.deltaStatus.status, headers: options.deltaStatus.headers });
      const token = Number(/deltatoken=(\d+)/.exec(url)?.[1] ?? 0);
      const value = (pages[token] ?? []).map((m) => ({ ...m, subject: 'Vertraulicher Betreff', from: { emailAddress: { address: 'kunde@privat.invalid', name: 'Kunde' } }, body: { contentType: 'text', content: 'Inhalt' } }));
      return new Response(JSON.stringify({ value, '@odata.deltaLink': `${GRAPH}/me/mailFolders('F1')/messages/delta?$deltatoken=${token + 1}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: 'notFound' } }), { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const graphProvider = (db: ReturnType<typeof memoryDb>, fetchImpl: typeof fetch, getAccessToken: (force?: boolean) => Promise<string> = async () => 'AT') => () =>
  createGraphInboundProvider({
    mailbox: db.row.mailbox_address,
    authMode: 'delegated',
    importFrom: db.row.import_from ?? null,
    folder: { name: db.row.mailbox_source_name ?? '', id: db.row.mailbox_source_id ?? null },
    getAccessToken,
    fetchImpl,
  });

/** Ein Scheduler-Lauf wie in mailbox-auto-sync/index.ts (derselbe runInboundSync). */
function autoRun(db: ReturnType<typeof memoryDb>, provider: () => InboundMailProvider, logs: Array<Record<string, unknown>> = []) {
  const syncDeps = db.deps(provider);
  return {
    syncDeps,
    run: () => runMailboxAutoSync({
      listCandidates: async () => db.candidates(),
      availableProviders: ['microsoft_graph'],
      syncConnection: (id) => runInboundSync(id, syncDeps),
      log: (entry) => void logs.push(entry),
      now: db.now,
    }),
  };
}

const candidate = (overrides: Partial<AutoSyncCandidateRow> = {}): AutoSyncCandidateRow => ({
  id: CONN, provider_type: 'microsoft_graph', auth_mode: 'delegated', status: 'connected', error_category: null,
  has_credential: true, lease_active: false, next_attempt_at: null, last_attempt_at: null, consecutive_failures: 0, ...overrides,
});
const ago = (ms: number) => new Date(T0 - ms).toISOString();

/* ------------------------------------------------------------------------ */

describe('07E-AUTO-SYNC — Auswahl der Postfächer', () => {
  it('nur aktive Postfächer mit Adapter und Zugangsdaten sind fällig; getrennt wird ignoriert', () => {
    expect(classifyAutoSyncCandidate(candidate(), T0, PROVIDERS)).toBe('due');
    expect(classifyAutoSyncCandidate(candidate({ last_attempt_at: ago(10 * MIN) }), T0, PROVIDERS)).toBe('due');
    // Abgelaufener Lease eines abgebrochenen Laufs (Status bleibt „syncing") wird wieder aufgenommen.
    expect(classifyAutoSyncCandidate(candidate({ status: 'syncing', lease_active: false, last_attempt_at: ago(30 * MIN) }), T0, PROVIDERS)).toBe('due');
    expect(classifyAutoSyncCandidate(candidate({ status: 'disconnected' }), T0, PROVIDERS)).toBe('disconnected');
    expect(classifyAutoSyncCandidate(candidate({ has_credential: false }), T0, PROVIDERS)).toBe('no_credential');
    for (const provider of ['google_gmail', 'imap', 'inbound_channel', 'stub']) {
      expect(classifyAutoSyncCandidate(candidate({ provider_type: provider }), T0, PROVIDERS)).toBe('provider_unavailable');
    }
    expect(classifyAutoSyncCandidate(candidate({ status: 'error', error_category: 'reauthorize' }), T0, PROVIDERS)).toBe('reconnect_required');
    expect(classifyAutoSyncCandidate(candidate({ lease_active: true, status: 'syncing' }), T0, PROVIDERS)).toBe('lease');
    expect(classifyAutoSyncCandidate(candidate({ next_attempt_at: new Date(T0 + 60_000).toISOString() }), T0, PROVIDERS)).toBe('retry_after');
    expect(classifyAutoSyncCandidate(candidate({ last_attempt_at: ago(30_000) }), T0, PROVIDERS)).toBe('recent');
  });

  it('Lauf: getrennte/übersprungene Postfächer lösen keinen Abruf aus; Zähler stimmen', async () => {
    const synced: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const summary = await runMailboxAutoSync({
      listCandidates: async () => [
        candidate({ id: 'a' }),
        candidate({ id: 'b', status: 'disconnected' }),
        candidate({ id: 'c', has_credential: false }),
        candidate({ id: 'd', provider_type: 'google_gmail' }),
        candidate({ id: 'e', status: 'error', error_category: 'reauthorize' }),
        candidate({ id: 'f', lease_active: true }),
        candidate({ id: 'g', status: 'error', error_category: 'network', consecutive_failures: 3, last_attempt_at: ago(10 * MIN) }),
        candidate({ id: 'h', last_attempt_at: ago(20_000) }),
        candidate({ id: 'i', status: 'error', error_category: 'network', consecutive_failures: 1, last_attempt_at: ago(10 * MIN) }),
      ],
      availableProviders: ['microsoft_graph'],
      async syncConnection(id) {
        synced.push(id);
        return id === 'i' ? { ok: false, action: 'provider_error', category: 'network', code: 'graph_network' } : { ok: true, action: 'synced', imported: 2, duplicates: 0, failed: 0, skippedOld: 0, pages: 1, more: false };
      },
      log: (entry) => void logs.push(entry),
      now: () => T0,
    });
    expect(synced).toEqual(['a', 'i']);
    expect(summary).toMatchObject({ considered: 8, due: 2, started: 2, success: 1, failure: 1, imported: 2, skippedLease: 1, skippedBackoff: 1, skippedRecent: 1, skippedReconnect: 1, skippedNoCredential: 1, skippedProvider: 1, budgetExhausted: false });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ outcome: 'run', considered: 8, started: 2, skippedLease: 1, skippedBackoff: 1, success: 1, failure: 1, imported: 2 });
  });

  it('Zeitbudget: nach Ablauf werden keine weiteren Postfächer begonnen', async () => {
    let clock = T0;
    const synced: string[] = [];
    const summary = await runMailboxAutoSync({
      listCandidates: async () => [candidate({ id: 'a' }), candidate({ id: 'b' }), candidate({ id: 'c' })],
      availableProviders: ['microsoft_graph'],
      async syncConnection(id) { synced.push(id); clock += 60_000; return { ok: true, action: 'synced', imported: 0, duplicates: 0, failed: 0, skippedOld: 0, pages: 1, more: false }; },
      log: () => undefined,
      now: () => clock,
      timeBudgetMs: 100_000,
    });
    expect(synced).toEqual(['a', 'b']);
    expect(summary.budgetExhausted).toBe(true);
  });
});

describe('07E-AUTO-SYNC — Lease zwischen automatischem und manuellem Abruf', () => {
  it('läuft ein manueller Abruf (Lease aktiv), überspringt der Scheduler sauber — kein zweiter Graph-Aufruf', async () => {
    const db = memoryDb();
    const graph = fakeGraph();
    const manual = db.deps(graphProvider(db, graph.fetchImpl));
    // Manueller Abruf hat den Lease geholt und läuft noch.
    expect((await manual.claim(CONN)).claimed).toBe(true);
    db.advance(5 * MIN);
    const logs: Array<Record<string, unknown>> = [];
    const auto = autoRun(db, graphProvider(db, graph.fetchImpl), logs);
    const summary = await auto.run();
    expect(summary).toMatchObject({ considered: 1, skippedLease: 0 + 1, started: 0, failure: 0 });
    expect(auto.syncDeps.providerCreated).toBe(0);
    expect(graph.calls).toEqual([]);
  });

  it('Wettlauf: Kandidatenliste veraltet, aber der Claim scheitert am Lease → busy, kein Anbieter-Aufruf, kein Fehler', async () => {
    const db = memoryDb({ last_attempt_at: T0 - 30 * MIN });
    const graph = fakeGraph();
    const stale = db.candidates();
    await db.deps(graphProvider(db, graph.fetchImpl)).claim(CONN);
    const syncDeps = db.deps(graphProvider(db, graph.fetchImpl));
    const summary = await runMailboxAutoSync({ listCandidates: async () => stale, availableProviders: ['microsoft_graph'], syncConnection: (id) => runInboundSync(id, syncDeps), log: () => undefined, now: db.now });
    expect(summary).toMatchObject({ due: 1, started: 0, skippedLease: 1, failure: 0 });
    expect(syncDeps.providerCreated).toBe(0);
    expect(graph.calls).toEqual([]);
    expect(db.row.status).toBe('syncing');
  });

  it('manueller Abruf während eines automatischen Laufs → „busy" (Lease greift in beide Richtungen)', async () => {
    const db = memoryDb();
    const graph = fakeGraph();
    const autoDeps = db.deps(graphProvider(db, graph.fetchImpl));
    await autoDeps.claim(CONN);
    const manualDeps = db.deps(graphProvider(db, graph.fetchImpl));
    expect(await runInboundSync(CONN, manualDeps)).toEqual({ ok: true, action: 'busy' });
    expect(manualDeps.providerCreated).toBe(0);
  });

  it('Auto kurz nach manuellem Lauf: innerhalb 2 min übersprungen, danach inkrementell per Cursor — kein Doppelimport', async () => {
    const db = memoryDb();
    const graph = fakeGraph({ pages: [[{ id: 'm1', receivedDateTime: '2026-09-28T07:55:00Z' }], [{ id: 'm1', receivedDateTime: '2026-09-28T07:55:00Z' }], []] });
    const manual = await runInboundSync(CONN, db.deps(graphProvider(db, graph.fetchImpl)));
    expect(manual).toMatchObject({ ok: true, action: 'synced', imported: 1 });
    expect(db.row.sync_cursor).toMatchObject({ folderId: 'F1', deltaLink: expect.stringContaining('deltatoken=1') });

    db.advance(60_000);
    const early = autoRun(db, graphProvider(db, graph.fetchImpl));
    expect(await early.run()).toMatchObject({ skippedRecent: 1, started: 0 });
    expect(early.syncDeps.providerCreated).toBe(0);

    db.advance(AUTO_SYNC_MIN_GAP_SECONDS * 1000);
    const callsBefore = graph.calls.length;
    const later = autoRun(db, graphProvider(db, graph.fetchImpl));
    // Delta meldet m1 erneut (z. B. gelesen markiert) → Duplikat, kein zweiter Datensatz.
    expect(await later.run()).toMatchObject({ started: 1, success: 1, imported: 0 });
    const deltaCalls = graph.calls.slice(callsBefore).filter((url) => url.includes('/messages/delta'));
    expect(deltaCalls).toHaveLength(1);
    expect(deltaCalls[0]).toContain('deltatoken=1');
    expect(db.messages.size).toBe(1);
    expect(db.row.sync_cursor).toMatchObject({ deltaLink: expect.stringContaining('deltatoken=2') });
  });
});

describe('07E-AUTO-SYNC — Backoff, Rate-Limit, Token, Ordner-Schutz', () => {
  it('Backoff-Stufen: 1. Fehler → nächster Takt, dann 20/40/80 min … höchstens 6 h', () => {
    expect(AUTO_SYNC_INTERVAL_MINUTES).toBe(10);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map(autoSyncBackoffSeconds)).toEqual([0, 0, 1200, 2400, 4800, 9600, 19200, 21600, 21600]);
    expect(AUTO_SYNC_MAX_BACKOFF_SECONDS).toBe(21600);
  });

  it('wiederholte Netzwerkfehler: nicht alle 10 Minuten blind — Wartezeit wächst, Erfolg setzt zurück', async () => {
    const db = memoryDb();
    let failing = true;
    const provider = (): InboundMailProvider => ({
      async listChanges() {
        if (failing) throw new InboundProviderError('network', 'graph_network', 60);
        return { items: [], nextCursor: { deltaLink: 'x' }, hasMore: false };
      },
    });
    const attempts: number[] = [];
    for (let tick = 0; tick < 12; tick += 1) {
      const auto = autoRun(db, provider);
      const summary = await auto.run();
      if (summary.started) attempts.push(tick);
      db.advance(10 * MIN);
    }
    // Takte 0,1 (1. Fehler → nächster Takt), dann 20 min (Takt 3), 40 min (Takt 7) …
    expect(attempts).toEqual([0, 1, 3, 7]);
    expect(db.row).toMatchObject({ status: 'error', error_category: 'network', consecutive_failures: 4 });
    failing = false;
    db.advance(80 * MIN);
    expect(await autoRun(db, provider).run()).toMatchObject({ success: 1 });
    expect(db.row).toMatchObject({ status: 'connected', consecutive_failures: 0, error_category: null });
  });

  it('Rate-Limit: Retry-After von Graph wird respektiert — vorher kein Graph-Aufruf', async () => {
    const db = memoryDb();
    const limited = fakeGraph({ deltaStatus: { status: 429, headers: { 'Retry-After': '900' } } });
    expect(await autoRun(db, graphProvider(db, limited.fetchImpl)).run()).toMatchObject({ failure: 1 });
    expect(db.finishes[0]).toMatchObject({ status: 'error', category: 'rate_limited', retryAfterSeconds: 900 });
    expect(db.row.next_attempt_at).toBe(T0 + 900_000);
    const ok = fakeGraph();
    db.advance(10 * MIN);
    const blocked = autoRun(db, graphProvider(db, ok.fetchImpl));
    expect(await blocked.run()).toMatchObject({ skippedBackoff: 1, started: 0 });
    expect(ok.calls).toEqual([]);
    db.advance(10 * MIN);
    expect(await autoRun(db, graphProvider(db, ok.fetchImpl)).run()).toMatchObject({ success: 1, imported: 1 });
  });

  const oauthConfig: MicrosoftOAuthConfig = { clientId: 'c', clientSecret: 'test-geheimnis', redirectUri: 'https://p.invalid/cb', appUrl: 'https://app.invalid', tenant: 'consumers' };
  const storedCredential = (extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, kind: 'ms_delegated', refresh_token: 'RT-alt', access_token: 'AT-alt', access_expires_at: new Date(T0 - MIN).toISOString(), scope: 'https://graph.microsoft.com/Mail.Read', updated_at: new Date(T0 - 3600_000).toISOString(), ...extra });

  it('Token-Refresh (bestehende Logik): abgelaufenes Access-Token wird erneuert, rotiertes Refresh-Token lease-gebunden gespeichert', async () => {
    const db = memoryDb();
    const graph = fakeGraph();
    const saved: Array<{ lease: string | null; value: string }> = [];
    const tokenProvider = createDelegatedTokenProvider({
      provider: microsoftMailboxOAuth, config: oauthConfig, fetchImpl: graph.fetchImpl, now: () => new Date(db.now()),
      loadCredential: async () => storedCredential(),
      saveCredential: async (value) => void saved.push({ lease: db.row.sync_lease_token ?? null, value }),
    });
    expect(await autoRun(db, graphProvider(db, graph.fetchImpl, tokenProvider)).run()).toMatchObject({ success: 1, imported: 1 });
    expect(graph.calls[0]).toMatch(/oauth2\/v2\.0\/token$/);
    expect(saved).toHaveLength(1);
    expect(saved[0].lease).toBe('lease-1');
    expect(parseDelegatedCredential(saved[0].value, 'ms_delegated')).toMatchObject({ refresh_token: 'RT-rotiert', access_token: 'AT-neu' });
  });

  it('invalid_grant → Status „neu verbinden" (kein Disconnect); danach kein automatischer Versuch mehr', async () => {
    const db = memoryDb();
    const graph = fakeGraph({ token: { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70000 geheim' } } });
    const saved: string[] = [];
    const tokenProvider = createDelegatedTokenProvider({
      provider: microsoftMailboxOAuth, config: oauthConfig, fetchImpl: graph.fetchImpl, now: () => new Date(db.now()),
      loadCredential: async () => storedCredential(), saveCredential: async (value) => void saved.push(value),
    });
    expect(await autoRun(db, graphProvider(db, graph.fetchImpl, tokenProvider)).run()).toMatchObject({ failure: 1 });
    expect(db.row).toMatchObject({ status: 'error', error_category: 'reauthorize', error_code: 'oauth_invalid_grant', has_credential: true });
    expect(db.row.status).not.toBe('disconnected');
    expect(saved).toEqual([]);
    expect(graph.calls.some((url) => url.includes('/messages'))).toBe(false);
    const callsAfterFailure = graph.calls.length;
    for (let tick = 0; tick < 6; tick += 1) {
      db.advance(60 * MIN);
      expect(await autoRun(db, graphProvider(db, graph.fetchImpl, tokenProvider)).run()).toMatchObject({ skippedReconnect: 1, started: 0 });
    }
    expect(graph.calls.length).toBe(callsAfterFailure);
  });

  it('fehlende Zugangsdaten im Vault → „neu verbinden", nichts gelesen', async () => {
    const db = memoryDb();
    const graph = fakeGraph();
    const tokenProvider = createDelegatedTokenProvider({ provider: microsoftMailboxOAuth, config: oauthConfig, fetchImpl: graph.fetchImpl, loadCredential: async () => null, saveCredential: async () => undefined });
    expect(await autoRun(db, graphProvider(db, graph.fetchImpl, tokenProvider)).run()).toMatchObject({ failure: 1 });
    expect(db.row).toMatchObject({ status: 'error', error_category: 'reauthorize', error_code: 'credential_missing' });
    expect(graph.calls).toEqual([]);
  });

  it('Ordner-Schutz bleibt aktiv: Systemordner als Quelle → nichts gelesen, Fehlerstatus, kein Posteingang-Rückfall', async () => {
    for (const name of ['Inbox', 'Posteingang', 'Privat']) {
      const db = memoryDb({ mailbox_source_name: name, mailbox_source_id: null });
      const graph = fakeGraph();
      expect(await autoRun(db, graphProvider(db, graph.fetchImpl)).run()).toMatchObject({ failure: 1, imported: 0 });
      expect(db.row).toMatchObject({ status: 'error', error_category: 'provider' });
      expect(String(db.row.error_code)).toMatch(/^graph_folder_/);
      expect(graph.calls.some((url) => /\/messages|mailFolders\/inbox\/messages/.test(url))).toBe(false);
      expect(db.messages.size).toBe(0);
    }
  });
});

describe('07E-AUTO-SYNC — sichere Logs', () => {
  it('Lauf-Log enthält nur Zähler — keine Adressen, Betreffe, Inhalte, Nachrichten-/Ordner-IDs, Cursor, Tokens', async () => {
    const db = memoryDb();
    const graph = fakeGraph();
    const logs: Array<Record<string, unknown>> = [];
    await autoRun(db, graphProvider(db, graph.fetchImpl), logs).run();
    const text = JSON.stringify(logs);
    expect(logs).toHaveLength(1);
    for (const value of Object.values(logs[0])) expect(['number', 'boolean', 'string']).toContain(typeof value);
    expect(Object.keys(logs[0]).sort()).toEqual(['budgetExhausted', 'considered', 'due', 'durationMs', 'failure', 'imported', 'outcome', 'skippedBackoff', 'skippedLease', 'skippedNoCredential', 'skippedProvider', 'skippedReconnect', 'skippedRecent', 'started', 'success'].sort());
    expect(text).not.toMatch(/@|Vertraulich|Inhalt|m1|F1|deltatoken|AT|RT-|lease-|OfficeTakt-Test/);
    expect(text).not.toContain(CONN);
    expect(text).not.toContain(WS);
  });

  it('Function protokolliert je Postfach nur Fehlerkategorie/-code; keine Secrets, kein Kontoname', () => {
    const fn = read('supabase/functions/mailbox-auto-sync/index.ts');
    expect(fn).toMatch(/if \(entry\.outcome === 'provider_error'\) log\(\{ outcome: 'connection_error', category: entry\.category \?\? null, code: entry\.code \?\? null \}\)/);
    expect(fn).not.toMatch(/log\(\{[^}]*(schedulerSecret|mailbox_address|connectionId|subject|token)/);
    expect(fn).not.toMatch(/console\.(log|error|warn)\((?!JSON\.stringify\(\{ scope: 'mailbox-auto-sync')/);
  });
});

describe('07E-AUTO-SYNC — Scheduler, Function, Migration', () => {
  const migration = read('supabase/migrations/20261016120000_workspace_mailbox_auto_sync.sql');
  const fn = read('supabase/functions/mailbox-auto-sync/index.ts');
  const manual = read('supabase/functions/sync-mailbox/index.ts');
  const server = read('supabase/functions/_shared/inboundSyncServer.ts');

  it('pg_cron alle 10 Minuten → pg_net → mailbox-auto-sync; OAuth-States stündlich bereinigt', () => {
    expect(migration).toMatch(/create extension if not exists pg_cron with schema pg_catalog;/);
    expect(migration).toMatch(/create extension if not exists pg_net with schema extensions;/);
    expect(migration).toContain("select cron.schedule('officetakt-mailbox-auto-sync', '*/10 * * * *', 'select public.mailbox_auto_sync_dispatch()');");
    expect(migration).toContain("select cron.schedule('officetakt-mailbox-oauth-state-purge', '17 * * * *', 'select public.purge_expired_workspace_mailbox_oauth_states()');");
    expect(migration).toMatch(/net\.http_post\(/);
    expect(migration).toMatch(/'x-officetakt-scheduler', v_secret/);
    // Auslöser nur für Datenbank-Eigentümer/pg_cron; Kandidaten + Geheimnisprüfung nur service_role.
    expect(migration).toContain('revoke all on function public.mailbox_auto_sync_dispatch() from public, anon, authenticated, service_role;');
    expect(migration).toMatch(/'list_workspace_mailbox_auto_sync_candidates\(integer\)',\s*'mailbox_auto_sync_secret_valid\(text\)'/);
    // Kandidatenliste ohne Adresse, Ordner, Cursor, Token.
    const list = migration.slice(migration.indexOf('function public.list_workspace_mailbox_auto_sync_candidates'), migration.indexOf('-- 3. Scheduler-Geheimnis'));
    expect(list).not.toMatch(/mailbox_address|mailbox_source|sync_cursor|sync_lease_token|decrypted_secret/);
    expect(list).toContain("where c.status <> 'disconnected'");
  });

  it('Scheduler-Geheimnis nur im Vault; Function prüft es vor jedem Datenzugriff; verify_jwt=false nur hier', () => {
    expect(migration).toMatch(/vault\.create_secret\(\s*replace\(gen_random_uuid\(\)::text, '-', ''\) \|\| replace\(gen_random_uuid\(\)::text, '-', ''\)/);
    expect(fn.indexOf("admin.rpc('mailbox_auto_sync_secret_valid'")).toBeGreaterThan(-1);
    expect(fn.indexOf("admin.rpc('mailbox_auto_sync_secret_valid'")).toBeLessThan(fn.indexOf('runMailboxAutoSync({'));
    expect(fn).not.toMatch(/Deno\.env\.get\('(MAILBOX_AUTO_SYNC|OFFICETAKT_SCHEDULER)/);
    const config = read('supabase/config.toml');
    expect(config).toMatch(/\[functions\.mailbox-auto-sync\]\nenabled = true\nverify_jwt = false\nentrypoint = "\.\/functions\/mailbox-auto-sync\/index\.ts"/);
    expect(config).toMatch(/\[functions\.sync-mailbox\]\nenabled = true\nverify_jwt = true/);
  });

  it('automatischer und manueller Abruf teilen Adapter, Lease, Token-Refresh und Ordner-Schutz', () => {
    expect(fn).toContain("import { runInboundSync } from '../_shared/inboundSyncCore.ts';");
    expect(fn).toContain('runInboundSync(connectionId, createInboundSyncDeps(admin, syncLog))');
    expect(manual).toContain('runInboundSync(connectionId, createInboundSyncDeps(admin, log))');
    expect(server).toContain("admin.rpc('claim_workspace_mailbox_sync'");
    expect(server).toContain('createDelegatedTokenProvider({');
    expect(server).toContain("admin.rpc('rotate_workspace_mailbox_credential', { p_connection_id: connection.id, p_lease_token: lease");
    expect(server).toContain("name: connection.mailbox_source_name ?? ''");
    // Kein eigener Abrufpfad, kein Posteingang, kein Versand im automatischen Abruf.
    expect(fn).not.toMatch(/graph\.microsoft\.com|mailFolders|inbox|sendMail|fetch\(/i);
    // Manueller Abruf behält Anmeldung, Schreibrecht, Postfach-Zugehörigkeit und 10-s-Cooldown.
    expect(manual).toMatch(/admin\.auth\.getUser[\s\S]*workspace_user_can_write[\s\S]*mailbox_connection_belongs_to_workspace[\s\S]*manualSyncCooldownRemaining\([\s\S]*runInboundSync\(/);
  });

  it('Fehlerserie: finish zählt consecutive_failures, Erfolg/Neu-Verbinden setzt zurück; kein Auto-Disconnect', () => {
    expect(migration).toMatch(/consecutive_failures = case when p_status = 'error' then least\(consecutive_failures \+ 1, 1000\) else 0 end/);
    expect(migration).toMatch(/if new\.account_verified_at is distinct from old\.account_verified_at then\s+new\.consecutive_failures := 0;/);
    expect(migration).not.toMatch(/status\s*=\s*'disconnected'/);
    expect(read('supabase/functions/_shared/mailboxAutoSyncCore.ts')).not.toMatch(/disconnect_workspace_mailbox|'disconnected' as|status: 'disconnected'/);
  });

  it('kein Browser-Polling: das Frontend ruft den automatischen Abruf nie auf', () => {
    for (const file of ['src/components/communication/InboxEmailList.tsx', 'src/components/home/HomeNewEmails.tsx', 'src/services/email/emailMessageCloudService.ts']) {
      expect(read(file)).not.toMatch(/mailbox-auto-sync|mailbox_auto_sync/);
    }
    expect(read('src/components/home/HomeNewEmails.tsx')).not.toMatch(/setInterval|syncMailbox/);
  });
});
