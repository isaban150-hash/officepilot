import type { AppPersistedState } from '../../types/models';
import type { SyncCoordinatorReport, SyncOutboxEntry, SyncState } from '../../types/sync';
import type { SyncAdapter, SyncAdapterStatus } from './syncAdapter';
import { createSyncAdapter } from './syncAdapterFactory';
import {
  createEmptySyncSimulationReport,
  finalizeSyncSimulationReport,
} from './syncSimulationReportService';
import { retryFailedOutboxEntries, wrapStateAsVirtualDevice } from './syncSimulatorService';

const MAX_RETRY_ATTEMPTS = 3;

function pendingOutboxCount(outbox: SyncOutboxEntry[] = []): number {
  return outbox.filter((entry) => entry.status === 'pending' || entry.status === 'error').length;
}

function mergeReports(
  pushReport: SyncCoordinatorReport,
  pullReport: SyncCoordinatorReport,
): SyncCoordinatorReport {
  return finalizeSyncSimulationReport(
    {
      ...pushReport,
      pullCount: pushReport.pullCount + pullReport.pullCount,
      pushCount: pushReport.pushCount + pullReport.pushCount,
      mergedEntityCount: pushReport.mergedEntityCount + pullReport.mergedEntityCount,
      conflictCount: pushReport.conflictCount + pullReport.conflictCount,
      errorCount: pushReport.errorCount + pullReport.errorCount,
      completedOutboxCount: pushReport.completedOutboxCount + pullReport.completedOutboxCount,
      syncedEntities: [...pushReport.syncedEntities, ...pullReport.syncedEntities],
      conflicts: [...pushReport.conflicts, ...pullReport.conflicts],
      errors: [...pushReport.errors, ...pullReport.errors],
      uploadCount: pushReport.uploadCount + pullReport.uploadCount,
      downloadCount: pushReport.downloadCount + pullReport.downloadCount,
      retryAttempts: Math.max(pushReport.retryAttempts, pullReport.retryAttempts),
    },
    pullReport.finishedAt,
  ) as SyncCoordinatorReport;
}

function toCoordinatorReport(
  report: ReturnType<typeof createEmptySyncSimulationReport>,
  retryAttempts: number,
  uploadCount: number,
  downloadCount: number,
): SyncCoordinatorReport {
  return {
    ...report,
    retryAttempts,
    uploadCount,
    downloadCount,
  };
}

export class SyncCoordinator {
  private adapter: SyncAdapter;
  private syncState: SyncState = 'idle';
  private lastReport: SyncCoordinatorReport | null = null;
  private lastSyncedAt?: string;
  private lastError?: string;
  private retryAttempts = 0;

  constructor(adapter?: SyncAdapter) {
    this.adapter = adapter ?? createSyncAdapter();
  }

  setAdapter(adapter: SyncAdapter): void {
    this.adapter = adapter;
  }

  getAdapter(): SyncAdapter {
    return this.adapter;
  }

  getStatus(): SyncAdapterStatus {
    const adapterStatus = this.adapter.getSyncStatus();
    return {
      syncState: this.syncState,
      pendingChanges: adapterStatus.pendingChanges,
      lastSyncedAt: this.lastSyncedAt ?? adapterStatus.lastSyncedAt,
      lastError: this.lastError ?? adapterStatus.lastError,
    };
  }

  getLastReport(): SyncCoordinatorReport | null {
    return this.lastReport ? { ...this.lastReport } : null;
  }

  prepareRetry(state: AppPersistedState): AppPersistedState {
    const device = wrapStateAsVirtualDevice(state);
    const retried = retryFailedOutboxEntries(device);
    this.retryAttempts += 1;
    return {
      ...retried.state,
      syncOutbox: retried.state.syncOutbox ?? [],
    };
  }

