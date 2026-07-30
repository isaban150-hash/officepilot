import type {
  ClassifiedDocumentKind,
  CompanyDocument,
  InboxItem,
  PaperFilingRule,
  RequiredDocument,
} from '../types/models';
import type {
  DocumentMemory,
  DocumentSummary,
  MemoryRelation,
  OfficePilotMemoryState,
  PaperRegisterEntry,
  ProofMemory,
  ProofStatus,
  ProofType,
} from '../types/memory';
import { PROOF_EXPIRY_WARNING_DAYS, SUPPORTED_PROOF_TYPES } from '../types/memory';
import { analyzeContractFromInbox } from './contractAnalysisService';
import { understandArchivedDocument } from './memory/documentUnderstandingService';
import { applyAiSummaryEnhancement } from './memory/documentSummaryService';
import { persistAll } from './persistenceService';
import {
  filterSyncActive,
  generateEntityId,
  isEntitySyncActive,
  withNewEntitySync,
  withTombstonedEntity,
  withUpdatedEntitySync,
} from './sync/syncMetaService';
import {
  resolvePaperFiling,
  type PaperFilingContext,
} from './paperFolderService';
import { getCompanyProfile } from './companyProfileService';
import { getTodayIso } from './taskNormalize';
import {
  getAllDocumentMemoriesFromStore,
  getAllPaperRegisterEntriesFromStore,
  getAllProofMemoriesFromStore,
  getMemoryStoreSnapshot,
  getPaperRegisterEntryByDocumentId,
  hydrateMemoryStore,
  removeProofMemoriesFromStore,
  resetMemoryStore,
  upsertDocumentMemoryInStore,
  upsertPaperRegisterEntryInStore,
  upsertProofMemoryInStore,
  upsertRelationInStore,
} from './officePilotMemoryStore';

const CONTRACT_PROOF_TYPE_MAP: Record<string, ProofType | undefined> = {
  freistellungsbescheinigung: 'freistellungsbescheinigung',
  bg_bau: 'bg_bau',
  soka_bau: 'soka_bau',
  versicherung: 'betriebshaftpflicht',
};

const CLASSIFIED_KIND_PROOF_MAP: Partial<Record<ClassifiedDocumentKind, ProofType>> = {
  freistellungsbescheinigung: 'freistellungsbescheinigung',
  unbedenklichkeitsbescheinigung: 'bg_bau',
  bg_bau: 'bg_bau',
  berufsgenossenschaft: 'bg_bau',
  soka_bau: 'soka_bau',
  betriebshaftpflicht: 'betriebshaftpflicht',
  versicherung: 'betriebshaftpflicht',
  versicherungsbescheid: 'betriebshaftpflicht',
};

function createId(prefix: string): string {
  return generateEntityId(prefix);
}

function cloneDocumentMemory(memory: DocumentMemory): DocumentMemory {
  return {
    ...memory,
    digitalFolder: { ...memory.digitalFolder },
    paperFolder: { ...memory.paperFolder },
    summary: memory.summary ? { ...memory.summary, amounts: [...memory.summary.amounts], requiredDocuments: [...memory.summary.requiredDocuments] } : undefined,
    requiredDocuments: memory.requiredDocuments ? [...memory.requiredDocuments] : undefined,
    relatedAuthorities: memory.relatedAuthorities ? [...memory.relatedAuthorities] : undefined,
    relatedCustomers: memory.relatedCustomers ? [...memory.relatedCustomers] : undefined,
    relatedProofs: memory.relatedProofs ? [...memory.relatedProofs] : undefined,
    letterExplanation: memory.letterExplanation
      ? {
          ...memory.letterExplanation,
          requiredDocuments: [...memory.letterExplanation.requiredDocuments],
        }
      : undefined,
  };
}

function cloneProofMemory(memory: ProofMemory): ProofMemory {
  return {
    ...memory,
    requiredByVorgangIds: [...memory.requiredByVorgangIds],
  };
}

function cloneRelation(relation: MemoryRelation): MemoryRelation {
  return { ...relation };
}

function clonePaperRegisterEntry(entry: PaperRegisterEntry): PaperRegisterEntry {
  return { ...entry };
}

function paperRegisterEntryId(documentId: string): string {
  return `paper-reg-${documentId}`;
}

