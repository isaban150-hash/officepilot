import { persistAll } from './persistenceService';
import { getDocumentById } from './documentService';
import { getInboxItemById } from './inboxService';
import { getVorgangById } from './vorgangService';
import {
  filterSyncActive,
  generateEntityId,
  isEntitySyncActive,
  withNewEntitySync,
  withTombstonedEntity,
  withUpdatedEntitySync,
} from './sync/syncMetaService';
import {
  getAllKnowledgeFromStore,
  getKnowledgeStoreSnapshot,
  hydrateKnowledgeStore,
  prependKnowledgeToStore,
  replaceKnowledgeInStore,
  resetKnowledgeStore,
} from './knowledgeStore';
import type { CommunicationContextRef } from '../types/communication';
import type { KnowledgeFact, KnowledgeFactInput, KnowledgeScope } from '../types/knowledge';

function cloneFact(fact: KnowledgeFact): KnowledgeFact {
  return { ...fact };
}

function normalizeScopeId(scope: KnowledgeScope, scopeId?: string): string | undefined {
  if (scope === 'company') return undefined;
  const trimmed = scopeId?.trim();
  return trimmed || undefined;
}

function scopeKey(scope: KnowledgeScope, scopeId?: string): string {
  return `${scope}:${scopeId ?? ''}`;
}

function isDuplicateActiveFact(
  candidate: Pick<KnowledgeFact, 'scope' | 'scopeId' | 'key' | 'active'>,
  excludeId?: string,
): boolean {
  if (!candidate.active || !candidate.key) return false;
  return getAllKnowledgeFromStore().some(
    (fact) =>
      fact.id !== excludeId &&
      isEntitySyncActive(fact) &&
      fact.active &&
      fact.scope === candidate.scope &&
      (fact.scopeId ?? '') === (candidate.scopeId ?? '') &&
      fact.key === candidate.key,
  );
}

export type KnowledgeMutationResult =
  | { success: true; fact: KnowledgeFact }
  | { success: false; errorKey: string };

export function addKnowledgeFact(input: KnowledgeFactInput): KnowledgeMutationResult {
  if (!input.key?.trim()) return { success: false, errorKey: 'knowledge.keyRequired' };
  if (!input.value?.trim()) return { success: false, errorKey: 'knowledge.valueRequired' };
  if (!input.displayText?.trim()) return { success: false, errorKey: 'knowledge.displayTextRequired' };
  if (input.scope !== 'company' && !input.scopeId?.trim() && !input.scopeLabel?.trim()) {
    return { success: false, errorKey: 'knowledge.scopeTargetRequired' };
  }

  const scopeId = normalizeScopeId(input.scope, input.scopeId);
  const key = input.key.trim();
  const value = input.value.trim();
  const displayText = input.displayText.trim();
  const active = input.active ?? true;

  if (isDuplicateActiveFact({ scope: input.scope, scopeId, key, active })) {
    return { success: false, errorKey: 'knowledge.duplicate' };
  }

  const now = new Date().toISOString();
  const fact = withNewEntitySync(
    {
      id: generateEntityId('knowledge'),
      scope: input.scope,
      scopeId,
      scopeLabel: input.scopeLabel?.trim() || undefined,
      category: input.category,
      key,
      value,
      displayText,
      sourceType: input.sourceType ?? 'user',
      sourceId: input.sourceId,
      confirmedAt: now,
      createdAt: now,
      active,
    },
    'knowledge_fact',
  );

  prependKnowledgeToStore(fact);
  persistAll();
  return { success: true, fact: cloneFact(fact) };
}

export function updateKnowledgeFact(
  id: string,
  changes: Partial<KnowledgeFactInput>,
): KnowledgeMutationResult {
  const current = getAllKnowledgeFromStore().find((fact) => fact.id === id && isEntitySyncActive(fact));
  if (!current) return { success: false, errorKey: 'knowledge.notFound' };

  const nextScope = changes.scope ?? current.scope;
  const nextScopeId = changes.scopeId !== undefined ? normalizeScopeId(nextScope, changes.scopeId) : current.scopeId;
  const nextKey = (changes.key ?? current.key).trim();
  const nextValue = (changes.value ?? current.value).trim();
  const nextDisplayText = (changes.displayText ?? current.displayText).trim();
  const nextActive = changes.active ?? current.active;

  if (!nextKey) return { success: false, errorKey: 'knowledge.keyRequired' };
  if (!nextValue) return { success: false, errorKey: 'knowledge.valueRequired' };
  if (!nextDisplayText) return { success: false, errorKey: 'knowledge.displayTextRequired' };

  const candidate = {
    scope: nextScope,
    scopeId: nextScopeId,
    key: nextKey,
    active: nextActive,
  };
  if (isDuplicateActiveFact(candidate, id)) {
    return { success: false, errorKey: 'knowledge.duplicate' };
  }

  const updated = withUpdatedEntitySync(
    {
      ...current,
      scope: nextScope,
      scopeId: nextScopeId,
      scopeLabel: changes.scopeLabel !== undefined ? changes.scopeLabel.trim() || undefined : current.scopeLabel,
      category: changes.category ?? current.category,
      key: nextKey,
      value: nextValue,
      displayText: nextDisplayText,
      active: nextActive,
      updatedAt: new Date().toISOString(),
    },
    'knowledge_fact',
  );

  const saved = replaceKnowledgeInStore(id, updated);
  if (!saved) return { success: false, errorKey: 'knowledge.notFound' };
  persistAll();
  return { success: true, fact: cloneFact(saved) };
}

