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

/**
 * REAL-DEVICE-CLOUD-COMPANY-IDENTICAL-COMPLETE-01 — schließt genau einen
 * gegenstandslosen Firmen-Auftrag ab: lokaler und Cloud-Payload sind bereits
 * identisch, es bleibt nur eine Versionshistorie.
 *
 * Bewusst eng: nur `company_setup`/`company_profile`, nur der übergebene
 * Workspace, und nur der Status `blocked`. `blocked` heißt, dass der letzte
 * Push an einem Versionskonflikt scheiterte und seither **keine** neue lokale
 * Inhaltsänderung kam — denn jede solche Änderung setzt den vorhandenen
 * aktiven Eintrag über `enqueueSyncOutbox`/`mergeOutboxEntry` wieder auf
 * `pending`. Damit kann ein neuerer lokaler Stand hier nicht verloren gehen.
 *
 * Kein „complete all blocked", keine local-only-Entitäten, kein Löschen.
 *
 * 01C — bewusst **seiteneffektfrei**: reine Transformation über ein übergebenes
 * Array. Kein Schreiben in `outbox`, kein `notifyOutboxChanged`, keine
 * Persistenz, keine Hydrierung. Das Ergebnis reist im Persisted-State-Kandidaten
 * und wird erst an der bestehenden Persistenzgrenze wirksam.
 */
export function completeIdenticalCompanyCloudOutboxEntry(
  entries: SyncOutboxEntry[],
  entityType: 'company_setup' | 'company_profile',
  entityId: string,
): { outbox: SyncOutboxEntry[]; completed: boolean } {
  const target = entries.find(
    (entry) =>
      entry.entityType === entityType && entry.entityId === entityId && entry.status === 'blocked',
  );
  if (!target) return { outbox: entries, completed: false };

  return {
    outbox: entries.map((entry) =>
      entry.id === target.id ? { ...entry, status: 'completed', blockedReason: undefined } : entry,
    ),
    completed: true,
  };
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
