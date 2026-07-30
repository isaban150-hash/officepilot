import { describe, expect, it, beforeEach } from 'vitest';
import { getActiveStorageKey } from './persistenceService';
import {
  addDocument,
  deleteDocument,
  getDocumentById,
  getDocumentsByCategory,
  hydrateDocumentStore,
  importInboxDocument,
  isDuplicateDocument,
  mapInboxItemToDocumentInput,
  searchDocuments,
  updateDocument,
  updateDocumentFromInbox,
} from './documentService';
import {
  getInboxItemById,
  hydrateInboxStore,
  markInboxImportedToArchive,
} from './inboxService';
import { createAuftragInboxItem } from '../test/fixtures';
import { confirmFilingDecisionForTests } from '../test/confirmFilingDecisionForTests';
import type { CompanyDocument } from '../types/models';

function createTestDocument(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: 'doc-test-1',
    title: 'Testversicherung',
    category: 'versicherung',
    issuer: 'Test AG',
    recognizedText: 'Police 12345',
    issueDate: '2026-01-01',
    validUntil: '2027-01-01',
    digitalFolder: { id: 'dig-1', name: 'Versicherungen', path: '/Firma/Versicherungen/' },
    paperFolder: { folderId: 'folder-5', register: 'A', label: 'Behörden & Versicherungen' },
    tags: ['Test', 'Versicherung'],
    linkedCompany: 'Test GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('addDocument', () => {
  it('creates a document with required fields', () => {
    hydrateDocumentStore([]);

    const result = addDocument({
      title: 'Neuer Vertrag',
      category: 'vertrag',
      issuer: 'Partner GmbH',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document.title).toBe('Neuer Vertrag');
      expect(result.document.category).toBe('vertrag');
      expect(result.document.issuer).toBe('Partner GmbH');
    }
  });

  it('rejects empty title', () => {
    hydrateDocumentStore([]);

    const result = addDocument({ title: '   ', category: 'vertrag' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKey).toBe('document.titleRequired');
  });

  it('persists to localStorage', () => {
    hydrateDocumentStore([]);
    localStorage.clear();

    addDocument({ title: 'Persist Test', category: 'steuer' });

    const raw = localStorage.getItem(getActiveStorageKey());
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.documents).toHaveLength(1);
    expect(parsed.documents[0].title).toBe('Persist Test');
  });
});