export function deleteKnowledgeFact(id: string): KnowledgeMutationResult {
  const current = getAllKnowledgeFromStore().find((fact) => fact.id === id && isEntitySyncActive(fact));
  if (!current) return { success: false, errorKey: 'knowledge.notFound' };
  const tombstoned = withTombstonedEntity({ ...current, active: false }, 'knowledge_fact');
  replaceKnowledgeInStore(id, tombstoned);
  persistAll();
  return { success: true, fact: cloneFact(tombstoned) };
}

export function getKnowledgeFacts(): KnowledgeFact[] {
  return filterSyncActive(getAllKnowledgeFromStore())
    .map(cloneFact)
    .sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt) || b.createdAt.localeCompare(a.createdAt));
}

export function getKnowledgeFactsForScope(scope: KnowledgeScope, scopeId?: string): KnowledgeFact[] {
  const normalizedId = scopeId?.trim();
  return getKnowledgeFacts().filter((fact) => {
    if (fact.scope !== scope) return false;
    if (scope === 'company') return true;
    return (fact.scopeId ?? '') === (normalizedId ?? '');
  });
}

export interface KnowledgeSearchOptions {
  query?: string;
  scope?: KnowledgeScope | 'all';
  scopeId?: string;
  category?: KnowledgeFact['category'] | 'all';
  active?: boolean | 'all';
}

export function searchKnowledgeFacts(options: KnowledgeSearchOptions = {}): KnowledgeFact[] {
  const query = options.query?.trim().toLowerCase() ?? '';
  return getKnowledgeFacts().filter((fact) => {
    if (options.scope && options.scope !== 'all' && fact.scope !== options.scope) return false;
    if (options.scopeId && (fact.scopeId ?? '') !== options.scopeId) return false;
    if (options.category && options.category !== 'all' && fact.category !== options.category) return false;
    if (options.active !== undefined && options.active !== 'all' && fact.active !== options.active) return false;
    if (!query) return true;
    const haystack = [fact.key, fact.value, fact.displayText, fact.scopeLabel ?? '', scopeKey(fact.scope, fact.scopeId)]
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

export function hydrateKnowledgeFacts(items: KnowledgeFact[]): void {
  hydrateKnowledgeStore(items);
}

export function resetKnowledgeFacts(): void {
  resetKnowledgeStore();
}

export function getKnowledgeSnapshot(): KnowledgeFact[] {
  return getKnowledgeStoreSnapshot();
}

function resolveVorgangContext(ref: CommunicationContextRef): {
  vorgangId?: string;
  customerName?: string;
} {
  if (ref.type === 'vorgang' && ref.id) {
    const vorgang = getVorgangById(ref.id);
    return { vorgangId: ref.id, customerName: vorgang?.customer };
  }
  if (ref.type === 'invoice' && ref.vorgangId) {
    const vorgang = getVorgangById(ref.vorgangId);
    return { vorgangId: ref.vorgangId, customerName: vorgang?.customer };
  }
  if (ref.type === 'inbox' && ref.id) {
    const item = getInboxItemById(ref.id);
    const vorgang = item?.vorgangId ? getVorgangById(item.vorgangId) : undefined;
    return { vorgangId: item?.vorgangId, customerName: vorgang?.customer };
  }
  if (ref.type === 'document' && ref.id) {
    const doc = getDocumentById(ref.id);
    const vorgangId = doc?.linkedVorgang?.vorgangId;
    const vorgang = vorgangId ? getVorgangById(vorgangId) : undefined;
    return { vorgangId, customerName: vorgang?.customer };
  }
  return {};
}

function matchesCustomerScope(fact: KnowledgeFact, customerName?: string): boolean {
  if (!customerName) return false;
  const normalized = customerName.trim().toLowerCase();
  return (
    fact.scopeId?.trim().toLowerCase() === normalized ||
    fact.scopeLabel?.trim().toLowerCase() === normalized
  );
}

export function getKnowledgeFactsForCommunicationContext(
  ref: CommunicationContextRef,
): KnowledgeFact[] {
  const { vorgangId, customerName } = resolveVorgangContext(ref);

  return getKnowledgeFacts().filter((fact) => {
    if (!fact.active) return false;
    if (fact.scope === 'company') return true;
    if (fact.scope === 'vorgang' && vorgangId && fact.scopeId === vorgangId) return true;
    if (fact.scope === 'customer' && matchesCustomerScope(fact, customerName)) return true;
    if (fact.scope === 'contact' && matchesCustomerScope(fact, customerName)) return true;
    return false;
  });
}
