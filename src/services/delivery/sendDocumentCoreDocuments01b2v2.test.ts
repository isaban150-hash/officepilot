/**
 * V1-B2 — Send-Kern fuer normale Dokumente (letter/offer/other).
 *
 *  D1  other: queued → Provider → provider_accepted; Absender aus dem Firmenprofil;
 *      keine Rechnungskopplung (coupling 'none' / markAccepted ohne Invoice)
 *  D2  Dokument fehlt / geloescht → failed, kein Provider-Aufruf
 *  D3  Anhang nicht an das Dokument gebunden → failed/attachment, kein Provider-Aufruf
 *  D4  Firmenprofil ohne E-Mail oder Name → fail-closed, kein Provider-Aufruf
 *  D5  Rechnung (invoice) weiterhin ueber den Snapshot — Firmenprofil spielt keine Rolle
 */
import { describe, expect, it, vi } from 'vitest';
import { createStubEmailProvider } from '../../../supabase/functions/_shared/emailProvider';
import {
  OFFICEPILOT_SENDER_EMAIL,
  resolveCompanySenderIdentity,
  runSendDocument,
  type CompanyContext,
  type DeliveryRow,
  type DocumentContext,
  type InvoiceContext,
  type LoadedDelivery,
  type SendDocumentDeps,
} from '../../../supabase/functions/_shared/sendDocumentCore';

const WS = '00000000-0000-4000-8000-00000000b2b2';
const PDF = new TextEncoder().encode('%PDF-1.4 archived-document');

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function documentDelivery(kind: 'letter' | 'offer' | 'other' = 'other', overrides: Partial<DeliveryRow> = {}): Promise<DeliveryRow> {
  const sha = await sha256Hex(PDF);
  return {
    id: 'd-doc-1',
    workspace_id: WS,
    client_delivery_id: 'cd-doc-1',
    document_kind: kind,
    linked_invoice_id: null,
    linked_document_id: 'doc-1',
    recipient_email: 'kunde@example.invalid',
    subject: 'Ihr Dokument',
    body_text: 'Anbei.',
    attachment_storage_path: `${WS}/${kind}-doc-1/${sha}.pdf`,
    attachment_sha256: sha,
    attachment_size_bytes: PDF.byteLength,
    attachment_filename: 'Dokument.pdf',
    attachment_mime_type: 'application/pdf',
    provider: 'stub',
    provider_message_id: null,
    status: 'queued',
    row_version: 1,
    error_category: null,
    error_code: null,
    error_message_safe: null,
    ...overrides,
  };
}

const doc = (overrides: Partial<DocumentContext> = {}): DocumentContext => ({
  client_document_id: 'doc-1', deleted: false, classified_kind: 'zertifikat', title: 'Zertifikat', attachment_bound: true, ...overrides,
});
const company = (overrides: Partial<CompanyContext> = {}): CompanyContext => ({ companyName: 'Betrieb', legalForm: 'GmbH', email: 'Info@Betrieb.invalid', ...overrides });

function deps(loaded: LoadedDelivery, options: { bytes?: Uint8Array | null } = {}) {
  const calls = { accepted: [] as unknown[], status: [] as unknown[], sent: [] as unknown[] };
  const stub = createStubEmailProvider();
  const d: SendDocumentDeps = {
    userCanWrite: vi.fn(async () => true),
    loadDelivery: vi.fn(async (ws, id) => (ws === loaded.delivery.workspace_id && id === loaded.delivery.client_delivery_id ? loaded : null)),
    downloadAttachment: vi.fn(async () => (options.bytes === undefined ? PDF : options.bytes)),
    sha256Hex,
    provider: { provider: 'stub', async sendTransactionalEmail(input) { calls.sent.push(input); return stub.sendTransactionalEmail(input); } },
    markAccepted: vi.fn(async (id, messageId, rv) => {
      calls.accepted.push({ id, messageId, rv });
      return { delivery: { ...loaded.delivery, status: 'provider_accepted', provider_message_id: messageId, row_version: rv + 1 }, coupling: loaded.delivery.document_kind === 'invoice' ? 'linked' : 'none' };
    }),
    markStatus: vi.fn(async (id, status, error, rv) => {
      calls.status.push({ id, status, error, rv });
      return { ...loaded.delivery, status, error_category: error.category, error_code: error.code, error_message_safe: error.message, row_version: rv + 1 };
    }),
    log: () => {},
  };
  return { d, calls };
}

const run = (d: SendDocumentDeps, id = 'cd-doc-1') => runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: id }, d);

