/**
 * DOC-LINK-AFTER-VORGANG-01 — Archive document binds after Vorgang create/link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAllDocuments,
  getDocumentById,
  hydrateDocumentStore,
} from './documentService';
import * as documentService from './documentService';
import {
  getInboxItemById,
  hydrateInboxStore,
  markInboxImportedToArchive,
} from './inboxService';
import {
  createVorgangFromInbox,
  getVorgangById,
  hydrateVorgangStore,
  linkInboxToExistingVorgang,
} from './vorgangService';
import { createAuftragInboxItem, createTestVorgang } from '../test/fixtures';
import {
  confirmFilingDecisionForTests,
  importInboxDocumentForTests,
} from '../test/confirmFilingDecisionForTests';
import { resetTestStores } from '../test/resetStores';
import type { InboxItem } from '../types/models';

const COMPANY = 'Test GmbH';

function seedInbox(overrides: Partial<InboxItem> = {}): InboxItem {
  const item = createAuftragInboxItem({
    id: 'inbox-doc-link-01',
    title: 'Subunternehmervertrag Link',
    sender: 'Partner GmbH',
    classifiedKind: 'subunternehmervertrag',
    markedAsCompanyDocument: true,
    ...overrides,
  });
  hydrateInboxStore([item]);
  return getInboxItemById(item.id)!;
}

function archiveInbox(item: InboxItem) {
  confirmFilingDecisionForTests(item.id);
  const imported = importInboxDocumentForTests(getInboxItemById(item.id)!, COMPANY);
  expect(imported.success).toBe(true);
  if (!imported.success) throw new Error('import failed');
  const marked = markInboxImportedToArchive(item.id, imported.document.id);
  expect(marked?.success).toBe(true);
  return {
    inbox: getInboxItemById(item.id)!,
    document: getDocumentById(imported.document.id)!,
  };
}

describe('DOC-LINK-AFTER-VORGANG-01', () => {
  beforeEach(() => {    hydrateDocumentStore([]);
    hydrateVorgangStore([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('Fall 1 — Archiv → Vorgang erstellen: linkedVorgang + Vorgang-Dokumentliste', () => {
    const seeded = seedInbox();
    const { inbox, document } = archiveInbox(seeded);
    expect(document.linkedVorgang).toBeNull();

    const created = createVorgangFromInbox(inbox, undefined, 'betrieb');
    expect(created).not.toBeNull();
    if (!created) return;

    expect(getAllDocuments()).toHaveLength(1);
    const archived = getDocumentById(document.id)!;
    expect(archived.linkedVorgang?.vorgangId).toBe(created.vorgang.id);
    expect(archived.linkedVorgang?.vorgangTitle).toBe(created.vorgang.title);

    const onVorgang = created.vorgang.documents.filter(
      (d) => d.companyDocumentId === document.id,
    );
    expect(onVorgang).toHaveLength(1);
    expect(created.inbox.vorgangId).toBe(created.vorgang.id);
    expect(created.inbox.archiveDocumentId).toBe(document.id);
  });

  it('Fall 2 — Archiv → bestehenden Vorgang verknüpfen: kein Duplikat', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-existing-doc-link',
        title: 'Bestehender Auftrag',
        customer: 'Partner GmbH',
        documents: [],
      }),
    ]);
    const seeded = seedInbox({ id: 'inbox-doc-link-02' });
    const { inbox, document } = archiveInbox(seeded);

    const linked = linkInboxToExistingVorgang(inbox, 'v-existing-doc-link');
    expect(linked).not.toBeNull();
    if (!linked) return;

    expect(getAllDocuments()).toHaveLength(1);
    expect(getDocumentById(document.id)?.linkedVorgang?.vorgangId).toBe('v-existing-doc-link');
    expect(
      linked.vorgang.documents.filter((d) => d.companyDocumentId === document.id),
    ).toHaveLength(1);
  });

  it('Fall 3 — Vorgang → Archiv: bestehendes Verhalten bleibt erhalten', () => {
    const seeded = seedInbox({ id: 'inbox-doc-link-03' });
    const created = createVorgangFromInbox(seeded, undefined, 'betrieb');
    expect(created).not.toBeNull();
    if (!created) return;

    const imported = importInboxDocumentForTests(getInboxItemById(seeded.id)!, COMPANY);
    expect(imported.success).toBe(true);
    if (!imported.success) return;
    markInboxImportedToArchive(seeded.id, imported.document.id);

    expect(getAllDocuments()).toHaveLength(1);
    expect(imported.document.linkedVorgang?.vorgangId).toBe(created.vorgang.id);

    const vorgang = getVorgangById(created.vorgang.id)!;
    expect(
      vorgang.documents.some((d) => d.companyDocumentId === imported.document.id),
    ).toBe(true);
  });

  it('Fall 4 — erneutes Verknüpfen erzeugt keine Doppelverknüpfung', () => {
    const seeded = seedInbox({ id: 'inbox-doc-link-04' });
    const { inbox, document } = archiveInbox(seeded);
    const created = createVorgangFromInbox(inbox, undefined, 'betrieb');
    expect(created).not.toBeNull();
    if (!created) return;

    const again = createVorgangFromInbox(getInboxItemById(inbox.id)!, undefined, 'betrieb');
    expect(again).toBeNull();

    const linkAgain = linkInboxToExistingVorgang(
      getInboxItemById(inbox.id)!,
      created.vorgang.id,
    );
    expect(linkAgain).toBeNull();

    expect(getAllDocuments()).toHaveLength(1);
    expect(getDocumentById(document.id)?.linkedVorgang?.vorgangId).toBe(created.vorgang.id);
    expect(
      getVorgangById(created.vorgang.id)!.documents.filter(
        (d) => d.companyDocumentId === document.id,
      ),
    ).toHaveLength(1);
  });

  it('Fall 5 — Link-Fehler: keine Inkonsistenz, keine zweite Dokumentinstanz', () => {
    const seeded = seedInbox({ id: 'inbox-doc-link-05' });
    const { inbox, document } = archiveInbox(seeded);

    vi.spyOn(documentService, 'updateDocument').mockReturnValue({
      success: false,
      errorKey: 'document.persistFailed',
    });

    const created = createVorgangFromInbox(inbox, undefined, 'betrieb');
    expect(created).toBeNull();

    expect(getAllDocuments()).toHaveLength(1);
    expect(getDocumentById(document.id)?.linkedVorgang).toBeNull();
    expect(getInboxItemById(inbox.id)?.vorgangId).toBeUndefined();
    expect(getInboxItemById(inbox.id)?.archiveDocumentId).toBe(document.id);
  });
});
