/**
 * BREVO-LIVE-CONFIG-01 — konfigurierbare, authentifizierte Absenderadresse.
 *
 *  1  MAIL_SENDER_EMAIL gueltig -> erreicht den Provider als sender.email
 *  2  fehlt -> server_misconfigured (Function), kein Provider-Aufruf
 *  3  ungueltig -> server_misconfigured, kein Provider-Aufruf
 *  4  keine send.officepilot.de-Adresse mehr im produktiven Versandpfad
 *  5  Anzeigename/Antwortadresse: Dokumentversand folgt den Kommunikations-
 *     Einstellungen (mit Validierung/Fallback); Rechnung bleibt beim Snapshot
 *  8  Fehlerantwort an den Client bleibt die sichere Kategorie, nie der Wert
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBrevoEmailProvider, createStubEmailProvider } from '../../../supabase/functions/_shared/emailProvider';
import {
  resolveCompanySenderIdentity,
  resolveConfiguredSenderEmail,
  runSendDocument,
  type DeliveryRow,
  type InvoiceContext,
  type SendDocumentDeps,
} from '../../../supabase/functions/_shared/sendDocumentCore';

const WS = '00000000-0000-4000-8000-00000000c0f1';
const PDF = new TextEncoder().encode('%PDF-1.4 config');
const SENDER = 'rechnung@send.officetakt.de';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function invoiceDelivery(): Promise<DeliveryRow> {
  const sha = await sha256Hex(PDF);
  return {
    id: 'd-1', workspace_id: WS, client_delivery_id: 'cd-1', document_kind: 'invoice', linked_invoice_id: 'inv-1', linked_document_id: null,
    recipient_email: 'kunde@example.invalid', subject: 'Rechnung 1', body_text: 'Anbei.',
    attachment_storage_path: `${WS}/invoice-inv-1/${sha}.pdf`, attachment_sha256: sha, attachment_size_bytes: PDF.byteLength,
    attachment_filename: 'Rechnung_1.pdf', attachment_mime_type: 'application/pdf', provider: 'stub', provider_message_id: null,
    status: 'queued', row_version: 1, error_category: null, error_code: null, error_message_safe: null,
  };
}
const invoice: InvoiceContext = { client_invoice_id: 'inv-1', invoice_number: '1', invoice_status: 'vorbereitet', cancelled_at: null, cancellation_kind: null, correction_document_id: null, sent_source: null, sent_delivery_id: null, company_snapshot: { companyName: 'Betrieb', legalForm: 'GmbH', email: 'info@betrieb.invalid' } };

function deps(row: DeliveryRow, senderEmail: string) {
  const sent: unknown[] = [];
  const stub = createStubEmailProvider();
  const d: SendDocumentDeps = {
    senderEmail,
    userCanWrite: async () => true,
    loadDelivery: async () => ({ delivery: row, invoice }),
    downloadAttachment: async () => PDF,
    sha256Hex,
    provider: { provider: 'stub', async sendTransactionalEmail(input) { sent.push(input); return stub.sendTransactionalEmail(input); } },
    markAccepted: async (id, messageId, rv) => ({ delivery: { ...row, status: 'provider_accepted', provider_message_id: messageId, row_version: rv + 1 }, coupling: 'linked' }),
    markStatus: async (id, status, error, rv) => ({ ...row, status, error_category: error.category, error_code: error.code, error_message_safe: error.message, row_version: rv + 1 }),
    log: () => {},
  };
  return { d, sent };
}

describe('BREVO-LIVE-CONFIG-01 — MAIL_SENDER_EMAIL', () => {
  it('1: konfigurierte Adresse erreicht den Kern und den Brevo-Request als sender.email', async () => {
    const row = await invoiceDelivery();
    const { d, sent } = deps(row, SENDER);
    expect(await runSendDocument({ userId: 'u', workspaceId: WS, clientDeliveryId: 'cd-1' }, d)).toMatchObject({ ok: true, action: 'sent' });
    expect((sent[0] as { from: { email: string } }).from.email).toBe(SENDER);

    // Brevo-Adapter: derselbe Wert landet unverändert im Request-Body.
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ messageId: '<m@brevo>' }), { status: 201 }); });
    const brevo = createBrevoEmailProvider({ apiKey: 'test-key-not-real', fetchImpl: fetchImpl as unknown as typeof fetch });
    await brevo.sendTransactionalEmail({ from: { email: SENDER, name: 'Betrieb GmbH' }, to: { email: 'kunde@example.invalid' }, subject: 'S', text: 'T' });
    expect(body.sender).toEqual({ email: SENDER, name: 'Betrieb GmbH' });
  });

  it('2/3: fehlend oder ungueltig -> null (Function antwortet server_misconfigured, ohne Provider); gueltig wird normalisiert', () => {
    expect(resolveConfiguredSenderEmail(undefined)).toBeNull();
    expect(resolveConfiguredSenderEmail('')).toBeNull();
    expect(resolveConfiguredSenderEmail('   ')).toBeNull();
    expect(resolveConfiguredSenderEmail('rechnung@send')).toBeNull();
    expect(resolveConfiguredSenderEmail('kein-at.de')).toBeNull();
    expect(resolveConfiguredSenderEmail('a b@send.officetakt.de')).toBeNull();
    expect(resolveConfiguredSenderEmail(' Rechnung@Send.Officetakt.de ')).toBe('rechnung@send.officetakt.de');

    // Function: der Guard sitzt vor Auth, DB und Provider.
    const fn = readFileSync(resolve(process.cwd(), 'supabase/functions/send-document/index.ts'), 'utf8');
    const guard = fn.indexOf("resolveConfiguredSenderEmail(Deno.env.get('MAIL_SENDER_EMAIL'))");
    expect(guard).toBeGreaterThan(0);
    expect(fn.indexOf("!senderEmail) {")).toBeGreaterThan(guard);
    expect(fn.indexOf("return fail('server_misconfigured');")).toBeLessThan(fn.indexOf('createMailProvider('));
    expect(fn.indexOf("return fail('server_misconfigured');")).toBeLessThan(fn.indexOf('auth.getUser'));
    expect(fn).toContain("senderConfigured: Boolean(senderEmail)");
    // In log()-Aufrufen kommt senderEmail nur als Boolean(...) vor, nie als Wert.
    const logCalls = fn.match(/log\(\{[^}]*\}\)/g) ?? [];
    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) expect(call.replace(/Boolean\(senderEmail\)/g, '')).not.toContain('senderEmail');
  });

  it('4: keine send.officepilot.de-Adresse und kein Default mehr im produktiven Versandpfad', () => {
    for (const file of ['supabase/functions/_shared/sendDocumentCore.ts', 'supabase/functions/_shared/emailProvider.ts', 'supabase/functions/send-document/index.ts']) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source, file).not.toContain('officepilot.de');
      expect(source, file).not.toContain('OFFICEPILOT_SENDER_EMAIL');
    }
  });

  it('5: Dokumentversand folgt Anzeigename/Antwortadresse mit Fallback und Validierung; Rechnung bleibt beim Snapshot', async () => {
    expect(resolveCompanySenderIdentity({ companyName: 'Betrieb', legalForm: 'GmbH', email: 'info@betrieb.invalid', senderDisplayName: 'Meister Müller', replyToEmail: 'Antwort@Betrieb.invalid' }))
      .toEqual({ ok: true, fromName: 'Meister Müller', replyTo: 'antwort@betrieb.invalid' });
    expect(resolveCompanySenderIdentity({ companyName: 'Betrieb', legalForm: 'GmbH', email: 'info@betrieb.invalid', senderDisplayName: '  ', replyToEmail: 'kaputt' }))
      .toEqual({ ok: true, fromName: 'Betrieb GmbH', replyTo: 'info@betrieb.invalid' });
    expect(resolveCompanySenderIdentity({ companyName: 'Betrieb', email: '', replyToEmail: 'ungueltig' })).toEqual({ ok: false, code: 'sender_reply_to_missing' });

    const row = await invoiceDelivery();
    const { d, sent } = deps(row, SENDER);
    await runSendDocument({ userId: 'u', workspaceId: WS, clientDeliveryId: 'cd-1' }, d);
    const mail = sent[0] as { from: { name: string }; replyTo: { email: string } };
    expect(mail.from.name).toBe('Betrieb GmbH');
    expect(mail.replyTo.email).toBe('info@betrieb.invalid');
  });
});