describe('updateDocument', () => {
  it('updates document fields', () => {
    hydrateDocumentStore([createTestDocument()]);

    const result = updateDocument('doc-test-1', { title: 'Aktualisiert', issuer: 'Neu GmbH' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document.title).toBe('Aktualisiert');
      expect(result.document.issuer).toBe('Neu GmbH');
    }
  });

  it('rejects empty title on update', () => {
    hydrateDocumentStore([createTestDocument()]);

    const result = updateDocument('doc-test-1', { title: '' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKey).toBe('document.titleRequired');
  });

  it('returns notFound for unknown id', () => {
    hydrateDocumentStore([]);

    const result = updateDocument('missing', { title: 'X' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKey).toBe('document.notFound');
  });
});

describe('deleteDocument', () => {
  it('removes document from store', () => {
    hydrateDocumentStore([createTestDocument()]);

    const result = deleteDocument('doc-test-1');
    expect(result.success).toBe(true);
    expect(getDocumentById('doc-test-1')).toBeUndefined();
  });
});

describe('getDocumentById', () => {
  it('returns a clone of the document', () => {
    hydrateDocumentStore([createTestDocument()]);

    const doc = getDocumentById('doc-test-1');
    expect(doc?.title).toBe('Testversicherung');
    doc!.title = 'Mutated';
    expect(getDocumentById('doc-test-1')?.title).toBe('Testversicherung');
  });
});

describe('searchDocuments', () => {
  beforeEach(() => {
    hydrateDocumentStore([
      createTestDocument(),
      createTestDocument({
        id: 'doc-test-2',
        title: 'Steuerbescheid 2025',
        category: 'steuer',
        issuer: 'Finanzamt',
        tags: ['Steuer'],
      }),
    ]);
  });

  it('finds documents by title', () => {
    const results = searchDocuments('Steuerbescheid');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('doc-test-2');
  });

  it('finds documents by tag', () => {
    const results = searchDocuments('Versicherung');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('doc-test-1');
  });

  it('filters by category', () => {
    const results = searchDocuments('', 'steuer');
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('steuer');
  });
});

describe('getDocumentsByCategory', () => {
  it('returns only matching category', () => {
    hydrateDocumentStore([
      createTestDocument(),
      createTestDocument({ id: 'doc-2', category: 'vertrag', title: 'Mietvertrag' }),
    ]);

    const results = getDocumentsByCategory('versicherung');
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('versicherung');
  });
});

describe('vorgang linking', () => {
  it('stores linked vorgang on add', () => {
    hydrateDocumentStore([]);

    const result = addDocument({
      title: 'BG Nachweis',
      category: 'behoerde',
      linkedVorgang: { vorgangId: 'v-001', vorgangTitle: 'Badezimmer Müller' },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document.linkedVorgang?.vorgangId).toBe('v-001');
      expect(result.document.linkedVorgang?.vorgangTitle).toBe('Badezimmer Müller');
    }
  });

  it('updates vorgang link', () => {
    hydrateDocumentStore([createTestDocument()]);

    const result = updateDocument('doc-test-1', {
      linkedVorgang: { vorgangId: 'v-002', vorgangTitle: 'Heizung Schmidt' },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document.linkedVorgang?.vorgangId).toBe('v-002');
    }
  });
});

describe('mapInboxItemToDocumentInput', () => {
  it('maps inbox fields to document input', () => {
    const inboxItem = createAuftragInboxItem({
      title: 'Auftrag Schmidt',
      sender: 'Familie Schmidt',
      deadline: '2026-05-01',
      vorgangId: 'v-001',
      vorgangTitle: 'Bad Schmidt',
      recognizedData: { Leistung: 'Sanierung', Angebotssumme: '5.000 €' },
    });

    const input = mapInboxItemToDocumentInput(inboxItem, 'Mustermann GmbH');

    expect(input.title).toBe('Auftrag Schmidt');
    expect(input.category).toBe('vertrag');
    expect(input.issuer).toBe('Familie Schmidt');
    expect(input.recognizedText).toContain('Leistung: Sanierung');
    expect(input.issueDate).toBe('2026-03-27');
    expect(input.validUntil).toBe('2026-05-01');
    expect(input.digitalFolder?.path).toBe('/test/');
    expect(input.paperFolder?.register).toBe('A');
    expect(input.tags).toContain('Inbox:kundenauftrag');
    expect(input.linkedCompany).toBe('Mustermann GmbH');
    expect(input.linkedVorgang?.vorgangId).toBe('v-001');
  });
});

describe('isDuplicateDocument', () => {
  it('detects duplicate by title and issuer', () => {
    hydrateDocumentStore([
      createTestDocument({ title: 'BG BAU Schreiben', issuer: 'BG BAU' }),
    ]);

    const inboxItem = createAuftragInboxItem({
      title: 'BG BAU Schreiben',
      sender: 'BG BAU',
      documentType: 'behoerde',
    });

    const duplicate = isDuplicateDocument(inboxItem, 'Test GmbH');
    expect(duplicate?.id).toBe('doc-test-1');
  });

  it('returns null when title or issuer differ', () => {
    hydrateDocumentStore([createTestDocument()]);

    const inboxItem = createAuftragInboxItem({
      title: 'Anderes Dokument',
      sender: 'Andere AG',
    });

    expect(isDuplicateDocument(inboxItem, 'Test GmbH')).toBeNull();
  });
});

describe('importInboxDocument', () => {
  it('creates archive document from inbox item', () => {
    hydrateDocumentStore([]);
    const inboxItem = createAuftragInboxItem({ id: 'inbox-import-create', title: 'Import Test' });
    hydrateInboxStore([inboxItem]);
    const confirmed = confirmFilingDecisionForTests(inboxItem.id);

    const result = importInboxDocument(confirmed, 'Firma GmbH');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document.title).toBe('Import Test');
      expect(result.document.linkedCompany).toBe('Firma GmbH');
    }
  });

  it('persists imported document to localStorage', () => {
    hydrateDocumentStore([]);
    localStorage.clear();
    const inboxItem = createAuftragInboxItem({ id: 'inbox-import-persist', title: 'Persist Import' });
    hydrateInboxStore([inboxItem]);
    confirmFilingDecisionForTests(inboxItem.id);

    importInboxDocument(getInboxItemById(inboxItem.id)!, 'Firma GmbH');

    const raw = localStorage.getItem(getActiveStorageKey());
    const parsed = JSON.parse(raw!);
    expect(parsed.documents.some((d: CompanyDocument) => d.title === 'Persist Import')).toBe(true);
  });
});

