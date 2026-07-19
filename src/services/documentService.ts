import { MOCK_COMPANY_DOCUMENTS } from '../data/documentMockData';
import { PAPER_FOLDERS } from '../data/mockData';
import { persistAll } from './persistenceService';
import { resolvePaperFilingFromInbox } from './paperFolderService';
import { getDocumentFileRefById } from './documentFileStoreService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  removeDocumentFileRepresentationBindingsForDocument,
} from './documentFileRepresentationBindingStoreService';
import { documentMatchesArea } from './documentAreaCatalog';
import type { DocumentAreaFilterId } from '../types/documentArea';
import {
  isContractInboxItem,
  recordArchivedDocumentMemory,
  syncContractProofRequirementsFromInbox,
  tombstoneMemoryForDocument,
} from './officePilotMemoryService';
import {
  filterSyncActive,
  generateEntityId,
  isEntitySyncActive,
  withNewEntitySync,
  withTombstonedEntity,
  withUpdatedEntitySync,
} from './sync/syncMetaService';
import type {
  CompanyDocument,
  CompanyDocumentCategory,
  CompanyDocumentInput,
  CompanyDocumentVorgangLink,
  DigitalFolder,
  DocumentType,
  InboxItem,
  PaperFilingRule,
} from '../types/models';

export const COMPANY_DOCUMENT_CATEGORIES: CompanyDocumentCategory[] = [
  'vertrag',
  'versicherung',
  'zertifikat',
  'steuer',
  'ausgangsrechnung',
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
    linkedInvoiceId: doc.linkedInvoiceId ?? null,
  };
}

function fileFieldsFromInput(input: CompanyDocumentInput): Pick<
  CompanyDocument,
  | 'fileRefId'
  | 'sourceFileHash'
  | 'originalFileName'
  | 'mimeType'
  | 'fileSize'
  | 'classifiedKind'
  | 'sourceInboxItemId'
  | 'documentDate'
  | 'uploadedAt'
> {
  return {
    fileRefId: input.fileRefId,
    sourceFileHash: input.sourceFileHash,
    originalFileName: input.originalFileName,
    mimeType: input.mimeType,
    fileSize: input.fileSize,
    classifiedKind: input.classifiedKind,
    sourceInboxItemId: input.sourceInboxItemId,
    documentDate: input.documentDate ?? null,
    uploadedAt: input.uploadedAt,
  };
}

