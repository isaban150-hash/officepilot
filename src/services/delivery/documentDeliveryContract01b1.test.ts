/**
 * EMAIL-01B1 — Delivery-Vertrag: Statusmaschine, fail-closed-Parser,
 * Idempotenz-Fingerprint, Anhangspfad, Stub-Provider. Kein Netz.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDeliveryAttachmentStoragePath,
  buildDeliveryIntentFingerprint,
  canTransitionDeliveryStatus,
  isDeliveryConsideredSent,
  isDeliveryRetryable,
  isValidRecipientEmail,
  parseDocumentDeliveryRow,
  sha256Hex,
} from './documentDeliveryContract';
import { createStubEmailProvider, isRetryableDeliveryError, resolveStubEmailOutcome } from './emailProviderAdapter';
import { DELIVERY_STATUSES } from '../../types/documentDelivery';

const WS = '00000000-0000-4000-8000-00000000e1b1';
const SHA = 'a'.repeat(64);

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'd-1',
    workspace_id: WS,
    client_delivery_id: 'cd-1',
    document_kind: 'invoice',
    linked_invoice_id: 'inv-1',
    linked_document_id: null,
    recipient_email: 'kunde@example.invalid',
    subject: 'Rechnung 2026-0001',
    body_text: 'Anbei die Rechnung.',
    attachment_storage_path: `${WS}/invoice-inv-1/${SHA}.pdf`,
    attachment_sha256: SHA,
    attachment_size_bytes: 12345,
    attachment_filename: 'Rechnung_2026-0001.pdf',
    attachment_mime_type: 'application/pdf',
    provider: 'stub',
    provider_message_id: null,
    status: 'queued',
    requested_by: 'usr-1',
    requested_at: '2026-09-14T10:00:00.000Z',
    provider_accepted_at: null,
    failed_at: null,
    error_category: null,
    error_code: null,
    error_message_safe: null,
    retry_of_delivery_id: null,
    attempt_number: 1,
    created_at: '2026-09-14T10:00:00.000Z',
    updated_at: '2026-09-14T10:00:00.000Z',
    row_version: 1,
    ...overrides,
  };
}

describe('EMAIL-01B1 — Statusmaschine', () => {
  it('S1: monotone Übergänge; provider_accepted geht nie zurück auf queued', () => {
    expect(canTransitionDeliveryStatus('prepared', 'queued')).toBe(true);
    expect(canTransitionDeliveryStatus('queued', 'provider_accepted')).toBe(true);
    expect(canTransitionDeliveryStatus('queued', 'failed')).toBe(true);
    expect(canTransitionDeliveryStatus('queued', 'unknown')).toBe(true);
    expect(canTransitionDeliveryStatus('unknown', 'provider_accepted')).toBe(true);
    expect(canTransitionDeliveryStatus('provider_accepted', 'delivered')).toBe(true);
    expect(canTransitionDeliveryStatus('provider_accepted', 'bounced')).toBe(true);
    expect(canTransitionDeliveryStatus('provider_accepted', 'queued')).toBe(false);
    expect(canTransitionDeliveryStatus('provider_accepted', 'failed')).toBe(false);
    expect(canTransitionDeliveryStatus('failed', 'queued')).toBe(false);
    expect(canTransitionDeliveryStatus('delivered', 'bounced')).toBe(false);
    for (const status of DELIVERY_STATUSES) expect(canTransitionDeliveryStatus(status, status)).toBe(true);
  });

  it('S2: „versendet" ≠ „zugestellt"; Retry nur nach Fehlschlag', () => {
    expect(isDeliveryConsideredSent('provider_accepted')).toBe(true);
    expect(isDeliveryConsideredSent('queued')).toBe(false);
    expect(isDeliveryConsideredSent('failed')).toBe(false);
    expect(isDeliveryRetryable('failed')).toBe(true);
    expect(isDeliveryRetryable('unknown')).toBe(false); // V1-B1: Handoff ungewiss → kein Retry
    expect(isDeliveryRetryable('bounced')).toBe(true);
    expect(isDeliveryRetryable('rejected')).toBe(true);
    expect(isDeliveryRetryable('provider_accepted')).toBe(false);
    expect(isDeliveryRetryable('queued')).toBe(false);
  });
});

describe('EMAIL-01B1 — Parser fail-closed', () => {
  it('P1: eine gültige Zeile wird vollständig übersetzt', () => {
    const parsed = parseDocumentDeliveryRow(row());
    expect(parsed).toMatchObject({
      id: 'd-1',
      documentKind: 'invoice',
      linkedInvoiceId: 'inv-1',
      status: 'queued',
      provider: 'stub',
      attemptNumber: 1,
      rowVersion: 1,
      attachment: { sha256: SHA, sizeBytes: 12345, filename: 'Rechnung_2026-0001.pdf', mimeType: 'application/pdf' },
    });
    expect(parsed?.providerMessageId).toBeUndefined();
    expect(parsed?.errorCategory).toBeUndefined();
  });

  it('P2: unbekannter Status/Provider/Kind/Fehlerkategorie → null, nie still akzeptiert', () => {
    expect(parseDocumentDeliveryRow(row({ status: 'sent' }))).toBeNull();
    expect(parseDocumentDeliveryRow(row({ status: 'delivered_maybe' }))).toBeNull();
    expect(parseDocumentDeliveryRow(row({ provider: 'sendgrid' }))).toBeNull();
    expect(parseDocumentDeliveryRow(row({ document_kind: 'vorgang' }))).toBeNull();
    expect(parseDocumentDeliveryRow(row({ error_category: 'brevo_400' }))).toBeNull();
    expect(parseDocumentDeliveryRow(row({ attempt_number: 0 }))).toBeNull();
    expect(parseDocumentDeliveryRow(row({ row_version: '1x' }))).toBeNull();
    expect(parseDocumentDeliveryRow(null)).toBeNull();
    expect(parseDocumentDeliveryRow('x')).toBeNull();
  });

  it('P3: Rechnungsdokument ohne Rechnungsbezug, fremder Anhangspfad, falscher Mime → null', () => {
    expect(parseDocumentDeliveryRow(row({ linked_invoice_id: null }))).toBeNull();
    expect(parseDocumentDeliveryRow(row({ attachment_storage_path: `other-ws/invoice-inv-1/${SHA}.pdf` }))).toBeNull();
    expect(parseDocumentDeliveryRow(row({ attachment_mime_type: 'image/png' }))).toBeNull();
    expect(parseDocumentDeliveryRow(row({ attachment_sha256: 'ABC' }))).toBeNull();
    expect(parseDocumentDeliveryRow(row({ attachment_size_bytes: 20 * 1024 * 1024 }))).toBeNull();
  });

  it('P4: spätere Webhook-Zustände sind bereits parsebar', () => {
    const delivered = parseDocumentDeliveryRow(row({ status: 'delivered', provider_message_id: 'm-1', provider_accepted_at: '2026-09-14T10:01:00.000Z' }));
    expect(delivered?.status).toBe('delivered');
    const bounced = parseDocumentDeliveryRow(row({ status: 'bounced', provider_message_id: 'm-1', provider_accepted_at: '2026-09-14T10:01:00.000Z', error_category: 'recipient' }));
    expect(bounced?.errorCategory).toBe('recipient');
  });
});

describe('EMAIL-01B1 — Idempotenz, Empfänger, Anhang', () => {
  it('I1: Fingerprint ist über Empfänger-Schreibweise stabil und über Inhalt sensibel', () => {
    const base = { documentKind: 'invoice' as const, linkedInvoiceId: 'inv-1', recipientEmail: 'Kunde@Example.invalid ', subject: ' Rechnung ', bodyText: 'Hallo', attachmentSha256: SHA.toUpperCase() };
    const same = { ...base, recipientEmail: 'kunde@example.invalid', subject: 'Rechnung', attachmentSha256: SHA };
    expect(buildDeliveryIntentFingerprint(base)).toBe(buildDeliveryIntentFingerprint(same));
    expect(buildDeliveryIntentFingerprint({ ...base, recipientEmail: 'andere@example.invalid' })).not.toBe(buildDeliveryIntentFingerprint(base));
    expect(buildDeliveryIntentFingerprint({ ...base, attachmentSha256: 'b'.repeat(64) })).not.toBe(buildDeliveryIntentFingerprint(base));
    expect(buildDeliveryIntentFingerprint({ ...base, bodyText: 'Hallo!' })).not.toBe(buildDeliveryIntentFingerprint(base));
  });

  it('I2: Empfängervalidierung syntaktisch, Pfad im eigenen Workspace mit Hash', async () => {
    expect(isValidRecipientEmail('kunde@example.invalid')).toBe(true);
    expect(isValidRecipientEmail('kunde@example')).toBe(false);
    expect(isValidRecipientEmail('kein mail')).toBe(false);
    expect(isValidRecipientEmail('')).toBe(false);
    const sha = await sha256Hex(new TextEncoder().encode('%PDF-1.4 test'));
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(buildDeliveryAttachmentStoragePath(WS, 'invoice-inv/1', sha)).toBe(`${WS}/invoice-inv-1/${sha}.pdf`);
    expect(() => buildDeliveryAttachmentStoragePath(WS, 'invoice-inv-1', 'nohash')).toThrow();
    expect(() => buildDeliveryAttachmentStoragePath(WS, '../x', sha)).toThrow();
  });
});

describe('EMAIL-01B1 — Stub-Provider', () => {
  it('ST1: deterministisch: accepted mit stabiler Message-ID, recipient/provider/network/auth über .invalid-Domains', async () => {
    const stub = createStubEmailProvider();
    const base = { from: { email: 'rechnung@send.officepilot.invalid', name: 'Betrieb GmbH' }, subject: 'Rechnung', text: 'Hallo' };
    const ok1 = await stub.sendTransactionalEmail({ ...base, to: { email: 'kunde@example.invalid' }, idempotencyKey: 'k1' });
    const ok2 = await stub.sendTransactionalEmail({ ...base, to: { email: 'kunde@example.invalid' }, idempotencyKey: 'k1' });
    expect(ok1).toMatchObject({ accepted: true, providerStatus: 'queued' });
    expect(ok1.accepted && ok1.providerMessageId).toMatch(/^stub-[0-9a-f]{8}$/);
    expect(ok1).toEqual(ok2);
    expect(resolveStubEmailOutcome('x@bounce.invalid')).toBe('recipient');
    const rec = await stub.sendTransactionalEmail({ ...base, to: { email: 'x@bounce.invalid' } });
    expect(rec).toMatchObject({ accepted: false, errorCategory: 'recipient', retryable: false });
    const prov = await stub.sendTransactionalEmail({ ...base, to: { email: 'x@provider.invalid' } });
    expect(prov).toMatchObject({ accepted: false, errorCategory: 'provider', retryable: true });
    const net = await stub.sendTransactionalEmail({ ...base, to: { email: 'x@timeout.invalid' } });
    expect(net).toMatchObject({ accepted: false, errorCategory: 'network', retryable: true });
    const auth = await stub.sendTransactionalEmail({ ...base, to: { email: 'x@auth.invalid' } });
    expect(auth).toMatchObject({ accepted: false, errorCategory: 'auth', retryable: false });
    expect(stub.provider).toBe('stub');
    expect(isRetryableDeliveryError('recipient')).toBe(false);
    expect(isRetryableDeliveryError('network')).toBe(true);
  });
});
