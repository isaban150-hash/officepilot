/**
 * OFFICEPILOT-DOCUMENT-DELETE-SEMANTICS-01I — Endgültig löschen heißt löschen.
 *
 * Bis 01G hat ein bestätigter Auftrag das Löschen seines Vertragsdokuments
 * verhindert. Das war für den Nutzer eine Sackgasse: Er bestätigt zweistufig,
 * und bekommt danach ein „Nein“. Die Produktentscheidung ist jetzt umgekehrt —
 * wer „Endgültig löschen“ bestätigt, meint es, und die technischen
 * Verknüpfungen werden als Teil desselben Vorgangs mit aufgeräumt.
 *
 * Was dabei ausdrücklich NICHT passiert: Der Auftrag bleibt vollständig. Der
 * Kunde bleibt. Die Herkunfts-IDs bleiben — sie sind Geschichte, keine aktive
 * Verknüpfung. Und der Beleg einer gebuchten Ausgabe bleibt geschützt.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStores } from '../test/resetStores';
import { createAuftragInboxItem, createOrderPosition, createTestVorgang } from '../test/fixtures';
import { deleteDocument, getDocumentById, hydrateDocumentStore } from './documentService';
import { getInboxItemById, getInboxStoreSnapshot, hydrateInboxStore } from './inboxService';
import { getVorgangById, hydrateVorgangStore } from './vorgangService';
import {
  getDocumentWorkResult,
  upsertDocumentWorkResult,
} from './documentWorkResultStoreService';
import {
  findDocumentFileIntakeTransformPlanCarryContext,
  replaceDocumentFileIntakeTransformPlanCarryContextStore,
} from './documentFileIntakeTransformPlanCarryContextStoreService';
import { getDocumentFileRefById, hydrateDocumentFileStore } from './documentFileStoreService';
import { hydrateExpenseStore } from './expenseStore';
import { isEntitySyncActive } from './sync/syncMetaService';
import { resetLastPersistFailureForTests } from './persistenceService';
import { getCustomerById, upsertCustomerInStore } from './customerStoreService';
import type { DocumentFileIntakeTransformPlanCarryContext } from '../types/documentFileIntakeTransformPlanCarryContext';
import type { DocumentFileRef } from '../types/documentFileRef';
import type { DocumentWorkResult } from '../types/documentWorkResult';
import type { CompanyDocument, Customer, InboxItem, Vorgang } from '../types/models';
import type { Expense } from '../types/expense';

const DOC_ID = 'doc-final-delete';
const INBOX_ID = 'inbox-final-delete';
const VORGANG_ID = 'v-final-delete';
const FILE_REF_ID = 'file-ref-final-delete';

/** Der reale Westfalen-Auftrag: 11 Positionen, 46.986,20 €. */
const WESTFALEN_POSITIONS = [
  { qty: 950, price: 3.8 },
  { qty: 950, price: 12.4 },
  { qty: 320, price: 18.5 },
  { qty: 180, price: 27.9 },
  { qty: 1, price: 1500 },
  { qty: 64, price: 96.5 },
  { qty: 210, price: 14.75 },
  { qty: 95, price: 33.2 },
  { qty: 1, price: 650 },
  { qty: 480, price: 9.6 },
  { qty: 1, price: 1468.7 },
];

function westfalenOrderPositions() {
  return WESTFALEN_POSITIONS.map((entry, index) =>
    createOrderPosition({
      id: `op-${index + 1}`,
      unit: 'm²',
      plannedQuantity: entry.qty,
      unitPrice: entry.price,
    }),
  );
}

function westfalenConfirmationPositions() {
  return WESTFALEN_POSITIONS.map((entry, index) => ({
    id: `op-${index + 1}`,
    description: `Position ${index + 1}`,
    plannedQuantity: entry.qty,
    unit: 'm²',
    unitPrice: entry.price,
  }));
}

