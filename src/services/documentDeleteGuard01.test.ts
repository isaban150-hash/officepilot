/**
 * OFFICEPILOT-DOCUMENT-DELETE-SEMANTICS-01I — was das Löschen noch aufhält.
 *
 * Ursprünglich (01E) hat `deleteDocument` jeden Vorgangsbezug und jeden
 * bestätigten Auftrag als Sperre behandelt. Das war zu streng: Wer zweistufig
 * „Endgültig löschen“ bestätigt, soll nicht vorher von Hand entkoppeln müssen.
 * Die Zustände werden weiterhin benannt — sie haben nur kein Vetorecht mehr,
 * und die technischen Verknüpfungen werden mit demselben Commit aufgeräumt.
 *
 * Eines bleibt: Der Beleg einer gebuchten Ausgabe. Der gehört nicht zum Archiv,
 * das der Nutzer gerade aufräumt, sondern zur Buchhaltung.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStores } from '../test/resetStores';
import {
  deleteDocument,
  getDocumentById,
  getDocumentDeleteBlockReason,
  hydrateDocumentStore,
} from './documentService';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { getVorgangById, hydrateVorgangStore } from './vorgangService';
import { hydrateExpenseStore } from './expenseStore';
import { createAuftragInboxItem, createOrderPosition, createTestVorgang } from '../test/fixtures';
import type { CompanyDocument, InboxItem, Vorgang } from '../types/models';
import type { Expense } from '../types/expense';

const DOC_ID = 'doc-guard-1';
const INBOX_ID = 'inbox-guard-1';

function buildDocument(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: DOC_ID,
    title: 'Werkvertrag Original',
    category: 'vertrag',
    issuer: 'Beispiel Bau GmbH',
    recognizedText: 'Werkvertrag',
    issueDate: '2026-03-01',
    digitalFolder: { id: 'dig-1', name: 'Verträge', path: '/Firma/Vertraege/' },
    paperFolder: { folderId: 'folder-1', register: 'A', label: 'Verträge' },
    tags: [],
    linkedCompany: 'Test GmbH',
    linkedVorgang: null,
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
    ...overrides,
  };
}

function buildVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return createTestVorgang({
    id: 'v-guard-1',
    status: 'eingegangen',
    customer: 'Beispiel Bau GmbH',
    orderPositions: [
      createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 5 }),
    ],
    ...overrides,
  });
}

/** Ein Vorgang, der das Dokument aktiv in seiner Dokumentliste führt. */
function withDocumentEntry(vorgang: Vorgang): Vorgang {
  return {
    ...vorgang,
    documents: [
      {
        id: 'vd-1',
        name: 'Werkvertrag Original',
        type: 'kundenauftrag',
        date: '2026-03-01',
        companyDocumentId: DOC_ID,
      },
    ],
  };
}

