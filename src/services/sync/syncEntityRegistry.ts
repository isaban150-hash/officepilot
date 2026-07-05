import type { CommunicationEvent } from '../../types/communicationHistory';
import type { Expense } from '../../types/expense';
import type { KnowledgeFact } from '../../types/knowledge';
import type { MailImport } from '../../types/mailImport';
import type {
  DocumentMemory,
  MemoryRelation,
  OfficePilotMemoryState,
  PaperRegisterEntry,
  ProofMemory,
} from '../../types/memory';
import type {
  AppPersistedState,
  CompanyDocument,
  InboxItem,
  Task,
  Vorgang,
} from '../../types/models';
import type { VorgangNote } from '../../types/communication';
import type { SyncEntityType, SyncableEntity } from '../../types/sync';

type SyncEntity = SyncableEntity & { id: string };

function defaultMemory(): OfficePilotMemoryState {
  return {
    documentMemories: [],
    proofMemories: [],
    relations: [],
    paperRegisterEntries: [],
  };
}

export function cloneAppPersistedState(state: AppPersistedState): AppPersistedState {
  return JSON.parse(JSON.stringify(state)) as AppPersistedState;
}

function upsertInArray<T extends { id: string }>(items: T[], entity: T): T[] {
  const index = items.findIndex((item) => item.id === entity.id);
  if (index === -1) return [entity, ...items];
  return [...items.slice(0, index), entity, ...items.slice(index + 1)];
}

export function findEntityInState(
  state: AppPersistedState,
  entityType: SyncEntityType,
  entityId: string,
): SyncEntity | null {
  switch (entityType) {
    case 'inbox_item':
      return state.inboxItems.find((item) => item.id === entityId) ?? null;
    case 'document':
      return state.documents?.find((item) => item.id === entityId) ?? null;
    case 'task':
      return state.tasks.find((item) => item.id === entityId) ?? null;
    case 'expense':
      return state.expenses?.find((item) => item.id === entityId) ?? null;
    case 'vorgang':
      return state.vorgaenge.find((item) => item.id === entityId) ?? null;
    case 'vorgang_note':
      return state.vorgangNotes?.find((item) => item.id === entityId) ?? null;
    case 'communication_event':
      return state.communicationHistory?.find((item) => item.id === entityId) ?? null;
    case 'knowledge_fact':
      return state.knowledgeFacts?.find((item) => item.id === entityId) ?? null;
    case 'mail_import':
      return state.mailImports?.find((item) => item.id === entityId) ?? null;
    case 'document_memory':
      return (
        state.officePilotMemory?.documentMemories.find((item) => item.id === entityId) ?? null
      );
    case 'proof_memory':
      return state.officePilotMemory?.proofMemories.find((item) => item.id === entityId) ?? null;
    case 'memory_relation':
      return state.officePilotMemory?.relations.find((item) => item.id === entityId) ?? null;
    case 'paper_register_entry':
      return (
        state.officePilotMemory?.paperRegisterEntries.find((item) => item.id === entityId) ?? null
      );
    default:
      return null;
  }
}

export function upsertEntityInState(
  state: AppPersistedState,
  entityType: SyncEntityType,
  entity: SyncEntity,
): AppPersistedState {
  const next = cloneAppPersistedState(state);

  switch (entityType) {
    case 'inbox_item':
      next.inboxItems = upsertInArray(next.inboxItems, entity as InboxItem);
      break;
    case 'document':
      next.documents = upsertInArray(next.documents ?? [], entity as CompanyDocument);
      break;
    case 'task':
      next.tasks = upsertInArray(next.tasks, entity as Task);
      break;
    case 'expense':
      next.expenses = upsertInArray(next.expenses ?? [], entity as Expense);
      break;
    case 'vorgang':
      next.vorgaenge = upsertInArray(next.vorgaenge, entity as Vorgang);
      break;
    case 'vorgang_note':
      next.vorgangNotes = upsertInArray(next.vorgangNotes ?? [], entity as VorgangNote);
      break;
    case 'communication_event':
      next.communicationHistory = upsertInArray(
        next.communicationHistory ?? [],
        entity as CommunicationEvent,
      );
      break;
    case 'knowledge_fact':
      next.knowledgeFacts = upsertInArray(next.knowledgeFacts ?? [], entity as KnowledgeFact);
      break;
    case 'mail_import':
      next.mailImports = upsertInArray(next.mailImports ?? [], entity as MailImport);
      break;
    case 'document_memory': {
      const memory = next.officePilotMemory ?? defaultMemory();
      memory.documentMemories = upsertInArray(
        memory.documentMemories,
        entity as DocumentMemory,
      );
      next.officePilotMemory = memory;
      break;
    }
    case 'proof_memory': {
      const memory = next.officePilotMemory ?? defaultMemory();
      memory.proofMemories = upsertInArray(memory.proofMemories, entity as ProofMemory);
      next.officePilotMemory = memory;
      break;
    }
    case 'memory_relation': {
      const memory = next.officePilotMemory ?? defaultMemory();
      memory.relations = upsertInArray(memory.relations, entity as MemoryRelation);
      next.officePilotMemory = memory;
      break;
    }
    case 'paper_register_entry': {
      const memory = next.officePilotMemory ?? defaultMemory();
      memory.paperRegisterEntries = upsertInArray(
        memory.paperRegisterEntries,
        entity as PaperRegisterEntry,
      );
      next.officePilotMemory = memory;
      break;
    }
    default:
      break;
  }

  next.savedAt = new Date().toISOString();
  return next;
}

export function listEntitiesByType(
  state: AppPersistedState,
  entityType: SyncEntityType,
): SyncEntity[] {
  switch (entityType) {
    case 'inbox_item':
      return [...state.inboxItems];
    case 'document':
      return [...(state.documents ?? [])];
    case 'task':
      return [...state.tasks];
    case 'expense':
      return [...(state.expenses ?? [])];
    case 'vorgang':
      return [...state.vorgaenge];
    case 'vorgang_note':
      return [...(state.vorgangNotes ?? [])];
    case 'communication_event':
      return [...(state.communicationHistory ?? [])];
    case 'knowledge_fact':
      return [...(state.knowledgeFacts ?? [])];
    case 'mail_import':
      return [...(state.mailImports ?? [])];
    case 'document_memory':
      return [...(state.officePilotMemory?.documentMemories ?? [])];
    case 'proof_memory':
      return [...(state.officePilotMemory?.proofMemories ?? [])];
    case 'memory_relation':
      return [...(state.officePilotMemory?.relations ?? [])];
    case 'paper_register_entry':
      return [...(state.officePilotMemory?.paperRegisterEntries ?? [])];
    default:
      return [];
  }
}

export const APPEND_ONLY_ENTITY_TYPES: SyncEntityType[] = ['communication_event'];
