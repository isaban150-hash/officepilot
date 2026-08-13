/**
 * CUSTOMER-FACHOBJEKT-03B2 — atomic customer/Vorgang/inbox/archive handoff.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompanyProfile, hydrateCompanyProfileStore } from './companyProfileService';
import { createCustomer } from './customerService';
import {
  getCustomerById,
  getCustomerStoreSnapshot,
  hydrateCustomerStore,
} from './customerStoreService';
import {
  addDocument,
  getDocumentById,
  getDocumentStoreSnapshot,
} from './documentService';
import { getInboxItemById, hydrateInboxStore, patchInboxItem } from './inboxService';
import { bootstrapBusinessState } from './storage/storageBootstrapService';
import {
  createVorgangFromInbox,
  getAllVorgaenge,
  getVorgangById,
} from './vorgangService';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import type { InboxItem } from '../types/models';

const OWN = 'Cirmak Haustechnik GmbH';
const NORDWEST = {
  name: 'NordWest Dachbau GmbH',
  contactPerson: 'Frau Nordmann',
  street: 'Hafenstraße 12',
  zip: '45356',
  city: 'Essen',
  email: 'kontakt@nordwest-dachbau.de',
  phone: '0201 4711',
};
const DOC_NAME = 'Rheinbau Partner GmbH';

function seedItem(overrides: Partial<InboxItem> = {}): InboxItem {
  const item = createAuftragInboxItem({
    id: 'inbox-03b2',
    sender: DOC_NAME,
    recognizedData: { Kunde: DOC_NAME },
    ...overrides,
  });
  hydrateInboxStore([item]);
  return getInboxItemById(item.id)!;
}

function bootstrapScope(workspaceId = 'ws-03b2') {
  return bootstrapBusinessState({ userId: 'user-03b2', workspaceId });
}

function archiveDocumentInput() {
  return {
    title: 'Werkvertrag NordWest',
    category: 'vertrag' as const,
    issuer: NORDWEST.name,
    recognizedText: 'Vertragstext',
    digitalFolder: { id: 'dig-03b2', name: 'Verträge', path: '/Vertraege/' },
    paperFolder: { folderId: 'p1', register: 'A', label: 'Ordner 1' },
    tags: [],
  };
}

/** Ungültige Bestandskunden nur über den normalen Store-Helfer einbringen. */
function seedRawCustomer(id: string, name: string): void {
  const now = '2026-08-13T08:00:00.000Z';
  hydrateCustomerStore([
    ...getCustomerStoreSnapshot(),
    {
      id,
      name,
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
      createdAt: now,
      updatedAt: now,
    },
  ]);
}