function orderValue(vorgang: Vorgang): number {
  return (vorgang.orderPositions ?? []).reduce(
    (sum, position) => sum + position.plannedQuantity * position.unitPrice,
    0,
  );
}

function buildDocument(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: DOC_ID,
    title: 'Westfalen Werkvertrag',
    category: 'vertrag',
    issuer: 'Westfalen Projektbau GmbH',
    recognizedText: 'Werkvertrag',
    issueDate: '2026-03-01',
    digitalFolder: { id: 'dig-1', name: 'Verträge', path: '/Firma/Vertraege/' },
    paperFolder: { folderId: 'folder-1', register: 'A', label: 'Verträge' },
    tags: [],
    linkedCompany: 'Test GmbH',
    linkedVorgang: { vorgangId: VORGANG_ID, vorgangTitle: 'Auftrag Westfalen' },
    sourceInboxItemId: INBOX_ID,
    fileRefId: FILE_REF_ID,
    archived: true,
    createdAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  } as CompanyDocument;
}

function buildInbox(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    ...createAuftragInboxItem({ id: INBOX_ID }),
    status: 'abgelegt',
    importedToArchive: true,
    archiveDocumentId: DOC_ID,
    fileRefId: FILE_REF_ID,
    vorgangId: VORGANG_ID,
    vorgangTitle: 'Auftrag Westfalen',
    vorgangLinkStatus: 'linked',
    ...overrides,
  };
}

function buildWestfalenVorgang(): Vorgang {
  return {
    ...createTestVorgang({
      id: VORGANG_ID,
      status: 'beauftragt',
      customer: 'Westfalen Projektbau GmbH',
      customerId: 'cust-westfalen',
      createdFromInboxId: INBOX_ID,
      orderPositions: westfalenOrderPositions(),
    }),
    documents: [
      {
        id: 'vd-1',
        name: 'Westfalen Werkvertrag',
        type: 'kundenauftrag',
        date: '2026-03-01',
        companyDocumentId: DOC_ID,
      },
      {
        id: 'vd-2',
        name: 'Fremdes Dokument',
        type: 'sonstiges',
        date: '2026-03-05',
        companyDocumentId: 'doc-anderes',
      },
    ],
    contractConfirmation: {
      id: 'cc-1',
      confirmedAt: '2026-03-02T10:00:00.000Z',
      customer: 'Westfalen Projektbau GmbH',
      auftraggeber: 'Westfalen Projektbau GmbH',
      baustelle: 'Baustelle Nord',
      title: 'Auftrag Westfalen',
      positions: westfalenConfirmationPositions(),
      negotiation: {
        conducted: false,
        notes: [],
        generalHints: [],
        priceProposals: [],
        positionProposals: [],
        drafts: [],
      },
      immutable: true,
    },
  };
}

function buildExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-final-delete',
    supplier: 'Westfalen Projektbau GmbH',
    invoiceDate: '2026-03-01',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    currency: 'EUR',
    paymentStatus: 'offen',
    positions: [],
    allocations: [],
    isCreditNote: false,
    dedupeKey: 'exp-final-delete',
    tags: [],
    digitalFolder: { id: 'dig-1', name: 'Ausgaben', path: '/Firma/Ausgaben/' },
    paperFolder: { folderId: 'folder-2', register: 'B', label: 'Ausgaben' },
    createdAt: '2026-03-01T10:00:00.000Z',
    updatedAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  } as Expense;
}

function createDwr(inboxItemId: string): DocumentWorkResult {
  return {
    schemaVersion: 1,
    inboxItemId,
    analyzedAt: '2026-03-01T10:00:00.000Z',
    analysisVersion: '01a.1',
    sourceFingerprint: `fp-${inboxItemId}`,
    businessInterpretation: null,
    specialistRefs: {
      hasContractIntelligence: false,
      hasContractOrderProposal: false,
      hasClassification: false,
      hasDocumentUnderstanding: false,
      companyRelevant: false,
    },
    overlay: [],
  };
}

