/**
 * E-MAIL-07E — Server-Kerne für eingehende E-Mail: MIME-Auswertung,
 * Graph-Adapter (gefälschtes fetch, kein echter Aufruf) und Sync-Kern
 * (Cursor, Wiederaufnahme, isolierte Fehler, Backoff, Anhangsregeln).
 * Kein Postfach, kein Versand.
 */
import { describe, expect, it, vi } from 'vitest';
import { htmlToText, parseRawMessage, decodeEncodedWords, parseAddressList } from '../../../supabase/functions/_shared/inboundMime';
import {
  createGraphClientCredentialsTokenProvider,
  createGraphInboundProvider,
  createRawFixtureInboundProvider,
  InboundProviderError,
  type InboundMailProvider,
  type RawFixtureMessage,
} from '../../../supabase/functions/_shared/inboundMailProvider';
import { runInboundSync, type InboundSyncDeps, type MailboxConnectionRow, type SkippedInboundAttachment, type StoredInboundAttachment } from '../../../supabase/functions/_shared/inboundSyncCore';
import { sha256Hex } from '../delivery/documentDeliveryContract';

const WS = '00000000-0000-4000-8000-0000000007e0';
const b64 = (text: string | Uint8Array) => btoa(typeof text === 'string' ? text : String.fromCharCode(...text));
const PDF = '%PDF-1.4 Aufmass';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

