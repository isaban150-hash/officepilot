/**
 * E-MAIL-07C — Kommunikationskontext, Historie, Vorlagen und Signatur.
 *
 * Kontext ausschliesslich über Kennungen; Anlage mit Kontext (und sicherer
 * Rückfall auf den 07B-Weg); Historie beim Kunden bzw. Vorgang mit
 * Retry-Ketten; Vorlagen je Dokumentart mit Platzhaltern; Signatur genau
 * einmal. Die serverseitige Prüfung (fremder Workspace) belegt der
 * SQL-Laufzeittest `supabase/tests/document_delivery_context_07c.sql`.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { resetTestStores } from '../../test/resetStores';
import { createTestVorgang } from '../../test/fixtures';
import { hydrateVorgangStore } from '../vorgangService';
import { hydrateCustomerStore } from '../customerStoreService';
import { hydrateDocumentStore } from '../documentService';
import { hydrateDocumentFileStore, resetDocumentFileStoreForTests } from '../documentFileStoreService';
import type { DocumentFileRef } from '../../types/documentFileRef';
import { hydrateBusinessLetters } from '../businessLetterService';
import { hydrateOffers } from '../offer/offerService';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import type { CompanyDocument, CompanyProfile, Customer, VorgangInvoice } from '../../types/models';
import type { BusinessLetter } from '../../types/businessLetter';
import type { Offer } from '../../types/offer';
import type { DocumentDelivery } from '../../types/documentDelivery';
import { parseDocumentDeliveryRow } from './documentDeliveryContract';
import { rpcCreateWorkspaceDocumentDelivery } from './documentDeliveryCloudService';
import {
  deliveryBelongsTo,
  groupDeliveryThreads,
  resolveContextOfDelivery,
  resolveDeliveryContext,
} from './deliveryCommunicationContext';
import {
  BULK_IDS_PER_KIND,
  documentCanHaveDelivery,
  invoiceCanHaveDelivery,
  loadCommunicationHistory,
  resetBulkDeliveryRpcDetectionForTests,
} from './deliveryCommunicationHistory';
import {
  appendSignatureOnce,
  buildDefaultEmailSignature,
  composeDeliveryMail,
  fillMailTemplate,
  resolveEmailSignature,
} from './deliveryMailComposer';
import { composeDocumentDeliveryDraft, composeInvoiceDeliveryDraft } from './documentDeliveryDefaults';

const WS = 'ws-07c';

function customer(id: string, name: string): Customer {
  return { id, name, street: 'Weg 1', zip: '20000', city: 'Stadt', createdAt: '2026-09-01T10:00:00.000Z' } as Customer;
}

function doc(overrides: Partial<CompanyDocument>): CompanyDocument {
  return {
    id: 'doc-x',
    title: 'Dokument',
    category: 'sonstiges',
    issuer: '',
    recognizedText: '',
    issueDate: null,
    validUntil: null,
    digitalFolder: { path: '' },
    paperFolder: { ordner: '', register: '' },
    tags: [],
    linkedCompany: '',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  } as CompanyDocument;
}

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'd-1',
    workspace_id: WS,
    client_delivery_id: 'cd-1',
    document_kind: 'letter',
    linked_invoice_id: null,
    linked_document_id: 'doc-brief',
    recipient_email: 'kunde@example.invalid',
    subject: 'Brief',
    body_text: 'Text',
    attachment_storage_path: null,
    attachment_sha256: null,
    attachment_size_bytes: null,
    attachment_filename: null,
    attachment_mime_type: null,
    provider: 'stub',
    provider_message_id: null,
    status: 'failed',
    requested_by: '00000000-0000-0000-0000-000000000001',
    requested_at: '2026-09-26T11:00:00.000Z',
    provider_accepted_at: null,
    failed_at: '2026-09-26T11:00:01.000Z',
    error_category: 'auth',
    error_code: 'x',
    error_message_safe: 'x',
    retry_of_delivery_id: null,
    attempt_number: 1,
    created_at: '2026-09-26T11:00:00.000Z',
    updated_at: '2026-09-26T11:00:01.000Z',
    row_version: 2,
    ...overrides,
  };
}

function delivery(overrides: Record<string, unknown>): DocumentDelivery {
  const parsed = parseDocumentDeliveryRow(row(overrides));
  if (!parsed) throw new Error('Testzeile ungültig');
  return parsed;
}

function seedStores(): void {
  hydrateCustomerStore([customer('c-a', 'Beispiel A GmbH'), customer('c-b', 'Beispiel B GmbH')]);
  hydrateVorgangStore([
    createTestVorgang({ id: 'v-a', customerId: 'c-a', invoices: [] }),
    createTestVorgang({ id: 'v-b', customerId: 'c-b', invoices: [] }),
  ]);
  hydrateInvoiceStore([
    { vorgangId: 'v-a', invoice: { id: 'inv-a', number: 'RE-2026-0013', customerSnapshot: { name: 'Beispiel A GmbH' } } as unknown as VorgangInvoice },
    { vorgangId: 'v-b', invoice: { id: 'inv-b', number: 'RE-2026-0014' } as unknown as VorgangInvoice },
  ]);
  hydrateBusinessLetters([{ id: 'letter-a', workspaceId: WS, subject: 'Terminbestätigung', body: 'Text', customerId: 'c-a', status: 'finalized', recipient: {} } as unknown as BusinessLetter]);
  hydrateOffers([{ id: 'offer-b', offerNumber: 'AN-2026-0003', customerId: 'c-b', resultingVorgangId: 'v-b', status: 'sent' } as unknown as Offer]);
  hydrateDocumentStore([
    doc({ id: 'doc-brief', title: 'Terminbestätigung', linkedLetterId: 'letter-a' }),
    doc({ id: 'doc-angebot', title: 'Badsanierung', linkedOfferId: 'offer-b' }),
    doc({ id: 'doc-plan', title: 'Plan', linkedVorgang: { vorgangId: 'v-a', vorgangTitle: 'Test' } }),
    doc({ id: 'doc-frei', title: 'Ohne Bezug' }),
  ]);
}

describe('E-MAIL-07C — Kontext über Kennungen', () => {
  beforeEach(() => {
    resetTestStores();
    seedStores();
  });

  it('A/B: Kunde und Vorgang je Dokumentart eindeutig aus den Verknüpfungen', () => {
    expect(resolveDeliveryContext({ kind: 'invoice', clientInvoiceId: 'inv-a' })).toEqual({ vorgangId: 'v-a', customerId: 'c-a' });
    expect(resolveDeliveryContext({ kind: 'letter', clientDocumentId: 'doc-brief' })).toEqual({ customerId: 'c-a', vorgangId: undefined });
    expect(resolveDeliveryContext({ kind: 'offer', clientDocumentId: 'doc-angebot' })).toEqual({ customerId: 'c-b', vorgangId: 'v-b' });
    expect(resolveDeliveryContext({ kind: 'other', clientDocumentId: 'doc-plan' })).toEqual({ vorgangId: 'v-a', customerId: 'c-a' });
    // Kein Bezug → kein erfundener Kontext.
    expect(resolveDeliveryContext({ kind: 'other', clientDocumentId: 'doc-frei' })).toEqual({ vorgangId: undefined, customerId: undefined });
  });

  it('D: alte Zeile ohne Kontext bleibt lesbar und wird nur über das Dokument zugeordnet', () => {
    const legacy = delivery({});
    expect(legacy.customerId).toBeUndefined();
    expect(resolveContextOfDelivery(legacy)).toEqual({ customerId: 'c-a', vorgangId: undefined });
    // Gespeicherter Kontext geht vor der Ableitung.
    const stored = delivery({ customer_id: 'c-b', vorgang_id: 'v-b' });
    expect(resolveContextOfDelivery(stored)).toEqual({ customerId: 'c-b', vorgangId: 'v-b' });
    // Unbekanntes Dokument → gar keine Zuordnung (keine Namensheuristik).
    expect(resolveContextOfDelivery(delivery({ linked_document_id: 'doc-unbekannt' }))).toEqual({ customerId: undefined, vorgangId: undefined });
  });

  it('G: Retry-Ketten werden gruppiert, eigenständige Sendungen bleiben getrennt', () => {
    const first = delivery({ id: 'd1', client_delivery_id: 'c1', requested_at: '2026-09-26T11:35:00.000Z' });
    const second = delivery({ id: 'd2', client_delivery_id: 'c2', retry_of_delivery_id: 'd1', attempt_number: 2, requested_at: '2026-09-26T11:36:00.000Z' });
    const third = delivery({
      id: 'd3', client_delivery_id: 'c3', retry_of_delivery_id: 'd2', attempt_number: 3, status: 'provider_accepted',
      provider_accepted_at: '2026-09-26T20:13:49.000Z', failed_at: null, error_category: null, error_code: null, error_message_safe: null,
      provider_message_id: 'm-1', requested_at: '2026-09-26T20:13:40.000Z',
    });
    const separate = delivery({ id: 'd9', client_delivery_id: 'c9', requested_at: '2026-09-27T09:00:00.000Z' });
    const threads = groupDeliveryThreads([third, separate, first, second]);
    expect(threads).toHaveLength(2);
    expect(threads[0].latest.id).toBe('d9');
    expect(threads[1].attempts.map((a) => a.id)).toEqual(['d1', 'd2', 'd3']);
    expect(threads[1].latest.status).toBe('provider_accepted');
  });

  it('E/F: nur passende Kommunikation im Kunden- bzw. Vorgangskontext', () => {
    const brief = delivery({ id: 'k1' });
    const angebot = delivery({ id: 'k2', linked_document_id: 'doc-angebot', document_kind: 'offer' });
    const rechnungA = delivery({ id: 'k3', document_kind: 'invoice', linked_document_id: null, linked_invoice_id: 'inv-a' });
    expect(deliveryBelongsTo(brief, { customerId: 'c-a' })).toBe(true);
    expect(deliveryBelongsTo(angebot, { customerId: 'c-a' })).toBe(false);
    expect(deliveryBelongsTo(rechnungA, { customerId: 'c-a' })).toBe(true);
    expect(deliveryBelongsTo(rechnungA, { vorgangId: 'v-a' })).toBe(true);
    expect(deliveryBelongsTo(rechnungA, { vorgangId: 'v-b' })).toBe(false);
    expect(deliveryBelongsTo(angebot, { vorgangId: 'v-b' })).toBe(true);
  });
});

describe('E-MAIL-07C — Historie laden (HALBZEIT-FIX B6: Bulk-RPC)', () => {
  const pdfRef = (id: string): DocumentFileRef => ({ id, originalFileName: `${id}.pdf`, mimeType: 'application/pdf', fileSize: 20, contentHash: `hash-${id}`, storageType: 'local_data_url', localDataKey: `blob-${id}`, createdAt: '2026-09-01T00:00:00.000Z', lifecycleStatus: 'committed' });

  beforeEach(() => {
    resetTestStores();
    resetDocumentFileStoreForTests();
    resetBulkDeliveryRpcDetectionForTests();
    seedStores();
    // Kunde A: zwei Briefe mit PDF, ein Foto ohne PDF; Kunde B: Angebot mit PDF.
    hydrateDocumentFileStore([pdfRef('fr-brief'), pdfRef('fr-brief-2'), pdfRef('fr-angebot')], {});
    hydrateDocumentStore([
      doc({ id: 'doc-brief', title: 'Terminbestätigung', linkedLetterId: 'letter-a', fileRefId: 'fr-brief', mimeType: 'application/pdf' }),
      doc({ id: 'doc-brief-2', title: 'Nachtrag', linkedLetterId: 'letter-a', fileRefId: 'fr-brief-2', mimeType: 'application/pdf' }),
      doc({ id: 'doc-angebot', title: 'Badsanierung', linkedOfferId: 'offer-b', fileRefId: 'fr-angebot', mimeType: 'application/pdf' }),
      doc({ id: 'doc-foto', title: 'Baustellenfoto', linkedLetterId: 'letter-a', mimeType: 'image/jpeg' }),
      doc({ id: 'doc-frei', title: 'Ohne Bezug' }),
    ]);
    hydrateInvoiceStore([
      { vorgangId: 'v-a', invoice: { id: 'inv-a', number: 'RE-2026-0013', status: 'versendet', customerSnapshot: { name: 'Beispiel A GmbH' } } as unknown as VorgangInvoice },
      { vorgangId: 'v-a', invoice: { id: 'inv-a-2', number: 'RE-2026-0015', status: 'storniert', customerSnapshot: { name: 'Beispiel A GmbH' } } as unknown as VorgangInvoice },
      { vorgangId: 'v-a', invoice: { id: 'inv-a-entwurf', status: 'entwurf' } as unknown as VorgangInvoice },
      { vorgangId: 'v-b', invoice: { id: 'inv-b', number: 'RE-2026-0014', status: 'vorbereitet' } as unknown as VorgangInvoice },
    ]);
  });

  /**
   * Gefälschter Client, der die Bulk-RPC wie der Server auswertet: nur dieser
   * Workspace, nur die übergebenen Kennungen, jede Zeile höchstens einmal.
   */
  function client(rows: Array<Record<string, unknown>>, options: { bulk?: 'ok' | 'missing' | 'failed'; context?: Array<Record<string, unknown>> } = {}) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === 'list_workspace_document_deliveries_for_context') {
        const data = options.context ?? rows.filter((row) => (args.p_customer_id && row.customer_id === args.p_customer_id) || (args.p_vorgang_id && row.vorgang_id === args.p_vorgang_id));
        return { data, error: null };
      }
      if (name === 'list_workspace_document_deliveries_for_documents') {
        if (options.bulk === 'missing') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.list_workspace_document_deliveries_for_documents' } };
        if (options.bulk === 'failed') return { data: null, error: { message: 'Kein Zugriff auf Workspace' } };
        const invoiceIds = new Set(args.p_invoice_ids as string[]);
        const documentIds = new Set(args.p_document_ids as string[]);
        const data = rows.filter((row) => row.workspace_id === args.p_workspace_id && ((row.linked_invoice_id && invoiceIds.has(row.linked_invoice_id as string)) || (row.linked_document_id && documentIds.has(row.linked_document_id as string))));
        return { data, error: null };
      }
      if (name === 'list_workspace_document_deliveries_for_document') {
        return { data: rows.filter((row) => row.linked_document_id === args.p_client_document_id), error: null };
      }
      if (name === 'list_workspace_document_deliveries') {
        return { data: rows.filter((row) => row.linked_invoice_id === args.p_linked_invoice_id), error: null };
      }
      return { data: [], error: null };
    });
    return { client: { rpc } as unknown as SupabaseClient, calls };
  }
  const accepted = { status: 'provider_accepted', provider_accepted_at: '2026-09-26T20:00:00.000Z', failed_at: null, error_category: null, error_code: null, error_message_safe: null, provider_message_id: 'm' };
  const perDocumentCalls = (calls: Array<{ name: string }>) =>
    calls.filter((call) => call.name === 'list_workspace_document_deliveries' || call.name === 'list_workspace_document_deliveries_for_document');
  const invoiceRow = (id: string, invoiceId: string, extra: Record<string, unknown> = {}) => row({ id, document_kind: 'invoice', linked_document_id: null, linked_invoice_id: invoiceId, ...extra });

  it('A/B/C/P: mehrere Rechnungen und Dokumente in EINER Bulk-Anfrage, keine Anfrage je Dokument', async () => {
    const { client: supabase, calls } = client([
      invoiceRow('r1', 'inv-a'),
      invoiceRow('r2', 'inv-a-2'),
      row({ id: 'b1', linked_document_id: 'doc-brief' }),
      row({ id: 'b3', linked_document_id: 'doc-brief-2' }),
    ]);
    const result = await loadCommunicationHistory({ customerId: 'c-a' }, { client: supabase, workspaceId: WS });
    expect(result.ok && result.threads.map((t) => t.latest.id).sort()).toEqual(['b1', 'b3', 'r1', 'r2']);
    const bulk = calls.filter((call) => call.name === 'list_workspace_document_deliveries_for_documents');
    expect(bulk).toHaveLength(1);
    expect(bulk[0].args).toEqual({ p_workspace_id: WS, p_invoice_ids: ['inv-a', 'inv-a-2'], p_document_ids: ['doc-brief', 'doc-brief-2'] });
    expect(perDocumentCalls(calls)).toHaveLength(0);
    // Konstante Anzahl: Kontext + Bulk.
    expect(calls.map((call) => call.name).sort()).toEqual(['list_workspace_document_deliveries_for_context', 'list_workspace_document_deliveries_for_documents']);
  });

  it('D/E/H/J: alte Zeilen ohne customer_id/vorgang_id erscheinen; 01J-Kette genau einmal, nicht vervielfacht', async () => {
    const chain = [
      row({ id: 'j1', linked_document_id: 'doc-brief', attempt_number: 1 }),
      row({ id: 'j2', linked_document_id: 'doc-brief', retry_of_delivery_id: 'j1', attempt_number: 2 }),
      row({ id: 'j3', linked_document_id: 'doc-brief', retry_of_delivery_id: 'j2', attempt_number: 3 }),
      row({ id: 'j4', linked_document_id: 'doc-brief', retry_of_delivery_id: 'j3', attempt_number: 4, ...accepted }),
    ];
    const { client: supabase } = client(chain);
    const customer = await loadCommunicationHistory({ customerId: 'c-a' }, { client: supabase, workspaceId: WS });
    expect(customer.ok && customer.threads).toHaveLength(1);
    expect(customer.ok && customer.threads[0].attempts.map((a) => a.id)).toEqual(['j1', 'j2', 'j3', 'j4']);
    expect(customer.ok && customer.threads[0].latest.status).toBe('provider_accepted');
    // Ohne vorgang_id: eine alte Rechnungszeile wird dem Vorgang über die Rechnung zugeordnet.
    const { client: vorgangClient } = client([invoiceRow('rv', 'inv-a')]);
    const vorgang = await loadCommunicationHistory({ vorgangId: 'v-a' }, { client: vorgangClient, workspaceId: WS });
    expect(vorgang.ok && vorgang.threads.map((t) => t.latest.id)).toEqual(['rv']);
  });

  it('F/G: neue Zeilen mit gespeichertem Kontext kommen über den Kontext und werden nicht verdoppelt', async () => {
    const withCustomer = row({ id: 'n1', linked_document_id: 'doc-brief', customer_id: 'c-a' });
    const withVorgang = invoiceRow('n2', 'inv-b', { vorgang_id: 'v-b' });
    const { client: supabase } = client([withCustomer, withVorgang]);
    const customer = await loadCommunicationHistory({ customerId: 'c-a' }, { client: supabase, workspaceId: WS });
    expect(customer.ok && customer.threads.map((t) => t.latest.id)).toEqual(['n1']);
    const vorgang = await loadCommunicationHistory({ vorgangId: 'v-b' }, { client: supabase, workspaceId: WS });
    expect(vorgang.ok && vorgang.threads.map((t) => t.latest.id)).toEqual(['n2']);
  });

  it('I: fremde Einträge nicht in der Kundenhistorie (Angebot von Kunde B, fremder Workspace)', async () => {
    const { client: supabase, calls } = client([
      row({ id: 'fremd-b', document_kind: 'offer', linked_document_id: 'doc-angebot' }),
      row({ id: 'fremd-ws', workspace_id: 'ws-fremd', linked_document_id: 'doc-brief' }),
      row({ id: 'eigen', linked_document_id: 'doc-brief' }),
    ]);
    const result = await loadCommunicationHistory({ customerId: 'c-a' }, { client: supabase, workspaceId: WS });
    expect(result.ok && result.threads.map((t) => t.latest.id)).toEqual(['eigen']);
    const bulk = calls.find((call) => call.name === 'list_workspace_document_deliveries_for_documents')!;
    expect(bulk.args.p_document_ids).not.toContain('doc-angebot');
    // Nur versandfähige: kein Entwurf, kein Foto ohne PDF.
    expect(bulk.args.p_invoice_ids).not.toContain('inv-a-entwurf');
    expect(bulk.args.p_document_ids).not.toContain('doc-foto');
  });

  it('K: dieselbe Zeile aus Kontext und Bulk erscheint genau einmal', async () => {
    const shared = row({ id: 's1', linked_document_id: 'doc-brief', customer_id: 'c-a' });
    const { client: supabase } = client([shared]);
    const result = await loadCommunicationHistory({ customerId: 'c-a' }, { client: supabase, workspaceId: WS });
    expect(result.ok && result.threads.map((t) => t.attempts.map((a) => a.id))).toEqual([['s1']]);
  });

  it('O: ohne zugeordnete Dokumente keine Bulk-Anfrage', async () => {
    hydrateDocumentStore([]);
    hydrateInvoiceStore([]);
    const { client: supabase, calls } = client([]);
    const result = await loadCommunicationHistory({ customerId: 'c-a' }, { client: supabase, workspaceId: WS });
    expect(result).toMatchObject({ ok: true, threads: [], incomplete: false });
    expect(calls.map((call) => call.name)).toEqual(['list_workspace_document_deliveries_for_context']);
  });

  it('N: mehr als 250 Kennungen je Art werden in Blöcke geteilt (Servergrenze), nie je Dokument', async () => {
    hydrateInvoiceStore(
      Array.from({ length: 300 }, (_, index) => ({ vorgangId: 'v-a', invoice: { id: `inv-x-${index}`, status: 'versendet', customerSnapshot: { name: 'Beispiel A GmbH' } } as unknown as VorgangInvoice })),
    );
    const { client: supabase, calls } = client([]);
    await loadCommunicationHistory({ customerId: 'c-a' }, { client: supabase, workspaceId: WS });
    const bulk = calls.filter((call) => call.name === 'list_workspace_document_deliveries_for_documents');
    expect(bulk.map((call) => (call.args.p_invoice_ids as string[]).length)).toEqual([BULK_IDS_PER_KIND, 50]);
    expect(perDocumentCalls(calls)).toHaveLength(0);
  });

  it('Übergang: Bulk-RPC fehlt (PGRST202) → bisheriger Weg; danach wird bis zur Frist nicht erneut geprüft, dann automatisch Bulk', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const legacy = [row({ id: 'b1', linked_document_id: 'doc-brief' })];
    const missing = client(legacy, { bulk: 'missing' });
    const first = await loadCommunicationHistory({ customerId: 'c-a' }, { client: missing.client, workspaceId: WS, now });
    expect(first.ok && first.threads.map((t) => t.latest.id)).toEqual(['b1']);
    expect(missing.calls.filter((call) => call.name === 'list_workspace_document_deliveries_for_documents')).toHaveLength(1);
    expect(perDocumentCalls(missing.calls).length).toBeGreaterThan(0);

    const second = client(legacy, { bulk: 'missing' });
    await loadCommunicationHistory({ customerId: 'c-a' }, { client: second.client, workspaceId: WS, now });
    expect(second.calls.filter((call) => call.name === 'list_workspace_document_deliveries_for_documents')).toHaveLength(0);

    clock += 11 * 60 * 1000; // Remote-Migration inzwischen angewendet
    const migrated = client(legacy);
    const third = await loadCommunicationHistory({ customerId: 'c-a' }, { client: migrated.client, workspaceId: WS, now });
    expect(third.ok && third.threads.map((t) => t.latest.id)).toEqual(['b1']);
    expect(migrated.calls.filter((call) => call.name === 'list_workspace_document_deliveries_for_documents')).toHaveLength(1);
    expect(perDocumentCalls(migrated.calls)).toHaveLength(0);
  });

  it('Bulk-Fehler (z. B. kein Zugriff): Hinweis „unvollständig", KEIN Rückfall auf Anfragen je Dokument', async () => {
    const { client: supabase, calls } = client([row({ id: 'k1', linked_document_id: 'doc-brief', customer_id: 'c-a' })], { bulk: 'failed' });
    const result = await loadCommunicationHistory({ customerId: 'c-a' }, { client: supabase, workspaceId: WS });
    expect(result).toMatchObject({ ok: true, incomplete: true });
    expect(result.ok && result.threads.map((t) => t.latest.id)).toEqual(['k1']);
    expect(perDocumentCalls(calls)).toHaveLength(0);
  });

  it('Versandfähigkeit großzügig — versendete/stornierte Rechnung und Dokument mit PDF zählen', async () => {
    expect(invoiceCanHaveDelivery({ status: 'entwurf' } as VorgangInvoice)).toBe(false);
    for (const status of ['vorbereitet', 'versendet', 'bezahlt', 'storniert']) {
      expect(invoiceCanHaveDelivery({ status } as unknown as VorgangInvoice)).toBe(true);
    }
    expect(documentCanHaveDelivery({ id: 'doc-brief', fileRefId: 'fr-brief', mimeType: 'application/pdf' })).toBe(true);
    expect(documentCanHaveDelivery({ id: 'doc-foto', fileRefId: undefined, mimeType: 'image/jpeg' })).toBe(false);
  });
});

