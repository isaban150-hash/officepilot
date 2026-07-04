import type {
  DocumentMemory,
  MemoryRelation,
  OfficePilotMemoryState,
  ProofMemory,
} from '../types/memory';

function cloneDocumentMemory(item: DocumentMemory): DocumentMemory {
  return {
    ...item,
    digitalFolder: { ...item.digitalFolder },
    paperFolder: { ...item.paperFolder },
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

let documentMemories: DocumentMemory[] = [];
let proofMemories: ProofMemory[] = [];
let relations: MemoryRelation[] = [];

export function getMemoryStoreSnapshot(): OfficePilotMemoryState {
  return {
    documentMemories: documentMemories.map(cloneDocumentMemory),
    proofMemories: proofMemories.map(cloneProofMemory),
    relations: relations.map(cloneRelation),
  };
}

export function hydrateMemoryStore(state: OfficePilotMemoryState): void {
  documentMemories = (state.documentMemories ?? []).map(cloneDocumentMemory);
  proofMemories = (state.proofMemories ?? []).map(cloneProofMemory);
  relations = (state.relations ?? []).map(cloneRelation);
}

export function resetMemoryStore(): void {
  documentMemories = [];
  proofMemories = [];
  relations = [];
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
