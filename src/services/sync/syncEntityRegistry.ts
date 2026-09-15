import type { CommunicationEvent } from '../../types/communicationHistory';
import type { Expense } from '../../types/expense';
import { parseExpensePaymentEntityId } from '../expense/expenseCloudSyncService';
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

/*
 * FINANZ-CORE-DURABILITY-01B — Bindings und WorkResults haben keine eigene `id`;
 * fuer die Sync-Maschine bekommen sie eine abgeleitete Kennung (Binding:
 * documentId|kind|part, WorkResult: inboxItemId). Die Kennung wird beim
 * Zurueckschreiben wieder entfernt.
 */
function bindingEntityId(binding: { documentId: string; kind: string; part?: string | null }): string {
  return `${binding.documentId}|${binding.kind}|${binding.part ?? ''}`;
}
function withId<T extends object>(entity: T, id: string): T & { id: string } {
  return { ...entity, id };
}
function withoutId<T extends { id: string }>(entity: T): Omit<T, 'id'> {
  const { id: _id, ...rest } = entity;
  return rest;
}

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
    case 'document_file':
      return (state.documentFileRefs ?? []).find((item) => item.id === entityId) ?? null;
    case 'document_file_binding': {
      const binding = (state.documentFileRepresentationBindings ?? []).find((item) => bindingEntityId(item) === entityId);
      return binding ? withId(binding, entityId) : null;
    }
    case 'document_work_result': {
      const result = (state.documentWorkResults ?? []).find((item) => item.inboxItemId === entityId);
      return result ? withId(result, entityId) : null;
    }
    case 'task':
      return state.tasks.find((item) => item.id === entityId) ?? null;
    case 'expense':
      return state.expenses?.find((item) => item.id === entityId) ?? null;
    case 'expense_payment': {
      /*
       * FINANZ-CORE-DURABILITY-01C — synthetische Sicht `expenseId|paymentId`.
       * Fehlt die Zahlung lokal (entfernt), bleibt die Kennung fuer das Reversal.
       */
      const parsed = parseExpensePaymentEntityId(entityId);
      if (!parsed) return null;
      const expense = state.expenses?.find((item) => item.id === parsed.expenseId);
      if (!expense) return null;
      const payment = (expense.payments ?? []).find((item) => item.id === parsed.paymentId) ?? null;
      return { id: entityId, expenseId: parsed.expenseId, paymentId: parsed.paymentId, payment } as unknown as SyncEntity;
    }
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
    case 'document_file':
      next.documentFileRefs = upsertInArray(next.documentFileRefs ?? [], entity as unknown as NonNullable<AppPersistedState['documentFileRefs']>[number]);
      break;
    case 'document_file_binding': {
      const incoming = withoutId(entity as { id: string; documentId: string; kind: string; fileRefId: string; part?: string | null });
      const list = next.documentFileRepresentationBindings ?? [];
      const index = list.findIndex((item) => bindingEntityId(item) === bindingEntityId(incoming));
      next.documentFileRepresentationBindings = (index < 0 ? [...list, incoming] : [...list.slice(0, index), incoming, ...list.slice(index + 1)]) as NonNullable<AppPersistedState['documentFileRepresentationBindings']>;
      break;
    }
    case 'document_work_result': {
      const incoming = withoutId(entity as { id: string; inboxItemId: string });
      const list = next.documentWorkResults ?? [];
      const index = list.findIndex((item) => item.inboxItemId === incoming.inboxItemId);
      next.documentWorkResults = (index < 0 ? [...list, incoming] : [...list.slice(0, index), incoming, ...list.slice(index + 1)]) as NonNullable<AppPersistedState['documentWorkResults']>;
      break;
    }
    case 'task':
      next.tasks = upsertInArray(next.tasks, entity as Task);
      break;
    case 'expense':
      next.expenses = upsertInArray(next.expenses ?? [], entity as Expense);
      break;
    case 'expense_payment':
      // Zahlungen werden ueber den Pull-Merge in die Ausgabe eingeflochten, nie einzeln eingesetzt.
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
    case 'document_file':
      return [...(state.documentFileRefs ?? [])] as SyncEntity[];
    case 'document_file_binding':
      return (state.documentFileRepresentationBindings ?? []).map((binding) => withId(binding, bindingEntityId(binding))) as SyncEntity[];
    case 'document_work_result':
      return (state.documentWorkResults ?? []).map((result) => withId(result, result.inboxItemId)) as SyncEntity[];
    case 'task':
      return [...state.tasks];
    case 'expense':
      return [...(state.expenses ?? [])];
    case 'expense_payment':
      return []; // nicht verfolgt — explizit eingereiht beim Buchen/Entfernen
    case 'vorgang':
      return [...state.vorgaenge];
    case 'customer':
      return [...(state.customers ?? [])];
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