export function resolvePaperFilingForDocument(
  document: CompanyDocument,
  context?: PaperFilingContext,
): ReturnType<typeof resolvePaperFiling> {
  return resolvePaperFiling({
    classifiedKind: context?.classifiedKind,
    documentType: context?.documentType,
    issuer: document.issuer,
    sender: document.issuer,
    isAdvertisement: context?.isAdvertisement,
    linkedVorgangId: document.linkedVorgang?.vorgangId ?? context?.linkedVorgangId,
    year: context?.year,
  });
}

export function createPaperRegisterEntryForDocument(
  document: CompanyDocument,
  options?: {
    sourceInboxId?: string;
    skipIfNoRule?: boolean;
    classifiedKind?: ClassifiedDocumentKind;
    isAdvertisement?: boolean;
    paperFolder?: PaperFilingRule;
  },
): PaperRegisterEntry | null {
  const resolution = options?.paperFolder?.folderId
    ? { rule: options.paperFolder, skipPhysicalFiling: false }
    : document.paperFolder?.folderId
      ? { rule: document.paperFolder, skipPhysicalFiling: false }
      : resolvePaperFilingForDocument(document, {
          classifiedKind: options?.classifiedKind,
          isAdvertisement: options?.isAdvertisement,
        });

  if (resolution.skipPhysicalFiling || !resolution.rule?.folderId) {
    return options?.skipIfNoRule ? null : null;
  }

  const existing = getPaperRegisterEntryByDocumentId(document.id);
  if (existing) {
    if (
      existing.folderId !== resolution.rule.folderId ||
      existing.register !== resolution.rule.register
    ) {
      const now = new Date().toISOString();
      const updated: PaperRegisterEntry = {
        ...existing,
        folderId: resolution.rule.folderId,
        register: resolution.rule.register,
        documentTitle: document.title,
        sourceInboxId: options?.sourceInboxId ?? existing.sourceInboxId,
        updatedAt: now,
      };
      upsertPaperRegisterEntryInStore(updated);
      return clonePaperRegisterEntry(updated);
    }
    return clonePaperRegisterEntry(existing);
  }

  const now = new Date().toISOString();
  const entry: PaperRegisterEntry = {
    id: paperRegisterEntryId(document.id),
    documentId: document.id,
    documentTitle: document.title,
    sourceInboxId: options?.sourceInboxId,
    folderId: resolution.rule.folderId,
    register: resolution.rule.register,
    physicalFiled: false,
    createdAt: now,
    updatedAt: now,
  };

  upsertPaperRegisterEntryInStore(entry);
  return clonePaperRegisterEntry(entry);
}

export function getPaperRegisterEntries(): PaperRegisterEntry[] {
  return filterSyncActive(getAllPaperRegisterEntriesFromStore()).map(clonePaperRegisterEntry);
}

export function getPaperRegisterEntryForDocument(documentId: string): PaperRegisterEntry | undefined {
  const entry = getPaperRegisterEntryByDocumentId(documentId);
  if (!entry || !isEntitySyncActive(entry)) return undefined;
  return clonePaperRegisterEntry(entry);
}

export function markDocumentPhysicallyFiled(
  documentId: string,
  filedByUser?: string,
): DocumentMemory | null {
  const memory = getDocumentMemoryByDocumentId(documentId);
  if (!memory) return null;

  const now = new Date().toISOString();
  const user = filedByUser ?? getCompanyProfile().contactPerson ?? 'Nutzer';

  const entry = getPaperRegisterEntryByDocumentId(documentId);
  if (entry) {
    upsertPaperRegisterEntryInStore({
      ...entry,
      physicalFiled: true,
      filedAt: now,
      filedByUser: user,
      updatedAt: now,
    });
  }

  const updated = enrichDocumentMemory(documentId, {
    physicalFiled: true,
    filedAt: now,
    filedByUser: user,
    paperRegisterEntryId: entry?.id ?? memory.paperRegisterEntryId,
  });

  persistAll();
  return updated;
}

