/**
 * EMAIL-01B3 — Client-Seite des Versands: Resolver (Empfänger/Betreff/
 * Nachricht in de/tr/bg), Resume-Draft, client_delivery_id, Orchestrator mit
 * gestubbtem Supabase/Edge-Aufruf (Replay, Upload-Replay, failed/unknown,
 * Serverwahrheit → lokale Rechnung), i18n-Parität. Kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { de } from '../../i18n';
import { deDelivery } from '../../i18n/locales/de/delivery';
import { trDelivery } from '../../i18n/locales/tr/delivery';
import { bgDelivery } from '../../i18n/locales/bg/delivery';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import * as supabaseLib from '../../lib/supabase';
import * as persistence from '../persistenceService';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateCustomerStore } from '../customerStoreService';
import { buildInvoiceDraftForType, finalizeInvoiceDraft, updateDraftPositionQuantity, updateInvoiceDraftMetadata } from '../invoiceService';
import { markInvoiceAsSent } from '../invoiceSentService';
import { getVorgangInvoice, hydrateVorgangStore } from '../vorgangService';
import { setActiveStorageScope } from '../storage/storageScopeService';
import type { CompanySetup, Customer, Vorgang, VorgangInvoice } from '../../types/models';
import { resolveDeliveryBody, resolveDeliveryDraftDefaults, resolveDeliveryRecipient, resolveDeliverySubject } from './documentDeliveryDefaults';
import {
  applyAcceptedDeliveryToLocalInvoice,
  clearSendDraft,
  createSendDraft,
  loadSendDraft,
  resolveClientMailProvider,
  runSendDocument,
  saveSendDraft,
  type SendDraftState,
} from './sendDocumentOrchestrator';

const WS = '00000000-0000-4000-8000-00000000e1b3';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };

function finalizeInvoice(id: string, email = 'kunde@example.invalid'): VorgangInvoice {
  hydrateVorgangStore([{ ...createTestVorgang({ id, status: 'beauftragt', customerBilling: { name: 'Kunde GmbH', contactPerson: '', street: 'Weg 1', zip: '1', city: 'X', email, phone: '' }, orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 10 })] }), invoices: [] } as Vorgang]);
  const base = buildInvoiceDraftForType(id, setup, 'rechnung')!;
  const draft = updateInvoiceDraftMetadata(updateDraftPositionQuantity(base, base.positions[0]!.id, 10), { servicePeriodFrom: '2026-09-01', servicePeriodTo: '2026-09-05', servicePeriodConfirmed: true });
  const result = finalizeInvoiceDraft(id, draft, setup);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return getVorgangInvoice(id, result.invoice.id)!;
}

function deliveryRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'd-1', workspace_id: WS, client_delivery_id: 'cd-x', document_kind: 'invoice', linked_invoice_id: 'inv', linked_document_id: null,
    recipient_email: 'kunde@example.invalid', subject: 'S', body_text: 'B', attachment_storage_path: `${WS}/invoice-inv/${'a'.repeat(64)}.pdf`,
    attachment_sha256: 'a'.repeat(64), attachment_size_bytes: 10, attachment_filename: 'R.pdf', attachment_mime_type: 'application/pdf',
    provider: 'stub', provider_message_id: null, status: 'queued', requested_by: 'u', requested_at: '2026-09-14T10:00:00.000Z',
    provider_accepted_at: null, failed_at: null, error_category: null, error_code: null, error_message_safe: null, retry_of_delivery_id: null,
    attempt_number: 1, created_at: '2026-09-14T10:00:00.000Z', updated_at: '2026-09-14T10:00:00.000Z', row_version: 1, ...overrides,
  };
}

/** Ein gestubbter Supabase-Client mit serverseitigem Gedächtnis (Deliveries je client_delivery_id). */
function fakeServer(options: { outcome?: 'accepted' | 'failed' | 'unknown'; uploadError?: { message: string; statusCode?: number } } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const uploads: string[] = [];
  const sends: string[] = [];
  const client = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'create_workspace_document_delivery') {
        const key = String(args.p_client_delivery_id);
        const existing = rows.get(key);
        if (existing) {
          if (existing.recipient_email !== args.p_recipient_email) return { data: null, error: { message: 'Idempotenzkonflikt: client_delivery_id mit abweichendem Inhalt' } };
          return { data: { outcome: 'replayed', delivery: existing }, error: null };
        }
        const row = deliveryRow({ id: `d-${rows.size + 1}`, client_delivery_id: key, linked_invoice_id: args.p_linked_invoice_id, recipient_email: args.p_recipient_email, subject: args.p_subject, body_text: args.p_body_text, attachment_sha256: args.p_attachment_sha256, attachment_storage_path: args.p_attachment_storage_path, attachment_size_bytes: args.p_attachment_size_bytes, attachment_filename: args.p_attachment_filename, retry_of_delivery_id: args.p_retry_of_delivery_id ?? null, attempt_number: args.p_retry_of_delivery_id ? 2 : 1 });
        rows.set(key, row);
        return { data: { outcome: 'created', delivery: row }, error: null };
      }
      if (name === 'list_workspace_document_deliveries') {
        return { data: [...rows.values()].filter((r) => r.linked_invoice_id === args.p_linked_invoice_id).reverse(), error: null };
      }
      return { data: null, error: { message: `unbekannt: ${name}` } };
    }),
    storage: { from: vi.fn(() => ({ upload: vi.fn(async (path: string) => { uploads.push(path); return { error: options.uploadError ?? null }; }) })) },
    auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 't' } } })) },
  };
  const invokeSend = vi.fn(async (input: { clientDeliveryId: string }) => {
    sends.push(input.clientDeliveryId);
    const row = rows.get(input.clientDeliveryId)!;
    if (row.status === 'provider_accepted') return { status: 200, body: { ok: true, action: 'replayed' as const } };
    const outcome = options.outcome ?? 'accepted';
    if (outcome === 'accepted') Object.assign(row, { status: 'provider_accepted', provider_message_id: 'stub-1', provider_accepted_at: '2026-09-14T10:01:00.000Z', row_version: 2 });
    if (outcome === 'failed') Object.assign(row, { status: 'failed', failed_at: '2026-09-14T10:01:00.000Z', error_category: 'recipient', error_code: 'x', row_version: 2 });
    if (outcome === 'unknown') Object.assign(row, { status: 'unknown', error_category: 'network', row_version: 2 });
    return { status: 200, body: { ok: true, action: outcome === 'accepted' ? ('sent' as const) : outcome === 'failed' ? ('failed' as const) : ('unknown_pending' as const) } };
  });
  return { client: client as never, invokeSend, uploads, sends, rows };
}