/** Ein eingefrorener Auftragsstand — der Beleg, der geschützt werden muss. */
function withConfirmation(vorgang: Vorgang): Vorgang {
  return {
    ...vorgang,
    status: 'beauftragt',
    contractConfirmation: {
      id: 'cc-1',
      confirmedAt: '2026-03-02T10:00:00.000Z',
      customer: 'Beispiel Bau GmbH',
      auftraggeber: 'Beispiel Bau GmbH',
      baustelle: 'Baustelle 1',
      title: 'Auftrag',
      // Muss zum Plan passen — sonst richtet repairContractPlanFromSnapshot
      // die orderPositions beim Lesen auf den leeren Snapshot aus.
      positions: [
        {
          id: 'op-1',
          description: 'Position 1',
          plannedQuantity: 10,
          unit: 'm²',
          unitPrice: 5,
        },
      ],
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
    id: 'exp-1',
    supplier: 'Beispiel Bau GmbH',
    invoiceDate: '2026-03-01',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    currency: 'EUR',
    paymentStatus: 'offen',
    positions: [],
    allocations: [],
    isCreditNote: false,
    dedupeKey: 'exp-1',
    tags: [],
    digitalFolder: { id: 'dig-1', name: 'Ausgaben', path: '/Firma/Ausgaben/' },
    paperFolder: { folderId: 'folder-2', register: 'B', label: 'Ausgaben' },
    createdAt: '2026-03-01T10:00:00.000Z',
    updatedAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  } as Expense;
}

describe('OFFICEPILOT-DOCUMENT-DELETE-GUARD-01E', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('A: ein Dokument ohne Vorgangs- und Ausgabenbezug bleibt löschbar', () => {
    hydrateDocumentStore([buildDocument()]);

    expect(getDocumentDeleteBlockReason(buildDocument())).toBeNull();
    expect(deleteDocument(DOC_ID).success).toBe(true);
    expect(getDocumentById(DOC_ID)).toBeUndefined();
  });

  it('B: ein aktiver Vorgangslink hält das Löschen nicht mehr auf', () => {
    const doc = buildDocument({ linkedVorgang: { vorgangId: 'v-guard-1', vorgangTitle: 'Auftrag' } });
    hydrateDocumentStore([doc]);
    hydrateVorgangStore([buildVorgang()]);

    // Der Zustand wird weiterhin benannt — er hat nur kein Vetorecht mehr.
    expect(getDocumentDeleteBlockReason(doc)).toBe('vorgang');
    expect(deleteDocument(DOC_ID).success).toBe(true);
    expect(getDocumentById(DOC_ID)).toBeUndefined();
    // Der Vorgang selbst bleibt.
    expect(getVorgangById('v-guard-1')).toBeDefined();
  });

  it('C: auch die Dokumentliste des Vorgangs hält es nicht mehr auf', () => {
    const doc = buildDocument();
    hydrateDocumentStore([doc]);
    hydrateVorgangStore([withDocumentEntry(buildVorgang())]);

    expect(getDocumentDeleteBlockReason(doc)).toBe('vorgang');
    expect(deleteDocument(DOC_ID).success).toBe(true);
    // Die Gegenreferenz wird als Teil des Löschens aufgeräumt.
    expect(getVorgangById('v-guard-1')?.documents).toHaveLength(0);
  });

  it('D: ein bestätigter Auftrag hält das Löschen nicht mehr auf', () => {
    const doc = buildDocument();
    hydrateDocumentStore([doc]);
    hydrateVorgangStore([withConfirmation(withDocumentEntry(buildVorgang()))]);

    expect(getDocumentDeleteBlockReason(doc)).toBe('confirmed_order');
    expect(deleteDocument(DOC_ID).success).toBe(true);

    // Der Auftrag ist danach unversehrt — nur der Dokumentbezug fehlt.
    const vorgang = getVorgangById('v-guard-1')!;
    expect(vorgang.status).toBe('beauftragt');
    expect(vorgang.contractConfirmation).toBeDefined();
    expect(vorgang.orderPositions).toHaveLength(1);
    expect(vorgang.documents).toHaveLength(0);
  });

  it('E: auch der historische Ursprung hält das Löschen nicht mehr auf', () => {
    // Kein linkedVorgang, kein Eintrag in documents[] — nur noch die Herkunft.
    const doc = buildDocument({ sourceInboxItemId: INBOX_ID });
    hydrateDocumentStore([doc]);
    hydrateVorgangStore([withConfirmation(buildVorgang({ createdFromInboxId: INBOX_ID }))]);

    expect(getDocumentDeleteBlockReason(doc)).toBe('confirmed_order');
    expect(deleteDocument(DOC_ID).success).toBe(true);

    // Die Herkunfts-ID bleibt — sie darf auf einen Tombstone zeigen.
    expect(getVorgangById('v-guard-1')?.createdFromInboxId).toBe(INBOX_ID);
    expect(getVorgangById('v-guard-1')?.contractConfirmation).toBeDefined();
  });

  it('F: eine Ausgabe blockiert über ihre eigene Archivreferenz', () => {
    const doc = buildDocument();
    hydrateDocumentStore([doc]);
    hydrateExpenseStore([buildExpense({ archiveDocumentId: DOC_ID })]);

    expect(getDocumentDeleteBlockReason(doc)).toBe('expense');
    const result = deleteDocument(DOC_ID);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('document.delete.blocked.expense');
  });

  it('G: eine Ausgabe blockiert auch über die gemeinsame Herkunft', () => {
    const doc = buildDocument({ sourceInboxItemId: INBOX_ID });
    hydrateDocumentStore([doc]);
    hydrateExpenseStore([buildExpense({ linkedInboxId: INBOX_ID })]);

    expect(getDocumentDeleteBlockReason(doc)).toBe('expense');
  });

  it('H: die Herkunft allein blockiert nicht', () => {
    const doc = buildDocument({ sourceInboxItemId: INBOX_ID });
    hydrateDocumentStore([doc]);
    hydrateInboxStore([buildInbox()]);
    // Ein Vorgang aus derselben Inbox, aber ohne bestätigten Auftrag.
    hydrateVorgangStore([buildVorgang({ createdFromInboxId: INBOX_ID })]);

    expect(getDocumentDeleteBlockReason(doc)).toBeNull();
    expect(deleteDocument(DOC_ID).success).toBe(true);
  });

  it('I: ein erlaubtes Löschen nimmt das unsichtbare Eingangsobjekt mit', () => {
    hydrateDocumentStore([buildDocument({ sourceInboxItemId: INBOX_ID })]);
    hydrateInboxStore([buildInbox()]);

    expect(deleteDocument(DOC_ID).success).toBe(true);

    // Die Herkunftszeile war bereits abgelegt und damit unsichtbar. Sie aktiv
    // stehen zu lassen hieße, die Originaldatei weiter festzuhalten — genau
    // das, was der Nutzer mit „Endgültig löschen“ beendet hat.
    expect(getInboxItemById(INBOX_ID)).toBeUndefined();
  });

  it('I2: ein fremdes Eingangsobjekt wird dabei nicht angefasst', () => {
    hydrateDocumentStore([buildDocument({ sourceInboxItemId: INBOX_ID })]);
    // Zeigt auf ein anderes Archivdokument — darf unverändert bleiben.
    hydrateInboxStore([buildInbox({ archiveDocumentId: 'doc-anders' })]);

    expect(deleteDocument(DOC_ID).success).toBe(true);

    const item = getInboxItemById(INBOX_ID);
    expect(item?.archiveDocumentId).toBe('doc-anders');
    expect(item?.importedToArchive).toBe(true);
  });

  it('J: der Vorgang bleibt bei einem blockierten Löschen unangetastet', () => {
    // Blockiert wird jetzt nur noch über die Ausgabe — und dann darf auch
    // nichts nebenbei entkoppelt worden sein.
    const doc = buildDocument();
    hydrateDocumentStore([doc]);
    hydrateVorgangStore([withConfirmation(withDocumentEntry(buildVorgang()))]);
    hydrateExpenseStore([buildExpense({ archiveDocumentId: DOC_ID })]);

    expect(deleteDocument(DOC_ID).success).toBe(false);

    const vorgang = getVorgangById('v-guard-1');
    expect(vorgang?.contractConfirmation).toBeDefined();
    expect(vorgang?.orderPositions).toHaveLength(1);
    expect(vorgang?.status).toBe('beauftragt');
    expect(vorgang?.documents).toHaveLength(1);
    expect(getDocumentById(DOC_ID)).toBeDefined();
  });
});
