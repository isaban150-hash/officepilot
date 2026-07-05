import { isBetaTestMode } from '../../config/betaTestMode';
import type {
  SyncEntityType,
  SyncOutboxEntry,
  SyncOutboxOperation,
  SyncOutboxStatus,
} from '../../types/sync';
import { generateUuid } from './syncMetaService';

let outbox: SyncOutboxEntry[] = [];

export function hydrateSyncOutbox(entries: SyncOutboxEntry[]): void {
  outbox = entries.map((entry) => ({ ...entry }));
}

export function getSyncOutboxSnapshot(): SyncOutboxEntry[] {
  return outbox.map((entry) => ({ ...entry }));
}

export function resetSyncOutboxForTests(entries: SyncOutboxEntry[] = []): void {
  outbox = entries.map((entry) => ({ ...entry }));
}

export interface EnqueueSyncOutboxInput {
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOutboxOperation;
  version: number;
}

export function enqueueSyncOutbox(input: EnqueueSyncOutboxInput): SyncOutboxEntry {
  const status: SyncOutboxStatus = isBetaTestMode() ? 'blocked' : 'pending';
  const entry: SyncOutboxEntry = {
    id: generateUuid(),
    entityType: input.entityType,
    entityId: input.entityId,
    operation: input.operation,
    version: input.version,
    queuedAt: new Date().toISOString(),
    retryCount: 0,
    status,
    blockedReason: isBetaTestMode() ? 'beta_mode' : undefined,
  };
  outbox = [entry, ...outbox];
  return { ...entry };
}