export function daysUntil(isoDate: string, todayIso: string): number {
  const today = new Date(`${todayIso.slice(0, 10)}T12:00:00`);
  const target = new Date(`${isoDate.slice(0, 10)}T12:00:00`);
  return Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

export function computeProofStatus(
  validUntil: string | null | undefined,
  todayIso: string = getTodayIso(),
): ProofStatus {
  if (!validUntil) return 'unknown';
  const days = daysUntil(validUntil, todayIso);
  if (days < 0) return 'expired';
  if (days <= PROOF_EXPIRY_WARNING_DAYS) return 'expiring';
  return 'valid';
}

export function mapContractRequiredDocToProofType(type: string): ProofType | undefined {
  return CONTRACT_PROOF_TYPE_MAP[type];
}

export function detectProofTypeFromDocument(
  document: CompanyDocument,
  classifiedKind?: ClassifiedDocumentKind,
): ProofType | undefined {
  if (classifiedKind && CLASSIFIED_KIND_PROOF_MAP[classifiedKind]) {
    return CLASSIFIED_KIND_PROOF_MAP[classifiedKind];
  }

  const haystack = `${document.title} ${document.issuer} ${document.recognizedText} ${document.tags.join(' ')}`.toLowerCase();

  if (/freistellungsbescheinigung|§48b|§48 b/.test(haystack)) {
    return 'freistellungsbescheinigung';
  }
  if (/bg[\s-]?bau|unbedenklichkeitsbescheinigung|berufsgenossenschaft der bauwirtschaft/.test(haystack)) {
    return 'bg_bau';
  }
  if (/soka[\s-]?bau/.test(haystack)) {
    return 'soka_bau';
  }
  if (/betriebshaftpflicht|haftpflichtversicherung|haftpflicht/.test(haystack)) {
    return 'betriebshaftpflicht';
  }

  return undefined;
}

function missingProofId(vorgangId: string, proofType: ProofType): string {
  return `proof-missing-${vorgangId}-${proofType}`;
}

function documentProofId(proofType: ProofType): string {
  return `proof-doc-${proofType}`;
}

function relationId(vorgangId: string, proofType: ProofType): string {
  return `relation-${vorgangId}-${proofType}`;
}

export function addDocumentMemory(
  input: Omit<DocumentMemory, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
): DocumentMemory {
  const now = new Date().toISOString();
  const existing = getAllDocumentMemoriesFromStore().find(
    (item) => item.documentId === input.documentId,
  );

  const memory: DocumentMemory = {
    id: existing?.id ?? input.id ?? createId('docmem'),
    documentId: input.documentId,
    inboxId: input.inboxId ?? existing?.inboxId,
    classifiedKind: input.classifiedKind ?? existing?.classifiedKind,
    title: input.title,
    issuer: input.issuer,
    digitalFolder: { ...input.digitalFolder },
    paperFolder: { ...input.paperFolder },
    validUntil: input.validUntil ?? null,
    linkedVorgangId: input.linkedVorgangId ?? existing?.linkedVorgangId,
    proofType: input.proofType ?? existing?.proofType,
    summary: existing?.summary,
    topic: existing?.topic,
    nextAction: existing?.nextAction,
    riskLevel: existing?.riskLevel,
    requiredDocuments: existing?.requiredDocuments,
    relatedAuthorities: existing?.relatedAuthorities,
    relatedCustomers: existing?.relatedCustomers,
    relatedProofs: existing?.relatedProofs,
    letterExplanation: existing?.letterExplanation,
    memoryStatus: existing?.memoryStatus,
    physicalFiled: input.physicalFiled ?? existing?.physicalFiled,
    filedAt: input.filedAt ?? existing?.filedAt,
    filedByUser: input.filedByUser ?? existing?.filedByUser,
    paperRegisterEntryId: input.paperRegisterEntryId ?? existing?.paperRegisterEntryId,
    source: input.source ?? existing?.source,
    mailFrom: input.mailFrom ?? existing?.mailFrom,
    mailSubject: input.mailSubject ?? existing?.mailSubject,
    mailImportId: input.mailImportId ?? existing?.mailImportId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  upsertDocumentMemoryInStore(memory);
  return cloneDocumentMemory(memory);
}

export function getDocumentMemory(id: string): DocumentMemory | undefined {
  const memory = getAllDocumentMemoriesFromStore().find((item) => item.id === id);
  return memory ? cloneDocumentMemory(memory) : undefined;
}

export function getDocumentMemoryByDocumentId(documentId: string): DocumentMemory | undefined {
  const memory = getAllDocumentMemoriesFromStore().find((item) => item.documentId === documentId);
  return memory ? cloneDocumentMemory(memory) : undefined;
}

function mergeOptionalString(existing: string | undefined, incoming: string | undefined): string | undefined {
  if (!incoming?.trim()) return existing;
  return incoming.trim();
}

function mergeOptionalArray<T>(existing: T[] | undefined, incoming: T[] | undefined): T[] | undefined {
  if (!incoming?.length) return existing;
  const merged = [...new Set([...(existing ?? []), ...incoming])];
  return merged.length > 0 ? merged : existing;
}

export function enrichDocumentMemory(
  documentId: string,
  patch: Partial<
    Pick<
      DocumentMemory,
      | 'summary'
      | 'topic'
      | 'nextAction'
      | 'riskLevel'
      | 'requiredDocuments'
      | 'relatedAuthorities'
      | 'relatedCustomers'
      | 'relatedProofs'
      | 'letterExplanation'
      | 'memoryStatus'
      | 'physicalFiled'
      | 'filedAt'
      | 'filedByUser'
      | 'paperRegisterEntryId'
    >
  >,
): DocumentMemory | null {
  const existing = getAllDocumentMemoriesFromStore().find((item) => item.documentId === documentId);
  if (!existing) return null;

  const merged: DocumentMemory = {
    ...existing,
    topic: mergeOptionalString(existing.topic, patch.topic),
    nextAction: mergeOptionalString(existing.nextAction, patch.nextAction),
    riskLevel: patch.riskLevel ?? existing.riskLevel,
    requiredDocuments: mergeOptionalArray(existing.requiredDocuments, patch.requiredDocuments),
    relatedAuthorities: mergeOptionalArray(existing.relatedAuthorities, patch.relatedAuthorities),
    relatedCustomers: mergeOptionalArray(existing.relatedCustomers, patch.relatedCustomers),
    relatedProofs: mergeOptionalArray(existing.relatedProofs, patch.relatedProofs),
    summary: patch.summary ?? existing.summary,
    letterExplanation: patch.letterExplanation ?? existing.letterExplanation,
    memoryStatus: patch.memoryStatus ?? existing.memoryStatus,
    physicalFiled: patch.physicalFiled ?? existing.physicalFiled,
    filedAt: patch.filedAt ?? existing.filedAt,
    filedByUser: patch.filedByUser ?? existing.filedByUser,
    paperRegisterEntryId: patch.paperRegisterEntryId ?? existing.paperRegisterEntryId,
    updatedAt: new Date().toISOString(),
  };

  const synced = withUpdatedEntitySync(merged, 'document_memory');
  upsertDocumentMemoryInStore(synced);
  return cloneDocumentMemory(synced);
}

export function getAllDocumentMemories(): DocumentMemory[] {
  return filterSyncActive(getAllDocumentMemoriesFromStore()).map(cloneDocumentMemory);
}

export function addOrUpdateProofMemory(
  input: Omit<ProofMemory, 'lastCheckedAt' | 'updatedAt'> & {
    lastCheckedAt?: string;
    updatedAt?: string;
  },
): ProofMemory {
  const now = new Date().toISOString();
  const existingProof = getAllProofMemoriesFromStore().find((item) => item.id === input.id);
  const base: ProofMemory = {
    id: input.id,
    proofType: input.proofType,
    status: input.status,
    validFrom: input.validFrom ?? null,
    validUntil: input.validUntil ?? null,
    documentMemoryId: input.documentMemoryId ?? null,
    documentId: input.documentId ?? null,
    requiredByVorgangIds: [...input.requiredByVorgangIds],
    sourceInboxId: input.sourceInboxId,
    lastCheckedAt: input.lastCheckedAt ?? now,
    updatedAt: input.updatedAt ?? now,
    sync: existingProof?.sync,
  };

  const memory = existingProof
    ? withUpdatedEntitySync(base, 'proof_memory')
    : withNewEntitySync(base, 'proof_memory');

  upsertProofMemoryInStore(memory);
  return cloneProofMemory(memory);
}

export function getProofMemories(): ProofMemory[] {
  return filterSyncActive(getAllProofMemoriesFromStore()).map(cloneProofMemory);
}

export function getProofsByStatus(status: ProofStatus): ProofMemory[] {
  return getProofMemories().filter((item) => item.status === status);
}

export function getProofsForVorgang(vorgangId: string): ProofMemory[] {
  const requiredTypes = new Set(
    getMemoryRelations()
      .filter((relation) => relation.fromType === 'vorgang' && relation.fromId === vorgangId)
      .map((relation) => relation.toProofType),
  );

  return getProofMemories().filter(
    (item) =>
      item.requiredByVorgangIds.includes(vorgangId) ||
      (Boolean(item.documentId) && requiredTypes.has(item.proofType)),
  );
}

export function getMemoryRelations(): MemoryRelation[] {
  return filterSyncActive(getMemoryStoreSnapshot().relations).map(cloneRelation);
}

export function tombstoneMemoryForDocument(documentId: string): void {
  for (const memory of getAllDocumentMemoriesFromStore()) {
    if (memory.documentId === documentId && isEntitySyncActive(memory)) {
      upsertDocumentMemoryInStore(withTombstonedEntity(memory, 'document_memory'));
    }
  }
  for (const proof of getAllProofMemoriesFromStore()) {
    if (proof.documentId === documentId && isEntitySyncActive(proof)) {
      upsertProofMemoryInStore(withTombstonedEntity(proof, 'proof_memory'));
    }
  }
  const paperEntry = getPaperRegisterEntryByDocumentId(documentId);
  if (paperEntry && isEntitySyncActive(paperEntry)) {
    upsertPaperRegisterEntryInStore(withTombstonedEntity(paperEntry, 'paper_register_entry'));
  }
}

export function resetMemory(): void {
  resetMemoryStore();
}

export function hydrateMemory(state: OfficePilotMemoryState): void {
  hydrateMemoryStore(state);
}

export function getOfficePilotMemorySnapshot(): OfficePilotMemoryState {
  return getMemoryStoreSnapshot();
}

function fulfillMissingProofsForType(proofType: ProofType): void {
  removeProofMemoriesFromStore(
    (item) => item.status === 'missing' && item.proofType === proofType,
  );
}

function upsertDocumentBackedProof(
  proofType: ProofType,
  documentMemory: DocumentMemory,
  todayIso: string = getTodayIso(),
): ProofMemory {
  const status = computeProofStatus(documentMemory.validUntil, todayIso);
  const proof = addOrUpdateProofMemory({
    id: documentProofId(proofType),
    proofType,
    status,
    validUntil: documentMemory.validUntil,
    documentMemoryId: documentMemory.id,
    documentId: documentMemory.documentId,
    requiredByVorgangIds: [],
  });

  if (documentMemory.documentId) {
    fulfillMissingProofsForType(proofType);
  }

  return proof;
}

export function recordArchivedDocumentMemory(
  document: CompanyDocument,
  options?: { inboxItem?: InboxItem; todayIso?: string },
): DocumentMemory | null {
  const classifiedKind = options?.inboxItem?.classifiedKind;
  const proofType = detectProofTypeFromDocument(document, classifiedKind);
  const linkedVorgangId =
    document.linkedVorgang?.vorgangId ?? options?.inboxItem?.vorgangId ?? undefined;

  const paperResolution = resolvePaperFiling({
    classifiedKind,
    documentType: options?.inboxItem?.documentType,
    issuer: document.issuer,
    sender: document.issuer,
    isAdvertisement: options?.inboxItem?.isAdvertisement,
    linkedVorgangId,
  });

  const paperFolder =
    paperResolution.rule && !paperResolution.skipPhysicalFiling
      ? paperResolution.rule
      : document.paperFolder;

  const registerEntry =
    paperResolution.rule && !paperResolution.skipPhysicalFiling
      ? createPaperRegisterEntryForDocument(document, {
            sourceInboxId: options?.inboxItem?.id,
            skipIfNoRule: true,
            classifiedKind,
            isAdvertisement: options?.inboxItem?.isAdvertisement,
            paperFolder,
          })
      : null;

  const documentMemory = addDocumentMemory({
    documentId: document.id,
    inboxId: options?.inboxItem?.id,
    classifiedKind,
    title: document.title,
    issuer: document.issuer,
    digitalFolder: document.digitalFolder,
    paperFolder,
    validUntil: document.validUntil,
    linkedVorgangId,
    proofType,
    paperRegisterEntryId: registerEntry?.id,
    physicalFiled: false,
    source: options?.inboxItem?.importSource === 'email' ? 'email' : undefined,
    mailFrom:
      options?.inboxItem?.importSource === 'email'
        ? (options.inboxItem.sender || document.issuer)
        : undefined,
    mailSubject:
      options?.inboxItem?.importSource === 'email'
        ? (options.inboxItem.title || document.title)
        : undefined,
    mailImportId: options?.inboxItem?.mailImportId,
  });

  if (proofType && SUPPORTED_PROOF_TYPES.includes(proofType)) {
    upsertDocumentBackedProof(proofType, documentMemory, options?.todayIso);
  }

  understandArchivedDocument(document, {
    inboxItem: options?.inboxItem,
    documentMemory,
    todayIso: options?.todayIso,
  });

  return getDocumentMemoryByDocumentId(document.id) ?? documentMemory;
}

/** AI-01 Hook: verbessert bestehende DocumentSummary-Felder im Gedächtnis. */
export function applyDocumentSummaryEnhancement(
  documentId: string,
  enhancement: Partial<DocumentSummary>,
): DocumentMemory | null {
  const existing = getDocumentMemoryByDocumentId(documentId);
  if (!existing?.summary) return null;

  const summary = applyAiSummaryEnhancement(existing.summary, enhancement ?? {});
  return enrichDocumentMemory(documentId, {
    summary,
    topic: summary.topic,
    nextAction: summary.nextAction,
    riskLevel: summary.riskLevel,
    requiredDocuments: summary.requiredDocuments,
    memoryStatus:
      summary.sourceConfidence === 'high'
        ? 'understood'
        : summary.sourceConfidence === 'medium'
          ? 'partial'
          : 'pending',
  });
}

export function syncContractProofRequirements(
  vorgangId: string,
  sourceInboxId: string,
  requiredDocuments: RequiredDocument[],
): { relations: MemoryRelation[]; missingProofs: ProofMemory[] } {
  const createdRelations: MemoryRelation[] = [];
  const createdMissing: ProofMemory[] = [];
  const now = new Date().toISOString();

  for (const required of requiredDocuments) {
    const proofType = mapContractRequiredDocToProofType(required.type);
    if (!proofType || !SUPPORTED_PROOF_TYPES.includes(proofType)) continue;

    const relation = upsertRelationInStore({
      id: relationId(vorgangId, proofType),
      relation: 'requires_proof',
      fromType: 'vorgang',
      fromId: vorgangId,
      toProofType: proofType,
      sourceInboxId,
      reason: required.reason,
      createdAt: now,
    });
    createdRelations.push(relation);

    const missingId = missingProofId(vorgangId, proofType);

    const existingDocumentProof = getProofMemories().find(
      (item) =>
        item.proofType === proofType &&
        item.status !== 'missing' &&
        Boolean(item.documentId),
    );

    if (existingDocumentProof) {
      fulfillMissingProofsForType(proofType);
      continue;
    }

    // Do not reset fulfilled/valid/unknown proofs back to missing on re-sync.
    const existingProtected = getProofMemories().find(
      (item) =>
        item.proofType === proofType &&
        item.status !== 'missing' &&
        (item.id === missingId || item.requiredByVorgangIds.includes(vorgangId)),
    );
    if (existingProtected) {
      continue;
    }

    const existingMissing = getProofMemories().find((item) => item.id === missingId);
    if (existingMissing) {
      createdMissing.push(existingMissing);
      continue;
    }

    const missing = addOrUpdateProofMemory({
      id: missingId,
      proofType,
      status: 'missing',
      validFrom: null,
      validUntil: null,
      documentMemoryId: null,
      documentId: null,
      requiredByVorgangIds: [vorgangId],
      sourceInboxId,
    });
    createdMissing.push(missing);
  }

  return { relations: createdRelations, missingProofs: createdMissing };
}

export function syncContractProofRequirementsFromInbox(item: InboxItem): {
  relations: MemoryRelation[];
  missingProofs: ProofMemory[];
} | null {
  const vorgangId = item.vorgangId;
  if (!vorgangId) return null;

  const analysis = analyzeContractFromInbox(item);
  if (!analysis.isContract || analysis.requiredDocuments.length === 0) {
    return null;
  }

  return syncContractProofRequirements(vorgangId, item.id, analysis.requiredDocuments);
}

export function isContractInboxItem(item: InboxItem): boolean {
  return analyzeContractFromInbox(item).isContract;
}
