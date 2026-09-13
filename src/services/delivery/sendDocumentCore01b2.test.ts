/**
 * EMAIL-01B2 — Kern der Versandkette mit injizierten Abhängigkeiten:
 * Berechtigung, Zustand (queued/replay/unknown/failed), Anhang-Integrität,
 * Absender-Wahrheit aus dem Snapshot, Provider-Ergebnis → autoritative
 * Statusübernahme, Korrekturbeleg. Kein Netz, kein Supabase.
 */
import { describe, expect, it, vi } from 'vitest';
import { createStubEmailProvider } from '../../../supabase/functions/_shared/emailProvider';
import {
  OFFICEPILOT_SENDER_EMAIL,
  resolveSenderIdentity,
  runSendDocument,
  type DeliveryRow,
  type InvoiceContext,
  type SendDocumentDeps,
} from '../../../supabase/functions/_shared/sendDocumentCore';

const WS = '00000000-0000-4000-8000-00000000e1b2';
const PDF = new TextEncoder().encode('%PDF-1.4 test-document');

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function delivery(overrides: Partial<DeliveryRow> = {}): Promise<DeliveryRow> {
  const sha = await sha256Hex(PDF);
  return {
    id: 'd-1',
    workspace_id: WS,
    client_delivery_id: 'cd-1',
    document_kind: 'invoice',
    linked_invoice_id: 'inv-1',
    recipient_email: 'kunde@example.invalid',
    subject: 'Rechnung 2026-0001',
    body_text: 'Anbei.',
    attachment_storage_path: `${WS}/invoice-inv-1/${sha}.pdf`,
    attachment_sha256: sha,
    attachment_size_bytes: PDF.byteLength,
    attachment_filename: 'Rechnung_2026-0001.pdf',
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

function invoice(overrides: Partial<InvoiceContext> = {}): InvoiceContext {
  return {
    client_invoice_id: 'inv-1',
    invoice_number: '2026-0001',
    invoice_status: 'vorbereitet',
    cancelled_at: null,
    cancellation_kind: null,
    correction_document_id: null,
    sent_source: null,
    sent_delivery_id: null,
    company_snapshot: { companyName: 'Betrieb', legalForm: 'GmbH', email: 'Info@Betrieb.invalid' },
    ...overrides,
  };
}

function deps(row: DeliveryRow, inv: InvoiceContext | null, options: { canWrite?: boolean; bytes?: Uint8Array | null; provider?: SendDocumentDeps['provider'] } = {}) {
  const calls = { accepted: [] as unknown[], status: [] as unknown[], sent: [] as unknown[], logs: [] as unknown[] };
  const provider = options.provider ?? createStubEmailProvider();
  const wrapped: SendDocumentDeps['provider'] = {
    provider: provider.provider,
    async sendTransactionalEmail(input) {
      calls.sent.push(input);
      return provider.sendTransactionalEmail(input);
    },
  };
  const d: SendDocumentDeps = {
    userCanWrite: vi.fn(async () => options.canWrite ?? true),
    loadDelivery: vi.fn(async (ws, id) => (ws === row.workspace_id && id === row.client_delivery_id ? { delivery: row, invoice: inv } : null)),
    downloadAttachment: vi.fn(async () => (options.bytes === undefined ? PDF : options.bytes)),
    sha256Hex,
    provider: wrapped,
    markAccepted: vi.fn(async (id, messageId, rv) => {
      calls.accepted.push({ id, messageId, rv });
      return { delivery: { ...row, status: 'provider_accepted', provider_message_id: messageId, row_version: rv + 1 }, coupling: row.document_kind === 'invoice' ? 'linked' : 'none' };
    }),
    markStatus: vi.fn(async (id, status, error, rv) => {
      calls.status.push({ id, status, error, rv });
      return { ...row, status, error_category: error.category, error_code: error.code, error_message_safe: error.message, row_version: rv + 1 };
    }),
    log: (entry) => calls.logs.push(entry),
  };
  return { d, calls };
}

describe('EMAIL-01B2 — Send-Kern', () => {
  it('K1: queued → Provider → provider_accepted mit Kopplung; From/Reply-To aus dem Snapshot; Log ohne Empfänger/Key', async () => {
    const row = await delivery();
    const { d, calls } = deps(row, invoice());
    const outcome = await runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: 'cd-1' }, d);
    expect(outcome).toMatchObject({ ok: true, action: 'sent', coupling: 'linked', delivery: { status: 'provider_accepted', rowVersion: 2 } });
    expect(calls.sent).toHaveLength(1);
    const sent = calls.sent[0] as { from: { email: string; name: string }; replyTo: { email: string }; to: { email: string }; attachment: { filename: string; contentBase64: string }; idempotencyKey: string };
    expect(sent.from).toEqual({ email: OFFICEPILOT_SENDER_EMAIL, name: 'Betrieb GmbH' });
    expect(sent.replyTo.email).toBe('info@betrieb.invalid');
    expect(sent.to.email).toBe('kunde@example.invalid');
    expect(sent.attachment.filename).toBe('Rechnung_2026-0001.pdf');
    expect(atob(sent.attachment.contentBase64)).toBe('%PDF-1.4 test-document');
    expect(sent.idempotencyKey).toBe(`${WS}:cd-1`);
    expect(calls.accepted).toEqual([{ id: 'd-1', messageId: expect.stringMatching(/^stub-/), rv: 1 }]);
    expect(calls.status).toHaveLength(0);
    expect(JSON.stringify(calls.logs)).not.toContain('kunde@example.invalid');
  });

  it('K2: fehlendes Schreibrecht, unbekannte Delivery, Fremdworkspace, Provider-Mismatch — kein Provider-Aufruf', async () => {
    const row = await delivery();
    const noWrite = deps(row, invoice(), { canWrite: false });
    expect(await runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: 'cd-1' }, noWrite.d)).toEqual({ ok: false, error: 'forbidden' });
    expect(await runSendDocument({ userId: null, workspaceId: WS, clientDeliveryId: 'cd-1' }, noWrite.d)).toEqual({ ok: false, error: 'unauthenticated' });
    const ok = deps(row, invoice());
    expect(await runSendDocument({ userId: 'u-1', workspaceId: 'other-ws', clientDeliveryId: 'cd-1' }, ok.d)).toEqual({ ok: false, error: 'delivery_not_found' });
    const mismatch = deps(await delivery({ provider: 'brevo' }), invoice());
    expect(await runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: 'cd-1' }, mismatch.d)).toEqual({ ok: false, error: 'provider_mismatch' });
    expect(noWrite.calls.sent).toHaveLength(0);
    expect(ok.calls.sent).toHaveLength(0);
    expect(mismatch.calls.sent).toHaveLength(0);
  });

  it('K3: Replay bei provider_accepted — keine zweite Mail, Kopplung idempotent bestätigt; unknown bleibt unknown ohne Neuversand; failed bleibt failed', async () => {
    const accepted = deps(await delivery({ status: 'provider_accepted', provider_message_id: 'stub-1', row_version: 2 }), invoice({ invoice_status: 'versendet', sent_source: 'officepilot', sent_delivery_id: 'd-1' }));
    const replay = await runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: 'cd-1' }, accepted.d);
    expect(replay).toMatchObject({ ok: true, action: 'replayed', coupling: 'linked' });
    expect(accepted.calls.sent).toHaveLength(0);
    expect(accepted.calls.accepted).toEqual([{ id: 'd-1', messageId: 'stub-1', rv: 2 }]);

    const unknown = deps(await delivery({ status: 'unknown', row_version: 2, error_category: 'network' }), invoice());
    expect(await runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: 'cd-1' }, unknown.d)).toMatchObject({ ok: true, action: 'unknown_pending', delivery: { status: 'unknown' } });
    expect(unknown.calls.sent).toHaveLength(0);
    expect(unknown.calls.status).toHaveLength(0);

    const failed = deps(await delivery({ status: 'failed', row_version: 2, error_category: 'recipient' }), invoice());
    expect(await runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: 'cd-1' }, failed.d)).toMatchObject({ ok: true, action: 'failed' });
    expect(failed.calls.sent).toHaveLength(0);
  });

  it('K4: Provider-Fehler — recipient/provider/auth → failed; timeout → unknown (kein failed, kein Neuversand)', async () => {
    for (const [email, category, status] of [['x@bounce.invalid', 'recipient', 'failed'], ['x@provider.invalid', 'provider', 'failed'], ['x@auth.invalid', 'auth', 'failed'], ['x@timeout.invalid', 'network', 'unknown']] as const) {
      const { d, calls } = deps(await delivery({ recipient_email: email }), invoice());
      const outcome = await runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: 'cd-1' }, d);
      expect(outcome, email).toMatchObject({ ok: true, action: status === 'unknown' ? 'unknown_pending' : 'failed', delivery: { status, errorCategory: category } });
      expect(calls.status[0], email).toMatchObject({ status, error: { category } });
      expect(calls.accepted).toHaveLength(0);
    }
  });

  it('K5: Anhang-Integrität — fehlt, Größe, Hash, Pfad, kein PDF → failed/attachment ohne Provider-Aufruf', async () => {
    const base = await delivery();
    const cases: [string, DeliveryRow, Uint8Array | null | undefined][] = [
      ['attachment_missing', base, null],
      ['attachment_size_mismatch', { ...base, attachment_size_bytes: base.attachment_size_bytes! + 1 }, undefined],
      ['attachment_sha256_mismatch', base, new TextEncoder().encode('%PDF-1.4 test-dOcument')],
      ['attachment_path_hash_mismatch', { ...base, attachment_storage_path: `${WS}/invoice-inv-1/${'f'.repeat(64)}.pdf` }, undefined],
      ['attachment_metadata_invalid', { ...base, attachment_storage_path: `other/invoice-inv-1/${base.attachment_sha256}.pdf` }, undefined],
      ['attachment_not_pdf', { ...base, attachment_size_bytes: 9, attachment_sha256: await sha256Hex(new TextEncoder().encode('<html></h')), attachment_storage_path: `${WS}/invoice-inv-1/${await sha256Hex(new TextEncoder().encode('<html></h'))}.pdf` }, new TextEncoder().encode('<html></h')],
    ];
    for (const [code, row, bytes] of cases) {
      const { d, calls } = deps(row, invoice(), { bytes });
      const outcome = await runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: 'cd-1' }, d);
      expect(outcome, code).toMatchObject({ ok: true, action: 'failed', delivery: { status: 'failed', errorCategory: 'attachment', errorCode: code } });
      expect(calls.sent, code).toHaveLength(0);
    }
  });

  it('K6: Absender-Wahrheit — Snapshot ohne E-Mail oder ohne Firma → fail-closed, kein Versand; nie aus aktuellem Profil', async () => {
    expect(resolveSenderIdentity(invoice())).toEqual({ ok: true, fromName: 'Betrieb GmbH', replyTo: 'info@betrieb.invalid' });
    expect(resolveSenderIdentity(invoice({ company_snapshot: { companyName: 'Betrieb', email: '' } }))).toEqual({ ok: false, code: 'sender_reply_to_missing' });
    expect(resolveSenderIdentity(invoice({ company_snapshot: null }))).toEqual({ ok: false, code: 'sender_snapshot_missing' });
    expect(resolveSenderIdentity(null)).toEqual({ ok: false, code: 'sender_snapshot_missing' });
    const { d, calls } = deps(await delivery(), invoice({ company_snapshot: { companyName: 'Betrieb', email: 'kein-mail' } }));
    expect(await runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: 'cd-1' }, d)).toMatchObject({ ok: true, action: 'failed', delivery: { errorCode: 'sender_reply_to_missing' } });
    expect(calls.sent).toHaveLength(0);
  });

  it('K7: Rechnungskontext — storniert/Entwurf/fehlend → failed; Korrekturbeleg nur mit Korrektur, Kopplung nicht für das Original', async () => {
    const cancelled = deps(await delivery(), invoice({ cancelled_at: '2026-09-14T00:00:00Z', cancellation_kind: 'internal' }));
    expect(await runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: 'cd-1' }, cancelled.d)).toMatchObject({ ok: true, action: 'failed', delivery: { errorCode: 'invoice_cancelled' } });
    const draft = deps(await delivery(), invoice({ invoice_status: 'entwurf' }));
    expect(await runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: 'cd-1' }, draft.d)).toMatchObject({ ok: true, action: 'failed', delivery: { errorCode: 'invoice_not_finalized' } });
    const missing = deps(await delivery(), null);
    expect(await runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: 'cd-1' }, missing.d)).toMatchObject({ ok: true, action: 'failed', delivery: { errorCode: 'invoice_missing' } });

    const noCorrection = deps(await delivery({ document_kind: 'invoice_correction' }), invoice({ invoice_status: 'versendet', cancelled_at: '2026-09-14T00:00:00Z', cancellation_kind: 'internal' }));
    expect(await runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: 'cd-1' }, noCorrection.d)).toMatchObject({ ok: true, action: 'failed', delivery: { errorCode: 'correction_missing' } });
    const correction = deps(await delivery({ document_kind: 'invoice_correction' }), invoice({ invoice_status: 'versendet', cancelled_at: '2026-09-14T00:00:00Z', cancellation_kind: 'correction', correction_document_id: 'corr-1' }));
    const sent = await runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: 'cd-1' }, correction.d);
    expect(sent).toMatchObject({ ok: true, action: 'sent', coupling: 'none' });
    expect(correction.calls.sent).toHaveLength(1);
  });
});