describe('CUSTOMER-FACHOBJEKT-03B2', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
    localStorage.clear();
  });

  it('Fall A — Legacy undefined bleibt unverändert', () => {
    const item = seedItem();
    const result = createVorgangFromInbox(item);

    expect(result).not.toBeNull();
    expect(result!.vorgang.customer).toBe(DOC_NAME);
    expect(result!.vorgang.customerId).toBeUndefined();
    expect(result!.vorgang.customerBilling?.name).toBe(DOC_NAME);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
  });

  it('Fall B — neuer Customer entsteht gemeinsam mit dem Vorgang', () => {
    const item = seedItem();
    const result = createVorgangFromInbox(item, undefined, 'unclear', {
      customerDecision: { kind: 'new', input: NORDWEST },
    });

    expect(result).not.toBeNull();
    const customers = getCustomerStoreSnapshot();
    expect(customers).toHaveLength(1);
    expect(getAllVorgaenge()).toHaveLength(1);

    const customer = customers[0]!;
    const vorgang = result!.vorgang;
    expect(vorgang.customerId).toBe(customer.id);
    expect(vorgang.customer).toBe(NORDWEST.name);
    expect(vorgang.customerBilling).toEqual(NORDWEST);
    expect(customer.createdFromInboxId).toBe(item.id);

    expect(result!.inbox.vorgangId).toBe(vorgang.id);
    expect(result!.inbox.vorgangLinkStatus).toBe('created');
    expect(getInboxItemById(item.id)?.vorgangId).toBe(vorgang.id);
  });

  it('Fall C — ausgewählter Customer gewinnt gegen Dokument und optionalDraft', () => {
    const created = createCustomer(NORDWEST);
    expect(created.success).toBe(true);
    if (!created.success) return;

    const item = seedItem();
    const result = createVorgangFromInbox(
      item,
      { customer: 'Ganz Anderer Kunde GmbH' },
      'unclear',
      { customerDecision: { kind: 'existing', customerId: created.customer.id } },
    );

    expect(result).not.toBeNull();
    expect(result!.vorgang.customer).toBe(NORDWEST.name);
    expect(result!.vorgang.customerId).toBe(created.customer.id);
    expect(result!.vorgang.customerBilling).toEqual(NORDWEST);
    expect(getCustomerStoreSnapshot()).toHaveLength(1);
  });

  it('Fall D — gleiche Namen, nur die gewählte ID zählt', () => {
    const first = createCustomer({ ...NORDWEST, street: 'Hafenstraße 12', city: 'Essen' });
    const second = createCustomer({ ...NORDWEST, street: 'Ruhrallee 5', city: 'Bochum' });
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;

    const item = seedItem();
    const result = createVorgangFromInbox(item, undefined, 'unclear', {
      customerDecision: { kind: 'existing', customerId: second.customer.id },
    });

    expect(result).not.toBeNull();
    expect(result!.vorgang.customerId).toBe(second.customer.id);
    expect(result!.vorgang.customerId).not.toBe(first.customer.id);
    expect(result!.vorgang.customerBilling?.street).toBe('Ruhrallee 5');
    expect(result!.vorgang.customerBilling?.city).toBe('Bochum');
    expect(getCustomerStoreSnapshot()).toHaveLength(2);
  });

  it('Fall E — none erzeugt den ausdrücklichen Unbekannt-Zustand', () => {
    const item = seedItem();
    const result = createVorgangFromInbox(item, { customer: DOC_NAME }, 'unclear', {
      customerDecision: { kind: 'none' },
    });

    expect(result).not.toBeNull();
    expect(result!.vorgang.customer).toBe('');
    expect(result!.vorgang.customerId).toBeUndefined();
    expect(result!.vorgang.customerBilling).toEqual({
      name: '',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    });
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
  });

  it('Fall F — Validierungsfehler brechen den gesamten Handoff ab', () => {
    const cases = [
      { label: 'unbekannte ID', decision: { kind: 'existing' as const, customerId: 'cust-gibt-es-nicht' } },
      { label: 'leerer Name', decision: { kind: 'new' as const, input: { name: '   ' } } },
      { label: 'eigene Firma', decision: { kind: 'new' as const, input: { name: OWN } } },
    ];

    for (const testCase of cases) {
      const item = seedItem();
      const setItemSpy = vi.spyOn(localStorage, 'setItem');

      const result = createVorgangFromInbox(item, undefined, 'unclear', {
        customerDecision: testCase.decision,
      });

      expect(result, testCase.label).toBeNull();
      expect(setItemSpy, testCase.label).not.toHaveBeenCalled();
      expect(getCustomerStoreSnapshot(), testCase.label).toHaveLength(0);
      expect(getAllVorgaenge(), testCase.label).toHaveLength(0);
      expect(getInboxItemById(item.id)?.vorgangId, testCase.label).toBeUndefined();

      setItemSpy.mockRestore();
      resetTestStores();
      hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
    }
  });

  it('Fall F2 — ungültige bestehende Customers werden abgelehnt', () => {
    const invalid = [
      { label: 'leerer Name', id: 'cust-leer', name: '   ' },
      { label: 'eigene Firma', id: 'cust-own', name: OWN },
    ];

    for (const testCase of invalid) {
      seedRawCustomer(testCase.id, testCase.name);
      const customersBefore = getCustomerStoreSnapshot();
      const item = seedItem();
      const setItemSpy = vi.spyOn(localStorage, 'setItem');

      const result = createVorgangFromInbox(item, { customer: 'Ganz Anderer Kunde GmbH' }, 'unclear', {
        customerDecision: { kind: 'existing', customerId: testCase.id },
      });

      expect(result, testCase.label).toBeNull();
      expect(setItemSpy, testCase.label).not.toHaveBeenCalled();
      expect(getAllVorgaenge(), testCase.label).toHaveLength(0);
      expect(getInboxItemById(item.id)?.vorgangId, testCase.label).toBeUndefined();
      // Kein Fallback auf Dokumentname oder optionalDraft.
      expect(getCustomerStoreSnapshot(), testCase.label).toEqual(customersBefore);

      setItemSpy.mockRestore();
      resetTestStores();
      hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
    }
  });

  it('Fall G — genau ein persistAll im Kernhandoff', () => {
    const item = seedItem();
    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    const result = createVorgangFromInbox(item, undefined, 'unclear', {
      customerDecision: { kind: 'new', input: NORDWEST },
    });

    expect(result).not.toBeNull();
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    setItemSpy.mockRestore();
  });

  it('Fall H — Persistenzfehler rollt alle vier Stores zurück', () => {
    bootstrapScope();

    // Dauerhafter Ausgangszustand: Dokument + verknüpftes Inbox-Item, kein Vorgang,
    // kein Customer. addDocument und patchInboxItem persistieren produktiv.
    const doc = addDocument(archiveDocumentInput());
    expect(doc.success).toBe(true);
    if (!doc.success) return;
    // Das Dokumentmodell liefert im unverknüpften Zustand null, nicht undefined.
    expect(doc.document.linkedVorgang).toBeNull();

    const seeded = seedItem();
    const item = patchInboxItem(seeded.id, {
      archiveDocumentId: doc.document.id,
      importedToArchive: true,
    });
    expect(item).not.toBeNull();
    expect(item!.vorgangId).toBeUndefined();

    // Der Vorzustand ist jetzt nachweislich dauerhaft gespeichert.
    const customersBefore = getCustomerStoreSnapshot();
    const vorgaengeBefore = getAllVorgaenge();
    const documentsBefore = getDocumentStoreSnapshot();
    const inboxBefore = getInboxItemById(seeded.id);
    expect(customersBefore).toHaveLength(0);
    expect(vorgaengeBefore).toHaveLength(0);
    expect(documentsBefore.some((d) => d.id === doc.document.id)).toBe(true);

    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    const result = createVorgangFromInbox(item!, undefined, 'unclear', {
      customerDecision: { kind: 'new', input: NORDWEST },
    });

    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
    expect(getCustomerStoreSnapshot()).toEqual(customersBefore);
    expect(getAllVorgaenge()).toEqual(vorgaengeBefore);
    expect(getDocumentStoreSnapshot()).toEqual(documentsBefore);
    expect(getInboxItemById(seeded.id)).toEqual(inboxBefore);
    expect(getInboxItemById(seeded.id)?.vorgangId).toBeUndefined();
    expect(getDocumentById(doc.document.id)?.linkedVorgang).toBeNull();
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(getAllVorgaenge()).toHaveLength(0);

    setItemSpy.mockRestore();
    bootstrapScope();

    // Der dauerhafte Vorzustand ist unverändert erhalten — kein leerer Scope.
    expect(getInboxItemById(seeded.id)).toBeDefined();
    expect(getInboxItemById(seeded.id)?.vorgangId).toBeUndefined();
    expect(getInboxItemById(seeded.id)?.archiveDocumentId).toBe(doc.document.id);
    expect(getDocumentById(doc.document.id)).toBeDefined();
    expect(getDocumentById(doc.document.id)?.linkedVorgang).toBeNull();
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(getAllVorgaenge()).toHaveLength(0);
  });

  it('Fall I — Archivdokumentbindung im selben Snapshot', () => {
    bootstrapScope();
    const doc = addDocument(archiveDocumentInput());
    expect(doc.success).toBe(true);
    if (!doc.success) return;

    const item = seedItem({ archiveDocumentId: doc.document.id, importedToArchive: true });
    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    const result = createVorgangFromInbox(item, undefined, 'unclear', {
      customerDecision: { kind: 'new', input: NORDWEST },
    });

    expect(result).not.toBeNull();
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    setItemSpy.mockRestore();

    // Die Erfolgsrückgabe selbst muss bereits vollständig sein.
    const returnedRefs = result!.vorgang.documents.filter(
      (d) => d.companyDocumentId === doc.document.id,
    );
    expect(returnedRefs).toHaveLength(1);
    expect(result!.inbox.vorgangId).toBe(result!.vorgang.id);
    expect(result!.inbox.vorgangLinkStatus).toBe('created');

    const vorgang = getVorgangById(result!.vorgang.id)!;
    expect(getDocumentById(doc.document.id)?.linkedVorgang?.vorgangId).toBe(vorgang.id);
    const refs = vorgang.documents.filter((d) => d.companyDocumentId === doc.document.id);
    expect(refs).toHaveLength(1);
    expect(vorgang.customerId).toBeTruthy();
  });

  it('Fall J — Doppelklick erzeugt keinen zweiten Customer', () => {
    const item = seedItem();
    const first = createVorgangFromInbox(item, undefined, 'unclear', {
      customerDecision: { kind: 'new', input: NORDWEST },
    });
    expect(first).not.toBeNull();

    const setItemSpy = vi.spyOn(localStorage, 'setItem');
    const second = createVorgangFromInbox(item, undefined, 'unclear', {
      customerDecision: { kind: 'new', input: NORDWEST },
    });

    expect(second).toBeNull();
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(getCustomerStoreSnapshot()).toHaveLength(1);
    expect(getAllVorgaenge()).toHaveLength(1);
    setItemSpy.mockRestore();
  });

  it('Fall K — alles überlebt den normalen Bootstrap', () => {
    bootstrapScope();
    const doc = addDocument(archiveDocumentInput());
    expect(doc.success).toBe(true);
    if (!doc.success) return;

    const item = seedItem({ archiveDocumentId: doc.document.id, importedToArchive: true });
    const result = createVorgangFromInbox(item, undefined, 'unclear', {
      customerDecision: { kind: 'new', input: NORDWEST },
    });
    expect(result).not.toBeNull();
    const customerId = result!.vorgang.customerId!;

    bootstrapScope();

    const reloadedVorgang = getVorgangById(result!.vorgang.id);
    expect(reloadedVorgang?.customerId).toBe(customerId);
    expect(reloadedVorgang?.customer).toBe(NORDWEST.name);
    expect(reloadedVorgang?.customerBilling).toEqual(NORDWEST);
    expect(getCustomerById(customerId)?.name).toBe(NORDWEST.name);
    expect(getInboxItemById(item.id)?.vorgangId).toBe(result!.vorgang.id);
    expect(getInboxItemById(item.id)?.vorgangLinkStatus).toBe('created');
    expect(getDocumentById(doc.document.id)?.linkedVorgang?.vorgangId).toBe(result!.vorgang.id);
  });
});