  async runSync(state: AppPersistedState): Promise<{ state: AppPersistedState; report: SyncCoordinatorReport }> {
    const startedAt = new Date().toISOString();
    this.syncState = 'checking';

    if (state.syncClient?.syncPolicy === 'disabled') {
      this.syncState = 'offline';
      const report = toCoordinatorReport(createEmptySyncSimulationReport(startedAt), this.retryAttempts, 0, 0);
      report.finishedAt = new Date().toISOString();
      report.durationMs = 0;
      this.lastReport = report;
      return { state, report };
    }

    const outbox = state.syncOutbox ?? [];
    let currentState = state;
    let pushReport = toCoordinatorReport(
      createEmptySyncSimulationReport(startedAt),
      this.retryAttempts,
      0,
      0,
    );

    if (pendingOutboxCount(outbox) > 0) {
      this.syncState = 'uploading';
      const pushResult = await this.adapter.pushChanges({
        deviceId: state.syncClient!.deviceId,
        workspaceId: state.syncClient!.workspaceId,
        state: currentState,
        outbox,
      });

      pushReport = toCoordinatorReport(
        pushResult.report,
        this.retryAttempts,
        pushResult.completedOutboxIds.length,
        0,
      );

      currentState = pushResult.state;
      await this.adapter.acknowledgeChanges({ outboxIds: pushResult.completedOutboxIds });

      if (!pushResult.success) {
        this.syncState = 'error';
        this.lastError = pushResult.failedOutbox[0]?.message;
        const failedReport = mergeReports(
          pushReport,
          toCoordinatorReport(createEmptySyncSimulationReport(startedAt), this.retryAttempts, 0, 0),
        );
        this.lastReport = failedReport;
        return { state: currentState, report: failedReport };
      }
    }

    try {
      this.syncState = 'downloading';
      const pullResult = await this.adapter.pullChanges({
        deviceId: state.syncClient!.deviceId,
        workspaceId: state.syncClient!.workspaceId,
        state: currentState,
      });

      const pullReport = toCoordinatorReport(
        pullResult.report,
        this.retryAttempts,
        pushReport.uploadCount ?? 0,
        pullResult.report.mergedEntityCount,
      );

      this.syncState = 'synced';
      this.lastSyncedAt = new Date().toISOString();
      this.lastError = undefined;

      const mergedReport = mergeReports(pushReport, pullReport);
      mergedReport.finishedAt = new Date().toISOString();
      mergedReport.durationMs = Math.max(
        0,
        Date.parse(mergedReport.finishedAt) - Date.parse(startedAt),
      );
      this.lastReport = mergedReport;

      return {
        state: {
          ...pullResult.state,
          syncOutbox: currentState.syncOutbox,
          savedAt: new Date().toISOString(),
        },
        report: mergedReport,
      };
    } catch (error) {
      this.syncState = 'error';
      this.lastError = error instanceof Error ? error.message : 'Unbekannter Sync-Fehler';
      const report = toCoordinatorReport(createEmptySyncSimulationReport(startedAt), this.retryAttempts, 0, 0);
      report.finishedAt = new Date().toISOString();
      report.durationMs = Math.max(0, Date.parse(report.finishedAt) - Date.parse(startedAt));
      report.errorCount = 1;
      report.errors.push({ outboxId: 'coordinator', message: this.lastError });
      this.lastReport = report;
      return { state, report };
    }
  }

  async retrySync(state: AppPersistedState): Promise<{ state: AppPersistedState; report: SyncCoordinatorReport }> {
    if (this.retryAttempts >= MAX_RETRY_ATTEMPTS) {
      this.syncState = 'error';
      this.lastError = 'Maximale Retry-Anzahl erreicht';
      const startedAt = new Date().toISOString();
      const report = toCoordinatorReport(createEmptySyncSimulationReport(startedAt), this.retryAttempts, 0, 0);
      report.finishedAt = startedAt;
      report.errors.push({ outboxId: 'coordinator', message: this.lastError });
      this.lastReport = report;
      return { state, report };
    }

    const retriedState = this.prepareRetry(state);
    return this.runSync(retriedState);
  }

  resetForTests(): void {
    this.syncState = 'idle';
    this.lastReport = null;
    this.lastSyncedAt = undefined;
    this.lastError = undefined;
    this.retryAttempts = 0;
  }
}

let defaultCoordinator: SyncCoordinator | null = null;

export function getSyncCoordinator(): SyncCoordinator {
  if (!defaultCoordinator) {
    defaultCoordinator = new SyncCoordinator();
  }
  return defaultCoordinator;
}

export function resetSyncCoordinatorForTests(): void {
  defaultCoordinator = null;
}
