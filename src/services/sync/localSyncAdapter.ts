import type {
  SyncAcknowledgeInput,
  SyncAdapter,
  SyncAdapterStatus,
  SyncBlobReference,
  SyncInvoiceNumberReservation,
  SyncPullInput,
  SyncPullResult,
  SyncPushInput,
  SyncPushResult,
} from './syncAdapter';
import { generateUuid } from './syncMetaService';
import {
  createEmptySyncSimulationReport,
  finalizeSyncSimulationReport,
} from './syncSimulationReportService';
import {
  getStateFromVirtualDevice,
  simulatePull,
  simulatePush,
  wrapStateAsVirtualDevice,
} from './syncSimulatorService';

const invoiceSequences = new Map<string, { year: number; lastIssuedNumber: number }>();
const blobStore = new Map<string, Blob>();

function formatInvoiceNumber(year: number, number: number): string {
  return `${year}-${String(number).padStart(4, '0')}`;
}

function collectPushFailures(
  before: SyncPushInput['outbox'],
  after: SyncPushInput['outbox'],
): SyncPushResult['failedOutbox'] {
  const afterById = new Map(after.map((entry) => [entry.id, entry]));
  return before
    .filter((entry) => entry.status === 'pending')
    .map((entry) => afterById.get(entry.id))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry && entry.status === 'error'))
    .map((entry) => ({
      outboxId: entry.id,
      message: `Push fehlgeschlagen für ${entry.entityType}:${entry.entityId}`,
      retryable: true,
    }));
}

function collectCompletedOutboxIds(
  before: SyncPushInput['outbox'],
  after: SyncPushInput['outbox'],
): string[] {
  const afterById = new Map(after.map((entry) => [entry.id, entry]));
  return before
    .filter((entry) => entry.status === 'pending')
    .filter((entry) => afterById.get(entry.id)?.status === 'completed')
    .map((entry) => entry.id);
}

export class LocalSyncAdapter implements SyncAdapter {
  readonly providerKind = 'local' as const;

  private syncState: SyncAdapterStatus['syncState'] = 'idle';
  private pendingChanges = 0;
  private lastSyncedAt?: string;
  private lastError?: string;
  private acknowledgedOutboxIds: string[] = [];

  async pushChanges(input: SyncPushInput): Promise<SyncPushResult> {
    this.syncState = 'uploading';
    this.pendingChanges = input.outbox.filter((entry) => entry.status === 'pending').length;

    const startedAt = new Date().toISOString();
    const report = createEmptySyncSimulationReport(startedAt);
    const device = wrapStateAsVirtualDevice({
      ...input.state,
      syncOutbox: input.outbox,
    });
    const pushResult = simulatePush(device, report);
    const nextState = getStateFromVirtualDevice(pushResult.device);
    const failedOutbox = collectPushFailures(input.outbox, nextState.syncOutbox ?? []);
    const completedOutboxIds = collectCompletedOutboxIds(input.outbox, nextState.syncOutbox ?? []);
    const finalizedReport = finalizeSyncSimulationReport(pushResult.report, new Date().toISOString());

    this.pendingChanges = (nextState.syncOutbox ?? []).filter((entry) => entry.status === 'pending').length;
    this.syncState = failedOutbox.length > 0 ? 'error' : 'synced';
    this.lastError = failedOutbox[0]?.message;
    if (failedOutbox.length === 0) {
      this.lastSyncedAt = new Date().toISOString();
    }

    return {
      success: failedOutbox.length === 0,
      state: nextState,
      completedOutboxIds,
      failedOutbox,
      report: finalizedReport,
    };
  }

  async pullChanges(input: SyncPullInput): Promise<SyncPullResult> {
    this.syncState = 'downloading';
    const startedAt = new Date().toISOString();
    const report = createEmptySyncSimulationReport(startedAt);
    const device = wrapStateAsVirtualDevice(input.state);
    const pullResult = simulatePull(device, report);
    const nextState = getStateFromVirtualDevice(pullResult.device);
    const finalizedReport = finalizeSyncSimulationReport(pullResult.report, new Date().toISOString());

    this.syncState = 'merging';
    this.syncState = 'synced';
    this.lastSyncedAt = new Date().toISOString();
    this.lastError = undefined;

    return {
      success: true,
      state: nextState,
      report: finalizedReport,
    };
  }

  async acknowledgeChanges(input: SyncAcknowledgeInput): Promise<void> {
    this.acknowledgedOutboxIds = [...input.outboxIds];
  }

  async reserveInvoiceNumber(workspaceId: string): Promise<SyncInvoiceNumberReservation> {
    const currentYear = new Date().getFullYear();
    const existing = invoiceSequences.get(workspaceId) ?? { year: currentYear, lastIssuedNumber: 0 };
    if (existing.year !== currentYear) {
      existing.year = currentYear;
      existing.lastIssuedNumber = 0;
    }
    existing.lastIssuedNumber += 1;
    invoiceSequences.set(workspaceId, existing);
    return {
      year: existing.year,
      sequenceNumber: existing.lastIssuedNumber,
      formatted: formatInvoiceNumber(existing.year, existing.lastIssuedNumber),
    };
  }

  async uploadBlob(
    _workspaceId: string,
    blob: Blob,
    metadata?: Record<string, string>,
  ): Promise<SyncBlobReference> {
    const blobId = metadata?.blobId ?? generateUuid();
    blobStore.set(blobId, blob);
    return {
      blobId,
      mimeType: blob.type || metadata?.mimeType,
      size: blob.size,
    };
  }

  async downloadBlob(blobId: string): Promise<Blob | null> {
    return blobStore.get(blobId) ?? null;
  }

  getSyncStatus(): SyncAdapterStatus {
    return {
      syncState: this.syncState,
      pendingChanges: this.pendingChanges,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
    };
  }

  getAcknowledgedOutboxIds(): string[] {
    return [...this.acknowledgedOutboxIds];
  }
}

export function resetLocalSyncAdapterStoresForTests(): void {
  invoiceSequences.clear();
  blobStore.clear();
}