describe('updateDocumentFromInbox', () => {
  it('updates existing document with inbox data', () => {
    hydrateDocumentStore([
      createTestDocument({ title: 'Alt', issuer: 'Alt AG', recognizedText: 'alt' }),
    ]);

    const inboxItem = createAuftragInboxItem({
      id: 'inbox-update-from-inbox',
      title: 'Alt',
      sender: 'Alt AG',
      recognizedData: { Hinweis: 'Neu erkannt' },
    });
    hydrateInboxStore([inboxItem]);
    const confirmed = confirmFilingDecisionForTests(inboxItem.id);

    const result = updateDocumentFromInbox('doc-test-1', confirmed, 'Neu GmbH');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document.recognizedText).toContain('Hinweis: Neu erkannt');
      expect(result.document.linkedCompany).toBe('Neu GmbH');
    }
  });
});

describe('inbox → archive integration', () => {
  it('marks inbox archived and document is searchable', () => {
    const inboxItem = createAuftragInboxItem({
      id: 'inbox-import-1',
      title: 'Archiv Import',
      sender: 'Import Kunde',
    });
    hydrateInboxStore([inboxItem]);
    hydrateDocumentStore([]);
    confirmFilingDecisionForTests(inboxItem.id);

    const importResult = importInboxDocument(getInboxItemById(inboxItem.id)!, 'Test GmbH');
    expect(importResult.success).toBe(true);

    if (importResult.success) {
      const archiveResult = markInboxImportedToArchive('inbox-import-1', importResult.document.id);
      expect(archiveResult?.item.importedToArchive).toBe(true);
      expect(archiveResult?.item.archiveDocumentId).toBe(importResult.document.id);
      expect(archiveResult?.item.status).toBe('abgelegt');

      const found = searchDocuments('Archiv Import');
      expect(found).toHaveLength(1);
      expect(getInboxItemById('inbox-import-1')?.importedToArchive).toBe(true);
    }
  });

  it('leaves inbox unmarked when archive mark fails after successful import', () => {
    const inboxItem = createAuftragInboxItem({
      id: 'inbox-import-2',
      title: 'Teil-Erfolg Test',
      sender: 'Import Kunde',
    });
    hydrateInboxStore([inboxItem]);
    hydrateDocumentStore([]);
    confirmFilingDecisionForTests(inboxItem.id);

    const importResult = importInboxDocument(getInboxItemById(inboxItem.id)!, 'Test GmbH');
    expect(importResult.success).toBe(true);

    if (importResult.success) {
      const archiveResult = markInboxImportedToArchive('missing-inbox-id', importResult.document.id);
      expect(archiveResult).toBeNull();

      const inbox = getInboxItemById('inbox-import-2');
      expect(inbox?.importedToArchive).toBeFalsy();
      expect(inbox?.status).toBe('neu');

      const found = searchDocuments('Teil-Erfolg Test');
      expect(found).toHaveLength(1);
    }
  });
});