function createCarryContext(inboxItemId: string): DocumentFileIntakeTransformPlanCarryContext {
  return {
    inboxItemId,
    policyId: 'business_document',
    userDecision: 'save_permanently',
    mediaProfile: 'native_pdf',
    schemaVersion: 1,
    capturedAt: '2026-03-01T10:00:00.000Z',
  };
}

function createFileRef(id: string): DocumentFileRef {
  return {
    id,
    originalFileName: 'werkvertrag.pdf',
    mimeType: 'application/pdf',
    fileSize: 2048,
    contentHash: `hash-${id}`,
    storageType: 'local_data_url',
    localDataKey: `blob-${id}`,
    createdAt: '2026-03-01T10:00:00.000Z',
    lifecycleStatus: 'committed',
  };
}

/** Die FileRef-Freigabe läuft nach dem Commit in einem Microtask. */
async function flushFileRelease(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function failLocalStorageSetItem(): void {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {
      const error = new Error('quota');
      error.name = 'QuotaExceededError';
      throw error;
    },
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  });
}

function seedWestfalen(): void {
  hydrateDocumentFileStore([createFileRef(FILE_REF_ID)]);
  hydrateDocumentStore([buildDocument()]);
  hydrateInboxStore([buildInbox()]);
  hydrateVorgangStore([buildWestfalenVorgang()]);
  upsertDocumentWorkResult(createDwr(INBOX_ID));
  replaceDocumentFileIntakeTransformPlanCarryContextStore([createCarryContext(INBOX_ID)]);
}

