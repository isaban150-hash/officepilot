import type {
  DocumentMemory,
  MemoryRelation,
  OfficePilotMemoryState,
  PaperRegisterEntry,
  ProofMemory,
} from '../types/memory';

function cloneDocumentMemory(item: DocumentMemory): DocumentMemory {
  return {
    ...item,
    digitalFolder: { ...item.digitalFolder },
    paperFolder: { ...item.paperFolder },
    summary: item.summary
      ? {
          ...item.summary,
          amounts: [...item.summary.amounts],
          requiredDocuments: [...item.summary.requiredDocuments],
        }
      : undefined,
    requiredDocuments: item.requiredDocuments ? [...item.requiredDocuments] : undefined,
    relatedAuthorities: item.relatedAuthorities ? [...item.relatedAuthorities] : undefined,
    relatedCustomers: item.relatedCustomers ? [...item.relatedCustomers] : undefined,
    relatedProofs: item.relatedProofs ? [...item.relatedProofs] : undefined,
    letterExplanation: item.letterExplanation
      ? {
          ...item.letterExplanation,
          requiredDocuments: [...item.letterExplanation.requiredDocuments],
        }
      : undefined,
  };
}

function cloneProofMemory(item: ProofMemory): ProofMemory {
  return {
    ...item,
    requiredByVorgangIds: [...item.requiredByVorgangIds],
  };
}

function cloneRelation(item: MemoryRelation): MemoryRelation {
  return { ...item };
}

function clonePaperRegisterEntry(item: PaperRegisterEntry): PaperRegisterEntry {
  return { ...item };
}

let documentMemories: DocumentMemory[] = [];
let proofMemories: ProofMemory[] = [];
let relations: MemoryRelation[] = [];
let paperRegisterEntries: PaperRegisterEntry[] = [];

export function getMemoryStoreSnapshot(): OfficePilotMemoryState {
  return {
    documentMemories: documentMemories.map(cloneDocumentMemory),
    proofMemories: proofMemories.map(cloneProofMemory),
    relations: relations.map(cloneRelation),
    paperRegisterEntries: paperRegisterEntries.map(clonePaperRegisterEntry),
  };
}

export function hydrateMemoryStore(state: OfficePilotMemoryState): void {
  documentMemories = (state.documentMemories ?? []).map(cloneDocumentMemory);
  proofMemories = (state.proofMemories ?? []).map(cloneProofMemory);
  relations = (state.relations ?? []).map(cloneRelation);
  paperRegisterEntries = (state.paperRegisterEntries ?? []).map(clonePaperRegisterEntry);
}

export function resetMemoryStore(): void {
  documentMemories = [];
  proofMemories = [];
  relations = [];
  paperRegisterEntries = [];
}

export function setMemoryStoreForTests(state: OfficePilotMemoryState): void {
  hydrateMemoryStore(state);
}

export function getAllDocumentMemoriesFromStore(): DocumentMemory[] {
  return documentMemories.map(cloneDocumentMemory);
}

export function upsertDocumentMemoryInStore(memory: DocumentMemory): DocumentMemory {
  const index = documentMemories.findIndex((item) => item.id === memory.id);
  if (index === -1) {
    documentMemories = [cloneDocumentMemory(memory), ...documentMemories];
  } else {
    documentMemories = [
      ...documentMemories.slice(0, index),
      cloneDocumentMemory(memory),
      ...documentMemories.slice(index + 1),
    ];
  }
  return cloneDocumentMemory(memory);
}

export function getAllProofMemoriesFromStore(): ProofMemory[] {
  return proofMemories.map(cloneProofMemory);
}

export function upsertProofMemoryInStore(memory: ProofMemory): ProofMemory {
  const index = proofMemories.findIndex((item) => item.id === memory.id);
  if (index === -1) {
    proofMemories = [cloneProofMemory(memory), ...proofMemories];
  } else {
    proofMemories = [
      ...proofMemories.slice(0, index),
      cloneProofMemory(memory),
      ...proofMemories.slice(index + 1),
    ];
  }
  return cloneProofMemory(memory);
}

export function removeProofMemoriesFromStore(predicate: (item: ProofMemory) => boolean): void {
  proofMemories = proofMemories.filter((item) => !predicate(item));
}

export function upsertRelationInStore(relation: MemoryRelation): MemoryRelation {
  const index = relations.findIndex((item) => item.id === relation.id);
  if (index === -1) {
    relations = [cloneRelation(relation), ...relations];
  } else {
    relations = [
      ...relations.slice(0, index),
      cloneRelation(relation),
      ...relations.slice(index + 1),
    ];
  }
  return cloneRelation(relation);
}

export function getAllPaperRegisterEntriesFromStore(): PaperRegisterEntry[] {
  return paperRegisterEntries.map(clonePaperRegisterEntry);
}

export function upsertPaperRegisterEntryInStore(entry: PaperRegisterEntry): PaperRegisterEntry {
  const index = paperRegisterEntries.findIndex((item) => item.id === entry.id);
  if (index === -1) {
    paperRegisterEntries = [clonePaperRegisterEntry(entry), ...paperRegisterEntries];
  } else {
    paperRegisterEntries = [
      ...paperRegisterEntries.slice(0, index),
      clonePaperRegisterEntry(entry),
      ...paperRegisterEntries.slice(index + 1),
    ];
  }
  return clonePaperRegisterEntry(entry);
}

export function getPaperRegisterEntryByDocumentId(documentId: string): PaperRegisterEntry | undefined {
  const entry = paperRegisterEntries.find((item) => item.documentId === documentId);
  return entry ? clonePaperRegisterEntry(entry) : undefined;
}
