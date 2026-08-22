import { isBetaTestMode } from '../../config/betaTestMode';
import type {
  SyncEntityType,
  SyncOutboxEntry,
  SyncOutboxOperation,
  SyncOutboxStatus,
} from '../../types/sync';
import { generateUuid } from './syncMetaService';
import { getSyncClient } from './syncClientService';

let outbox: SyncOutboxEntry[] = [];

/**
 * OFFICEPILOT-SETUP-CLOUD-PERSIST-01C — der Hinweis „Cloud-Sicherung steht aus"
 * muss verschwinden, sobald die Übertragung geglückt ist. Dafür meldet die
 * Outbox jede Änderung; keine zweite Sync-Architektur, nur eine Benachrichtigung.
 */
type OutboxListener = () => void;
const outboxListeners = new Set<OutboxListener>();

export function subscribeSyncOutbox(listener: OutboxListener): () => void {
  outboxListeners.add(listener);
  return () => {
    outboxListeners.delete(listener);
  };
}

function notifyOutboxChanged(): void {
  for (const listener of [...outboxListeners]) listener();
}

const ACTIVE_OUTBOX_STATUSES: SyncOutboxStatus[] = ['pending', 'blocked', 'error'];

function resolveOutboxStatus(): SyncOutboxStatus {
  if (isBetaTestMode()) {
    return 'blocked';
  }
  return 'pending';
}

function mergeOutboxEntry(
  existing: SyncOutboxEntry,
  input: EnqueueSyncOutboxInput,
  status: SyncOutboxStatus,
): SyncOutboxEntry {
  return {
    ...existing,
    operation: input.operation,
    version: input.version,
    queuedAt: new Date().toISOString(),
    status: existing.status === 'error' ? 'pending' : status,
    retryCount: existing.status === 'error' ? 0 : existing.retryCount,
    blockedReason: status === 'blocked' ? existing.blockedReason ?? 'beta_mode' : undefined,
  };
}

export function hydrateSyncOutbox(entries: SyncOutboxEntry[]): void {
  outbox = entries.map((entry) => ({ ...entry }));
  notifyOutboxChanged();
}

export function getSyncOutboxSnapshot(): SyncOutboxEntry[] {
  return outbox.map((entry) => ({ ...entry }));
}

export function resetSyncOutboxForTests(entries: SyncOutboxEntry[] = []): void {
  outbox = entries.map((entry) => ({ ...entry }));
  notifyOutboxChanged();
}

export interface EnqueueSyncOutboxInput {
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOutboxOperation;
  version: number;
}

export function enqueueSyncOutbox(input: EnqueueSyncOutboxInput): SyncOutboxEntry {
  const status = resolveOutboxStatus();
  const existingIndex = outbox.findIndex(
    (entry) =>
      entry.entityType === input.entityType &&
      entry.entityId === input.entityId &&
      ACTIVE_OUTBOX_STATUSES.includes(entry.status),
  );

  if (existingIndex >= 0) {
    const merged = mergeOutboxEntry(outbox[existingIndex], input, status);
    outbox = [merged, ...outbox.filter((_, index) => index !== existingIndex)];
    notifyOutboxChanged();
    return { ...merged };
  }

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
  notifyOutboxChanged();
  return { ...entry };
}

/**
 * OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — true, solange Firmendaten noch nicht in
 * der Cloud liegen. Grundlage für den sichtbaren Hinweis „nur lokal gespeichert“.
 */
export function hasPendingCompanyCloudBackup(): boolean {
  return outbox.some(
    (entry) =>
      (entry.entityType === 'company_setup' || entry.entityType === 'company_profile') &&
      ACTIVE_OUTBOX_STATUSES.includes(entry.status),
  );
}

export function markOutboxEntriesCompleted(outboxIds: string[]): void {
  if (outboxIds.length === 0) return;
  const completedIds = new Set(outboxIds);
  outbox = outbox.map((entry) =>
    completedIds.has(entry.id) ? { ...entry, status: 'completed' } : entry,
  );
  notifyOutboxChanged();
}

export function markOutboxEntriesFailed(outboxIds: string[], reason?: string): void {
  if (outboxIds.length === 0) return;
  const failedIds = new Set(outboxIds);
  outbox = outbox.map((entry) =>
    failedIds.has(entry.id)
      ? {
          ...entry,
          status: 'error',
          retryCount: entry.retryCount + 1,
          blockedReason: reason ?? entry.blockedReason,
        }
      : entry,
  );
  notifyOutboxChanged();
}

export function isSyncOutboxEnabled(): boolean {
  return getSyncClient().syncPolicy !== 'disabled';
}
