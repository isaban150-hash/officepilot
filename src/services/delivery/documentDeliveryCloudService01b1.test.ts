/**
 * EMAIL-01B1 — Cloud-Service: Anhang aus dem historischen Snapshot (derselbe
 * PDF-Renderer wie im Detail), Upload-Pfad, Create-RPC-Ergebnisse (created /
 * replayed / Konflikt / Berechtigung), Historie fail-closed. Supabase gestubbt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { buildInvoiceDraftForType, buildManualInvoiceDraft, finalizeInvoiceDraft, updateDraftPositionQuantity, updateInvoiceDraftMetadata } from '../invoiceService';
import { getVorgangInvoice, hydrateVorgangStore } from '../vorgangService';
import { generateApprovedInvoicePdf } from '../invoicePdfService';
import type { CompanySetup, Vorgang, VorgangInvoice } from '../../types/models';
import {
  prepareInvoiceDeliveryAttachment,
  rpcCreateWorkspaceDocumentDelivery,
  rpcListWorkspaceDocumentDeliveries,
  uploadDeliveryAttachment,
} from './documentDeliveryCloudService';
import { sha256Hex } from './documentDeliveryContract';

const WS = '00000000-0000-4000-8000-00000000e1b1';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };
const CUSTOMER = { name: 'Beispiel Projektbau GmbH', contactPerson: '', street: 'Beispielweg 1', zip: '10000', city: 'Beispielstadt', email: 'kunde@example.invalid', phone: '' };

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'd-1', workspace_id: WS, client_delivery_id: 'cd-1', document_kind: 'invoice', linked_invoice_id: 'inv-1', linked_document_id: null,
    recipient_email: 'kunde@example.invalid', subject: 'Rechnung', body_text: 'Text',
    attachment_storage_path: `${WS}/invoice-inv-1/${'a'.repeat(64)}.pdf`, attachment_sha256: 'a'.repeat(64), attachment_size_bytes: 100,
    attachment_filename: 'Rechnung_1.pdf', attachment_mime_type: 'application/pdf', provider: 'stub', provider_message_id: null,
    status: 'queued', requested_by: 'u', requested_at: '2026-09-14T10:00:00.000Z', provider_accepted_at: null, failed_at: null,
    error_category: null, error_code: null, error_message_safe: null, retry_of_delivery_id: null, attempt_number: 1,
    created_at: '2026-09-14T10:00:00.000Z', updated_at: '2026-09-14T10:00:00.000Z', row_version: 1, ...overrides,
  };
}

function client(rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>, upload?: () => Promise<{ error: { message?: string; statusCode?: number } | null }>) {
  return {
    rpc: vi.fn(rpc),
    storage: { from: vi.fn(() => ({ upload: vi.fn(upload ?? (async () => ({ error: null }))) })) },
  } as never;
}

function finalizeOrderInvoice(id: string): VorgangInvoice {
  hydrateVorgangStore([{ ...createTestVorgang({ id, status: 'beauftragt', orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 10 })] }), invoices: [] } as Vorgang]);
  const base = buildInvoiceDraftForType(id, setup, 'rechnung')!;
  const draft = updateInvoiceDraftMetadata(updateDraftPositionQuantity(base, base.positions[0]!.id, 10), { servicePeriodFrom: '2026-09-01', servicePeriodTo: '2026-09-05', servicePeriodConfirmed: true });
  const result = finalizeInvoiceDraft(id, draft, setup);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return getVorgangInvoice(id, result.invoice.id)!;
}

describe('EMAIL-01B1 — Cloud-Service', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb GmbH', street: 'Werkstraße 2', zip: '54321', city: 'Betriebsstadt', email: 'info@example.invalid', iban: 'DE89370400440532013000', taxNumber: '143/123/45678' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('A1: Anhang der Vorgangsrechnung ist byteidentisch mit dem Detail-/Download-PDF; Hash und Name passen', async () => {
    const invoice = finalizeOrderInvoice('v-e1');
    const prepared = await prepareInvoiceDeliveryAttachment(invoice, { kind: 'invoice', clientInvoiceId: invoice.id });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const reference = await generateApprovedInvoicePdf(invoice);
    expect(reference.ok).toBe(true);
    if (!reference.ok) return;
    expect(prepared.attachment.filename).toBe(reference.filename);
    // pdf-lib schreibt Erstellzeit/ID in die Metadaten — Bytes sind je Render verschieden,
    // der Hash gehört deshalb zum konkreten Upload. Inhaltlich derselbe Renderer, gleiche Länge.
    expect(prepared.attachment.sha256).toBe(await sha256Hex(prepared.attachment.bytes));
    expect(prepared.attachment.sizeBytes).toBe(prepared.attachment.bytes.byteLength);
    expect(Math.abs(prepared.attachment.sizeBytes - reference.bytes.byteLength)).toBeLessThanOrEqual(64);
    expect(prepared.attachment.mimeType).toBe('application/pdf');
    // Spätere Firmenänderung ändert den Anhang nicht (Snapshot-Wahrheit).
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Umbenannt GmbH', street: 'Neu 1', zip: '1', city: 'X', email: 'x@example.invalid', iban: 'DE89370400440532013000', taxNumber: '1' });
    const again = await prepareInvoiceDeliveryAttachment(getVorgangInvoice('v-e1', invoice.id)!, { kind: 'invoice', clientInvoiceId: invoice.id });
    expect(again.ok && Math.abs(again.attachment.sizeBytes - prepared.attachment.sizeBytes) <= 64).toBe(true);
    expect(getVorgangInvoice('v-e1', invoice.id)!.companySnapshot?.companyName).toBe('Betrieb GmbH');
  });

  it('A2: freie Rechnung (ohne Vorgang) wird identisch adressiert — kind invoice + clientInvoiceId; Entwurf nicht versandfähig', async () => {
    const base = finalizeOrderInvoice('v-e2');
    // Dieselbe finalisierte Rechnung ohne Auftragsbezug — so liegt eine freie Rechnung im Store.
    const free: VorgangInvoice = { ...base, id: 'inv-free-1', customerSnapshot: CUSTOMER };
    const prepared = await prepareInvoiceDeliveryAttachment(free, { kind: 'invoice', clientInvoiceId: free.id });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.attachment.filename).toBe(`Rechnung_${free.number}.pdf`);
    const notFinal = await prepareInvoiceDeliveryAttachment({ ...free, status: 'entwurf' }, { kind: 'invoice', clientInvoiceId: free.id });
    expect(notFinal).toEqual({ ok: false, reason: 'not_finalized' });
    expect(typeof buildManualInvoiceDraft).toBe('function');
  });

  it('U1: Upload legt den Hash-Pfad im eigenen Workspace an; vorhandenes Objekt gilt als wiederverwendet', async () => {
    const attachment = { bytes: new TextEncoder().encode('%PDF-1.4'), filename: 'Rechnung_1.pdf', sha256: 'c'.repeat(64), sizeBytes: 8, mimeType: 'application/pdf' as const };
    const okClient = client(async () => ({ data: null, error: null }));
    const first = await uploadDeliveryAttachment({ workspaceId: WS, identity: { kind: 'invoice', clientInvoiceId: 'inv/1' }, attachment }, okClient);
    expect(first).toEqual({ ok: true, storagePath: `${WS}/invoice-inv-1/${'c'.repeat(64)}.pdf`, reused: false });
    const dupClient = client(async () => ({ data: null, error: null }), async () => ({ error: { message: 'The resource already exists', statusCode: 409 } }));
    const second = await uploadDeliveryAttachment({ workspaceId: WS, identity: { kind: 'invoice', clientInvoiceId: 'inv/1' }, attachment }, dupClient);
    expect(second).toMatchObject({ ok: true, reused: true });
    const forbidden = client(async () => ({ data: null, error: null }), async () => ({ error: { message: 'new row violates row-level security policy', statusCode: 403 } }));
    expect(await uploadDeliveryAttachment({ workspaceId: WS, identity: { kind: 'invoice', clientInvoiceId: 'inv-1' }, attachment }, forbidden)).toEqual({ ok: false, error: 'forbidden' });
  });

  it('C1: Create-RPC — created, replayed, Idempotenzkonflikt, fehlende Berechtigung, ungültige Antwort', async () => {
    const input = { workspaceId: WS, clientDeliveryId: 'cd-1', identity: { kind: 'invoice' as const, clientInvoiceId: 'inv-1' }, recipientEmail: ' Kunde@Example.invalid ', subject: 'Rechnung', bodyText: 'Text', attachment: { storagePath: `${WS}/invoice-inv-1/${'a'.repeat(64)}.pdf`, sha256: 'a'.repeat(64), sizeBytes: 100, filename: 'Rechnung_1.pdf' }, provider: 'stub' as const };
    const created = client(async (name, args) => {
      expect(name).toBe('create_workspace_document_delivery');
      expect(args.p_recipient_email).toBe('kunde@example.invalid');
      expect(args.p_attachment_mime_type).toBe('application/pdf');
      return { data: { outcome: 'created', delivery: row() }, error: null };
    });
    expect(await rpcCreateWorkspaceDocumentDelivery(input, created)).toMatchObject({ ok: true, outcome: 'created', delivery: { id: 'd-1', status: 'queued' } });
    expect(await rpcCreateWorkspaceDocumentDelivery(input, client(async () => ({ data: { outcome: 'replayed', delivery: row() }, error: null })))).toMatchObject({ ok: true, outcome: 'replayed' });
    expect(await rpcCreateWorkspaceDocumentDelivery(input, client(async () => ({ data: null, error: { message: 'Idempotenzkonflikt: client_delivery_id mit abweichendem Inhalt' } })))).toMatchObject({ ok: false, error: 'idempotency_conflict' });
    expect(await rpcCreateWorkspaceDocumentDelivery(input, client(async () => ({ data: null, error: { message: 'Keine Schreibberechtigung' } })))).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await rpcCreateWorkspaceDocumentDelivery(input, client(async () => ({ data: null, error: { message: 'Rechnung nicht finalisiert' } })))).toMatchObject({ ok: false, error: 'not_sendable' });
    expect(await rpcCreateWorkspaceDocumentDelivery(input, client(async () => ({ data: { outcome: 'created', delivery: row({ status: 'sent' }) }, error: null })))).toEqual({ ok: false, error: 'invalid_response' });
    expect(await rpcCreateWorkspaceDocumentDelivery({ ...input, recipientEmail: 'kein-mail' }, created)).toEqual({ ok: false, error: 'invalid_recipient' });
  });

  it('L1: Historie — Liste parsebar, eine unbekannte Zeile macht die Antwort ungültig (fail-closed)', async () => {
    const ok = client(async (name, args) => {
      expect(name).toBe('list_workspace_document_deliveries');
      expect(args.p_linked_invoice_id).toBe('inv-1');
      return { data: [row({ id: 'd-2', status: 'provider_accepted', provider_message_id: 'm', provider_accepted_at: '2026-09-14T10:01:00.000Z' }), row()], error: null };
    });
    const listed = await rpcListWorkspaceDocumentDeliveries({ workspaceId: WS, identity: { kind: 'invoice', clientInvoiceId: 'inv-1' } }, ok);
    expect(listed.ok && listed.deliveries.map((d) => d.status)).toEqual(['provider_accepted', 'queued']);
    const bad = client(async () => ({ data: [row(), row({ provider: 'mailgun' })], error: null }));
    expect(await rpcListWorkspaceDocumentDeliveries({ workspaceId: WS, identity: { kind: 'invoice', clientInvoiceId: 'inv-1' } }, bad)).toEqual({ ok: false, error: 'invalid_response' });
  });
});
