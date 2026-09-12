/**
 * MANUAL-INVOICE-UI-01B1B (N) — der Preflight einer Rechnung ohne Auftrag
 * darf nicht am Konflikt einer **anderen** freien Rechnung scheitern.
 *
 * Freie Rechnungen hängen fachlich nicht zusammen; die eigene Kennung entsteht
 * erst in `prepare`. Ein fremder Konflikt ist deshalb Warnung, kein Blocker.
 * Gegenprobe: derselbe Konflikt im Vorgangsbereich blockiert weiterhin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPersistedState, InvoiceDraft, VorgangInvoice } from '../../types/models';
import type { InvoiceDraftIdentity } from '../../types/invoiceDraftDurability';
import * as supabaseLib from '../../lib/supabase';
import * as persistenceService from '../persistenceService';
import * as workspaceSyncPayloadService from '../workspace/workspaceSyncPayloadService';
import * as vorgangStoreModule from '../vorgangService';
import { hydrateInvoiceStore, resetInvoiceStore } from './invoiceStore';
import { buildInvoicePayloadV1 } from './workspaceInvoiceFinalizeRequestValidator';
import { runInvoiceFinalizationPreflight } from './invoiceFinalizationPreflightService';
import {
  createInvoiceDraftRecord,
  resetInvoiceDraftDurabilityDatabaseForTests,
} from './invoiceDraftDurabilityService';
import { resetSyncOperationQueueForTests } from '../sync/syncOperationQueue';
import { resetStorageScopeForTests, setActiveStorageScope } from '../storage/storageScopeService';
import { resetTestStores } from '../../test/resetStores';
import { createTestVorgang } from '../../test/fixtures';

const WORKSPACE = 'ws-pre';
const SCOPE = 'workspace:ws-pre';
const VORGANG = 'vg-pre-1';

const COMPANY = {
  companyName: 'Cirmak Haustechnik GmbH', legalForm: 'GmbH', street: 'Ruhrallee 5', zip: '45138', city: 'Essen', country: 'Deutschland',
  contactPerson: '', phone: '', email: '', website: '', taxNumber: '27/123/45678', vatId: 'DE123456789', bankName: 'Sparkasse',
  iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', defaultPaymentDays: 14, defaultPaymentTerms: '14 Tage', defaultSkonto: '', invoiceFooterNotes: '',
};

function otherFreeInvoice(customerId: string): VorgangInvoice {
  return {
    id: 'inv-other', number: '2026-0005', invoiceSequenceNumber: 5, type: 'rechnung', status: 'vorbereitet',
    positions: [{ id: 'l', description: 'X', quantity: 1, unit: 'Stück', unitPrice: 10, lineTotal: 10 }],
    subtotal: 10, amount: 11.9, taxStatus: 'standard_19', date: '2026-09-01', issueDate: '2026-09-01',
    createdAt: '2026-09-01T00:00:00.000Z', paymentDueDate: '2026-09-15', paymentTermsText: '', skontoText: '',
    payments: [], paymentStatus: 'offen', legalNotices: [], previousAbschlagDeductions: [],
    customerSnapshot: { name: 'Fremd GmbH', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
    companySnapshot: COMPANY, customerId,
  } as unknown as VorgangInvoice;
}

function cloudRow(invoice: VorgangInvoice, vorgangId: string | null) {
  return {
    id: 'cloud-other', workspace_id: WORKSPACE, vorgang_id: vorgangId, client_invoice_id: invoice.id,
    invoice_number: invoice.number, invoice_year: 2026, invoice_sequence_number: 5, invoice_type: 'rechnung',
    invoice_status: 'vorbereitet', payload: buildInvoicePayloadV1(invoice), row_version: 1,
    created_at: invoice.createdAt, updated_at: invoice.createdAt,
  };
}

function draft(vorgangId: string | null): InvoiceDraft {
  return {
    id: 'draft-pre', vorgangId, customerId: 'cust-neu', customer: 'Neu GmbH', baustelle: '', type: 'rechnung',
    taxStatus: 'standard_19', materialSource: 'betrieb',
    positions: [{ id: 'p', description: 'Anfahrt', quantity: 1, unit: 'Pauschal', unitLabel: 'Pauschal', unitPrice: 45, billable: true }],
    issueDate: '2026-09-12', servicePeriodFrom: '2026-09-01', servicePeriodTo: '2026-09-01', servicePeriodConfirmed: true,
    paymentDueDate: '2026-09-26', paymentTermsText: '14 Tage', skontoText: '',
    customerBilling: { name: 'Neu GmbH', contactPerson: '', street: 'W 1', zip: '1', city: 'E', email: '', phone: '' },
    companySnapshot: COMPANY, legalNotices: [], previousAbschlagDeductions: [], invoiceNumberPreview: 'Vorschau', introText: '', closingText: '',
  } as InvoiceDraft;
}

function identity(vorgangId: string | null): InvoiceDraftIdentity {
  return { sourceScopeKey: SCOPE, workspaceId: WORKSPACE, vorgangId, invoiceType: 'rechnung', draftId: 'draft-pre' };
}

let rows: unknown[] = [];
let snapshot: AppPersistedState;

beforeEach(async () => {
  vi.restoreAllMocks();
  resetTestStores();
  resetInvoiceStore();
  resetSyncOperationQueueForTests();
  localStorage.clear();
  rows = [];
  snapshot = {
    version: 1, setup: { companyName: COMPANY.companyName, taxStatus: 'standard_19' }, inboxItems: [], tasks: [], documents: [],
    vorgaenge: [createTestVorgang({ id: VORGANG, invoices: [] })], workspace: { id: WORKSPACE },
    syncClient: { serverWorkspaceId: WORKSPACE, workspaceId: WORKSPACE, deviceId: 'd1' },
  } as unknown as AppPersistedState;
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockImplementation(
    () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: 'u' } } }, error: null }) }, rpc: async () => ({ data: rows, error: null }) }) as never,
  );
  vi.spyOn(workspaceSyncPayloadService, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE);
  vi.spyOn(persistenceService, 'buildPersistedStateSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(persistenceService, 'savePersistedState').mockImplementation((state) => { snapshot = state; return true; });
  vi.spyOn(persistenceService, 'applyStateToStores').mockImplementation(() => undefined);
  vi.spyOn(vorgangStoreModule, 'getVorgangStoreSnapshot').mockImplementation(() => (snapshot.vorgaenge ?? []) as never);
  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
  await resetInvoiceDraftDurabilityDatabaseForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetStorageScopeForTests();
  await resetInvoiceDraftDurabilityDatabaseForTests();
  resetTestStores();
});

describe('01B1B (N) — Fremdkonflikt im Preflight', () => {
  it('N1: der Kundenkonflikt einer ANDEREN freien Rechnung blockiert den neuen Manual-Entwurf nicht', async () => {
    hydrateInvoiceStore([{ invoice: otherFreeInvoice('cust-a'), vorgangId: null }]);
    rows = [cloudRow(otherFreeInvoice('cust-b'), null)];
    expect((await createInvoiceDraftRecord({ identity: identity(null), draft: draft(null), now: '2026-09-12T08:00:00.000Z' })).ok).toBe(true);

    const result = await runInvoiceFinalizationPreflight({ identity: identity(null), expectedRevision: 1 });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    // Der Konflikt geht nicht verloren — er wird gemeldet, nicht verschluckt.
    expect(result.cloudReconciliation.warnings.some((w) => w.includes('customer_relation_conflict'))).toBe(true);
  });

  it('N2: derselbe Konflikt im eigenen Vorgangsbereich blockiert weiterhin', async () => {
    const vorgangInvoice = otherFreeInvoice('cust-a');
    snapshot = {
      ...snapshot,
      vorgaenge: [createTestVorgang({ id: VORGANG, invoices: [vorgangInvoice] })],
    } as AppPersistedState;
    hydrateInvoiceStore([{ invoice: vorgangInvoice, vorgangId: VORGANG }]);
    rows = [cloudRow(otherFreeInvoice('cust-b'), VORGANG)];
    expect((await createInvoiceDraftRecord({ identity: identity(VORGANG), draft: draft(VORGANG), now: '2026-09-12T08:00:00.000Z' })).ok).toBe(true);

    const result = await runInvoiceFinalizationPreflight({ identity: identity(VORGANG), expectedRevision: 1 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason, JSON.stringify(result)).toBe('merge_conflict');
  });
});
