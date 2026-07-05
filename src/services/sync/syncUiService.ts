import type { SyncCoordinatorReport, SyncOutboxEntry } from '../../types/sync';
import type { SyncAdapterStatus } from './syncAdapter';
import { buildPersistedStateSnapshot, applyPersistedStateFromSync } from '../persistenceService';
import { getSyncClient } from './syncClientService';
import { getSyncOutboxSnapshot } from './syncOutboxService';
import { getSyncCoordinator } from './syncCoordinator';

export interface SyncOutboxCounts {
  pending: number;
  completed: number;
  error: number;
}

export interface SyncUiSnapshot {
  deviceId: string;
  workspaceId: string;
  syncPolicy: string;
  status: SyncAdapterStatus;
  lastReport: SyncCoordinatorReport | null;
  outbox: SyncOutboxEntry[];
  outboxCounts: SyncOutboxCounts;
  isOffline: boolean;
  hasRetryableErrors: boolean;
}

function countOutbox(outbox: SyncOutboxEntry[]): SyncOutboxCounts {
  return {
    pending: outbox.filter((entry) => entry.status === 'pending').length,
    completed: outbox.filter((entry) => entry.status === 'completed').length,
    error: outbox.filter((entry) => entry.status === 'error' || entry.status === 'failed').length,
  };
}

export function getSyncUiSnapshot(): SyncUiSnapshot {
  const syncClient = getSyncClient();
  const outbox = getSyncOutboxSnapshot();
  const coordinator = getSyncCoordinator();
  const status = coordinator.getStatus();
  const isOffline = syncClient.syncPolicy === 'disabled' || status.syncState === 'offline';

  return {
    deviceId: syncClient.deviceId,
    workspaceId: syncClient.workspaceId,
    syncPolicy: syncClient.syncPolicy,
    status,
    lastReport: coordinator.getLastReport(),
    outbox,
    outboxCounts: countOutbox(outbox),
    isOffline,
    hasRetryableErrors: outbox.some((entry) => entry.status === 'error' || entry.status === 'failed'),
  };
}

export async function runSyncFromUi(): Promise<SyncCoordinatorReport> {
  const result = await getSyncCoordinator().runSync(buildPersistedStateSnapshot());
  applyPersistedStateFromSync(result.state);
  return result.report;
}

export async function retrySyncFromUi(): Promise<SyncCoordinatorReport> {
  const result = await getSyncCoordinator().retrySync(buildPersistedStateSnapshot());
  applyPersistedStateFromSync(result.state);
  return result.report;
}

export function shortenSyncId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}