describe('EMAIL-01B3 — Resolver', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb', legalForm: 'GmbH', street: 'W 1', zip: '1', city: 'X', email: 'info@betrieb.invalid', iban: 'DE89370400440532013000', taxNumber: '1' });
  });
  afterEach(() => resetTestStores());

  it('R1: Empfänger — Snapshot der Rechnung vor Kundenstamm; ohne Adresse leer, nie erfunden', () => {
    const invoice = finalizeInvoice('v-r1', 'Kunde@Example.INVALID ');
    expect(resolveDeliveryRecipient(invoice)).toEqual({ email: 'kunde@example.invalid', source: 'invoice_snapshot' });
    hydrateCustomerStore([{ id: 'c-1', name: 'Kunde GmbH', contactPerson: '', street: '', zip: '', city: '', email: 'neu@example.invalid', phone: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as Customer]);
    expect(resolveDeliveryRecipient({ customerSnapshot: { ...invoice.customerSnapshot!, email: '' }, customerId: 'c-1' })).toEqual({ email: 'neu@example.invalid', source: 'customer' });
    expect(resolveDeliveryRecipient({ customerSnapshot: { ...invoice.customerSnapshot!, email: 'kaputt' }, customerId: 'c-unknown' })).toEqual({ email: '', source: 'none' });
  });

  it('R2: Betreff/Nachricht aus i18n in de/tr/bg mit Rechnungsnummer und Snapshot-Firmenname; kein HTML', () => {
    const invoice = finalizeInvoice('v-r2');
    const number = invoice.number;
    expect(resolveDeliverySubject(invoice, 'de')).toBe(`Rechnung ${number} - Betrieb GmbH`);
    expect(resolveDeliverySubject(invoice, 'tr')).toBe(`Fatura ${number} - Betrieb GmbH`);
    expect(resolveDeliverySubject(invoice, 'bg')).toBe(`Фактура ${number} - Betrieb GmbH`);
    expect(resolveDeliveryBody(invoice, 'de')).toContain(`unsere Rechnung ${number}`);
    expect(resolveDeliveryBody(invoice, 'de')).toMatch(/Betrieb GmbH$/);
    expect(resolveDeliveryBody(invoice, 'tr')).toContain(number);
    expect(resolveDeliveryBody(invoice, 'de')).not.toMatch(/<[a-z]+>/);
    // Spätere Profiländerung ändert die Vorbelegung nicht (Snapshot).
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Umbenannt', street: 'W', zip: '1', city: 'X', email: 'x@x.invalid', iban: 'DE89370400440532013000', taxNumber: '1' });
    expect(resolveDeliveryDraftDefaults(getVorgangInvoice('v-r2', invoice.id)!, 'de').subject).toBe(`Rechnung ${number} - Betrieb GmbH`);
  });

  it('R3: i18n-Parität — jeder delivery.*-Schlüssel existiert in de, tr und bg; Status-/Fehlerlabels vollständig; kein „zugestellt" für provider_accepted', () => {
    const keys = Object.keys(deDelivery).filter((k) => k.startsWith('delivery.'));
    for (const key of keys) {
      expect(key in trDelivery, `tr fehlt ${key}`).toBe(true);
      expect(key in bgDelivery, `bg fehlt ${key}`).toBe(true);
      expect((de as Record<string, string>)[key], key).toBeTruthy();
    }
    for (const status of ['prepared', 'queued', 'provider_accepted', 'failed', 'unknown', 'delivered', 'bounced', 'complained', 'rejected']) {
      expect(keys).toContain(`delivery.status.${status}`);
    }
    for (const category of ['auth', 'recipient', 'provider', 'attachment', 'network', 'unknown']) {
      expect(keys).toContain(`delivery.error.${category}`);
    }
    expect(deDelivery['delivery.status.provider_accepted'].toLowerCase()).not.toContain('zugestellt');
    expect(deDelivery['delivery.status.delivered']).toBe('Zugestellt');
  });
});

