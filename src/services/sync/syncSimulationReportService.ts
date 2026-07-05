import type { SyncSimulationReport } from '../../types/sync';

let lastReport: SyncSimulationReport | null = null;

export function createEmptySyncSimulationReport(startedAt: string): SyncSimulationReport {
  return {
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    pushCount: 0,
    pullCount: 0,
    mergedEntityCount: 0,
    conflictCount: 0,
    errorCount: 0,
    completedOutboxCount: 0,
    syncedEntities: [],
    conflicts: [],
    errors: [],
  };
}

export function finalizeSyncSimulationReport(
  report: SyncSimulationReport,
  finishedAt: string,
): SyncSimulationReport {
  const finalized = {
    ...report,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(report.startedAt)),
  };
  lastReport = finalized;
  return finalized;
}

export function getLastSyncSimulationReport(): SyncSimulationReport | null {
  return lastReport ? { ...lastReport, syncedEntities: [...lastReport.syncedEntities], conflicts: [...lastReport.conflicts], errors: [...lastReport.errors] } : null;
}

export function resetSyncSimulationReportForTests(): void {
  lastReport = null;
}

export function recordSyncedEntity(
  report: SyncSimulationReport,
  entityType: SyncSimulationReport['syncedEntities'][number]['entityType'],
  entityId: string,
  resolution: SyncSimulationReport['syncedEntities'][number]['resolution'],
  conflict: boolean,
): void {
  report.syncedEntities.push({ entityType, entityId, resolution });
  if (resolution !== 'noop') {
    report.mergedEntityCount += 1;
  }
  if (conflict) {
    report.conflictCount += 1;
    report.conflicts.push({ entityType, entityId, resolution });
  }
}

export function recordOutboxError(
  report: SyncSimulationReport,
  outboxId: string,
  message: string,
): void {
  report.errorCount += 1;
  report.errors.push({ outboxId, message });
}