describe('E-MAIL-07C — Anlage mit Kontext', () => {
  const input = {
    workspaceId: WS,
    clientDeliveryId: 'cd-ctx',
    identity: { kind: 'letter' as const, clientDocumentId: 'doc-brief' },
    recipientEmail: 'kunde@example.invalid',
    subject: 'Brief',
    bodyText: 'Text',
    attachment: { storagePath: 'x', sha256: 'y', sizeBytes: 1, filename: 'Brief.pdf' },
    provider: 'stub' as const,
    context: { customerId: 'c-a', vorgangId: 'v-a' },
  };
  const envelope = { outcome: 'created', delivery: row({ id: 'n1', status: 'queued', failed_at: null, error_category: null, error_code: null, error_message_safe: null, row_version: 1 }) };

  function recordingClient(behaviour: (name: string) => { data?: unknown; error?: { code?: string; message: string } }) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const supabase = {
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        const result = behaviour(name);
        return { data: result.data ?? null, error: result.error ?? null };
      }),
    } as unknown as SupabaseClient;
    return { supabase, calls };
  }

  it('A/B: Kunde und Vorgang reisen mit der Kontext-RPC', async () => {
    const { supabase, calls } = recordingClient(() => ({ data: envelope }));
    const result = await rpcCreateWorkspaceDocumentDelivery(input, supabase);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('create_workspace_document_delivery_with_context');
    expect(calls[0].args).toMatchObject({ p_customer_id: 'c-a', p_vorgang_id: 'v-a', p_linked_document_id: 'doc-brief' });
  });

  it('Q: fehlt die Kontext-RPC (Migration ausstehend), genau ein Rückfall auf den 07B-Weg — keine Doppelanlage', async () => {
    const { supabase, calls } = recordingClient((name) =>
      name === 'create_workspace_document_delivery_with_context'
        ? { error: { code: 'PGRST202', message: 'Could not find the function public.create_workspace_document_delivery_with_context' } }
        : { data: envelope },
    );
    const result = await rpcCreateWorkspaceDocumentDelivery(input, supabase);
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.name)).toEqual(['create_workspace_document_delivery_with_context', 'create_workspace_document_delivery']);
    expect(calls[1].args).not.toHaveProperty('p_customer_id');
    expect(calls[1].args.p_client_delivery_id).toBe('cd-ctx');
  });

  it('C: abgelehnter Kontext (z. B. Kunde noch nicht in der Cloud) blockiert den Versand nicht, speichert aber keinen Kontext', async () => {
    const { supabase, calls } = recordingClient((name) =>
      name === 'create_workspace_document_delivery_with_context'
        ? { error: { message: 'customer_id gehoert nicht zum Workspace' } }
        : { data: envelope },
    );
    const result = await rpcCreateWorkspaceDocumentDelivery(input, supabase);
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.name)).toEqual(['create_workspace_document_delivery_with_context', 'create_workspace_document_delivery']);
  });

  it('Q: andere Fehler der Kontext-RPC führen zu keinem zweiten Aufruf', async () => {
    const { supabase, calls } = recordingClient(() => ({ error: { message: 'Versandstatus unklar' } }));
    const result = await rpcCreateWorkspaceDocumentDelivery(input, supabase);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('ohne Kontext bleibt es beim unveränderten 07B-Aufruf', async () => {
    const { supabase, calls } = recordingClient(() => ({ data: envelope }));
    await rpcCreateWorkspaceDocumentDelivery({ ...input, context: {} }, supabase);
    expect(calls.map((call) => call.name)).toEqual(['create_workspace_document_delivery']);
  });
});

