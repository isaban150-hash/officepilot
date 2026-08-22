import type { SyncCoordinatorReport, SyncOutboxEntry } from '../../types/sync';
import type { SyncAdapterStatus } from './syncAdapter';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { getSyncClient } from './syncClientService';
import { getSyncOutboxSnapshot, hasPendingCompanyCloudBackup } from './syncOutboxService';
import { getSyncCoordinator } from './syncCoordinator';
import { applySyncPullCandidateSafely } from './syncPullPersistService';
import { runQueuedSyncOperation } from './syncOperationQueue';
import { createSyncAdapter, isSyncProviderAvailable } from './syncAdapterFactory';
import { isSupabaseConfigured } from '../../lib/supabase';
import { bootstrapWorkspaceCloudSyncIfNeeded } from '../workspace/workspaceCloudBootstrapService';

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
  pendingOutboxEntries: SyncOutboxEntry[];
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

export function isLocalOnlySyncMode(
  snapshot: Pick<SyncUiSnapshot, 'syncPolicy' | 'isOffline'>,
): boolean {
  return (
    snapshot.syncPolicy === 'disabled' ||
    snapshot.syncPolicy === 'local_only' ||
    snapshot.isOffline
  );
}

export function getSyncUiSnapshot(): SyncUiSnapshot {
  const syncClient = getSyncClient();
  const outbox = getSyncOutboxSnapshot();
  const coordinator = getSyncCoordinator();
  const status = coordinator.getStatus();
  const isOffline = syncClient.syncPolicy === 'disabled' || status.syncState === 'offline';
  const pendingOutboxEntries = outbox.filter(
    (entry) => entry.status === 'pending' || entry.status === 'blocked',
  );

  return {
    deviceId: syncClient.deviceId,
    workspaceId: syncClient.workspaceId,
    syncPolicy: syncClient.syncPolicy,
    status,
    lastReport: coordinator.getLastReport(),
    outbox,
    outboxCounts: countOutbox(outbox),
    pendingOutboxEntries,
    isOffline,
    hasRetryableErrors: outbox.some((entry) => entry.status === 'error' || entry.status === 'failed'),
  };
}

export async function runSyncFromUi(): Promise<SyncCoordinatorReport> {
  // 01P4C: Netzwerk und anschließende Persistenz sind ein Queue-Lauf; der
  // Snapshot entsteht erst beim tatsächlichen Start.
  return runQueuedSyncOperation(async () => {
    const result = await getSyncCoordinator().runSync(buildPersistedStateSnapshot());
    if (result.skipPersist) {
      return result.report;
    }
    return applySyncPullCandidateSafely({
      state: result.state,
      report: result.report,
      pendingInvoiceIntentClears: result.pendingInvoiceIntentClears,
      pendingAmendmentIntentClears: result.pendingAmendmentIntentClears,
    }).report;
  });
}

/**
 * OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — direkt nach dem Einrichtungsassistenten
 * einmalig in die Cloud sichern. Reihenfolge bleibt: Workspace ermitteln und
 * pullen (Bootstrap), erst danach die lokalen Firmendaten hochladen.
 *
 * Ein Doppelklick startet keinen zweiten Lauf: der laufende Versuch wird geteilt.
 */
let afterSetupSyncPromise: Promise<CloudBackupOutcome> | null = null;

export interface CloudBackupOutcome {
  /** True, wenn Firmendaten weiterhin nur lokal liegen. */
  pending: boolean;
  reason?: string;
}

export async function syncCompanyDataAfterSetup(): Promise<CloudBackupOutcome> {
  if (afterSetupSyncPromise) return afterSetupSyncPromise;

  afterSetupSyncPromise = (async (): Promise<CloudBackupOutcome> => {
    if (!isSupabaseConfigured()) {
      return { pending: hasPendingCompanyCloudBackup(), reason: 'not_configured' };
    }
    const bootstrap = await bootstrapWorkspaceCloudSyncIfNeeded();
    if (bootstrap.status === 'failed') {
      return { pending: hasPendingCompanyCloudBackup(), reason: bootstrap.reason ?? 'bootstrap' };
    }
    if (isSyncProviderAvailable('supabase')) {
      getSyncCoordinator().setAdapter(createSyncAdapter({ provider: 'supabase' }));
    }
    await runSyncFromUi();
    return { pending: hasPendingCompanyCloudBackup() };
  })();

  try {
    return await afterSetupSyncPromise;
  } catch (error) {
    return {
      pending: hasPendingCompanyCloudBackup(),
      reason: error instanceof Error ? error.message : 'unknown',
    };
  } finally {
    afterSetupSyncPromise = null;
  }
}

export async function retrySyncFromUi(): Promise<SyncCoordinatorReport> {
  // 01P4C: derselbe Queue-Vertrag wie in runSyncFromUi.
  return runQueuedSyncOperation(async () => {
    const result = await getSyncCoordinator().retrySync(buildPersistedStateSnapshot());
    if (result.skipPersist) {
      return result.report;
    }
    return applySyncPullCandidateSafely({
      state: result.state,
      report: result.report,
      pendingInvoiceIntentClears: result.pendingInvoiceIntentClears,
      pendingAmendmentIntentClears: result.pendingAmendmentIntentClears,
    }).report;
  });
}

export function shortenSyncId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}
