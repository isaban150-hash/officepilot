import { describe, expect, it, beforeEach } from 'vitest';
import { STORAGE_KEY } from './persistenceService';
import {
  addDocument,
  deleteDocument,
  getDocumentById,
  getDocumentsByCategory,
  hydrateDocumentStore,
  searchDocuments,
  updateDocument,
} from './documentService';
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

    const raw = localStorage.getItem(STORAGE_KEY);
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
