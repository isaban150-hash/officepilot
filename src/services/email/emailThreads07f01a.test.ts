/**
 * E-MAIL 07F-01A — Antworten + Gesprächsverläufe (Kern, Server-Adapter,
 * Client-Vertrag). Gefälschtes fetch und gefälschter Supabase-Client —
 * kein Postfach, kein Versand, keine echten Kennungen.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildQuotedReply,
  buildReplyReferences,
  isNoReplyAddress,
  normalizeMessageId,
  normalizeReplySubject,
  parseMessageIdList,
  resolveReplyRecipients,
} from '../../../supabase/functions/_shared/emailThreadRules';
import { parseRawMessage } from '../../../supabase/functions/_shared/inboundMime';
import { createGraphInboundProvider, rawMessageToNormalized } from '../../../supabase/functions/_shared/inboundMailProvider';
import { importInboundMessage } from '../../../supabase/functions/_shared/inboundSyncCore';
import { createBrevoEmailProvider } from '../../../supabase/functions/_shared/emailProvider';
import { classifyEmailRpcError, parseEmailMessageRow, rpcCreateEmailMessage, rpcGetEmailThread } from './emailMessageCloudService';
import {
  clearFreeEmailDraft,
  createFreeEmailDraft,
  freeEmailDraftStorageKey,
  loadFreeEmailDraft,
  sendFreeEmail,
} from './freeEmailOrchestrator';
import * as supabaseLib from '../../lib/supabase';
import * as persistence from '../persistenceService';
import { setActiveStorageScope } from '../storage/storageScopeService';
import { sha256Hex } from '../delivery/documentDeliveryContract';

const WS = '00000000-0000-4000-8000-0000000f01a0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const read = (file: string) => readFileSync(file, 'utf8');

describe('07F-01A — Message-IDs', () => {
  it('normalisiert (ohne <>, klein), lehnt Ungültiges ab, erfindet nichts', () => {
    expect(normalizeMessageId('  <AbC.1@Mail.X.de> ')).toBe('abc.1@mail.x.de');
    expect(normalizeMessageId('abc@x')).toBe('abc@x');
    for (const bad of ['', 'ohne-at', '<a b@x>', null, undefined, `<${'a'.repeat(950)}@x>`]) expect(normalizeMessageId(bad as string)).toBeNull();
  });

  it('In-Reply-To/References-Listen: Reihenfolge, Dubletten, jüngste zuletzt, Obergrenze', () => {
    expect(parseMessageIdList('<a@x> <B@Y>\r\n\t<a@x> <c@z>')).toEqual(['a@x', 'b@y', 'c@z']);
    expect(parseMessageIdList('kaputt ohne klammern')).toEqual([]);
    expect(parseMessageIdList(Array.from({ length: 40 }, (_, i) => `<m${i}@x>`).join(' '))).toHaveLength(30);
    expect(parseMessageIdList(Array.from({ length: 40 }, (_, i) => `<m${i}@x>`).join(' ')).at(-1)).toBe('m39@x');
    expect(buildReplyReferences(['a@x', 'b@y'], '<C@Z>')).toEqual(['a@x', 'b@y', 'c@z']);
    expect(buildReplyReferences(['a@x'], '<a@x>')).toEqual(['a@x']);
    expect(buildReplyReferences([], null)).toEqual([]);
  });
});

describe('07F-01A — Betreff „Re:"', () => {
  it('ein „Re:" ohne Präfixketten (DE/EN/TR/BG), Weiterleitung bleibt erkennbar', () => {
    expect(normalizeReplySubject('Anfrage Bad')).toBe('Re: Anfrage Bad');
    expect(normalizeReplySubject('Re: Re: AW: Anfrage Bad')).toBe('Re: Anfrage Bad');
    expect(normalizeReplySubject('AW: Antwort: RE[2]: re (3): Anfrage')).toBe('Re: Anfrage');
    expect(normalizeReplySubject('Ynt: Teklif')).toBe('Re: Teklif');
    expect(normalizeReplySubject('Отг: Оферта')).toBe('Re: Оферта');
    expect(normalizeReplySubject('SV: Tilbud')).toBe('Re: Tilbud');
    expect(normalizeReplySubject('Fwd: OfficeTakt 07E Testmail')).toBe('Re: Fwd: OfficeTakt 07E Testmail');
    expect(normalizeReplySubject('Rechnung Reparatur')).toBe('Re: Rechnung Reparatur');
    expect(normalizeReplySubject('')).toBe('Re:');
    expect(normalizeReplySubject('x'.repeat(400))).toHaveLength(255);
  });
});

describe('07F-01A — Antwortempfänger (Reply-To vor From, nie eigene/No-Reply)', () => {
  const own = ['schabi82@hotmail.de', 'info@betrieb.invalid'];

  it('gültiges Reply-To hat Vorrang, sonst From', () => {
    expect(resolveReplyRecipients({ fromAddress: 'saban_irmak@icloud.com', replyToAddresses: [] }, own)).toEqual({ to: ['saban_irmak@icloud.com'], cc: [], source: 'from', problem: null });
    expect(resolveReplyRecipients({ fromAddress: 'versand@shop.invalid', replyToAddresses: ['Service@Shop.invalid'] }, own)).toMatchObject({ to: ['service@shop.invalid'], source: 'reply_to', problem: null });
    // Reply-To nur No-Reply → sicher auf From zurück.
    expect(resolveReplyRecipients({ fromAddress: 'kunde@firma.invalid', replyToAddresses: ['noreply@firma.invalid'] }, own)).toMatchObject({ to: ['kunde@firma.invalid'], source: 'from' });
  });

  it('eigene Firmenadresse, No-Reply, ungültig, fehlend → „An" leer, Benutzer wählt (keine stille Fehladressierung)', () => {
    expect(resolveReplyRecipients({ fromAddress: 'SCHABI82@hotmail.de' }, own)).toEqual({ to: [], cc: [], source: null, problem: 'own_address' });
    expect(resolveReplyRecipients({ fromAddress: 'no-reply@bank.invalid' }, own)).toMatchObject({ to: [], problem: 'no_reply' });
    expect(resolveReplyRecipients({ fromAddress: 'mailer-daemon@mx.invalid' }, own)).toMatchObject({ to: [], problem: 'no_reply' });
    expect(resolveReplyRecipients({ fromAddress: 'kaputt' }, own)).toMatchObject({ to: [], problem: 'invalid' });
    expect(resolveReplyRecipients({ fromAddress: null }, own)).toMatchObject({ to: [], problem: 'missing' });
    expect(resolveReplyRecipients({ fromAddress: 'info@betrieb.invalid', replyToAddresses: ['donotreply@betrieb.invalid'] }, own)).toMatchObject({ to: [], problem: 'no_reply' });
    expect(isNoReplyAddress('noreply+123@x.invalid')).toBe(true);
    expect(isNoReplyAddress('anna.noreply-fan@x.invalid')).toBe(false);
  });

  it('Cc nur aus dem Cc des Originals — ohne eigene Adressen, ohne „An"; Bcc gibt es nicht', () => {
    const result = resolveReplyRecipients({ fromAddress: 'kunde@firma.invalid', cc: ['schabi82@hotmail.de', 'kollege@firma.invalid', 'kunde@firma.invalid', 'no-reply@firma.invalid'] }, own);
    expect(result.cc).toEqual(['kollege@firma.invalid']);
  });
});

describe('07F-01A — Zitat', () => {
  it('kompakt, nur Text, begrenzt', () => {
    const quote = buildQuotedReply({ bodyText: 'Hallo,\r\n\r\n<b>fett</b>\nZeile', senderLabel: 'saban_irmak@icloud.com', dateLabel: '27.09.2026, 17:04' }, { wrote: 'Am {date} schrieb {sender}:' });
    expect(quote).toBe('Am 27.09.2026, 17:04 schrieb saban_irmak@icloud.com:\n> Hallo,\n>\n> <b>fett</b>\n> Zeile');
    const long = buildQuotedReply({ bodyText: Array.from({ length: 100 }, (_, i) => `Zeile ${i}`).join('\n'), senderLabel: 'x', dateLabel: 'd' }, { wrote: '{sender}:' });
    expect(long.split('\n').length).toBeLessThanOrEqual(22);
    expect(long.endsWith('> …')).toBe(true);
  });
});

describe('07F-01A — Eingang: Verlaufsdaten lesen (MIME + Graph), Dedup unverändert', () => {
  it('MIME: In-Reply-To, References, Reply-To', () => {
    const raw = [
      'From: Kunde <kunde@firma.invalid>',
      'Reply-To: Service <Service@Firma.invalid>',
      'To: info@betrieb.invalid',
      'Subject: AW: Angebot',
      'Message-ID: <neu@firma.invalid>',
      'In-Reply-To: <Brevo-1@Smtp-Relay.Mailin.fr>',
      'References: <a1@mail.invalid>\r\n <Brevo-1@Smtp-Relay.Mailin.fr>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Danke!',
    ].join('\r\n');
    const parsed = parseRawMessage(raw);
    expect(parsed).toMatchObject({ inReplyTo: 'brevo-1@smtp-relay.mailin.fr', references: ['a1@mail.invalid', 'brevo-1@smtp-relay.mailin.fr'], replyTo: ['service@firma.invalid'] });
    expect(rawMessageToNormalized({ providerMessageId: 'p', raw })).toMatchObject({ inReplyTo: 'brevo-1@smtp-relay.mailin.fr', replyTo: ['service@firma.invalid'] });
  });

  type Route = { match: RegExp; status?: number; body?: unknown };
  function graph(routes: Route[]) {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      const route = routes.find((entry) => entry.match.test(url));
      if (!route) return new Response(JSON.stringify({ error: { code: 'notFound' } }), { status: 404 });
      return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }
  const delta = { match: /\/messages\/delta/, body: { value: [{ id: 'm1', internetMessageId: '<neu@firma.invalid>', conversationId: 'conv-1', receivedDateTime: '2026-09-28T08:00:00Z', subject: 'AW: Angebot', from: { emailAddress: { address: 'Kunde@Firma.invalid' } }, body: { contentType: 'text', content: 'Danke' } }], '@odata.deltaLink': `${GRAPH}/users/x/mailFolders('inbox')/messages/delta?$deltatoken=1` } };
  const provider = (fetchImpl: typeof fetch) => createGraphInboundProvider({ mailbox: 'info@betrieb.invalid', authMode: 'application', getAccessToken: async () => 'AT', fetchImpl });

  it('Graph: Kopfzeilen + Reply-To je Nachricht (nur lesend), Delta-Abfrage unverändert', async () => {
    const { fetchImpl, calls } = graph([
      delta,
      { match: /\/messages\/m1\?\$select=internetMessageHeaders,replyTo$/, body: { internetMessageHeaders: [{ name: 'In-Reply-To', value: '<Brevo-1@Smtp-Relay.Mailin.fr>' }, { name: 'References', value: '<a1@mail.invalid> <Brevo-1@Smtp-Relay.Mailin.fr>' }], replyTo: [{ emailAddress: { address: 'Service@Firma.invalid' } }] } },
    ]);
    const page = await provider(fetchImpl).listChanges(null, 10);
    expect(calls[0]).not.toContain('internetMessageHeaders');
    const message = await page.items[0].load();
    expect(message).toMatchObject({ providerThreadId: 'conv-1', internetMessageId: '<neu@firma.invalid>', inReplyTo: 'brevo-1@smtp-relay.mailin.fr', references: ['a1@mail.invalid', 'brevo-1@smtp-relay.mailin.fr'], replyTo: ['service@firma.invalid'] });
    expect(calls.filter((url) => url.includes('internetMessageHeaders'))).toHaveLength(1);
    expect(calls.every((url) => !/method|PATCH|DELETE|send/i.test(url))).toBe(true);
  });

  it('Graph: Kopfzeilen nicht verfügbar (404) → Import ohne Verlaufsbezug; Drosselung (429) → Abruf bricht ab, nichts halb importiert', async () => {
    const missing = graph([delta]);
    const message = await (await provider(missing.fetchImpl).listChanges(null, 10)).items[0].load();
    expect(message.inReplyTo).toBeUndefined();
    expect(message.subject).toBe('AW: Angebot');
    const limited = graph([delta, { match: /internetMessageHeaders/, status: 429 }]);
    const item = (await provider(limited.fetchImpl).listChanges(null, 10)).items[0];
    await expect(item.load()).rejects.toMatchObject({ category: 'rate_limited' });
  });

  it('Sync-Kern gibt Verlaufsdaten an den Import; Zuordnung/Thread entscheidet nur der Server', async () => {
    const importMessage = vi.fn(async () => ({ outcome: 'imported' as const }));
    await importInboundMessage(
      { id: 'c', workspace_id: WS, import_from: null },
      'lease',
      { providerMessageId: 'm1', internetMessageId: '<neu@firma.invalid>', providerThreadId: 'conv-1', inReplyTo: 'brevo-1@smtp-relay.mailin.fr', references: ['a1@mail.invalid'], replyTo: ['service@firma.invalid'], from: { address: 'kunde@firma.invalid' }, to: [], cc: [], subject: 's', bodyText: 'b', hasHtml: false, receivedAt: '2026-09-28T08:00:00Z', attachments: [] },
      { importMessage, storeAttachment: async () => true, sha256Hex },
    );
    expect(importMessage).toHaveBeenCalledWith('c', 'lease', expect.objectContaining({ in_reply_to: 'brevo-1@smtp-relay.mailin.fr', references: ['a1@mail.invalid'], reply_to: ['service@firma.invalid'], provider_thread_id: 'conv-1' }), [], []);
  });
});

describe('07F-01A — Datenbank (Migration 20261017)', () => {
  const sql = read('supabase/migrations/20261017120000_workspace_email_threads.sql');
  const resolver = sql.slice(sql.indexOf('create or replace function public.email_resolve_thread'), sql.indexOf('-- 5. Import'));

  it('eigene Thread-ID; Reihenfolge In-Reply-To → References → conversationId (nur mit Teilnehmer); nie Betreff', () => {
    expect(sql).toMatch(/add column if not exists thread_id uuid/);
    expect(sql).toMatch(/alter column thread_id set not null/);
    expect(resolver.indexOf("'in_reply_to'")).toBeLessThan(resolver.indexOf("'references'"));
    expect(resolver.indexOf("'references'")).toBeLessThan(resolver.indexOf("'provider_thread'"));
    expect(resolver).toMatch(/t\.from_address = v_from or \(t\.direction = 'outbound' and v_from = any \(t\.to_recipients \|\| t\.cc_recipients\)\)/);
    expect(resolver).not.toMatch(/subject/i);
  });

  it('Antwort: Thread/In-Reply-To/References aus dem Original, Teil der Idempotenz, Versandlimit unverändert; rfc_message_id nur aus der Quelle', () => {
    const create = sql.slice(sql.indexOf('create or replace function public.create_workspace_email_message'), sql.indexOf('-- 7. Neuversuch'));
    expect(create).toContain('p_reply_to_message_id uuid default null');
    expect(create).toContain("raise exception 'Beantwortete Nachricht nicht gefunden'");
    expect(create).toContain('or v_existing.reply_to_message_id is distinct from p_reply_to_message_id');
    expect(create).toContain('perform public.email_message_assert_rate_limit(p_workspace_id, v_user_id, cardinality(v_to) + cardinality(v_cc) + cardinality(v_bcc));');
    expect(create).toContain('coalesce(v_parent.thread_id, gen_random_uuid())');
    expect(sql).toMatch(/new\.rfc_message_id := case\s+when new\.direction = 'inbound' then public\.email_normalize_message_id\(new\.internet_message_id\)\s+else public\.email_normalize_message_id\(new\.provider_message_id\)/);
    // Deduplizierung (07E) bleibt vor jeder Thread-Zuordnung.
    const imp = sql.slice(sql.indexOf('create or replace function public.import_workspace_inbound_email'), sql.indexOf('-- 6. Freie E-Mail'));
    expect(imp.indexOf("return jsonb_build_object('outcome', 'duplicate'")).toBeLessThan(imp.indexOf('public.email_resolve_thread('));
    // Zuordnung über den Verlauf nur ohne eigene eindeutige Zuordnung.
    expect(imp).toMatch(/if v_assignment->>'status' = 'needs_review' and v_parent\.id is not null and v_parent\.customer_id is not null/);
  });

  it('kein automatischer Versand: Import, Abruf und Scheduler senden nie', () => {
    const imp = sql.slice(sql.indexOf('create or replace function public.import_workspace_inbound_email'), sql.indexOf('-- 6. Freie E-Mail'));
    expect(imp).not.toMatch(/create_workspace_email_message|net\.http|send-email|queued/);
    for (const file of ['supabase/functions/_shared/inboundSyncCore.ts', 'supabase/functions/_shared/inboundMailProvider.ts', 'supabase/functions/_shared/mailboxAutoSyncCore.ts', 'supabase/functions/mailbox-auto-sync/index.ts', 'supabase/functions/sync-mailbox/index.ts']) {
      expect(read(file)).not.toMatch(/send-email|sendFreeEmail|create_workspace_email_message|runSendEmail/);
    }
  });
});

describe('07F-01A — Versandweg unverändert (Brevo)', () => {
  it('Brevo unterstützt keine Standard-Kopfzeilen: kein In-Reply-To/References im Payload; Message-ID kommt vom Versanddienst', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ messageId: '<201798300811.5787683@relay.domain.com>' }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await createBrevoEmailProvider({ apiKey: 'k', fetchImpl }).sendTransactionalEmail({ from: { email: 'a@b.invalid' }, to: [{ email: 'c@d.invalid' }], subject: 'Re: x', text: 'y' });
    expect(result).toMatchObject({ accepted: true, providerMessageId: '<201798300811.5787683@relay.domain.com>' });
    expect(JSON.stringify(bodies[0])).not.toMatch(/In-Reply-To|References|Message-Id/i);
    expect(normalizeMessageId((result as { providerMessageId: string }).providerMessageId)).toBe('201798300811.5787683@relay.domain.com');
  });

  it('send-email, sendEmailCore und emailProvider sind für 07F-01A unverändert (kein neuer Providerpfad)', () => {
    for (const file of ['supabase/functions/send-email/index.ts', 'supabase/functions/_shared/sendEmailCore.ts', 'supabase/functions/_shared/emailProvider.ts']) {
      expect(read(file)).not.toMatch(/07F|reply_to_message_id|thread_id/);
    }
  });
});

describe('07F-01A — Client-Vertrag', () => {
  beforeEach(() => {
    localStorage.clear();
    setActiveStorageScope({ type: 'workspace', workspaceId: WS });
    vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
  });
  afterEach(() => vi.restoreAllMocks());

  const row = (patch: Record<string, unknown> = {}) => ({
    id: 'm-1', workspace_id: WS, client_message_id: 'em-1', direction: 'outbound', provider: 'brevo', status: 'queued', to_recipients: ['a@b.invalid'],
    cc_recipients: [], bcc_recipients: [], subject: 'Re: x', body_text: 'y', sender_name: 'B', reply_to_email: 'r@b.invalid', created_at: 'x', attempt_number: 1, row_version: 1, attachments: [],
    thread_id: 't-1', reply_to_message_id: 'in-1', rfc_message_id: null, in_reply_to: 'a1@mail.invalid', references_ids: ['a1@mail.invalid'], reply_to_addresses: [],
    ...patch,
  });

  it('Verlaufsfelder werden gelesen; „auto_thread" ist eine bekannte Zuordnungsquelle', () => {
    expect(parseEmailMessageRow(row())).toMatchObject({ threadId: 't-1', replyToMessageId: 'in-1', inReplyTo: 'a1@mail.invalid', references: ['a1@mail.invalid'], replyToAddresses: [] });
    expect(parseEmailMessageRow(row({ direction: 'inbound', provider: 'microsoft_graph', status: 'received', assignment_status: 'assigned', assignment_source: 'auto_thread', reply_to_addresses: ['s@x.invalid'] }))).toMatchObject({ assignmentSource: 'auto_thread', replyToAddresses: ['s@x.invalid'] });
    expect(classifyEmailRpcError({ message: 'Beantwortete Nachricht nicht gefunden' })).toBe('reply_parent_missing');
  });

  it('Anlegen: p_reply_to_message_id nur bei Antworten; Verlauf über get_workspace_email_thread', async () => {
    const rpc = vi.fn(async () => ({ data: { outcome: 'created', message: row() }, error: null }));
    const client = { rpc } as never;
    const base = { workspaceId: WS, clientMessageId: 'em-1', to: ['a@b.invalid'], cc: [], bcc: [], subject: 'S', bodyText: 'T', attachments: [], provider: 'stub' as const };
    await rpcCreateEmailMessage(base, client);
    expect(Object.keys((rpc.mock.calls[0] as unknown[])[1] as object)).not.toContain('p_reply_to_message_id');
    await rpcCreateEmailMessage({ ...base, replyToMessageId: 'in-1' }, client);
    expect((rpc.mock.calls[1] as unknown[])[1]).toMatchObject({ p_reply_to_message_id: 'in-1' });
    rpc.mockResolvedValueOnce({ data: [row()], error: null } as never);
    const thread = await rpcGetEmailThread({ workspaceId: WS, messageId: 'in-1' }, client);
    expect(rpc).toHaveBeenLastCalledWith('get_workspace_email_thread', { p_workspace_id: WS, p_message_id: 'in-1' });
    expect(thread).toMatchObject({ ok: true, messages: [{ id: 'm-1', threadId: 't-1' }] });
  });

  it('Antwort-Entwurf hat eigenen Schlüssel je Original; freie E-Mail und andere Antworten bleiben unberührt', () => {
    const free = createFreeEmailDraft({ subject: 'Frei' });
    const reply = createFreeEmailDraft({ subject: 'Re: A', replyToMessageId: 'in-1' });
    const scope = free.scopeKey;
    expect(freeEmailDraftStorageKey(scope, 'in-1')).not.toBe(freeEmailDraftStorageKey(scope));
    expect(loadFreeEmailDraft()?.subject).toBe('Frei');
    expect(loadFreeEmailDraft(undefined, 'in-1')?.clientMessageId).toBe(reply.clientMessageId);
    expect(loadFreeEmailDraft(undefined, 'in-2')).toBeNull();
    clearFreeEmailDraft(undefined, 'in-1');
    expect(loadFreeEmailDraft(undefined, 'in-1')).toBeNull();
    expect(loadFreeEmailDraft()?.subject).toBe('Frei');
  });

  it('Senden einer Antwort: gleiche Kette wie 07D (anlegen → send-email → Status), Antwortbezug an den Server, Entwurf danach gelöscht', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const created = row({ status: 'queued' });
    const accepted = row({ status: 'provider_accepted', provider_message_id: '<brevo-1@relay.invalid>', provider_accepted_at: '2026-09-28T09:00:00Z', row_version: 3 });
    const rpc = vi.fn(async (name: string) => {
      if (name === 'create_workspace_email_message') return { data: { outcome: 'created', message: created }, error: null };
      if (name === 'get_workspace_email_message_chain') return { data: [accepted], error: null };
      return { data: null, error: { message: 'unerwartet' } };
    });
    const invokeSend = vi.fn(async () => ({ status: 200, body: { ok: true, action: 'sent' as const } }));
    const draft = createFreeEmailDraft({ to: 'saban_irmak@icloud.com', subject: 'Re: OfficeTakt 07E Testmail', bodyText: 'Danke', replyToMessageId: 'in-1' });
    const result = await sendFreeEmail(draft, { client: { rpc } as never, invokeSend, isOnline: () => true });
    expect(result).toMatchObject({ ok: true, action: 'sent' });
    expect(rpc.mock.calls[0]).toEqual(['create_workspace_email_message', expect.objectContaining({ p_reply_to_message_id: 'in-1', p_to: ['saban_irmak@icloud.com'] })]);
    expect(invokeSend).toHaveBeenCalledTimes(1);
    expect(loadFreeEmailDraft(undefined, 'in-1')).toBeNull();
  });
});