function eml(options: { id: string; from?: string; subject?: string; body?: string; html?: string; parts?: string[]; date?: string; messageId?: string | null }): string {
  const boundary = `b-${options.id}`;
  const headers = [
    `From: ${options.from ?? '"Müller, Anna" <Anna.Mueller@Kunde-A.invalid>'}`,
    'To: info@betrieb.invalid, "Büro" <buero@betrieb.invalid>',
    'Cc: chef@betrieb.invalid',
    `Subject: ${options.subject ?? 'Anfrage'}`,
    `Date: ${options.date ?? 'Sat, 27 Sep 2026 08:15:00 +0200'}`,
    options.messageId === null ? '' : `Message-ID: ${options.messageId ?? `<${options.id}@mail.invalid>`}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean);
  const bodyParts: string[] = [];
  if (options.html !== undefined && options.body === undefined) {
    bodyParts.push(`--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(unescape(encodeURIComponent(options.html)))}`);
  } else {
    bodyParts.push(`--${boundary}\r\nContent-Type: multipart/alternative; boundary="alt-${boundary}"\r\n\r\n--alt-${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${options.body ?? 'Guten Tag,=0D=0Aanbei das Aufma=C3=9F.'}\r\n--alt-${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>HTML-Variante</p>\r\n--alt-${boundary}--`);
  }
  for (const part of options.parts ?? []) bodyParts.push(`--${boundary}\r\n${part}`);
  return `${headers.join('\r\n')}\r\n\r\n${bodyParts.join('\r\n')}\r\n--${boundary}--\r\n`;
}

const pdfPart = (name = 'Aufmass.pdf') => `Content-Type: application/pdf; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(PDF)}`;
const pngPart = (inline = false) => `Content-Type: image/png; name="foto.png"\r\nContent-Disposition: ${inline ? 'inline' : 'attachment'}; filename="foto.png"\r\n${inline ? 'Content-ID: <logo@x>\r\n' : ''}Content-Transfer-Encoding: base64\r\n\r\n${b64(PNG)}`;
const exePart = `Content-Type: application/octet-stream; name="rechnung.pdf.exe"\r\nContent-Disposition: attachment; filename="rechnung.pdf.exe"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64('MZ\u0090\u0000')}`;
const fakePdfPart = `Content-Type: application/pdf; name="fake.pdf"\r\nContent-Disposition: attachment; filename="fake.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64('MZ\u0090\u0000 kein pdf')}`;

/* ------------------------------------------------------------------------ */
/* MIME                                                                      */
/* ------------------------------------------------------------------------ */

describe('E-MAIL-07E — MIME', () => {
  it('A/B: Kopf, Adressen, Text (QP/UTF-8, text/plain bevorzugt), PDF-Anhang', () => {
    const parsed = parseRawMessage(eml({ id: 'm1', subject: '=?UTF-8?Q?R=C3=BCckfrage_zu_AU-2026-0001?=', parts: [pdfPart()] }));
    expect(parsed.from).toEqual({ address: 'anna.mueller@kunde-a.invalid', name: 'Müller, Anna' });
    expect(parsed.to).toEqual(['info@betrieb.invalid', 'buero@betrieb.invalid']);
    expect(parsed.cc).toEqual(['chef@betrieb.invalid']);
    expect(parsed.subject).toBe('Rückfrage zu AU-2026-0001');
    expect(parsed.bodyText).toBe('Guten Tag,\r\nanbei das Aufmaß.');
    expect(parsed.hasHtml).toBe(true);
    expect(parsed.internetMessageId).toBe('<m1@mail.invalid>');
    expect(parsed.receivedAt).toBe('2026-09-27T06:15:00.000Z');
    expect(parsed.attachments.map((a) => [a.filename, a.mimeType, a.inline, new TextDecoder().decode(a.content)])).toEqual([['Aufmass.pdf', 'application/pdf', false, PDF]]);
  });

  it('C: mehrere Anhänge; RFC 2231-Dateiname; Inline-Bild erkannt', () => {
    const rfc2231 = `Content-Type: application/pdf\r\nContent-Disposition: attachment; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(PDF)}`;
    const parsed = parseRawMessage(eml({ id: 'm2', parts: [pdfPart(), rfc2231, pngPart(true), exePart] }));
    expect(parsed.attachments.map((a) => a.filename)).toEqual(['Aufmass.pdf', 'Rechnung März.pdf', 'foto.png', 'rechnung.pdf.exe']);
    expect(parsed.attachments[2].inline).toBe(true);
    expect(parsed.attachments[2].contentId).toBe('logo@x');
  });

  it('Q: nur-HTML-Mail wird sicher zu Text — Skripte, Stile, Event-Handler verschwinden, kein Tag bleibt', () => {
    const html = '<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><p>Hallo&nbsp;<b>Welt</b></p><img src=x onerror="alert(2)"><div>Zeile 2 &lt;script&gt;alert(3)&lt;/script&gt;</div><ul><li>Punkt</li></ul></body></html>';
    const parsed = parseRawMessage(eml({ id: 'm3', html }));
    expect(parsed.hasHtml).toBe(true);
    expect(parsed.bodyText).toBe('Hallo Welt\nZeile 2 <script>alert(3)</script>\n• Punkt');
    expect(parsed.bodyText).not.toContain('alert(1)');
    expect(parsed.bodyText).not.toContain('onerror');
    expect(htmlToText('<a href="javascript:alert(1)">Link</a>')).toBe('Link');
  });

  it('robust: fehlende Message-ID, gefaltete Kopfzeilen, Encoded-Words, Adressen mit Kommas', () => {
    const parsed = parseRawMessage(eml({ id: 'm4', messageId: null, subject: '=?ISO-8859-1?Q?Gr=FC=DFe?=\r\n =?UTF-8?B?IGF1cyBLw7Zsbg==?=' }));
    expect(parsed.internetMessageId).toBeUndefined();
    expect(parsed.subject).toBe('Grüße aus Köln');
    expect(decodeEncodedWords('=?utf-8?b?w4TDhMOE?=')).toBe('ÄÄÄ');
    expect(parseAddressList('"Firma, GmbH" <a@b.invalid>; c@d.invalid, kaputt')).toEqual([{ address: 'a@b.invalid', name: 'Firma, GmbH' }, { address: 'c@d.invalid' }]);
    expect(() => parseRawMessage('')).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* Graph-Adapter                                                             */
/* ------------------------------------------------------------------------ */

describe('E-MAIL-07E — Microsoft-Graph-Adapter (gefälschtes fetch)', () => {
  const BASE = 'https://graph.microsoft.com/v1.0';
  function graphFetch(routes: Array<{ match: RegExp; status?: number; body?: unknown; bytes?: Uint8Array; headers?: Record<string, string> }>) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const route = routes.find((entry) => entry.match.test(url));
      if (!route) return new Response(JSON.stringify({ error: { code: 'notFound' } }), { status: 404 });
      if (route.bytes) return new Response(route.bytes as BodyInit, { status: route.status ?? 200 });
      return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200, headers: route.headers });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }
  const message = (id: string, extra: Record<string, unknown> = {}) => ({
    id, internetMessageId: `<${id}@x>`, conversationId: 'conv-1', subject: `Betreff ${id}`,
    from: { emailAddress: { address: 'Kunde@Example.invalid', name: 'Kunde' } },
    toRecipients: [{ emailAddress: { address: 'info@betrieb.invalid' } }], ccRecipients: [],
    body: { contentType: 'text', content: 'Hallo' }, receivedDateTime: '2026-09-27T08:00:00Z', hasAttachments: false, ...extra,
  });

  it('Delta-Seiten: nextLink → Fortsetzung, deltaLink → Endstand; gelöschte/Entwürfe übersprungen; Text angefordert', async () => {
    const { fetchImpl, calls } = graphFetch([
      { match: /delta\?\$select/, body: { value: [message('g1'), { id: 'g-x', '@removed': { reason: 'deleted' } }, message('g-d', { isDraft: true })], '@odata.nextLink': `${BASE}/users/x/next-1` } },
      { match: /next-1/, body: { value: [message('g2')], '@odata.deltaLink': `${BASE}/users/x/delta-final` } },
    ]);
    const provider = createGraphInboundProvider({ mailbox: 'info@betrieb.invalid', getAccessToken: async () => 'token', fetchImpl });
    const first = await provider.listChanges(null, 10);
    expect(first.items.map((item) => item.providerMessageId)).toEqual(['g1']);
    expect(first).toMatchObject({ hasMore: true, nextCursor: { nextLink: `${BASE}/users/x/next-1` } });
    expect(calls[0].url).toContain('/users/info%40betrieb.invalid/mailFolders/inbox/messages/delta');
    expect(calls[0].headers.Prefer).toContain('outlook.body-content-type="text"');
    expect(calls[0].headers.Authorization).toBe('Bearer token');
    const loaded = await first.items[0].load();
    expect(loaded).toMatchObject({ providerMessageId: 'g1', internetMessageId: '<g1@x>', providerThreadId: 'conv-1', from: { address: 'kunde@example.invalid' }, to: ['info@betrieb.invalid'], bodyText: 'Hallo', hasHtml: false });
    const second = await provider.listChanges(first.nextCursor, 10);
    expect(second).toMatchObject({ hasMore: false, nextCursor: { deltaLink: `${BASE}/users/x/delta-final` } });
  });

  it('Anhänge: nur Dateianhänge, Inhalt erst bei Bedarf; HTML-Body wird zu Text', async () => {
    const { fetchImpl } = graphFetch([
      { match: /delta\?\$select/, body: { value: [message('g3', { hasAttachments: true, body: { contentType: 'html', content: '<p>Hi<script>x()</script></p>' } })], '@odata.deltaLink': `${BASE}/d` } },
      { match: /attachments\?\$select/, body: { value: [
        { id: 'a1', name: 'Plan.pdf', contentType: 'application/pdf', size: 16, isInline: false, '@odata.type': '#microsoft.graph.fileAttachment' },
        { id: 'a2', name: 'Weitergeleitet', '@odata.type': '#microsoft.graph.itemAttachment' },
      ] } },
      { match: /attachments\/a1\/\$value/, bytes: new TextEncoder().encode(PDF) },
    ]);
    const provider = createGraphInboundProvider({ mailbox: 'info@betrieb.invalid', getAccessToken: async () => 't', fetchImpl });
    const page = await provider.listChanges(null, 5);
    const loaded = await page.items[0].load();
    expect(loaded.bodyText).toBe('Hi');
    expect(loaded.hasHtml).toBe(true);
    expect(loaded.attachments.map((a) => a.filename)).toEqual(['Plan.pdf']);
    expect(new TextDecoder().decode((await loaded.attachments[0].loadContent())!)).toBe(PDF);
  });

  it('Fehler: 429 → Pause mit Retry-After; 401 → Anmeldung; 403 → neu autorisieren; 410 → Delta abgelaufen; fremde Cursor-URL abgelehnt', async () => {
    const cases: Array<[number, Record<string, string>, string, number | undefined]> = [
      [429, { 'Retry-After': '42' }, 'rate_limited', 42],
      [401, {}, 'auth', undefined],
      [403, {}, 'reauthorize', undefined],
      [410, {}, 'cursor_expired', undefined],
      [500, {}, 'provider', 120],
    ];
    for (const [status, headers, category, retry] of cases) {
      const { fetchImpl } = graphFetch([{ match: /delta/, status, headers, body: { error: { code: 'x' } } }]);
      const provider = createGraphInboundProvider({ mailbox: 'm@x.invalid', getAccessToken: async () => 't', fetchImpl });
      const error = await provider.listChanges(null, 5).catch((e) => e);
      expect(error).toBeInstanceOf(InboundProviderError);
      expect(error.category).toBe(category);
      expect(error.retryAfterSeconds).toBe(retry);
    }
    const provider = createGraphInboundProvider({ mailbox: 'm@x.invalid', getAccessToken: async () => 't', fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(provider.listChanges({ nextLink: 'https://angreifer.invalid/stehle' }, 5)).rejects.toMatchObject({ category: 'cursor_expired' });
  });

  it('Token: fehlende/ungültige Zugangsdaten → neu autorisieren; Token wird zwischengespeichert', async () => {
    await expect(createGraphClientCredentialsTokenProvider(null)()).rejects.toMatchObject({ category: 'reauthorize' });
    await expect(createGraphClientCredentialsTokenProvider('kein json')()).rejects.toMatchObject({ category: 'reauthorize' });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'abc', expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
    const provider = createGraphClientCredentialsTokenProvider(JSON.stringify({ tenantId: 'tenant', clientId: 'c', clientSecret: 's' }), fetchImpl);
    expect(await provider()).toBe('abc');
    expect(await provider()).toBe('abc');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------ */
/* Sync-Kern                                                                 */
/* ------------------------------------------------------------------------ */

interface FakeServerMessage {
  providerMessageId: string;
  internetMessageId: string | null;
  subject: string;
  attachments: StoredInboundAttachment[];
  skipped: SkippedInboundAttachment[];
}

function fakeServer(options: { claimable?: boolean; status?: string } = {}) {
  const connection: MailboxConnectionRow = { id: 'conn-1', workspace_id: WS, provider_type: 'stub', mailbox_address: 'info@betrieb.invalid', status: options.status ?? 'connected', sync_cursor: null, sync_lease_token: null };
  const messages: FakeServerMessage[] = [];
  const failures = new Map<string, number>();
  const cursors: unknown[] = [];
  const finishes: Array<Record<string, unknown>> = [];
  const storage = new Map<string, { bytes: Uint8Array; mime: string }>();
  let leaseCount = 0;
  const logs: Array<Record<string, unknown>> = [];
  const make = (provider: InboundMailProvider, overrides: Partial<InboundSyncDeps> = {}): InboundSyncDeps => ({
    async claim() {
      if (options.claimable === false) return { claimed: false, connection };
      leaseCount += 1;
      connection.sync_lease_token = `lease-${leaseCount}`;
      return { claimed: true, connection: { ...connection } };
    },
    createProvider: async () => provider,
    async advanceCursor(_id, lease, cursor) {
      if (lease !== connection.sync_lease_token) throw new Error('lease');
      connection.sync_cursor = cursor;
      cursors.push(cursor);
    },
    async finish(_id, _lease, result) {
      finishes.push(result);
      connection.sync_lease_token = null;
    },
    async importMessage(_id, _lease, message, attachments, skipped) {
      const duplicate = messages.some((m) => m.providerMessageId === message.provider_message_id || (message.internet_message_id && m.internetMessageId?.toLowerCase() === String(message.internet_message_id).toLowerCase()));
      if (duplicate) return { outcome: 'duplicate' };
      messages.push({ providerMessageId: String(message.provider_message_id), internetMessageId: (message.internet_message_id as string) ?? null, subject: String(message.subject), attachments, skipped });
      failures.delete(String(message.provider_message_id));
      return { outcome: 'imported' };
    },
    async recordFailure(_id, _lease, providerMessageId) {
      failures.set(providerMessageId, (failures.get(providerMessageId) ?? 0) + 1);
    },
    async storeAttachment(path, bytes, mime) {
      storage.set(path, { bytes, mime });
      return true;
    },
    sha256Hex,
    log: (entry) => logs.push(entry),
    batchSize: 2,
    ...overrides,
  });
  return { connection, messages, failures, cursors, finishes, storage, logs, make };
}

const fixtures = (count: number, extra: Partial<RawFixtureMessage>[] = []): RawFixtureMessage[] =>
  Array.from({ length: count }, (_, index) => ({ providerMessageId: `p-${index + 1}`, raw: eml({ id: `m-${index + 1}`, subject: `Nachricht ${index + 1}` }), ...extra[index] }));

describe('E-MAIL-07E — Sync-Kern', () => {
  it('A/B/C/S: Import mit Anhängen — erlaubte privat unter {workspace}/{sha}.{endung}, gefährliche/verdächtige nicht übernommen, Inline-Logo ignoriert', async () => {
    const server = fakeServer();
    const provider = createRawFixtureInboundProvider([
      { providerMessageId: 'p-1', raw: eml({ id: 'm1' }) },
      { providerMessageId: '../../etc/passwd', raw: eml({ id: 'm2', parts: [pdfPart('Aufmaß: Bad?.pdf'), pngPart(), pngPart(true), exePart, fakePdfPart] }) },
    ]);
    const outcome = await runInboundSync('conn-1', server.make(provider));
    expect(outcome).toMatchObject({ ok: true, action: 'synced', imported: 2, failed: 0 });
    const withFiles = server.messages[1];
    expect(withFiles.attachments.map((a) => [a.filename, a.mime_type])).toEqual([['Aufmaß_ Bad_.pdf', 'application/pdf'], ['foto.png', 'image/png']]);
    for (const attachment of withFiles.attachments) {
      expect(attachment.storage_path).toMatch(new RegExp(`^${WS}/[0-9a-f]{64}\\.(pdf|png)$`));
      expect(attachment.storage_path).not.toContain('passwd');
    }
    expect(withFiles.skipped.map((s) => [s.filename, s.reason])).toEqual([['rechnung.pdf.exe', 'type_not_allowed'], ['fake.pdf', 'content_mismatch']]);
    expect([...server.storage.keys()].every((key) => key.startsWith(`${WS}/`))).toBe(true);
    expect(server.finishes.at(-1)).toMatchObject({ status: 'connected' });
    // Logs ohne Adressen, Betreffe, Dateinamen.
    const serialized = JSON.stringify(server.logs);
    expect(serialized).not.toMatch(/@|Nachricht|Aufma|foto/);
  });

  it('D/E: Dedup über Provider-ID und Message-ID — nichts doppelt', async () => {
    const server = fakeServer();
    const provider = createRawFixtureInboundProvider([
      { providerMessageId: 'p-1', raw: eml({ id: 'same' }) },
      { providerMessageId: 'p-1', raw: eml({ id: 'same' }) },
      { providerMessageId: 'p-2', raw: eml({ id: 'same' }) },
    ]);
    const outcome = await runInboundSync('conn-1', server.make(provider));
    expect(outcome).toMatchObject({ imported: 1, duplicates: 2 });
    expect(server.messages).toHaveLength(1);
  });

  it('G: Cursor erst nach vollständig verarbeiteter Seite; F: Abbruch → nächster Lauf setzt genau dort fort, ohne Verlust und ohne Dublette', async () => {
    const server = fakeServer();
    const list = fixtures(5);
    let calls = 0;
    // Mail 4 (zweite Seite, zweites Element) bricht anbieterweit ab (Netz).
    const flaky: InboundMailProvider = {
      provider: 'stub',
      async listChanges(cursor, size) {
        const page = await createRawFixtureInboundProvider(list).listChanges(cursor, size);
        return {
          ...page,
          items: page.items.map((item) => ({
            providerMessageId: item.providerMessageId,
            load: async () => {
              calls += 1;
              if (item.providerMessageId === 'p-4' && calls < 10) throw new InboundProviderError('network', 'net', 30);
              return item.load();
            },
          })),
        };
      },
    };
    const first = await runInboundSync('conn-1', server.make(flaky));
    expect(first).toMatchObject({ ok: false, category: 'network' });
    expect(server.cursors).toEqual([{ position: 2 }]); // nur Seite 1 abgeschlossen
    expect(server.messages.map((m) => m.providerMessageId)).toEqual(['p-1', 'p-2', 'p-3']);
    expect(server.finishes.at(-1)).toMatchObject({ status: 'error', category: 'network', retryAfterSeconds: 30 });
    calls = 100; // Störung vorbei
    const second = await runInboundSync('conn-1', server.make(flaky));
    expect(second).toMatchObject({ ok: true, imported: 2, duplicates: 1 }); // p-3 erneut gesehen, nicht doppelt
    expect(server.messages.map((m) => m.providerMessageId)).toEqual(['p-1', 'p-2', 'p-3', 'p-4', 'p-5']);
    expect(server.cursors.at(-1)).toEqual({ position: 5 });
  });

  it('kaputte Mail blockiert nicht: Fehler vermerkt, Rest importiert, Cursor läuft weiter', async () => {
    const server = fakeServer();
    const provider = createRawFixtureInboundProvider([
      { providerMessageId: 'p-1', raw: eml({ id: 'ok-1' }) },
      { providerMessageId: 'p-kaputt', raw: '' },
      { providerMessageId: 'p-3', raw: eml({ id: 'ok-3' }) },
    ]);
    const outcome = await runInboundSync('conn-1', server.make(provider));
    expect(outcome).toMatchObject({ ok: true, imported: 2, failed: 1 });
    expect(server.failures.get('p-kaputt')).toBe(1);
    expect(server.cursors.at(-1)).toEqual({ position: 3 });
  });

  it('begrenzte Batchgröße und Seitenzahl je Lauf; Rest im nächsten Lauf', async () => {
    const server = fakeServer();
    const provider = createRawFixtureInboundProvider(fixtures(7));
    const first = await runInboundSync('conn-1', server.make(provider, { batchSize: 2, maxPages: 2 }));
    expect(first).toMatchObject({ imported: 4, pages: 2, more: true });
    const second = await runInboundSync('conn-1', server.make(provider, { batchSize: 2, maxPages: 10 }));
    expect(second).toMatchObject({ imported: 3, more: false });
  });

  it('Rate-Limit/Backoff und Lease: Pause wird gemeldet; belegtes Postfach startet keinen zweiten Lauf', async () => {
    const server = fakeServer();
    const limited: InboundMailProvider = { provider: 'stub', listChanges: async () => { throw new InboundProviderError('rate_limited', 'graph_429', 90); } };
    const outcome = await runInboundSync('conn-1', server.make(limited));
    expect(outcome).toMatchObject({ ok: false, category: 'rate_limited' });
    expect(server.finishes.at(-1)).toMatchObject({ status: 'error', category: 'rate_limited', retryAfterSeconds: 90, message: 'Der Postfach-Anbieter bittet um eine Pause. Der Abruf wird später fortgesetzt.' });
    const busy = fakeServer({ claimable: false, status: 'syncing' });
    expect(await runInboundSync('conn-1', busy.make(limited))).toEqual({ ok: true, action: 'busy' });
    const disconnected = fakeServer({ claimable: false, status: 'disconnected' });
    expect(await runInboundSync('conn-1', disconnected.make(limited))).toEqual({ ok: true, action: 'disconnected' });
  });

  it('abgelaufener Delta-Stand: einmal neu beginnen, Dubletten verhindert der Import', async () => {
    const server = fakeServer();
    server.connection.sync_cursor = { position: 99, expired: true };
    const base = createRawFixtureInboundProvider(fixtures(2));
    const provider: InboundMailProvider = {
      provider: 'stub',
      async listChanges(cursor, size) {
        if ((cursor as { expired?: boolean } | null)?.expired) throw new InboundProviderError('cursor_expired', 'graph_delta_expired');
        return base.listChanges(cursor, size);
      },
    };
    expect(await runInboundSync('conn-1', server.make(provider))).toMatchObject({ ok: true, imported: 2 });
  });

  it('AB: der Sync-Kern kennt keinen Versand — nur Lese-/Import-Abhängigkeiten', () => {
    const deps = fakeServer().make(createRawFixtureInboundProvider([]));
    expect(Object.keys(deps).some((key) => /send|reply|mail(?!box)/i.test(key))).toBe(false);
  });
});