describe('OFFICEPILOT-DOCUMENT-FINAL-DELETE-01I', () => {
  beforeEach(() => {
    resetTestStores();
    resetLastPersistFailureForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTestStores();
    resetLastPersistFailureForTests();
  });

  it('G/H: der Auftrag bleibt vollständig, nur der Dokumenteintrag geht', () => {
    seedWestfalen();
    const before = getVorgangById(VORGANG_ID)!;
    expect(before.orderPositions).toHaveLength(11);
    expect(Number(orderValue(before).toFixed(2))).toBe(46986.2);

    expect(deleteDocument(DOC_ID).success).toBe(true);

    const after = getVorgangById(VORGANG_ID)!;
    expect(after.status).toBe('beauftragt');
    expect(after.contractConfirmation).toEqual(before.contractConfirmation);
    expect(after.orderPositions).toEqual(before.orderPositions);
    expect(after.orderPositions).toHaveLength(11);
    expect(Number(orderValue(after).toFixed(2))).toBe(46986.2);
    expect(after.customer).toBe('Westfalen Projektbau GmbH');
    expect(after.customerId).toBe('cust-westfalen');
    expect(after.customerBilling).toEqual(before.customerBilling);
    expect(after.invoices ?? []).toEqual(before.invoices ?? []);
    expect(after.confirmedOrderAmendments ?? []).toEqual(before.confirmedOrderAmendments ?? []);
    expect(after.createdFromInboxId).toBe(INBOX_ID);

    // H: nur der Eintrag dieses Dokuments verschwindet — der fremde bleibt.
    expect(after.documents.map((doc) => doc.companyDocumentId)).toEqual(['doc-anderes']);
  });

  it('I/J: die Herkunftszeile ist danach nicht mehr aktiv und hält nichts mehr', () => {
    seedWestfalen();

    expect(deleteDocument(DOC_ID).success).toBe(true);

    // I: nicht mehr aktiv — weder auffindbar noch als Halter zählbar.
    expect(getInboxItemById(INBOX_ID)).toBeUndefined();
    const raw = getInboxStoreSnapshot().find((item) => item.id === INBOX_ID);
    expect(raw).toBeDefined();
    expect(isEntitySyncActive(raw!)).toBe(false);

    // J: keine aktive Vorgangs- oder Archivbeziehung mehr auf dem Tombstone.
    expect(raw?.vorgangId).toBeUndefined();
    expect(raw?.vorgangTitle).toBeUndefined();
    expect(raw?.vorgangLinkStatus).toBeUndefined();
    expect(raw?.archiveDocumentId).toBeUndefined();
  });

  it('K/L: DocumentWorkResult und Carry-Context der Herkunftszeile sind entfernt', () => {
    seedWestfalen();
    expect(getDocumentWorkResult(INBOX_ID)).not.toBeNull();
    expect(findDocumentFileIntakeTransformPlanCarryContext(INBOX_ID)).not.toBeNull();

    expect(deleteDocument(DOC_ID).success).toBe(true);

    expect(getDocumentWorkResult(INBOX_ID)).toBeNull();
    expect(findDocumentFileIntakeTransformPlanCarryContext(INBOX_ID)).toBeNull();
  });

  it('M/N: die historischen Herkunfts-IDs bleiben, auch wenn sie auf Tombstones zeigen', () => {
    seedWestfalen();
    upsertCustomerInStore({
      id: 'cust-westfalen',
      name: 'Westfalen Projektbau GmbH',
      createdAt: '2026-03-01T10:00:00.000Z',
      updatedAt: '2026-03-01T10:00:00.000Z',
      createdFromInboxId: INBOX_ID,
    } as Customer);

    expect(deleteDocument(DOC_ID).success).toBe(true);

    // M: der Auftrag weiß weiterhin, woraus er entstand …
    expect(getVorgangById(VORGANG_ID)?.createdFromInboxId).toBe(INBOX_ID);
    // … N: und der Kunde ebenso. Herkunft ist Geschichte, keine Verknüpfung.
    const customer = getCustomerById('cust-westfalen');
    expect(customer).toBeDefined();
    expect(customer?.createdFromInboxId).toBe(INBOX_ID);
    expect(customer?.name).toBe('Westfalen Projektbau GmbH');
  });

  it('Q: die Originaldatei wird freigegeben, wenn niemand sie mehr aktiv hält', async () => {
    seedWestfalen();
    expect(getDocumentFileRefById(FILE_REF_ID)).toBeTruthy();

    expect(deleteDocument(DOC_ID).success).toBe(true);
    await flushFileRelease();

    expect(getDocumentFileRefById(FILE_REF_ID)).toBeFalsy();
  });

  it('R: eine dritte aktive Referenz hält die Datei fest', async () => {
    seedWestfalen();
    hydrateInboxStore([
      buildInbox(),
      { ...createAuftragInboxItem({ id: 'inbox-anderer' }), fileRefId: FILE_REF_ID },
    ]);

    expect(deleteDocument(DOC_ID).success).toBe(true);
    await flushFileRelease();

    expect(getDocumentFileRefById(FILE_REF_ID)).toBeTruthy();
    expect(getInboxItemById('inbox-anderer')).toBeDefined();
  });

  it('S: ein Persistfehler rollt alles zurück und gibt keine Datei frei', async () => {
    seedWestfalen();
    const documentBefore = getDocumentById(DOC_ID)!;
    const vorgangBefore = getVorgangById(VORGANG_ID)!;

    failLocalStorageSetItem();
    const result = deleteDocument(DOC_ID);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('document.persistFailed');
    await flushFileRelease();

    // Dokument wieder aktiv, mit seiner Zuordnung.
    const documentAfter = getDocumentById(DOC_ID);
    expect(documentAfter).toBeDefined();
    expect(documentAfter?.linkedVorgang?.vorgangId).toBe(VORGANG_ID);
    expect(documentAfter?.fileRefId).toBe(documentBefore.fileRefId);

    // Eingangszeile wieder aktiv, mit allen Verknüpfungsfeldern.
    const item = getInboxItemById(INBOX_ID);
    expect(item).toBeDefined();
    expect(item?.vorgangId).toBe(VORGANG_ID);
    expect(item?.vorgangTitle).toBe('Auftrag Westfalen');
    expect(item?.vorgangLinkStatus).toBe('linked');
    expect(item?.archiveDocumentId).toBe(DOC_ID);

    // Nebenspeicher wiederhergestellt.
    expect(getDocumentWorkResult(INBOX_ID)).not.toBeNull();
    expect(findDocumentFileIntakeTransformPlanCarryContext(INBOX_ID)).not.toBeNull();

    // Der Dokumenteintrag im Vorgang ist zurück.
    const vorgangAfter = getVorgangById(VORGANG_ID)!;
    expect(vorgangAfter.documents.map((doc) => doc.companyDocumentId)).toEqual(
      vorgangBefore.documents.map((doc) => doc.companyDocumentId),
    );
    expect(vorgangAfter.orderPositions).toEqual(vorgangBefore.orderPositions);

    // Und die Datei liegt unangetastet da.
    expect(getDocumentFileRefById(FILE_REF_ID)).toBeTruthy();
  });

  it('O/P: der Beleg einer Ausgabe bleibt geschützt — über beide Wege', () => {
    seedWestfalen();
    hydrateExpenseStore([buildExpense({ archiveDocumentId: DOC_ID })]);

    const viaArchive = deleteDocument(DOC_ID);
    expect(viaArchive.success).toBe(false);
    if (viaArchive.success) return;
    expect(viaArchive.errorKey).toBe('document.delete.blocked.expense');
    expect(getDocumentById(DOC_ID)).toBeDefined();
    // Nichts wurde nebenbei entkoppelt.
    expect(getVorgangById(VORGANG_ID)?.documents).toHaveLength(2);
    expect(getInboxItemById(INBOX_ID)).toBeDefined();

    hydrateExpenseStore([buildExpense({ linkedInboxId: INBOX_ID })]);
    const viaOrigin = deleteDocument(DOC_ID);
    expect(viaOrigin.success).toBe(false);
    if (viaOrigin.success) return;
    expect(viaOrigin.errorKey).toBe('document.delete.blocked.expense');
    expect(getDocumentById(DOC_ID)).toBeDefined();
  });

  it('mehrere Vorgänge mit derselben Dokumentreferenz bleiben nicht verwaist', () => {
    seedWestfalen();
    hydrateVorgangStore([
      buildWestfalenVorgang(),
      {
        ...createTestVorgang({ id: 'v-zweit', status: 'eingegangen', customer: 'Andere GmbH' }),
        documents: [
          {
            id: 'vd-3',
            name: 'Westfalen Werkvertrag',
            type: 'kundenauftrag',
            date: '2026-03-01',
            companyDocumentId: DOC_ID,
          },
        ],
      },
    ]);

    expect(deleteDocument(DOC_ID).success).toBe(true);

    expect(getVorgangById(VORGANG_ID)?.documents.map((d) => d.companyDocumentId)).toEqual([
      'doc-anderes',
    ]);
    expect(getVorgangById('v-zweit')?.documents).toHaveLength(0);
  });

  it('ein fremdes Eingangsobjekt wird nicht getombstonet', () => {
    hydrateDocumentFileStore([createFileRef(FILE_REF_ID)]);
    hydrateDocumentStore([buildDocument()]);
    // Zeigt auf ein anderes Archivdokument — bleibt unberührt.
    hydrateInboxStore([buildInbox({ archiveDocumentId: 'doc-anderes' })]);
    hydrateVorgangStore([buildWestfalenVorgang()]);

    expect(deleteDocument(DOC_ID).success).toBe(true);

    const item = getInboxItemById(INBOX_ID);
    expect(item).toBeDefined();
    expect(item?.archiveDocumentId).toBe('doc-anderes');
    expect(item?.vorgangId).toBe(VORGANG_ID);
  });
});
