/**
 * E-MAIL 07F-01B — Provider-Zustellereignisse: Brevo-Webhook-Kern
 * (Normalisierung, Tracking verworfen, Dedupe-Schlüssel, Bearer-Prüfung,
 * gebündelte Payloads, Grenzen), Client-Vertrag (Parser, Anzeige-Regel) und
 * statische Zusicherungen (Function, Konfiguration, Migration). Kein Netz,
 * kein Versand.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_WEBHOOK_MAX_EVENTS,
  brevoEventState,
  constantTimeEqual,
  normalizeBrevoEventName,
  parseBrevoWebhookPayload,
  processBrevoWebhook,
  sanitizeProviderReason,
  verifyBearerToken,
  type NormalizedProviderEvent,
} from '../../../supabase/functions/_shared/providerEventCore';
import { parseEmailMessageRow, rpcListDeliveryEvents } from './emailMessageCloudService';
import { parseDocumentDeliveryRow } from '../delivery/documentDeliveryContract';
import { deliveryDisplayLabelKey, deliveryDisplayTone, displayDeliveryStatus } from '../delivery/providerDeliveryState';

const sha = async (text: string) => createHash('sha256').update(text).digest('hex');
const read = (file: string) => readFileSync(file, 'utf8');
const TS = 1_790_502_000; // 2026-09-27T…Z
const event = (patch: Record<string, unknown> = {}) => ({ event: 'delivered', email: 'saban_irmak@icloud.com', id: 12345, date: '2026-09-28 11:41:10', 'message-id': '<Brevo-1@smtp-relay.mailin.fr>', ts_event: TS, subject: 'Re: OfficeTakt 07E Testmail', ...patch });

describe('07F-01B — Brevo-Ereignisse normalisieren', () => {
  it('Zustellereignisse → accepted/delivered/deferred/bounced/rejected/complained', () => {
    const map = Object.fromEntries(['request', 'delivered', 'deferred', 'soft_bounce', 'hard_bounce', 'invalid_email', 'blocked', 'error', 'spam'].map((name) => [name, brevoEventState(name)]));
    expect(map).toEqual({ request: 'accepted', delivered: 'delivered', deferred: 'deferred', soft_bounce: 'deferred', hard_bounce: 'bounced', invalid_email: 'rejected', blocked: 'rejected', error: 'rejected', spam: 'complained' });
    expect(normalizeBrevoEventName('hardBounce')).toBe('hard_bounce');
    expect(normalizeBrevoEventName('softBounce')).toBe('soft_bounce');
    expect(normalizeBrevoEventName('Hard_Bounce')).toBe('hard_bounce');
  });

  it('Öffnen/Klicken/Abmelden sind KEIN Zustellstatus (nie „gelesen"); Unbekanntes wird verworfen', async () => {
    for (const name of ['opened', 'unique_opened', 'proxy_open', 'unique_proxy_open', 'click', 'unsubscribed']) expect(brevoEventState(name)).toBeNull();
    const parsed = await parseBrevoWebhookPayload([event({ event: 'opened' }), event({ event: 'click', link: 'https://x.invalid' }), event({ event: 'irgendwas' }), event()], sha);
    expect(parsed).toMatchObject({ ok: true, ignoredTracking: 2, ignoredUnknown: 1, ignoredInvalid: 0 });
    expect((parsed as { events: NormalizedProviderEvent[] }).events.map((e) => e.state)).toEqual(['delivered']);
  });

  it('Zeitpunkt aus ts_event (GMT), Message-ID unverändert weitergegeben, keine Adresse/kein Betreff im Ergebnis', async () => {
    const parsed = await parseBrevoWebhookPayload(event(), sha);
    const e = (parsed as { events: NormalizedProviderEvent[] }).events[0];
    expect(e).toMatchObject({ provider: 'brevo', providerMessageId: '<Brevo-1@smtp-relay.mailin.fr>', eventType: 'delivered', state: 'delivered', reason: null, eventAt: new Date(TS * 1000).toISOString() });
    expect(JSON.stringify(e)).not.toMatch(/saban_irmak|OfficeTakt 07E Testmail/);
  });

  it('Bounce-Grund: gekürzt, Adressen maskiert, Steuerzeichen entfernt', () => {
    expect(sanitizeProviderReason('550 5.1.1 <saban_irmak@icloud.com>: user unknown\r\n')).toBe('550 5.1.1 <<adresse>>: user unknown');
    expect(sanitizeProviderReason('x'.repeat(500))).toHaveLength(200);
    expect(sanitizeProviderReason(42)).toBeNull();
  });

  it('ungültige Einträge (ohne Message-ID/Zeit, keine Adresse als ID) werden gezählt und verworfen', async () => {
    const parsed = await parseBrevoWebhookPayload([event({ 'message-id': undefined }), event({ ts_event: undefined }), event({ 'message-id': 'ohne-at' }), 'kaputt', event()], sha);
    expect(parsed).toMatchObject({ ok: true, ignoredInvalid: 4 });
    expect((parsed as { events: unknown[] }).events).toHaveLength(1);
    expect(await parseBrevoWebhookPayload('text', sha)).toEqual({ ok: false, error: 'invalid_payload' });
    expect(await parseBrevoWebhookPayload(Array.from({ length: PROVIDER_WEBHOOK_MAX_EVENTS + 1 }, () => event()), sha)).toEqual({ ok: false, error: 'too_many_events' });
  });

  it('Dedupe-Schlüssel: gleicher Webhook = gleicher Schlüssel (auch mit <> / Großschreibung), anderes Ereignis/Zeitpunkt = anderer', async () => {
    const key = async (patch: Record<string, unknown>) => ((await parseBrevoWebhookPayload(event(patch), sha)) as { events: NormalizedProviderEvent[] }).events[0].dedupeKey;
    const a = await key({});
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await key({ 'message-id': 'brevo-1@SMTP-relay.mailin.fr', id: 999, date: 'anders' })).toBe(a);
    expect(await key({ event: 'hard_bounce' })).not.toBe(a);
    expect(await key({ ts_event: TS + 1 })).not.toBe(a);
  });
});

describe('07F-01B — Webhook-Authentisierung (Bearer, fail closed)', () => {
  const token = 't'.repeat(40);
  it('richtiges Token ok; falsches/fehlendes/anders formatiertes abgelehnt; ohne konfiguriertes Secret alles abgelehnt', () => {
    expect(verifyBearerToken(`Bearer ${token}`, token)).toBe('ok');
    expect(verifyBearerToken(`bearer   ${token}`, token)).toBe('ok');
    expect(verifyBearerToken(`Bearer ${token}x`, token)).toBe('unauthenticated');
    expect(verifyBearerToken(`Basic ${token}`, token)).toBe('unauthenticated');
    expect(verifyBearerToken(null, token)).toBe('unauthenticated');
    expect(verifyBearerToken(`Bearer ${token}`, undefined)).toBe('not_configured');
    expect(verifyBearerToken('Bearer kurz', 'kurz')).toBe('not_configured');
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('07F-01B — Verarbeitung (Datenbank entscheidet; Fehler einzelner Ereignisse stoppen die anderen nicht)', () => {
  it('gebündelte Ereignisse, Zähler je Ergebnis, keine Wiederholungsschleife', async () => {
    const outcomes = ['applied', 'duplicate', 'ignored_older', 'unmatched', 'ambiguous'] as const;
    let i = 0;
    const record = vi.fn(async () => {
      const outcome = outcomes[i % outcomes.length];
      i += 1;
      if (i === 6) throw new Error('db');
      return outcome;
    });
    const result = await processBrevoWebhook([...outcomes.map((_, n) => event({ ts_event: TS + n })), event({ ts_event: TS + 9 }), event({ event: 'opened' })], { record, sha256Hex: sha });
    expect(result).toEqual({ ok: true, summary: { received: 7, applied: 1, duplicates: 1, ignoredOlder: 1, unmatched: 1, ambiguous: 1, failed: 1, ignoredTracking: 1, ignoredUnknown: 0, ignoredInvalid: 0 } });
    expect(record).toHaveBeenCalledTimes(6);
  });
});

describe('07F-01B — Function, Konfiguration, Migration', () => {
  const fn = read('supabase/functions/email-provider-webhook/index.ts');
  const sql = read('supabase/migrations/20261018120000_workspace_email_provider_events.sql');

  it('Function: nur Brevo, Bearer-Prüfung vor jedem Datenzugriff, nur die Server-RPC, kein Versand/keine Nachricht', () => {
    expect(fn.indexOf("verifyBearerToken(request.headers.get('Authorization'), Deno.env.get('BREVO_WEBHOOK_TOKEN'))")).toBeGreaterThan(-1);
    expect(fn.indexOf('verifyBearerToken(')).toBeLessThan(fn.indexOf('createClient('));
    expect(fn).toContain("if (provider !== 'brevo') return json({ ok: false, error: 'unknown_provider' }, 404);");
    expect(fn).toMatch(/admin\.rpc\('record_email_provider_event'/);
    expect(fn.match(/admin\.rpc\(/g)).toHaveLength(1);
    expect(fn).not.toMatch(/send-email|sendTransactionalEmail|create_workspace_email_message|retry_|from\('workspace_/);
    expect(fn).not.toMatch(/log\(\{[^}]*(email|subject|token|reason|message)/i);
    const config = read('supabase/config.toml');
    expect(config).toMatch(/\[functions\.email-provider-webhook\]\nenabled = true\nverify_jwt = false\nentrypoint = "\.\/functions\/email-provider-webhook\/index\.ts"/);
  });

  it('Migration: getrennter Zustellstatus, Rang (out-of-order), Deduplizierung, Zuordnung nur per Message-ID, kein row_version/Thread-Eingriff', () => {
    expect(sql).toMatch(/add column if not exists delivery_state text null/);
    expect(sql).toMatch(/when 'accepted' then 1\s+when 'deferred' then 2\s+when 'delivered' then 3\s+when 'bounced' then 4\s+when 'rejected' then 4\s+when 'complained' then 5/);
    expect(sql).toContain('constraint workspace_email_provider_events_dedupe_unique unique (provider, dedupe_key)');
    expect(sql).toContain('on conflict (provider, dedupe_key) do nothing');
    const apply = sql.slice(sql.indexOf('create or replace function public.email_provider_apply_event'), sql.indexOf('-- Webhook-Einstieg')).replace(/--[^\n]*/g, '');
    expect(apply).not.toMatch(/subject|to_recipients|recipient_email|created_at|customer_id/);
    expect(apply).toContain('m.rfc_message_id = v_event.provider_message_id');
    expect(apply).not.toMatch(/row_version|thread_id|reply_to_message_id|set status|insert into public\.workspace_email_messages/);
    expect(sql).not.toMatch(/opened|click/);
    expect(sql).toContain("revoke all on function public.record_email_provider_event(text, text, text, text, text, text, timestamptz) from public, anon, authenticated;");
  });

  it('bestehende Versand-Wege unverändert (kein neuer Providerpfad, keine Tracking-Parameter)', () => {
    for (const file of ['supabase/functions/send-email/index.ts', 'supabase/functions/_shared/sendEmailCore.ts', 'supabase/functions/_shared/emailProvider.ts', 'supabase/functions/send-document/index.ts']) {
      expect(read(file)).not.toMatch(/07F-01B|delivery_state|webhook/i);
    }
  });
});

