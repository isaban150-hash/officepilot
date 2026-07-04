import type {
  ClassifiedDocumentKind,
  CompanyDocument,
  InboxItem,
  RequiredDocument,
} from '../types/models';
import type {
  DocumentMemory,
  DocumentSummary,
  MemoryRelation,
  OfficePilotMemoryState,
  ProofMemory,
  ProofStatus,
  ProofType,
} from '../types/memory';
import { PROOF_EXPIRY_WARNING_DAYS, SUPPORTED_PROOF_TYPES } from '../types/memory';
import { analyzeContractFromInbox } from './contractAnalysisService';
import { understandArchivedDocument } from './memory/documentUnderstandingService';
import { applyAiSummaryEnhancement } from './memory/documentSummaryService';
import { getTodayIso } from './taskNormalize';
import {
  getAllDocumentMemoriesFromStore,
  getAllProofMemoriesFromStore,
  getMemoryStoreSnapshot,
  hydrateMemoryStore,
  removeProofMemoriesFromStore,
  resetMemoryStore,
  upsertDocumentMemoryInStore,
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
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    updatedAt: new Date().toISOString(),
  };

  upsertDocumentMemoryInStore(merged);
  return cloneDocumentMemory(merged);
}

export function getAllDocumentMemories(): DocumentMemory[] {
  return getAllDocumentMemoriesFromStore().map(cloneDocumentMemory);
}

export function addOrUpdateProofMemory(
  input: Omit<ProofMemory, 'lastCheckedAt' | 'updatedAt'> & {
    lastCheckedAt?: string;
    updatedAt?: string;
  },
): ProofMemory {
  const now = new Date().toISOString();
  const memory: ProofMemory = {
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
  };

  upsertProofMemoryInStore(memory);
  return cloneProofMemory(memory);
}

export function getProofMemories(): ProofMemory[] {
  return getAllProofMemoriesFromStore().map(cloneProofMemory);
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
  return getMemoryStoreSnapshot().relations.map(cloneRelation);
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

  const documentMemory = addDocumentMemory({
    documentId: document.id,
    inboxId: options?.inboxItem?.id,
    classifiedKind,
    title: document.title,
    issuer: document.issuer,
    digitalFolder: document.digitalFolder,
    paperFolder: document.paperFolder,
    validUntil: document.validUntil,
    linkedVorgangId,
    proofType,
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

    const existingDocumentProof = getProofMemories().find(
      (item) =>
        item.proofType === proofType &&
        item.status !== 'missing' &&
        item.documentId,
    );

    if (existingDocumentProof) {
      fulfillMissingProofsForType(proofType);
      continue;
    }

    const missing = addOrUpdateProofMemory({
      id: missingProofId(vorgangId, proofType),
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