describe('EMAIL-01B3 — Orchestrator, Resume, client_delivery_id', () => {
  beforeEach(() => {
    resetTestStores();
    localStorage.clear();
    setActiveStorageScope({ type: 'workspace', workspaceId: WS });
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb', legalForm: 'GmbH', street: 'W 1', zip: '1', city: 'X', email: 'info@betrieb.invalid', iban: 'DE89370400440532013000', taxNumber: '1' });
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
    localStorage.clear();
  });

  it('O1: Draft entsteht vor Upload/Create/Send mit stabiler client_delivery_id; Resume nur für dieselbe Rechnung und denselben Scope; keine PDF-Bytes', () => {
    const invoice = finalizeInvoice('v-o1');
    const identity = { kind: 'invoice' as const, clientInvoiceId: invoice.id };
    const draft = createSendDraft({ identity, vorgangId: 'v-o1', recipientEmail: ' Kunde@Example.invalid', subject: ' S ', bodyText: 'B' });
    expect(draft.clientDeliveryId).toMatch(/^cd-[0-9a-f-]{36}$/);
    expect(draft).toMatchObject({ phase: 'draft', recipientEmail: 'kunde@example.invalid', subject: 'S', workspaceId: WS });
    expect(loadSendDraft(identity)?.clientDeliveryId).toBe(draft.clientDeliveryId);
    expect(loadSendDraft({ kind: 'invoice', clientInvoiceId: 'andere' })).toBeNull();
    expect(loadSendDraft(identity, 'anderer-scope')).toBeNull();
    const raw = localStorage.getItem(Object.keys(localStorage).find((k) => k.includes('sendDraft'))!) ?? '';
    expect(raw).not.toContain('%PDF');
    expect(raw).not.toContain('api');
    const second = createSendDraft({ identity, vorgangId: 'v-o1', recipientEmail: 'kunde@example.invalid', subject: 'S', bodyText: 'B' });
    expect(second.clientDeliveryId).not.toBe(draft.clientDeliveryId);
    clearSendDraft(identity);
    expect(loadSendDraft(identity)).toBeNull();
    expect(resolveClientMailProvider()).toBe('brevo');
  });

  it('O2: kompletter Lauf — PDF, Upload, Create, Send, Refresh; Rechnung wird aus der Serverwahrheit versendet/officepilot; Draft gelöscht', async () => {
    const invoice = finalizeInvoice('v-o2');
    const identity = { kind: 'invoice' as const, clientInvoiceId: invoice.id };
    const server = fakeServer();
    const phases: string[] = [];
    const draft = createSendDraft({ identity, vorgangId: 'v-o2', recipientEmail: 'kunde@example.invalid', subject: 'S', bodyText: 'B' });
    const result = await runSendDocument({ draft, vorgangId: 'v-o2' }, { client: server.client, invokeSend: server.invokeSend, onPhase: (p) => phases.push(p) });
    expect(result).toMatchObject({ ok: true, action: 'sent', delivery: { status: 'provider_accepted', providerMessageId: 'stub-1' } });
    expect(phases).toEqual(['preparing', 'uploading', 'creating', 'sending', 'refreshing', 'done']);
    expect(server.uploads).toHaveLength(1);
    expect(server.uploads[0]).toMatch(new RegExp(`^${WS}/invoice-${invoice.id}/[0-9a-f]{64}\\.pdf$`));
    expect(server.sends).toEqual([draft.clientDeliveryId]);
    const updated = getVorgangInvoice('v-o2', invoice.id)!;
    expect(updated).toMatchObject({ status: 'versendet', sentVia: 'email', sentSource: 'officepilot', sentDeliveryId: 'd-1', sentAt: '2026-09-14' });
    expect(loadSendDraft(identity)).toBeNull();
  });

  it('O3: derselbe Draft zweimal (Doppelklick/Reload) → Upload-Replay, Create-Replay, keine zweite Provider-Ausführung', async () => {
    const invoice = finalizeInvoice('v-o3');
    const identity = { kind: 'invoice' as const, clientInvoiceId: invoice.id };
    const server = fakeServer({ uploadError: { message: 'The resource already exists', statusCode: 409 } });
    const draft = createSendDraft({ identity, vorgangId: 'v-o3', recipientEmail: 'kunde@example.invalid', subject: 'S', bodyText: 'B' });
    const first = await runSendDocument({ draft, vorgangId: 'v-o3' }, { client: server.client, invokeSend: server.invokeSend });
    expect(first.ok && first.action).toBe('sent');
    saveSendDraft({ ...draft, phase: 'sending' });
    const second = await runSendDocument({ draft: loadSendDraft(identity) as SendDraftState, vorgangId: 'v-o3' }, { client: server.client, invokeSend: server.invokeSend });
    expect(second).toMatchObject({ ok: true, action: 'replayed' });
    expect(server.rows.size).toBe(1);
    expect(server.sends).toEqual([draft.clientDeliveryId, draft.clientDeliveryId]);
    await expect(server.invokeSend.mock.results[1]?.value).resolves.toMatchObject({ body: { action: 'replayed' } });
  });

  it('O4: failed → Rechnung bleibt vorbereitet, Draft für bewussten Retry geräumt; unknown → nicht versendet, kein Draft-Replay', async () => {
    const invoice = finalizeInvoice('v-o4');
    const identity = { kind: 'invoice' as const, clientInvoiceId: invoice.id };
    const failed = fakeServer({ outcome: 'failed' });
    const d1 = createSendDraft({ identity, vorgangId: 'v-o4', recipientEmail: 'x@bounce.invalid', subject: 'S', bodyText: 'B' });
    const r1 = await runSendDocument({ draft: d1, vorgangId: 'v-o4' }, { client: failed.client, invokeSend: failed.invokeSend });
    expect(r1).toMatchObject({ ok: true, action: 'failed', delivery: { status: 'failed', errorCategory: 'recipient' } });
    expect(getVorgangInvoice('v-o4', invoice.id)!.status).toBe('vorbereitet');
    expect(loadSendDraft(identity)).toBeNull();

    const unknown = fakeServer({ outcome: 'unknown' });
    const d2 = createSendDraft({ identity, vorgangId: 'v-o4', recipientEmail: 'x@timeout.invalid', subject: 'S', bodyText: 'B', retryOfDeliveryId: 'd-1' });
    const r2 = await runSendDocument({ draft: d2, vorgangId: 'v-o4' }, { client: unknown.client, invokeSend: unknown.invokeSend });
    expect(r2).toMatchObject({ ok: true, action: 'unknown_pending', delivery: { status: 'unknown' } });
    expect(getVorgangInvoice('v-o4', invoice.id)!.status).toBe('vorbereitet');
    expect(loadSendDraft(identity)).toBeNull();
  });

  it('O5: Upload-Fehler → kein Create, kein Send; Server nicht erreichbar → Draft bleibt für technischen Replay', async () => {
    const invoice = finalizeInvoice('v-o5');
    const identity = { kind: 'invoice' as const, clientInvoiceId: invoice.id };
    const broken = fakeServer({ uploadError: { message: 'new row violates row-level security policy', statusCode: 403 } });
    const d1 = createSendDraft({ identity, vorgangId: 'v-o5', recipientEmail: 'kunde@example.invalid', subject: 'S', bodyText: 'B' });
    expect(await runSendDocument({ draft: d1, vorgangId: 'v-o5' }, { client: broken.client, invokeSend: broken.invokeSend })).toMatchObject({ ok: false, error: 'upload_failed' });
    expect(broken.rows.size).toBe(0);
    expect(broken.sends).toHaveLength(0);

    const offline = fakeServer();
    const d2 = createSendDraft({ identity, vorgangId: 'v-o5', recipientEmail: 'kunde@example.invalid', subject: 'S', bodyText: 'B' });
    const r2 = await runSendDocument({ draft: d2, vorgangId: 'v-o5' }, { client: offline.client, invokeSend: vi.fn(async () => { throw new TypeError('fetch failed'); }) });
    expect(r2).toMatchObject({ ok: false, error: 'server_unavailable' });
    expect(loadSendDraft(identity)?.clientDeliveryId).toBe(d2.clientDeliveryId);
    expect(loadSendDraft(identity)?.phase).toBe('creating');
    expect(getVorgangInvoice('v-o5', invoice.id)!.status).toBe('vorbereitet');
  });

  it('O6: manuell markierte Rechnung — Serverwahrheit officepilot bewahrt die manuellen Angaben; fremde Delivery überschreibt keine bestehende Kopplung', () => {
    const invoice = finalizeInvoice('v-o6');
    const marked = markInvoiceAsSent('v-o6', invoice.id, { sentAt: '2026-09-01', sentVia: 'post', sentNote: 'Brief' });
    expect(marked.ok && marked.invoice.sentSource).toBe('manual');
    const accepted = { id: 'd-9', workspaceId: WS, clientDeliveryId: 'cd-9', documentKind: 'invoice' as const, linkedInvoiceId: invoice.id, recipientEmail: 'k@example.invalid', subject: 'S', bodyText: 'B', provider: 'stub' as const, providerMessageId: 'm', status: 'provider_accepted' as const, requestedBy: 'u', requestedAt: '2026-09-14T10:00:00.000Z', providerAcceptedAt: '2026-09-14T10:01:00.000Z', attemptNumber: 1, createdAt: '', updatedAt: '', rowVersion: 2 };
    const upgraded = applyAcceptedDeliveryToLocalInvoice('v-o6', getVorgangInvoice('v-o6', invoice.id)!, accepted);
    expect(upgraded).toMatchObject({ status: 'versendet', sentSource: 'officepilot', sentDeliveryId: 'd-9', sentVia: 'email', sentManualPrior: { sentAt: '2026-09-01', sentVia: 'post', sentNote: 'Brief' } });
    const other = { ...accepted, id: 'd-10', clientDeliveryId: 'cd-10' };
    expect(applyAcceptedDeliveryToLocalInvoice('v-o6', upgraded, other).sentDeliveryId).toBe('d-9');
    // Ein späteres manuelles Korrigieren stuft nicht zurück.
    const again = markInvoiceAsSent('v-o6', invoice.id, { sentAt: '2026-09-02', sentVia: 'email' });
    expect(again.ok ? 'already' : again.reason).toBe('already_sent');
  });
});