describe('E-MAIL-07C — Vorlagen, Platzhalter, Signatur', () => {
  const profile: Partial<CompanyProfile> = {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Çırmak Haustechnik',
    legalForm: 'GmbH',
    street: 'Bahnhofstraße 12',
    zip: '32105',
    city: 'Bad Salzuflen',
    phone: '05222 000000',
    email: 'info@example.invalid',
  };

  beforeEach(() => {
    resetTestStores();
    seedStores();
  });

  it('H: Rechnung nutzt die Rechnungsvorlage (gespeichert oder Vorgabe) mit Nummer', () => {
    const invoice = { id: 'inv-a', number: 'RE-2026-0013', customerSnapshot: { name: 'Beispiel A GmbH' }, companySnapshot: { companyName: 'Çırmak Haustechnik', legalForm: 'GmbH' } } as unknown as VorgangInvoice;
    const standard = composeInvoiceDeliveryDraft(invoice, 'de', { profile });
    expect(standard.subject).toBe('Rechnung RE-2026-0013 - Çırmak Haustechnik GmbH');
    expect(standard.bodyText).toContain('anbei erhalten Sie unsere Rechnung RE-2026-0013.');
    const custom = composeInvoiceDeliveryDraft(invoice, 'de', {
      profile: { ...profile, defaultInvoiceEmailSubject: 'Ihre Rechnung {{documentNumber}}', defaultInvoiceEmailBody: 'Hallo {{customerName}},\n\nhier Rechnung {{documentNumber}}.' },
    });
    expect(custom.subject).toBe('Ihre Rechnung RE-2026-0013');
    expect(custom.bodyText.startsWith('Hallo Beispiel A GmbH,\n\nhier Rechnung RE-2026-0013.')).toBe(true);
  });

  it('I: Angebot nutzt die Angebotsvorlage — kein Rechnungstext', () => {
    const draft = composeDocumentDeliveryDraft({ kind: 'offer', title: 'Badsanierung', documentNumber: 'AN-2026-0003', customerName: 'Beispiel B GmbH', profile }, 'de');
    expect(draft.subject).toBe('Angebot AN-2026-0003 - Çırmak Haustechnik GmbH');
    expect(draft.bodyText).toContain('unser Angebot AN-2026-0003 „Badsanierung“');
    expect(draft.bodyText).not.toMatch(/Rechnung/);
  });

  it('J: Geschäftsbrief nutzt die Briefvorlage', () => {
    const draft = composeDocumentDeliveryDraft({ kind: 'letter', title: '01J Abnahme Kundenkontext', profile }, 'de');
    expect(draft.subject).toBe('01J Abnahme Kundenkontext - Çırmak Haustechnik GmbH');
    expect(draft.bodyText).toContain('unser Schreiben „01J Abnahme Kundenkontext“');
    expect(draft.bodyText).not.toMatch(/Rechnung|Angebot/);
  });

  it('K: Signatur genau einmal — aus Firmendaten oder gespeichert', () => {
    const derived = buildDefaultEmailSignature(profile, 'de');
    expect(derived).toBe('Mit freundlichen Grüßen\n\nÇırmak Haustechnik GmbH\nBahnhofstraße 12\n32105 Bad Salzuflen\nTelefon 05222 000000\nE-Mail info@example.invalid');
    const mail = composeDeliveryMail({ kind: 'letter', values: { documentTitle: 'Brief' }, profile, language: 'de' });
    expect(mail.bodyText.split('Mit freundlichen Grüßen')).toHaveLength(2);
    expect(mail.bodyText.endsWith(derived)).toBe(true);
    const own = composeDeliveryMail({ kind: 'letter', values: { documentTitle: 'Brief' }, profile: { ...profile, emailSignature: 'Viele Grüße\nIhr Team' }, language: 'de' });
    expect(own.bodyText.endsWith('Viele Grüße\nIhr Team')).toBe(true);
    expect(resolveEmailSignature({ ...profile, emailSignature: '  ' }, 'de')).toBe(derived);
  });

  it('L: erneutes Anhängen (Dialog erneut geöffnet, Entwurf/Retry) verdoppelt nichts; alte Grussformel wird ersetzt', () => {
    const signature = resolveEmailSignature(profile, 'de');
    const once = appendSignatureOnce('Guten Tag,\n\nanbei der Brief.', signature);
    expect(appendSignatureOnce(once, signature)).toBe(once);
    expect(appendSignatureOnce(`${once}\n\n`, signature)).toBe(once);
    // Ältere gespeicherte Rechnungsvorlage mit eigener Grussformel: keine doppelte Grussformel.
    const legacy = appendSignatureOnce('Guten Tag,\n\nanbei Rechnung 1.\n\nMit freundlichen Grüßen\nÇırmak Haustechnik GmbH', signature);
    expect(legacy.split('Mit freundlichen Grüßen')).toHaveLength(2);
    expect(legacy.startsWith('Guten Tag,\n\nanbei Rechnung 1.\n\nMit freundlichen Grüßen\n\nÇırmak')).toBe(true);
  });

  it('M: Platzhalter — kanonisch {{…}} und ältere {invoiceNumber}-Schreibweise', () => {
    expect(fillMailTemplate('Rechnung {{documentNumber}} an {{customerName}} von {{ companyName }}', { documentNumber: '7', customerName: 'Kunde', companyName: 'Firma' })).toBe('Rechnung 7 an Kunde von Firma');
    expect(fillMailTemplate('Rechnung {invoiceNumber} - {companyName}', { documentNumber: '7', companyName: 'Firma' })).toBe('Rechnung 7 - Firma');
    // Fremde geschweifte Klammern im Text bleiben unangetastet.
    expect(fillMailTemplate('Menge {3 Stück}', {})).toBe('Menge {3 Stück}');
  });

  it('N: fehlender Wert hinterlässt keinen rohen Platzhalter und keine hängenden Trenner', () => {
    expect(fillMailTemplate('{{documentTitle}} - {{companyName}}', { documentTitle: 'Brief' })).toBe('Brief');
    expect(fillMailTemplate('Guten Tag {{customerName}},\n\nText', {})).toBe('Guten Tag,\n\nText');
    const letter = composeDeliveryMail({ kind: 'letter', values: { documentTitle: 'Brief', documentNumber: 'X-1' }, profile: { ...profile, defaultLetterEmailSubject: 'Brief {{documentNumber}} {{documentTitle}}' }, language: 'de' });
    // Für Briefe gibt es keine Dokumentnummer — auch nicht, wenn eine übergeben wird.
    expect(letter.subject).toBe('Brief Brief');
    expect(letter.bodyText).not.toMatch(/\{\{|\}\}/);
  });

  it('O: Zusammensetzen verändert die gespeicherte Vorlage nicht', () => {
    const stored = { ...profile, defaultOfferEmailSubject: 'Angebot {{documentNumber}}', defaultOfferEmailBody: 'Hallo,\n\nAngebot {{documentNumber}}.' };
    const snapshot = JSON.stringify(stored);
    composeDeliveryMail({ kind: 'offer', values: { documentNumber: 'AN-1' }, profile: stored, language: 'de' });
    expect(JSON.stringify(stored)).toBe(snapshot);
  });
});
