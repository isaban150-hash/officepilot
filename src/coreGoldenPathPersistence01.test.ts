/**
 * CORE-REALTEST-01B — die bisher fehlende Verbindung in einem Lauf:
 *
 *   alter Rechnungssnapshot
 *   → Customer-Stamm ändern (05A)
 *   → Vorgang bleibt zunächst alt
 *   → ausdrückliche 06B-Übernahme
 *   → neuer Rechnungsentwurf
 *   → echte Finalisierung
 *   → App-State leeren
 *   → echter Bootstrap
 *
 * Kein PDF-, OCR-, Rollen- oder Positionsextraktionstest. Keine Fachfunktion
 * gemockt; nur die Supabase-Grenze und der RPC-Aufruf sind Testadapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as supabaseLib from './lib/supabase';
import { getCompanyProfile, hydrateCompanyProfileStore } from './services/companyProfileService';
import { createCustomer, updateCustomer } from './services/customerService';
import { getCustomerById, getCustomerStoreSnapshot } from './services/customerStoreService';
import { getAllDocuments, getDocumentById, hydrateDocumentStore } from './services/documentService';
import { finalizeInvoiceDraftWithCloud } from './services/invoice/invoiceCloudFinalizeOrchestrator';
import { resetInvoiceFinalizeIntentsForTests } from './services/invoice/invoiceFinalizeIntentService';
import * as workspaceInvoiceCloud from './services/invoice/workspaceInvoiceCloudService';
import { buildRechnungDraft, validateInvoiceDraftForApproval } from './services/invoiceService';
import { clearInMemoryBusinessState } from './services/persistenceService';
import { bootstrapBusinessState } from './services/storage/storageBootstrapService';
import {
  getAllVorgaenge,
  getVorgangById,
  hydrateVorgangStore,
  updateVorgangCustomerFromMaster,
} from './services/vorgangService';
import { setWorkspace } from './services/workspace/workspaceStore';
import { createAbschlagInvoice, createOrderPosition, createTestVorgang, testSetup } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { CompanyDocument, CustomerBilling, Vorgang, VorgangInvoice } from './types/models';

const OWN = 'Cirmak Haustechnik GmbH';
const WORKSPACE_ID = 'ws-golden-01b-persist';
const USER_ID = 'user-golden-01b-persist';

const VORGANG_ID = 'v-golden-persist';
const POSITION_ID = 'op-golden-persist';
const OLD_INVOICE_ID = 'inv-golden-old';
const DOCUMENT_ID = 'doc-golden-persist';

/** Stammdaten vor der Pflege — zugleich Vorgangssnapshot und alter Rechnungssnapshot. */
const OLD_MASTER: CustomerBilling = {
  name: 'Rheinbau Partner GmbH',
  contactPerson: 'Frau Alt',
  street: 'Altweg 7',
  zip: '50667',
  city: 'Köln',
  email: 'alt@rheinbau-partner.de',
  phone: '0221 1111',
};

/** Stammdaten nach der Pflege — alle sieben Felder verschieden. */
const NEW_MASTER: CustomerBilling = {
  name: 'Rheinbau Partner Nord GmbH',
  contactPerson: 'Herr Neu',
  street: 'Rheinallee 3',
  zip: '40213',
  city: 'Düsseldorf',
  email: 'neu@rheinbau-partner.de',
  phone: '0211 2222',
};

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

const FIELDS: Array<keyof CustomerBilling> = [
  'name',
  'contactPerson',
  'street',
  'zip',
  'city',
  'email',
  'phone',
];

function bootstrapScope(): void {
  bootstrapBusinessState({ userId: USER_ID, workspaceId: WORKSPACE_ID });
}

