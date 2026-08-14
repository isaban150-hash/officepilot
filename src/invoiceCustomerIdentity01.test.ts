/**
 * CORE-COMPLETE-GOLDEN-PATH-01B — Kundenidentität vom Vorgang bis in die
 * finalisierte Rechnung.
 *
 * Zwei getrennte Wahrheiten:
 *  - der Vorgang hält customerId, customer und customerBilling
 *  - die finalisierte Rechnung friert den vollständigen CustomerBilling-Wert
 *    in customerSnapshot ein (die Rechnung speichert KEINE customerId)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as supabaseLib from './lib/supabase';
import { getCompanyProfile, hydrateCompanyProfileStore } from './services/companyProfileService';
import { billingFromCustomer, createCustomer, updateCustomer } from './services/customerService';
import { getCustomerById, getCustomerStoreSnapshot } from './services/customerStoreService';
import { hydrateDocumentStore } from './services/documentService';
import { getInboxItemById, hydrateInboxStore } from './services/inboxService';
import { finalizeInvoiceDraftWithCloud } from './services/invoice/invoiceCloudFinalizeOrchestrator';
import { resetInvoiceFinalizeIntentsForTests } from './services/invoice/invoiceFinalizeIntentService';
import * as workspaceInvoiceCloud from './services/invoice/workspaceInvoiceCloudService';
import {
  buildRechnungDraft,
  updateInvoiceDraftMetadata,
  validateInvoiceDraftForApproval,
} from './services/invoiceService';
import { buildInvoicePrintModelFromInvoice } from './services/invoicePrintModel';
import { clearInMemoryBusinessState } from './services/persistenceService';
import { bootstrapBusinessState } from './services/storage/storageBootstrapService';
import {
  assignCustomerToVorgang,
  createVorgangFromInbox,
  getVorgangById,
  hydrateVorgangStore,
} from './services/vorgangService';
import { setWorkspace } from './services/workspace/workspaceStore';
import { createAuftragInboxItem, testSetup } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { CustomerDecision } from './services/customerService';
import type { CustomerBilling, InboxItem, Vorgang, VorgangInvoice } from './types/models';

const OWN = 'Cirmak Haustechnik GmbH';
const WORKSPACE_ID = 'ws-golden-01b';
const USER_ID = 'user-golden-01b';

const NORDWEST = {
  name: 'NordWest Dachbau GmbH',
  contactPerson: 'Frau Nordmann',
  street: 'Hafenstraße 12',
  zip: '45356',
  city: 'Essen',
  email: 'kontakt@nordwest-dachbau.de',
  phone: '0201 4711',
};

/** Die UI erfasst bei „Neuer Kunde“ ausschließlich den Namen. */
const UI_NEW_CUSTOMER_INPUT = { name: NORDWEST.name };

const OWN_PROFILE = {
  companyName: OWN,
  legalForm: 'GmbH',
  street: 'Ruhrallee 5',
  zip: '45138',
  city: 'Essen',
  country: 'Deutschland',
  contactPerson: 'Herr Cirmak',
  phone: '0201 999999',
  email: 'buero@cirmak-haustechnik.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

/** Rechnungsanschrift, die der Nutzer im Entwurf ergänzt. */
const DRAFT_ADDRESS: Partial<CustomerBilling> = {
  street: 'Hafenstraße 12',
  zip: '45356',
  city: 'Essen',
};

function mockCloudReady() {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 't' } }, error: null }),
    },
  } as never);
  setWorkspace({
    id: WORKSPACE_ID,
    name: 'Testbetrieb',
    ownerUserId: USER_ID,
    createdAt: '2026-05-04T09:00:00.000Z',
    updatedAt: '2026-05-04T09:00:00.000Z',
    version: 1,
  });
}

function mockRpcSuccess(number = '2026-0100', sequence = 100) {
  return vi
    .spyOn(workspaceInvoiceCloud, 'rpcFinalizeWorkspaceInvoice')
    .mockImplementation(async (input) => ({
      invoice: {
        ...input.invoice,
        number,
        invoiceSequenceNumber: sequence,
        status: 'vorbereitet' as const,
      },
      idempotentReplay: false,
      rowVersion: 1,
      cloudInvoiceId: `cloud-${sequence}`,
    }));
}

