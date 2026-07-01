import type { KnowledgeFact } from '../types/knowledge';

function cloneFact(fact: KnowledgeFact): KnowledgeFact {
  return { ...fact };
}

let facts: KnowledgeFact[] = [];

export function getKnowledgeStoreSnapshot(): KnowledgeFact[] {
  return facts.map(cloneFact);
}

export function hydrateKnowledgeStore(items: KnowledgeFact[]): void {
  facts = items.map(cloneFact);
}

export function resetKnowledgeStore(): void {
  facts = [];
}

export function setKnowledgeStoreForTests(items: KnowledgeFact[]): void {
  facts = items.map(cloneFact);
}

export function getAllKnowledgeFromStore(): KnowledgeFact[] {
  return facts.map(cloneFact);
}

export function prependKnowledgeToStore(fact: KnowledgeFact): KnowledgeFact {
  facts = [cloneFact(fact), ...facts];
  return cloneFact(fact);
}

export function replaceKnowledgeInStore(id: string, next: KnowledgeFact): KnowledgeFact | null {
  const index = facts.findIndex((item) => item.id === id);
  if (index === -1) return null;
  facts = [...facts.slice(0, index), cloneFact(next), ...facts.slice(index + 1)];
  return cloneFact(next);
}

export function deleteKnowledgeFromStore(id: string): KnowledgeFact | null {
  const index = facts.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const removed = cloneFact(facts[index]);
  facts = facts.filter((item) => item.id !== id);
  return removed;
}