function defaultDigitalFolder(): DigitalFolder {
  return {
    id: generateEntityId('dig-doc'),
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
    linkedInvoiceId: input.linkedInvoiceId ?? null,
    ...fileFieldsFromInput(input),
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
  return filterSyncActive(documents).map(cloneDocument);
}

export function getDocumentById(id: string): CompanyDocument | undefined {
  const doc = documents.find((d) => d.id === id && isEntitySyncActive(d));
  return doc ? cloneDocument(doc) : undefined;
}

export function getDocumentByLinkedInvoiceId(invoiceId: string): CompanyDocument | undefined {
  const doc = documents.find((d) => d.linkedInvoiceId === invoiceId && isEntitySyncActive(d));
  return doc ? cloneDocument(doc) : undefined;
}

export function getDocumentsByCategory(category: CompanyDocumentCategory): CompanyDocument[] {
  return filterSyncActive(documents).filter((d) => d.category === category).map(cloneDocument);
}

export function searchDocuments(
  query: string,
  filter:
    | CompanyDocumentCategory
    | 'all'
    | {
        category?: CompanyDocumentCategory | 'all';
        area?: DocumentAreaFilterId;
      } = 'all',
): CompanyDocument[] {
  const normalizedQuery = query.trim().toLowerCase();
  const categoryFilter = typeof filter === 'string' ? filter : (filter.category ?? 'all');
  const areaFilter = typeof filter === 'string' ? 'alle' : (filter.area ?? 'alle');

  return documents
    .filter((doc) => isEntitySyncActive(doc))
    .filter((doc) => {
      if (categoryFilter && categoryFilter !== 'all' && doc.category !== categoryFilter) {
        return false;
      }
      if (!documentMatchesArea(doc, areaFilter)) {
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
  const document = withNewEntitySync(
    buildDocumentFromInput(input, generateEntityId('doc'), now),
    'document',
  );
  documents = [document, ...documents];
  recordArchivedDocumentMemory(document);
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
    linkedInvoiceId:
      changes.linkedInvoiceId !== undefined ? changes.linkedInvoiceId : current.linkedInvoiceId,
    fileRefId: changes.fileRefId ?? current.fileRefId,
    sourceFileHash: changes.sourceFileHash ?? current.sourceFileHash,
    originalFileName: changes.originalFileName ?? current.originalFileName,
    mimeType: changes.mimeType ?? current.mimeType,
    fileSize: changes.fileSize ?? current.fileSize,
    classifiedKind: changes.classifiedKind ?? current.classifiedKind,
    sourceInboxItemId: changes.sourceInboxItemId ?? current.sourceInboxItemId,
    documentDate: changes.documentDate !== undefined ? changes.documentDate : current.documentDate,
    uploadedAt: changes.uploadedAt ?? current.uploadedAt,
  };

  const validationError = validateInput(merged);
  if (validationError) return { success: false, errorKey: validationError };

  const updated = withUpdatedEntitySync(
    buildDocumentFromInput(merged, current.id, current.createdAt),
    'document',
  );
  documents = [...documents.slice(0, index), updated, ...documents.slice(index + 1)];
  persistAll();
  return { success: true, document: cloneDocument(updated) };
}

export function deleteDocument(id: string): DocumentMutationResult {
  const index = documents.findIndex((d) => d.id === id && isEntitySyncActive(d));
  if (index === -1) return { success: false, errorKey: 'document.notFound' };

  const document = documents[index];
  // Capture original + binding FileRefs before bindings are removed.
  const heldFileRefIds = new Set<string>();
  if (document.fileRefId) {
    heldFileRefIds.add(document.fileRefId);
  }
  for (const binding of getDocumentFileRepresentationBindingStoreSnapshot()) {
    if (binding.documentId === id) {
      heldFileRefIds.add(binding.fileRefId);
    }
  }

  const tombstoned = withTombstonedEntity(cloneDocument(document), 'document');
  documents = [...documents.slice(0, index), tombstoned, ...documents.slice(index + 1)];
  tombstoneMemoryForDocument(id);
  removeDocumentFileRepresentationBindingsForDocument(id);
  persistAll();
  queueMicrotask(() => {
    void import('./documentFileReferenceService')
      .then(async ({ releaseDocumentFileIfUnreferenced }) => {
        for (const fileRefId of heldFileRefIds) {
          await releaseDocumentFileIfUnreferenced(fileRefId);
        }
      })
      .then(() => persistAll());
  });
  return { success: true, document: cloneDocument(tombstoned) };
}

export function linkDocumentToVorgang(
  id: string,
  link: CompanyDocumentVorgangLink | null,
): DocumentMutationResult {
  return updateDocument(id, { linkedVorgang: link });
}

function normalizeDuplicateKey(title: string, issuer: string): string {
  return `${title.trim().toLowerCase()}|${issuer.trim().toLowerCase()}`;
}

function buildRecognizedTextFromInbox(item: InboxItem): string {
  const lines = Object.entries(item.recognizedData).map(([key, value]) => `${key}: ${value}`);
  if (item.officePilotSuggestion) {
    lines.push('', item.officePilotSuggestion);
  }
  return lines.join('\n').trim();
}

function buildTagsFromInbox(item: InboxItem): string[] {
  const tags = [`Inbox:${item.documentType}`];
  if (item.sourceFileName) tags.push(item.sourceFileName);
  if (item.vorgangTitle) tags.push(item.vorgangTitle);
  return tags;
}

function mapDocumentCategory(item: InboxItem): CompanyDocumentCategory {
  const text = `${item.sender} ${item.title} ${JSON.stringify(item.recognizedData)}`.toLowerCase();

  switch (item.documentType) {
    case 'behoerde':
      if (/versicherung|allianz|haftpflicht|policy/.test(text)) return 'versicherung';
      return 'behoerde';
    case 'eingangsrechnung':
      return 'steuer';
    case 'ausgangsrechnung':
      return 'ausgangsrechnung';
    case 'kundenauftrag':
      return 'vertrag';
    case 'brief':
      return 'sonstiges';
    default:
      return 'sonstiges';
  }
}

function imagePreviewForDocumentType(type: DocumentType): string {
  switch (type) {
    case 'behoerde':
      return '🏛️';
    case 'brief':
      return '✉️';
    case 'eingangsrechnung':
    case 'ausgangsrechnung':
      return '🧾';
    case 'kundenauftrag':
      return '📋';
    default:
      return '📄';
  }
}

function linkedVorgangFromInbox(item: InboxItem): CompanyDocumentVorgangLink | null {
  if (!item.vorgangId || !item.vorgangTitle) return null;
  return { vorgangId: item.vorgangId, vorgangTitle: item.vorgangTitle };
}

function fileMetaFromInbox(item: InboxItem): Pick<
  CompanyDocumentInput,
  | 'fileRefId'
  | 'sourceFileHash'
  | 'originalFileName'
  | 'mimeType'
  | 'fileSize'
  | 'classifiedKind'
  | 'sourceInboxItemId'
  | 'documentDate'
  | 'uploadedAt'
> {
  const ref = item.fileRefId ? getDocumentFileRefById(item.fileRefId) : undefined;
  return {
    fileRefId: item.fileRefId ?? ref?.id,
    sourceFileHash: item.sourceFileHash ?? ref?.contentHash,
    originalFileName: ref?.originalFileName ?? item.sourceFileName,
    mimeType: ref?.mimeType,
    fileSize: ref?.fileSize,
    classifiedKind: item.classifiedKind,
    sourceInboxItemId: item.id,
    documentDate: item.receivedAt || null,
    uploadedAt: ref?.createdAt ?? item.receivedAt,
  };
}

export function mapInboxItemToDocumentInput(
  item: InboxItem,
  linkedCompany: string,
): CompanyDocumentInput {
  const filing = resolvePaperFilingFromInbox(item);
  const paperFolder: PaperFilingRule = filing.skipPhysicalFiling
    ? item.paperFiling
    : filing.rule ?? item.paperFiling;

  return {
    title: item.title,
    category: mapDocumentCategory(item),
    issuer: item.sender,
    recognizedText: buildRecognizedTextFromInbox(item),
    issueDate: item.receivedAt || null,
    validUntil: item.deadline,
    digitalFolder: { ...item.digitalFolder },
    paperFolder: { ...paperFolder },
    tags: buildTagsFromInbox(item),
    linkedCompany,
    linkedVorgang: linkedVorgangFromInbox(item),
    archived: true,
    imagePreview: imagePreviewForDocumentType(item.documentType),
    ...fileMetaFromInbox(item),
  };
}

export function findDocumentByContentHash(contentHash: string): CompanyDocument | null {
  if (!contentHash) return null;
  const doc = documents.find(
    (entry) => entry.sourceFileHash === contentHash && isEntitySyncActive(entry),
  );
  return doc ? cloneDocument(doc) : null;
}

export function isDuplicateDocument(
  item: InboxItem,
  linkedCompany: string,
  options?: { excludeDocumentId?: string },
): CompanyDocument | null {
  if (item.sourceFileHash) {
    const hashMatch = findDocumentByContentHash(item.sourceFileHash);
    if (hashMatch && hashMatch.id !== options?.excludeDocumentId) {
      return hashMatch;
    }
  }

  const input = mapInboxItemToDocumentInput(item, linkedCompany);
  const candidateKey = normalizeDuplicateKey(input.title, input.issuer ?? '');

  const match = documents.find((doc) => {
    if (options?.excludeDocumentId && doc.id === options.excludeDocumentId) return false;
    return normalizeDuplicateKey(doc.title, doc.issuer) === candidateKey;
  });

  return match ? cloneDocument(match) : null;
}

import { linkArchivedDocumentToVorgang } from './vorgangDocumentLinkService';
import type { DocumentFileTransformPlan } from '../types/documentFileTransformPlan';
import { orchestrateSourceReuseArchiveBindingAfterImport } from './documentFileSourceReuseArchiveOrchestrationService';

export interface ImportInboxDocumentOptions {
  /** Pre-built transform plan for post-import source-reuse archive binding. */
  transformPlan?: DocumentFileTransformPlan | null;
}

export function importInboxDocument(
  item: InboxItem,
  linkedCompany: string,
  options?: ImportInboxDocumentOptions,
): DocumentMutationResult {
  const input = mapInboxItemToDocumentInput(item, linkedCompany);
  const result = addDocument(input);
  if (result.success) {
    recordArchivedDocumentMemory(result.document, { inboxItem: item });
    if (isContractInboxItem(item)) {
      syncContractProofRequirementsFromInbox(item);
    }
    if (item.vorgangId) {
      linkArchivedDocumentToVorgang(result.document, item);
    }
    persistAll();
    orchestrateSourceReuseArchiveBindingAfterImport({
      documentId: result.document.id,
      transformPlan: options?.transformPlan,
    });
  }
  return result;
}

export function updateDocumentFromInbox(
  documentId: string,
  item: InboxItem,
  linkedCompany: string,
): DocumentMutationResult {
  const input = mapInboxItemToDocumentInput(item, linkedCompany);
  return updateDocument(documentId, input);
}
