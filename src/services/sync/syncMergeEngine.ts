import type { Expense, ExpensePayment } from '../../types/expense';
import type { KnowledgeFact } from '../../types/knowledge';
import type { InboxItem, Task } from '../../types/models';
import type { VorgangNote } from '../../types/communication';
import type { DocumentMemory, ProofMemory } from '../../types/memory';
import type {
  MergeEntityResult,
  MergeResolution,
  SyncEntityType,
  SyncMeta,
  SyncableEntity,
} from '../../types/sync';
import { APPEND_ONLY_ENTITY_TYPES } from './syncEntityRegistry';

type SyncEntity = SyncableEntity & { id: string };

function hasSync(entity: SyncEntity): entity is SyncEntity & { sync: SyncMeta } {
  return Boolean(entity.sync?.version);
}

function prefersLocalUserConfirmedData(
  local: SyncEntity,
  remote: SyncEntity,
  entityType: SyncEntityType,
): boolean {
  if (entityType === 'inbox_item') {
    const inboxLocal = local as InboxItem;
    const inboxRemote = remote as InboxItem;
    return Boolean(inboxLocal.userModified) && !inboxRemote.userModified;
  }
  if (entityType === 'vorgang_note') {
    const noteLocal = local as VorgangNote;
    const noteRemote = remote as VorgangNote;
    return noteLocal.source === 'user' && noteRemote.source !== 'user';
  }
  if (entityType === 'knowledge_fact') {
    const factLocal = local as KnowledgeFact;
    const factRemote = remote as KnowledgeFact;
    return factLocal.sourceType === 'user' && factRemote.sourceType !== 'user';
  }
  if (entityType === 'document_memory') {
    const memLocal = local as DocumentMemory;
    const memRemote = remote as DocumentMemory;
    const localUserConfirmed =
      memLocal.memoryStatus === 'understood' || Boolean(memLocal.physicalFiled);
    const remoteAuto = memRemote.memoryStatus === 'pending' || memRemote.memoryStatus === 'partial';
    return localUserConfirmed && remoteAuto;
  }
  if (entityType === 'task') {
    const taskLocal = local as Task;
    const taskRemote = remote as Task;
    return !taskLocal.autoCreated && taskRemote.autoCreated;
  }
  return false;
}

function unionAppendOnlyById<T extends { id: string }>(left: T[], right: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of left) map.set(item.id, item);
  for (const item of right) map.set(item.id, item);
  return [...map.values()];
}

function mergeExpensePayments(local: Expense, remote: Expense): ExpensePayment[] {
  return unionAppendOnlyById(local.payments ?? [], remote.payments ?? []);
}

export function mergeSyncEntities<T extends SyncEntity>(
  local: T | null,
  remote: T | null,
  entityType: SyncEntityType,
): MergeEntityResult<T | null> {
  if (!local && !remote) {
    return { entity: null, resolution: 'noop', conflict: false };
  }
  if (!local && remote) {
    return { entity: remote, resolution: 'remote_wins', conflict: false };
  }
  if (local && !remote) {
    return { entity: local, resolution: 'local_wins', conflict: false };
  }

  const left = local!;
  const right = remote!;

  if (!hasSync(left) || !hasSync(right)) {
    return { entity: right, resolution: 'remote_wins', conflict: false };
  }

  const lSync = left.sync;
  const rSync = right.sync;

  if (lSync.version === rSync.version) {
    if (lSync.deleted !== rSync.deleted) {
      if (lSync.deleted) {
        return { entity: left, resolution: 'local_wins', conflict: true };
      }
      if (rSync.deleted) {
        return { entity: right, resolution: 'remote_wins', conflict: true };
      }
    }
    return { entity: left, resolution: 'noop', conflict: false };
  }

  const tombstoneConflict =
    (lSync.deleted && !rSync.deleted) || (!lSync.deleted && rSync.deleted);

  if (rSync.deleted && rSync.version >= lSync.version) {
    return {
      entity: right,
      resolution: 'remote_wins',
      conflict: tombstoneConflict && !lSync.deleted,
    };
  }

  if (lSync.deleted && lSync.version >= rSync.version) {
    return { entity: left, resolution: 'local_wins', conflict: false };
  }

  if (rSync.version > lSync.version) {
    if (prefersLocalUserConfirmedData(left, right, entityType)) {
      return { entity: left, resolution: 'conflict', conflict: true };
    }
    return { entity: right, resolution: 'remote_wins', conflict: false };
  }

  if (lSync.version > rSync.version) {
    return { entity: left, resolution: 'local_wins', conflict: false };
  }

  return { entity: left, resolution: 'noop', conflict: false };
}

export function mergeEntityWithAppendOnlyFields<T extends SyncEntity>(
  local: T | null,
  remote: T | null,
  entityType: SyncEntityType,
): MergeEntityResult<T | null> {
  const base = mergeSyncEntities(local, remote, entityType);
  if (!base.entity) return base;

  if (entityType === 'expense' && local && remote) {
    const mergedExpense: Expense = {
      ...(base.entity as unknown as Expense),
      payments: mergeExpensePayments(local as unknown as Expense, remote as unknown as Expense),
    };
    return { ...base, entity: mergedExpense as unknown as T };
  }

  return base;
}

export function mergeAppendOnlyCollections<T extends SyncEntity>(
  localItems: T[],
  remoteItems: T[],
): { items: T[]; mergedCount: number; conflictCount: number } {
  const byId = new Map<string, T>();
  let mergedCount = 0;
  let conflictCount = 0;

  for (const local of localItems) {
    byId.set(local.id, local);
  }

  for (const remote of remoteItems) {
    const local = byId.get(remote.id) ?? null;
    const result = mergeSyncEntities(local, remote, 'communication_event');
    if (result.resolution !== 'noop') mergedCount += 1;
    if (result.conflict) conflictCount += 1;
    if (result.entity) {
      byId.set(remote.id, result.entity);
    } else if (!local) {
      byId.set(remote.id, remote);
      mergedCount += 1;
    }
  }

  return { items: [...byId.values()], mergedCount, conflictCount };
}

export function isAppendOnlyEntityType(entityType: SyncEntityType): boolean {
  return APPEND_ONLY_ENTITY_TYPES.includes(entityType);
}

export function mergeProofMemoryEntities(
  local: ProofMemory | null,
  remote: ProofMemory | null,
): MergeEntityResult<ProofMemory | null> {
  const base = mergeSyncEntities(local, remote, 'proof_memory');
  if (!base.entity || !local || !remote) return base;

  const merged: ProofMemory = {
    ...base.entity,
    requiredByVorgangIds: [
      ...new Set([
        ...(local?.requiredByVorgangIds ?? []),
        ...(remote?.requiredByVorgangIds ?? []),
      ]),
    ],
  };

  return { ...base, entity: merged, resolution: base.conflict ? 'conflict' : base.resolution };
}

export function pickMergeResolutionWinner(
  resolution: MergeResolution,
): 'local' | 'remote' | 'none' {
  if (resolution === 'remote_wins') return 'remote';
  if (resolution === 'local_wins' || resolution === 'conflict') return 'local';
  return 'none';
}