/** Externe Grenze: kein Netzwerk, keine Fachfunktion gemockt. */
function mockCloudReady(): void {
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

function mockRpcSuccess(number: string, sequence: number) {
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

function billingOf(customer: {
  name: string;
  contactPerson: string;
  street: string;
  zip: string;
  city: string;
  email: string;
  phone: string;
}): CustomerBilling {
  return {
    name: customer.name,
    contactPerson: customer.contactPerson,
    street: customer.street,
    zip: customer.zip,
    city: customer.city,
    email: customer.email,
    phone: customer.phone,
  };
}

/** Bereits abgerechnete Teilleistung mit vollständigem altem Snapshot. */
function oldInvoice(): VorgangInvoice {
  return createAbschlagInvoice(POSITION_ID, 4, {
    id: OLD_INVOICE_ID,
    number: 'AR-2026-0001',
    status: 'versendet',
    customerSnapshot: { ...OLD_MASTER },
  });
}

function linkedDocument(): CompanyDocument {
  return {
    id: DOCUMENT_ID,
    title: 'Werkvertrag',
    category: 'vertrag',
    issuer: OLD_MASTER.name,
    recognizedText: '',
    digitalFolder: { id: 'dig-1', name: 'Verträge', path: '/Vertraege/' },
    paperFolder: { folderId: 'p1', register: 'A', label: 'Ordner 1' },
    tags: [],
    linkedCompany: '',
    linkedVorgang: { vorgangId: VORGANG_ID, vorgangTitle: 'Dachsanierung' },
    archived: false,
    createdAt: '2026-02-01T09:00:00.000Z',
  } as CompanyDocument;
}

function seedVorgang(customerId: string): Vorgang {
  hydrateVorgangStore([
    createTestVorgang({
      id: VORGANG_ID,
      title: 'Dachsanierung',
      customer: OLD_MASTER.name,
      customerId,
      customerBilling: { ...OLD_MASTER },
      orderPositions: [
        createOrderPosition({
          id: POSITION_ID,
          description: 'Dacharbeiten',
          plannedQuantity: 10,
          unit: 'Stunden',
          unitPrice: 65,
        }),
      ],
      invoices: [oldInvoice()],
    }),
  ]);
  hydrateDocumentStore([linkedDocument()]);
  return getVorgangById(VORGANG_ID)!;
}

describe('CORE-REALTEST-01B — Snapshot- und Bootstrap-Golden-Path', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    hydrateDocumentStore([]);
    resetInvoiceFinalizeIntentsForTests();
    hydrateCompanyProfileStore(OWN_PROFILE);
    bootstrapScope();
    hydrateCompanyProfileStore(OWN_PROFILE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
    localStorage.clear();
  });

  it('führt Stammpflege, 06B-Übernahme, Finalisierung und Neustart in einer Kette', async () => {
    // --- 3. Ausgangszustand -------------------------------------------------
    const created = createCustomer({ ...OLD_MASTER });
    expect(created.success).toBe(true);
    if (!created.success) return;
    const customerId = created.customer.id;
    expect(customerId).toBeTruthy();
    expect(billingOf(created.customer)).toEqual(OLD_MASTER);

    const seeded = seedVorgang(customerId);
    expect(seeded.id).toBe(VORGANG_ID);
    expect(seeded.customerId).toBe(customerId);
    expect(seeded.customer).toBe(OLD_MASTER.name);
    expect(seeded.customerBilling).toEqual(OLD_MASTER);
    expect(seeded.invoices).toHaveLength(1);
    const oldInvoiceBefore = seeded.invoices.find((inv) => inv.id === OLD_INVOICE_ID)!;
    expect(oldInvoiceBefore).toBeDefined();
    expect(oldInvoiceBefore.customerSnapshot).toEqual(OLD_MASTER);
    // Offene Restleistung für die neue Rechnung: 10 geplant, 4 abgerechnet.
    expect(seeded.orderPositions[0]!.plannedQuantity).toBe(10);
    expect(oldInvoiceBefore.positions[0]!.quantity).toBe(4);

    const documentBefore = getDocumentById(DOCUMENT_ID);
    expect(documentBefore).toBeDefined();
    expect(documentBefore!.linkedVorgang?.vorgangId).toBe(VORGANG_ID);

    // --- 4. Customer-Stamm ändern ------------------------------------------
    const updated = updateCustomer(customerId, NEW_MASTER);
    expect(updated.success).toBe(true);
    if (!updated.success) return;
    expect(billingOf(updated.customer)).toEqual(NEW_MASTER);
    expect(updated.customer.id).toBe(customerId);

    const afterMasterChange = getVorgangById(VORGANG_ID)!;
    expect(afterMasterChange.customer).toBe(OLD_MASTER.name);
    expect(afterMasterChange.customerBilling).toEqual(OLD_MASTER);
    expect(afterMasterChange.invoices.find((inv) => inv.id === OLD_INVOICE_ID)).toEqual(
      oldInvoiceBefore,
    );
    expect(getDocumentById(DOCUMENT_ID)!.linkedVorgang?.vorgangId).toBe(VORGANG_ID);

    // --- 5. Ausdrückliche 06B-Übernahme ------------------------------------
    const takeover = updateVorgangCustomerFromMaster(VORGANG_ID);
    expect(takeover.success).toBe(true);
    if (!takeover.success) return;
    expect(takeover.changed).toBe(true);

    const afterTakeover = getVorgangById(VORGANG_ID)!;
    expect(afterTakeover.customer).toBe(NEW_MASTER.name);
    expect(afterTakeover.customerBilling).toEqual(NEW_MASTER);
    for (const field of FIELDS) {
      expect(afterTakeover.customerBilling![field], field).toBe(updated.customer[field]);
    }
    expect(afterTakeover.customerId).toBe(customerId);
    expect(getCustomerById(customerId)).toEqual(updated.customer);
    expect(afterTakeover.invoices.find((inv) => inv.id === OLD_INVOICE_ID)).toEqual(
      oldInvoiceBefore,
    );
    expect(getDocumentById(DOCUMENT_ID)!.linkedVorgang?.vorgangId).toBe(VORGANG_ID);

    // --- 6. Neuer Rechnungsentwurf -----------------------------------------
    const draft = buildRechnungDraft(VORGANG_ID, testSetup);
    expect(draft).not.toBeNull();
    expect(draft!.customerBilling).toEqual(NEW_MASTER);
    expect(draft!.customerBilling.street).not.toBe(OLD_MASTER.street);
    expect(draft!.customerBilling.name).not.toBe(OLD_MASTER.name);
    // Restmenge aus der Produktionsberechnung, keine umgangene Validierung.
    expect(draft!.positions).toHaveLength(1);
    expect(draft!.positions[0]!.quantity).toBe(6);
    const validation = validateInvoiceDraftForApproval(
      draft!,
      getCompanyProfile(),
      getVorgangById(VORGANG_ID),
    );
    expect(validation.blockingErrors, JSON.stringify(validation.blockingErrors)).toHaveLength(0);
    expect(getVorgangById(VORGANG_ID)!.invoices.find((inv) => inv.id === OLD_INVOICE_ID)).toEqual(
      oldInvoiceBefore,
    );

    // --- 7. Echte Finalisierung --------------------------------------------
    mockCloudReady();
    const rpcSpy = mockRpcSuccess('2026-0301', 301);
    const finalized = await finalizeInvoiceDraftWithCloud(VORGANG_ID, draft!, testSetup);
    expect(finalized.ok, finalized.ok ? '' : JSON.stringify(finalized)).toBe(true);
    if (!finalized.ok) return;
    expect(rpcSpy).toHaveBeenCalledTimes(1);

    const afterFinalize = getVorgangById(VORGANG_ID)!;
    expect(afterFinalize.invoices).toHaveLength(2);
    const oldAfter = afterFinalize.invoices.find((inv) => inv.id === OLD_INVOICE_ID)!;
    const newInvoice = afterFinalize.invoices.find((inv) => inv.id !== OLD_INVOICE_ID)!;
    expect(oldAfter).toBeDefined();
    expect(newInvoice).toBeDefined();
    expect(newInvoice.id).not.toBe(oldAfter.id);
    expect(newInvoice.number).toBeTruthy();
    expect(newInvoice.number).not.toBe(oldAfter.number);
    expect(newInvoice.customerSnapshot).toBeDefined();
    expect(newInvoice.customerSnapshot).toEqual(NEW_MASTER);
    expect(oldAfter.customerSnapshot).toEqual(OLD_MASTER);
    expect(newInvoice.customerSnapshot).not.toEqual(oldAfter.customerSnapshot);
    expect(afterFinalize.customerId).toBe(customerId);
    expect(afterFinalize.customerBilling).toEqual(NEW_MASTER);
    expect(getCustomerById(customerId)).toEqual(updated.customer);
    expect(getDocumentById(DOCUMENT_ID)!.linkedVorgang?.vorgangId).toBe(VORGANG_ID);

    // --- 8. Echter Neustart --------------------------------------------------
    const expectedCustomer = getCustomerById(customerId)!;
    const expectedVorgang = getVorgangById(VORGANG_ID)!;
    const expectedDocument = getDocumentById(DOCUMENT_ID)!;
    const expectedNewInvoiceId = newInvoice.id;
    const expectedNewInvoiceNumber = newInvoice.number;
    const expectedArchiveDocumentId = newInvoice.archiveDocumentId;
    const storageKeysBefore = Object.keys(localStorage);
    expect(storageKeysBefore.length).toBeGreaterThan(0);

    clearInMemoryBusinessState();
    expect(getCustomerById(customerId)).toBeUndefined();
    expect(getVorgangById(VORGANG_ID)).toBeUndefined();
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(Object.keys(localStorage)).toEqual(storageKeysBefore);

    bootstrapScope();

    const reloadedCustomers = getCustomerStoreSnapshot();
    expect(reloadedCustomers).toHaveLength(1);
    const reloadedCustomer = getCustomerById(customerId);
    expect(reloadedCustomer).toBeDefined();
    expect(reloadedCustomer).toEqual(expectedCustomer);
    expect(billingOf(reloadedCustomer!)).toEqual(NEW_MASTER);

    const reloadedVorgaenge = getAllVorgaenge();
    expect(reloadedVorgaenge).toHaveLength(1);
    const reloadedVorgang = getVorgangById(VORGANG_ID);
    expect(reloadedVorgang).toBeDefined();
    expect(reloadedVorgang!.id).toBe(expectedVorgang.id);
    expect(reloadedVorgang!.customerId).toBe(customerId);
    expect(reloadedVorgang!.customer).toBe(NEW_MASTER.name);
    expect(reloadedVorgang!.customerBilling).toEqual(NEW_MASTER);

    expect(reloadedVorgang!.invoices).toHaveLength(2);
    const reloadedOld = reloadedVorgang!.invoices.find((inv) => inv.id === OLD_INVOICE_ID);
    const reloadedNew = reloadedVorgang!.invoices.find((inv) => inv.id === expectedNewInvoiceId);
    expect(reloadedOld).toBeDefined();
    expect(reloadedNew).toBeDefined();
    expect(reloadedOld!.customerSnapshot).toEqual(OLD_MASTER);
    expect(reloadedNew!.customerSnapshot).toEqual(NEW_MASTER);
    expect(reloadedNew!.number).toBe(expectedNewInvoiceNumber);

    const reloadedDocument = getDocumentById(DOCUMENT_ID);
    expect(reloadedDocument).toBeDefined();
    // Feldweise statt Gesamtvergleich: der Bootstrap ergänzt zulässig Sync-Meta,
    // die fachlichen Werte und die Vorgangsverknüpfung müssen identisch bleiben.
    expect(reloadedDocument!.id).toBe(expectedDocument.id);
    expect(reloadedDocument!.title).toBe(expectedDocument.title);
    expect(reloadedDocument!.category).toBe(expectedDocument.category);
    expect(reloadedDocument!.issuer).toBe(expectedDocument.issuer);
    expect(reloadedDocument!.archived).toBe(expectedDocument.archived);
    expect(reloadedDocument!.createdAt).toBe(expectedDocument.createdAt);
    expect(reloadedDocument!.digitalFolder).toEqual(expectedDocument.digitalFolder);
    expect(reloadedDocument!.paperFolder).toEqual(expectedDocument.paperFolder);
    expect(reloadedDocument!.linkedVorgang).toEqual(expectedDocument.linkedVorgang);
    expect(reloadedDocument!.linkedVorgang?.vorgangId).toBe(VORGANG_ID);

    /**
     * Die Finalisierung archiviert die neue Rechnung über archiveOutgoingInvoice
     * und verknüpft das Archivdokument mit ihr. Nach dem Neustart müssen also
     * genau zwei Dokumente vorliegen: der Vertrag und dieses Archivdokument.
     */
    expect(expectedArchiveDocumentId).toBeTruthy();
    expect(reloadedNew!.archiveDocumentId).toBe(expectedArchiveDocumentId);
    const reloadedArchive = getDocumentById(expectedArchiveDocumentId!);
    expect(reloadedArchive).toBeDefined();
    const reloadedDocumentIds = getAllDocuments()
      .map((doc) => doc.id)
      .sort();
    expect(reloadedDocumentIds).toEqual([DOCUMENT_ID, expectedArchiveDocumentId!].sort());
  });
});