function seedItem(overrides: Partial<InboxItem> = {}): InboxItem {
  const item = createAuftragInboxItem({
    id: 'inbox-golden-01b',
    title: 'Werkvertrag NordWest',
    sender: NORDWEST.name,
    recognizedData: {
      Kunde: NORDWEST.name,
      Leistung: 'Dachsanierung Nord',
      Angebotssumme: '5.000 €',
    },
    ...overrides,
  });
  hydrateInboxStore([item]);
  return getInboxItemById(item.id)!;
}

/** Vorgang über den echten Handoff; die Auftragsposition stammt aus dem Produktionsbauer. */
function createVorgangWithDecision(decision: CustomerDecision): Vorgang {
  const item = seedItem();
  const result = createVorgangFromInbox(item, undefined, 'betrieb', {
    customerDecision: decision,
  });
  expect(result).not.toBeNull();
  const vorgang = getVorgangById(result!.vorgang.id)!;
  expect(vorgang.orderPositions.length).toBeGreaterThan(0);
  const position = vorgang.orderPositions[0]!;
  expect(position.plannedQuantity).toBeGreaterThan(0);
  expect(position.unitPrice).toBeGreaterThan(0);
  expect(position.billable).not.toBe(false);
  return vorgang;
}

/** Prüft die vorbefüllte Pauschalposition — schließt no_positions ausdrücklich aus. */
function expectSinglePauschalPosition(draft: { positions: readonly unknown[] }): void {
  const positions = draft.positions as Array<{
    billable: boolean;
    quantity: number;
    unit: string;
    unitPrice: number;
  }>;
  expect(positions).toHaveLength(1);
  expect(positions[0]!.billable).toBe(true);
  expect(positions[0]!.quantity).toBe(1);
  expect(positions[0]!.unit).toBe('Pauschal');
  expect(positions[0]!.unitPrice).toBe(5000);
}

/** Entwurf inkl. der vom Nutzer ergänzten Rechnungsanschrift. */
function buildApprovableDraft(vorgangId: string) {
  const vorgang = getVorgangById(vorgangId);
  expect(vorgang).toBeDefined();
  const base = buildRechnungDraft(vorgangId, testSetup);
  expect(base).not.toBeNull();
  expectSinglePauschalPosition(base!);

  const draft = updateInvoiceDraftMetadata(base!, { customerBilling: DRAFT_ADDRESS });
  const validation = validateInvoiceDraftForApproval(draft, getCompanyProfile(), vorgang);
  expect(validation.blockingErrors, JSON.stringify(validation.blockingErrors)).toHaveLength(0);
  return draft;
}