describe('07F-01B — Client-Vertrag und Anzeige-Regel', () => {
  it('Parser lesen den Zustellstatus (nur gültige Werte, nie bei eingehender Mail)', () => {
    const base = { id: 'm', workspace_id: 'w', client_message_id: 'c', direction: 'outbound', provider: 'brevo', status: 'provider_accepted', to_recipients: ['a@b.invalid'], cc_recipients: [], bcc_recipients: [], subject: 's', body_text: 'b', created_at: 'x', attachments: [] };
    expect(parseEmailMessageRow({ ...base, delivery_state: 'delivered', delivery_state_at: '2026-09-28T09:41:10Z' })).toMatchObject({ deliveryState: 'delivered', deliveryStateAt: '2026-09-28T09:41:10Z' });
    expect(parseEmailMessageRow({ ...base, delivery_state: 'opened' })?.deliveryState).toBeUndefined();
    expect(parseEmailMessageRow({ ...base, direction: 'inbound', provider: 'microsoft_graph', status: 'received', delivery_state: 'delivered' })?.deliveryState).toBeUndefined();
    const delivery = parseDocumentDeliveryRow({ id: 'd', workspace_id: 'w', client_delivery_id: 'c', document_kind: 'other', recipient_email: 'a@b.invalid', subject: 's', body_text: 'b', provider: 'brevo', status: 'provider_accepted', requested_by: 'u', requested_at: 'x', created_at: 'x', updated_at: 'x', row_version: 1, attempt_number: 1, delivery_state: 'bounced' });
    expect(delivery?.deliveryState).toBe('bounced');
  });

  it('Anzeige: nur übergebene Nachrichten übernehmen den Zustellstatus; „accepted" bleibt „übergeben"; nie „gelesen"', () => {
    expect(displayDeliveryStatus('provider_accepted', undefined)).toBe('provider_accepted');
    expect(displayDeliveryStatus('provider_accepted', 'accepted')).toBe('provider_accepted');
    expect(displayDeliveryStatus('provider_accepted', 'delivered')).toBe('delivered');
    expect(displayDeliveryStatus('provider_accepted', 'deferred')).toBe('deferred');
    expect(displayDeliveryStatus('failed', 'delivered')).toBe('failed');
    expect(displayDeliveryStatus('unknown', 'delivered')).toBe('unknown');
    expect(deliveryDisplayLabelKey('deferred')).toBe('delivery.status.deferred');
    expect([deliveryDisplayTone('delivered'), deliveryDisplayTone('deferred'), deliveryDisplayTone('bounced'), deliveryDisplayTone('rejected'), deliveryDisplayTone('complained')]).toEqual(['success', 'warning', 'critical', 'critical', 'critical']);
    const de = read('src/i18n/locales/de/delivery.ts');
    const states = de.slice(de.indexOf('/* E-MAIL 07F-01B'));
    expect(states).not.toMatch(/'[^']*': '[^']*\b(gelesen|geöffnet)\b[^']*(?<!nicht, dass die E-Mail gelesen wurde\.|Öffnen oder Lesen wird nicht erfasst\.)',/);
    expect(de).toContain("'delivery.state.hint.delivered': 'Vom Empfängerserver angenommen – das heißt nicht, dass die E-Mail gelesen wurde.'");
  });

  it('Zustellverlauf: eine Anfrage, nur Zustand + Zeitpunkt', async () => {
    const rpc = vi.fn(async () => ({ data: [{ state: 'accepted', event_at: '2026-09-28T09:41:08Z', applied: true }, { state: 'delivered', event_at: '2026-09-28T09:41:10Z', applied: true }, { state: 'opened', event_at: 'x', applied: true }], error: null }));
    const result = await rpcListDeliveryEvents({ workspaceId: 'w', emailMessageId: 'm' }, { rpc } as never);
    expect(rpc).toHaveBeenCalledWith('list_workspace_email_delivery_events', { p_workspace_id: 'w', p_email_message_id: 'm', p_document_delivery_id: null });
    expect(result).toEqual({ ok: true, events: [{ state: 'accepted', at: '2026-09-28T09:41:08Z', applied: true }, { state: 'delivered', at: '2026-09-28T09:41:10Z', applied: true }] });
  });
});
