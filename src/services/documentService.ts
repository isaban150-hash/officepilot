import { MOCK_COMPANY_DOCUMENTS } from '../data/documentMockData';
import { PAPER_FOLDERS } from '../data/mockData';
import { persistAll } from './persistenceService';
import type {
  CompanyDocument,
  CompanyDocumentCategory,
  CompanyDocumentInput,
  CompanyDocumentVorgangLink,
  DigitalFolder,
  PaperFilingRule,
} from '../types/models';

export const COMPANY_DOCUMENT_CATEGORIES: CompanyDocumentCategory[] = [
  'vertrag',
  'versicherung',
  'zertifikat',
  'steuer',
  'behoerde',
  'personal',
  'sonstiges',
];

export type DocumentMutationResult =
  | { success: true; document: CompanyDocument }
  | { success: false; errorKey: string };

let documents: CompanyDocument[] = [];

function cloneDocument(doc: CompanyDocument): CompanyDocument {
  return {
    ...doc,
    digitalFolder: { ...doc.digitalFolder },
    paperFolder: { ...doc.paperFolder },
    tags: [...doc.tags],
    linkedVorgang: doc.linkedVorgang ? { ...doc.linkedVorgang } : null,
  };
}

function defaultDigitalFolder(): DigitalFolder {
  return {
    id: `dig-doc-${Date.now()}`,
    name: 'Firmendokumente',
    path: '/Firma/Dokumente/',
  };
}

function defaultPaperFolder(): PaperFilingRule {
  const folder = PAPER_FOLDERS[4] ?? PAPER_FOLDERS[0];
  return {
    folderId: folder.id,
    register: folder.registers[0] ?? 'A',
    label: folder.name,
  };
}

function normalizeTitle(title: string): string | null {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTags(tags?: string[]): string[] {
  if (!tags) return [];
  return tags.map((t) => t.trim()).filter(Boolean);
}

function validateInput(input: CompanyDocumentInput): string | null {
  if (!normalizeTitle(input.title)) return 'document.titleRequired';
  if (!input.category) return 'document.categoryRequired';
  return null;
}

function buildDocumentFromInput(
  input: CompanyDocumentInput,
  id: string,
  createdAt: string,
): CompanyDocument {
  return {
    id,
    title: normalizeTitle(input.title)!,
    category: input.category,
    issuer: input.issuer?.trim() ?? '',
    recognizedText: input.recognizedText?.trim() ?? '',
    issueDate: input.issueDate ?? null,
    validUntil: input.validUntil ?? null,
    digitalFolder: input.digitalFolder ? { ...input.digitalFolder } : defaultDigitalFolder(),
    paperFolder: input.paperFolder ? { ...input.paperFolder } : defaultPaperFolder(),
    tags: normalizeTags(input.tags),
    linkedCompany: input.linkedCompany?.trim() ?? '',
    linkedVorgang: input.linkedVorgang ? { ...input.linkedVorgang } : null,
    archived: input.archived ?? true,
    createdAt,
    imagePreview: input.imagePreview ?? '📄',
  };
}

export function getDocumentStoreSnapshot(): CompanyDocument[] {
  return documents.map(cloneDocument);
}

export function hydrateDocumentStore(items: CompanyDocument[]): void {
  documents = items.map(cloneDocument);
}

export function resetDocuments(): void {
  documents = MOCK_COMPANY_DOCUMENTS.map(cloneDocument);
}

export function getAllDocuments(): CompanyDocument[] {
  return documents.map(cloneDocument);
}

export function getDocumentById(id: string): CompanyDocument | undefined {
  const doc = documents.find((d) => d.id === id);
  return doc ? cloneDocument(doc) : undefined;
}

export function getDocumentsByCategory(category: CompanyDocumentCategory): CompanyDocument[] {
  return documents.filter((d) => d.category === category).map(cloneDocument);
}

export function searchDocuments(
  query: string,
  categoryFilter?: CompanyDocumentCategory | 'all',
): CompanyDocument[] {
  const normalizedQuery = query.trim().toLowerCase();

  return documents
    .filter((doc) => {
      if (categoryFilter && categoryFilter !== 'all' && doc.category !== categoryFilter) {
        return false;
      }
      if (!normalizedQuery) return true;

      const haystack = [
        doc.title,
        doc.issuer,
        doc.recognizedText,
        doc.linkedCompany,
        doc.linkedVorgang?.vorgangTitle ?? '',
        ...doc.tags,
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    })
    .map(cloneDocument);
}

export function addDocument(input: CompanyDocumentInput): DocumentMutationResult {
  const validationError = validateInput(input);
  if (validationError) return { success: false, errorKey: validationError };

  const now = new Date().toISOString();
  const document = buildDocumentFromInput(input, `doc-${Date.now()}`, now);
  documents = [document, ...documents];
  persistAll();
  return { success: true, document: cloneDocument(document) };
}

export function updateDocument(
  id: string,
  changes: Partial<CompanyDocumentInput>,
): DocumentMutationResult {
  const index = documents.findIndex((d) => d.id === id);
  if (index === -1) return { success: false, errorKey: 'document.notFound' };

  const current = documents[index];
  const merged: CompanyDocumentInput = {
    title: changes.title ?? current.title,
    category: changes.category ?? current.category,
    issuer: changes.issuer ?? current.issuer,
    recognizedText: changes.recognizedText ?? current.recognizedText,
    issueDate: changes.issueDate !== undefined ? changes.issueDate : current.issueDate,
    validUntil: changes.validUntil !== undefined ? changes.validUntil : current.validUntil,
    digitalFolder: changes.digitalFolder ?? current.digitalFolder,
    paperFolder: changes.paperFolder ?? current.paperFolder,
    tags: changes.tags ?? current.tags,
    linkedCompany: changes.linkedCompany ?? current.linkedCompany,
    linkedVorgang:
      changes.linkedVorgang !== undefined ? changes.linkedVorgang : current.linkedVorgang,
    archived: changes.archived ?? current.archived,
    imagePreview: changes.imagePreview ?? current.imagePreview,
  };

  const validationError = validateInput(merged);
  if (validationError) return { success: false, errorKey: validationError };

  const updated = buildDocumentFromInput(merged, current.id, current.createdAt);
  documents = [...documents.slice(0, index), updated, ...documents.slice(index + 1)];
  persistAll();
  return { success: true, document: cloneDocument(updated) };
}

export function deleteDocument(id: string): DocumentMutationResult {
  const index = documents.findIndex((d) => d.id === id);
  if (index === -1) return { success: false, errorKey: 'document.notFound' };

  const deleted = cloneDocument(documents[index]);
  documents = documents.filter((d) => d.id !== id);
  persistAll();
  return { success: true, document: deleted };
}

export function linkDocumentToVorgang(
  id: string,
  link: CompanyDocumentVorgangLink | null,
): DocumentMutationResult {
  return updateDocument(id, { linkedVorgang: link });
}