describe('CORE-COMPLETE-GOLDEN-PATH-01B', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    hydrateDocumentStore([]);
    resetInvoiceFinalizeIntentsForTests();
    hydrateCompanyProfileStore(OWN_PROFILE);
    bootstrapBusinessState({ userId: USER_ID, workspaceId: WORKSPACE_ID });
    hydrateCompanyProfileStore(OWN_PROFILE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
    localStorage.clear();
  });

  it('Fall A — CustomerDecision bei Vorgangserstellung erreicht den Rechnungsentwurf', () => {
    const vorgang = createVorgangWithDecision({ kind: 'new', input: UI_NEW_CUSTOMER_INPUT });

    const customers = getCustomerStoreSnapshot();
    expect(customers).toHaveLength(1);
    const customer = customers[0]!;
    expect(vorgang.customerId).toBe(customer.id);
    expect(vorgang.customer).toBe(NORDWEST.name);
    expect(vorgang.customerBilling).toEqual({
      name: NORDWEST.name,
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    });
    expect(vorgang.customerExplicitlyUnknown).toBeUndefined();

    // Der Entwurf übernimmt zunächst exakt den Vorgangssnapshot.
    const base = buildRechnungDraft(vorgang.id, testSetup);
    expect(base).not.toBeNull();
    expect(base!.customerBilling).toEqual(vorgang.customerBilling);
    expectSinglePauschalPosition(base!);

    // Ohne Anschrift blockt die Freigabe — der Guard ist wirksam.
    const beforeAddress = validateInvoiceDraftForApproval(base!, getCompanyProfile(), vorgang);
    expect(beforeAddress.blockingErrors.some((issue) => issue.code === 'customer_address')).toBe(
      true,
    );
    expect(beforeAddress.blockingErrors.some((issue) => issue.code === 'no_positions')).toBe(false);

    // Anschrift ausschließlich über die Produktionsfunktion ergänzen.
    const draft = updateInvoiceDraftMetadata(base!, { customerBilling: DRAFT_ADDRESS });
    expect(draft.customerBilling.name).toBe(NORDWEST.name);
    expect(draft.customerBilling.street).toBe('Hafenstraße 12');
    expect(draft.customerBilling.zip).toBe('45356');
    expect(draft.customerBilling.city).toBe('Essen');
    const validation = validateInvoiceDraftForApproval(draft, getCompanyProfile(), vorgang);
    expect(validation.blockingErrors, JSON.stringify(validation.blockingErrors)).toHaveLength(0);
  });

  it('Fall B — U4-Zuordnung, echte Finalisierung, Snapshot und Bootstrap', async () => {
    // Bestehender, vollständig ausgefüllter Customer.
    const created = createCustomer(NORDWEST);
    expect(created.success).toBe(true);
    if (!created.success) return;
    const customerId = created.customer.id;

    // Vorgang zunächst ausdrücklich ohne Kunden.
    const unknown = createVorgangWithDecision({ kind: 'none' });
    expect(unknown.customer).toBe('');
    expect(unknown.customerId).toBeUndefined();
    expect(unknown.customerExplicitlyUnknown).toBe(true);

    // Nachträgliche Zuordnung per ID.
    const assigned = assignCustomerToVorgang(unknown.id, { kind: 'existing', customerId });
    expect(assigned.success).toBe(true);
    if (!assigned.success) return;

    const withCustomer = getVorgangById(unknown.id)!;
    expect(withCustomer.customerId).toBe(customerId);
    expect(withCustomer.customer).toBe(NORDWEST.name);
    expect(withCustomer.customerBilling).toEqual(NORDWEST);
    expect(withCustomer.customerExplicitlyUnknown).toBeUndefined();
    expect(getCustomerStoreSnapshot()).toHaveLength(1);

    // --- Echte Finalisierung über den UI-Pfad.
    mockCloudReady();
    const rpcSpy = mockRpcSuccess();
    const draft = buildApprovableDraft(withCustomer.id);
    expect(draft.customerBilling.name).toBe(NORDWEST.name);
    expect(draft.customerBilling.street).toBe('Hafenstraße 12');
    expect(draft.customerBilling.zip).toBe('45356');
    expect(draft.customerBilling.city).toBe('Essen');
    const approvedBilling: CustomerBilling = { ...draft.customerBilling };

    const finalized = await finalizeInvoiceDraftWithCloud(withCustomer.id, draft, testSetup);
    expect(finalized.ok, finalized.ok ? '' : JSON.stringify(finalized)).toBe(true);
    if (!finalized.ok) return;
    expect(rpcSpy).toHaveBeenCalledTimes(1);

    const afterFinalize = getVorgangById(withCustomer.id)!;
    expect(afterFinalize.invoices).toHaveLength(1);
    const invoice = afterFinalize.invoices[0]!;
    expect(invoice.number).toBeTruthy();
    expect(invoice.type).toBe('rechnung');
    expect(invoice.customerSnapshot).toBeDefined();
    expect(invoice.customerSnapshot).toEqual(approvedBilling);
    expect(invoice.customerSnapshot?.name).toBe(NORDWEST.name);
    expect(invoice.customerSnapshot?.city).toBe('Essen');
    // Die Rechnung trägt keine Customer-ID — die Verbindung läuft über den Vorgang.
    expect('customerId' in invoice).toBe(false);
    expect(afterFinalize.customerId).toBe(customerId);
    expect(getCustomerStoreSnapshot()).toHaveLength(1);

    const printModel = buildInvoicePrintModelFromInvoice(invoice);
    expect(printModel.customer).toEqual(approvedBilling);

    // --- Snapshot-Unveränderlichkeit nach produktiver Customer-Änderung.
    const billingBeforeChange: CustomerBilling = { ...afterFinalize.customerBilling! };
    const updated = updateCustomer(customerId, { city: 'Bochum', contactPerson: 'Herr Nord' });
    expect(updated.success).toBe(true);
    expect(getCustomerById(customerId)?.city).toBe('Bochum');

    const afterCustomerChange = getVorgangById(withCustomer.id)!;
    expect(afterCustomerChange.customerId).toBe(customerId);
    expect(afterCustomerChange.customer).toBe(NORDWEST.name);
    expect(afterCustomerChange.customerBilling).toEqual(billingBeforeChange);
    expect(afterCustomerChange.invoices[0]?.customerSnapshot).toEqual(approvedBilling);
    expect(buildInvoicePrintModelFromInvoice(afterCustomerChange.invoices[0]!).customer).toEqual(
      approvedBilling,
    );

    // --- Bootstrap: nur In-Memory leeren, localStorage bleibt.
    const expectedVorgang = getVorgangById(withCustomer.id)!;
    const expectedInvoice = expectedVorgang.invoices[0]!;
    clearInMemoryBusinessState();
    expect(getVorgangById(withCustomer.id)).toBeUndefined();
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    bootstrapBusinessState({ userId: USER_ID, workspaceId: WORKSPACE_ID });

    const reloaded = getVorgangById(withCustomer.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.customerId).toBe(customerId);
    expect(reloaded!.customer).toBe(NORDWEST.name);
    expect(reloaded!.customerBilling).toEqual(expectedVorgang.customerBilling);
    expect(reloaded!.invoices).toHaveLength(1);
    expect(reloaded!.invoices[0]?.customerSnapshot).toEqual(approvedBilling);
    expect(reloaded!.invoices[0]?.number).toBe(expectedInvoice.number);
    expect(buildInvoicePrintModelFromInvoice(reloaded!.invoices[0]!).customer).toEqual(
      approvedBilling,
    );
    expect(getCustomerStoreSnapshot()).toHaveLength(1);
    expect(getCustomerById(customerId)?.city).toBe('Bochum');
  });

  it('Fall C — 05B: ausdrücklich übernommene Stammdaten frieren nur in der neuen Rechnung ein', async () => {
    const created = createCustomer(NORDWEST);
    expect(created.success).toBe(true);
    if (!created.success) return;
    const customerId = created.customer.id;

    // Gemeinsamer Mapper liefert genau die sieben Felder.
    expect(billingFromCustomer(created.customer)).toEqual({
      name: NORDWEST.name,
      contactPerson: NORDWEST.contactPerson,
      street: NORDWEST.street,
      zip: NORDWEST.zip,
      city: NORDWEST.city,
      email: NORDWEST.email,
      phone: NORDWEST.phone,
    });

    // Vorgangserstellung verhält sich unverändert: Snapshot aus demselben Mapper.
    const vorgang = createVorgangWithDecision({ kind: 'existing', customerId });
    expect(vorgang.customerId).toBe(customerId);
    expect(vorgang.customerBilling).toEqual(NORDWEST);

    /**
     * Bestehende pauschale Abschlagsrechnung: modellgültig, mit leerer
     * Positionsliste — sie verbraucht daher keine Menge der Auftragsposition.
     */
    const firstBilling: CustomerBilling = { ...NORDWEST };
    const existingInvoice: VorgangInvoice = {
      id: 'inv-05b-alt',
      number: '2026-0201',
      type: 'abschlag',
      abschlagNumber: 1,
      calculationMode: 'fixed_amount',
      fixedAmountNet: 1000,
      positions: [],
      subtotal: 1000,
      taxStatus: 'standard_19',
      amount: 1190,
      status: 'versendet',
      date: '2026-06-01',
      createdAt: '2026-06-01T10:00:00.000Z',
      issueDate: '2026-06-01',
      paymentStatus: 'offen',
      payments: [],
      customerSnapshot: { ...firstBilling },
      companySnapshot: getCompanyProfile(),
      legalNotices: [],
      previousAbschlagDeductions: [],
    };
    hydrateVorgangStore([{ ...getVorgangById(vorgang.id)!, invoices: [existingInvoice] }]);

    const afterFirst = getVorgangById(vorgang.id)!;
    expect(afterFirst.invoices).toHaveLength(1);
    expect(afterFirst.invoices[0]!.customerSnapshot).toBeDefined();
    expect(afterFirst.invoices[0]!.customerSnapshot).toEqual(firstBilling);

    // Stammdaten ändern sich; Vorgang und erste Rechnung bleiben unberührt.
    const renamed = updateCustomer(customerId, {
      name: 'NordWest Dachbau Nord GmbH',
      street: 'Ruhrallee 5',
      zip: '44787',
      city: 'Bochum',
      contactPerson: 'Herr Nordmann',
      email: 'neu@nordwest-dachbau.de',
      phone: '0234 999999',
    });
    expect(renamed.success).toBe(true);
    if (!renamed.success) return;
    const masterBilling = billingFromCustomer(renamed.customer);
    expect(getVorgangById(vorgang.id)!.customerBilling).toEqual(NORDWEST);

    // Zweiter Entwurf: erst der Vorgangssnapshot, dann die ausdrückliche Übernahme.
    // buildApprovableDraft belegt dabei die weiterhin offene Pauschalposition mit Menge 1.
    const secondBase = buildApprovableDraft(vorgang.id);
    expect(secondBase.customerBilling).toEqual(firstBilling);
    const secondDraft = updateInvoiceDraftMetadata(secondBase, { customerBilling: masterBilling });
    expect(secondDraft.customerBilling).toEqual(masterBilling);

    mockCloudReady();
    const secondRpc = mockRpcSuccess('2026-0202', 202);
    const secondResult = await finalizeInvoiceDraftWithCloud(vorgang.id, secondDraft, testSetup);
    expect(secondResult.ok, secondResult.ok ? '' : JSON.stringify(secondResult)).toBe(true);
    expect(secondRpc).toHaveBeenCalledTimes(1);

    const afterSecond = getVorgangById(vorgang.id)!;
    expect(afterSecond.invoices).toHaveLength(2);
    const firstInvoice = afterSecond.invoices.find((inv) => inv.number === '2026-0201')!;
    const secondInvoice = afterSecond.invoices.find((inv) => inv.number === '2026-0202')!;
    expect(firstInvoice.customerSnapshot).toBeDefined();
    expect(secondInvoice.customerSnapshot).toBeDefined();
    // Nur die neue Rechnung trägt die übernommenen Stammdaten.
    expect(secondInvoice.customerSnapshot).toEqual(masterBilling);
    expect(firstInvoice.customerSnapshot).toEqual(firstBilling);
    expect(secondInvoice.customerSnapshot).not.toEqual(firstInvoice.customerSnapshot);
    // Das Druckmodell folgt je Rechnung ihrem eigenen eingefrorenen Snapshot.
    expect(buildInvoicePrintModelFromInvoice(firstInvoice).customer).toEqual(firstBilling);
    expect(buildInvoicePrintModelFromInvoice(secondInvoice).customer).toEqual(masterBilling);
    // Customer und Vorgangssnapshot bleiben unverändert.
    expect(getCustomerById(customerId)).toEqual(renamed.customer);
    expect(afterSecond.customerId).toBe(customerId);
    expect(afterSecond.customer).toBe(NORDWEST.name);
    expect(afterSecond.customerBilling).toEqual(NORDWEST);

    // Bootstrap erhält beide eingefrorenen Snapshots.
    clearInMemoryBusinessState();
    expect(getVorgangById(vorgang.id)).toBeUndefined();
    bootstrapBusinessState({ userId: USER_ID, workspaceId: WORKSPACE_ID });
    const reloaded = getVorgangById(vorgang.id)!;
    expect(reloaded.invoices).toHaveLength(2);
    expect(
      reloaded.invoices.find((inv) => inv.number === '2026-0201')!.customerSnapshot,
    ).toEqual(firstBilling);
    expect(
      reloaded.invoices.find((inv) => inv.number === '2026-0202')!.customerSnapshot,
    ).toEqual(masterBilling);
    expect(
      buildInvoicePrintModelFromInvoice(
        reloaded.invoices.find((inv) => inv.number === '2026-0202')!,
      ).customer,
    ).toEqual(masterBilling);
    expect(reloaded.customerBilling).toEqual(NORDWEST);
  });
});
