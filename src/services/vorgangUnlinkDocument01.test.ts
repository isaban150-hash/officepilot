/**
 * OFFICEPILOT-DOCUMENT-UNLINK-DELETE-01E — atomares Lösen der Verknüpfung.
 *
 * Eine Dokument↔Vorgang-Verknüpfung besteht aus drei aktiven Stellen: den drei
 * Feldern am Eingangsobjekt, dem Eintrag in `vorgang.documents[]` und
 * `document.linkedVorgang`. `clearInboxVorgangLink` löst nur die erste — als
 * Rollback-Helfer gedacht, nicht als fachliche Operation. Wird nur ein Drittel
 * gelöst, bleiben zwei verwaiste Gegenreferenzen zurück.
 *
 * Gelöst werden ausschließlich die aktiven Zuordnungen. Die Herkunft bleibt:
 * sie belegt, woraus etwas entstanden ist, und darf nicht verschwinden, solange
 * das Entstandene existiert.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStores } from '../test/resetStores';
import { getDocumentById, hydrateDocumentStore } from './documentService';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import {
  getVorgangById,
  hydrateVorgangStore,
  unlinkInboxItemFromVorgang,
} from './vorgangService';
import { createAuftragInboxItem, createOrderPosition, createTestVorgang } from '../test/fixtures';
import type { CompanyDocument, InboxItem, Vorgang } from '../types/models';

const DOC_ID = 'doc-unlink-1';
const INBOX_ID = 'inbox-unlink-1';
const VORGANG_ID = 'v-unlink-1';

function seedLinked(options: { confirmed?: boolean } = {}): void {
  const document: CompanyDocument = {
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
    linkedVorgang: { vorgangId: VORGANG_ID, vorgangTitle: 'Auftrag' },
    sourceInboxItemId: INBOX_ID,
    archived: true,
    createdAt: '2026-03-01T10:00:00.000Z',
  } as CompanyDocument;

  const item: InboxItem = {
    ...createAuftragInboxItem({ id: INBOX_ID }),
    status: 'abgelegt',
    importedToArchive: true,
    archiveDocumentId: DOC_ID,
    vorgangId: VORGANG_ID,
    vorgangTitle: 'Auftrag',
    vorgangLinkStatus: 'linked',
  };

  const positions = [
    createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 5 }),
  ];

  let vorgang: Vorgang = {
    ...createTestVorgang({
      id: VORGANG_ID,
      status: 'eingegangen',
      customer: 'Beispiel Bau GmbH',
      customerId: 'cust-1',
      createdFromInboxId: INBOX_ID,
      orderPositions: positions,
    }),
    documents: [
      {
        id: 'vd-1',
        name: 'Werkvertrag Original',
        type: 'kundenauftrag',
        date: '2026-03-01',
        companyDocumentId: DOC_ID,
      },
      // Ein zweites, fremdes Dokument — es darf nicht mitgelöst werden.
      {
        id: 'vd-2',
        name: 'Fremdes Dokument',
        type: 'brief',
        date: '2026-03-02',
        companyDocumentId: 'doc-anders',
      },
    ],
  };

  if (options.confirmed) {
    vorgang = {
      ...vorgang,
      status: 'beauftragt',
      contractConfirmation: {
        id: 'cc-1',
        confirmedAt: '2026-03-02T10:00:00.000Z',
        customer: 'Beispiel Bau GmbH',
        auftraggeber: 'Beispiel Bau GmbH',
        baustelle: 'Baustelle 1',
        title: 'Auftrag',
        positions: [
          { id: 'op-1', description: 'Position 1', plannedQuantity: 10, unit: 'm²', unitPrice: 5 },
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

  hydrateDocumentStore([document]);
  hydrateInboxStore([item]);
  hydrateVorgangStore([vorgang]);
}

describe('OFFICEPILOT-VORGANG-UNLINK-DOCUMENT-01E', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('K: löst genau die drei aktiven Verknüpfungen', () => {
    seedLinked();

    const result = unlinkInboxItemFromVorgang(INBOX_ID);
    expect(result.success).toBe(true);

    const item = getInboxItemById(INBOX_ID)!;
    expect(item.vorgangId).toBeUndefined();
    expect(item.vorgangTitle).toBeUndefined();
    expect(item.vorgangLinkStatus).toBeUndefined();

    const vorgang = getVorgangById(VORGANG_ID)!;
    expect(vorgang.documents.map((doc) => doc.companyDocumentId)).toEqual(['doc-anders']);

    expect(getDocumentById(DOC_ID)?.linkedVorgang ?? null).toBeNull();
  });

  it('L: die Herkunft und alles Geschäftliche bleiben unberührt', () => {
    seedLinked({ confirmed: true });

    expect(unlinkInboxItemFromVorgang(INBOX_ID).success).toBe(true);

    const vorgang = getVorgangById(VORGANG_ID)!;
    expect(vorgang.createdFromInboxId).toBe(INBOX_ID);
    expect(vorgang.contractConfirmation).toBeDefined();
    expect(vorgang.orderPositions).toHaveLength(1);
    expect(vorgang.customerId).toBe('cust-1');
    expect(vorgang.status).toBe('beauftragt');

    expect(getDocumentById(DOC_ID)?.sourceInboxItemId).toBe(INBOX_ID);

    const item = getInboxItemById(INBOX_ID)!;
    expect(item.archiveDocumentId).toBe(DOC_ID);
    expect(item.importedToArchive).toBe(true);
    expect(item.status).toBe('abgelegt');
  });

  it('N: nach dem Lösen ist auch das Original eines bestätigten Auftrags löschbar', async () => {
    seedLinked({ confirmed: true });

    expect(unlinkInboxItemFromVorgang(INBOX_ID).success).toBe(true);

    // Der Ursprung wird weiterhin erkannt — seit 01I hält er das Löschen aber
    // nicht mehr auf. Der Nutzer soll nach dem Lösen nicht in einer zweiten
    // Sperre landen.
    const { deleteDocument, getDocumentDeleteBlockReason } = await import('./documentService');
    expect(getDocumentDeleteBlockReason(getDocumentById(DOC_ID)!)).toBe('confirmed_order');
    expect(deleteDocument(DOC_ID).success).toBe(true);

    // Und der Auftrag steht unverändert da.
    const vorgang = getVorgangById(VORGANG_ID)!;
    expect(vorgang.status).toBe('beauftragt');
    expect(vorgang.contractConfirmation).toBeDefined();
    expect(vorgang.orderPositions).toHaveLength(1);
  });

  it('N2: nach dem Lösen eines unbestätigten Vorgangs ist das Original löschbar', async () => {
    seedLinked();

    expect(unlinkInboxItemFromVorgang(INBOX_ID).success).toBe(true);

    const { deleteDocument, getDocumentDeleteBlockReason } = await import('./documentService');
    expect(getDocumentDeleteBlockReason(getDocumentById(DOC_ID)!)).toBeNull();
    expect(deleteDocument(DOC_ID).success).toBe(true);
  });

  it('O: ein Eingangsobjekt ohne Verknüpfung meldet das sauber', () => {
    seedLinked();
    expect(unlinkInboxItemFromVorgang(INBOX_ID).success).toBe(true);

    const second = unlinkInboxItemFromVorgang(INBOX_ID);
    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.errorKey).toBe('vorgang.unlink.notLinked');
  });

  it('O2: ein unbekanntes Eingangsobjekt meldet nicht gefunden', () => {
    const result = unlinkInboxItemFromVorgang('gibt-es-nicht');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('inbox.notFound');
  });
});