describe('V1-B2 — Send-Kern normale Dokumente', () => {
  it('D1: other/letter/offer → provider_accepted; From/Reply-To aus dem Firmenprofil; keine Rechnungskopplung', async () => {
    for (const kind of ['other', 'letter', 'offer'] as const) {
      const row = await documentDelivery(kind);
      const { d, calls } = deps({ delivery: row, invoice: null, document: doc(), company: company() });
      const outcome = await run(d);
      expect(outcome, kind).toMatchObject({ ok: true, action: 'sent', coupling: 'none', delivery: { status: 'provider_accepted' } });
      const sent = calls.sent[0] as { from: { email: string; name: string }; replyTo: { email: string }; attachment: { filename: string } };
      expect(sent.from).toEqual({ email: OFFICEPILOT_SENDER_EMAIL, name: 'Betrieb GmbH' });
      expect(sent.replyTo.email).toBe('info@betrieb.invalid');
      expect(sent.attachment.filename).toBe('Dokument.pdf');
      expect(calls.status).toHaveLength(0);
    }
  });

  it('D2: Dokument fehlt oder geloescht → failed, kein Provider-Aufruf', async () => {
    const row = await documentDelivery();
    for (const loaded of [
      { delivery: row, invoice: null, document: null, company: company() },
      { delivery: row, invoice: null, document: doc({ deleted: true }), company: company() },
      { delivery: { ...row, linked_document_id: null }, invoice: null, document: doc(), company: company() },
    ] as LoadedDelivery[]) {
      const { d, calls } = deps(loaded);
      const outcome = await run(d);
      expect(outcome).toMatchObject({ ok: true, action: 'failed', delivery: { status: 'failed', errorCode: 'document_missing' } });
      expect(calls.sent).toHaveLength(0);
      expect(calls.accepted).toHaveLength(0);
    }
  });

  it('D3: Anhang nicht an das Dokument gebunden → failed/attachment, kein Provider-Aufruf', async () => {
    const row = await documentDelivery();
    const { d, calls } = deps({ delivery: row, invoice: null, document: doc({ attachment_bound: false }), company: company() });
    expect(await run(d)).toMatchObject({ ok: true, action: 'failed', delivery: { status: 'failed', errorCategory: 'attachment', errorCode: 'attachment_not_bound' } });
    expect(calls.sent).toHaveLength(0);
  });

  it('D4: Firmenprofil ohne E-Mail oder Name → fail-closed, keine erfundene Adresse', async () => {
    expect(resolveCompanySenderIdentity(null)).toEqual({ ok: false, code: 'sender_company_missing' });
    expect(resolveCompanySenderIdentity({ companyName: '', email: 'a@b.de' })).toEqual({ ok: false, code: 'sender_company_missing' });
    expect(resolveCompanySenderIdentity({ companyName: 'Betrieb', email: '' })).toEqual({ ok: false, code: 'sender_reply_to_missing' });
    const row = await documentDelivery();
    const { d, calls } = deps({ delivery: row, invoice: null, document: doc(), company: company({ email: '' }) });
    expect(await run(d)).toMatchObject({ ok: true, action: 'failed', delivery: { status: 'failed', errorCode: 'sender_reply_to_missing' } });
    expect(calls.sent).toHaveLength(0);
  });

  it('D5: Rechnung nutzt weiterhin den Snapshot — ein abweichendes Firmenprofil aendert nichts', async () => {
    const sha = await sha256Hex(PDF);
    const row: DeliveryRow = { ...(await documentDelivery('other')), id: 'd-inv', client_delivery_id: 'cd-inv', document_kind: 'invoice', linked_invoice_id: 'inv-1', linked_document_id: null, attachment_storage_path: `${WS}/invoice-inv-1/${sha}.pdf` };
    const invoice: InvoiceContext = { client_invoice_id: 'inv-1', invoice_number: '1', invoice_status: 'vorbereitet', cancelled_at: null, cancellation_kind: null, correction_document_id: null, sent_source: null, sent_delivery_id: null, company_snapshot: { companyName: 'Alt', legalForm: 'e.K.', email: 'alt@betrieb.invalid' } };
    const { d, calls } = deps({ delivery: row, invoice, document: null, company: company({ companyName: 'Neu', email: 'neu@betrieb.invalid' }) });
    expect(await run(d, 'cd-inv')).toMatchObject({ ok: true, action: 'sent', coupling: 'linked' });
    const sent = calls.sent[0] as { from: { name: string }; replyTo: { email: string } };
    expect(sent.from.name).toBe('Alt e.K.');
    expect(sent.replyTo.email).toBe('alt@betrieb.invalid');
  });
});
