import type { AppPersistedState } from '../../types/models';
import type {
  SyncOutboxEntry,
  SyncSimulationReport,
  SyncState,
} from '../../types/sync';

export type SyncProviderKind = 'local' | 'supabase' | 'firebase' | 'node' | 'json';

export interface SyncPushInput {
  deviceId: string;
  workspaceId: string;
  state: AppPersistedState;
  outbox: SyncOutboxEntry[];
}

export interface SyncPushFailure {
  outboxId: string;
  message: string;
  retryable: boolean;
}

export interface SyncPushResult {
  success: boolean;
  state: AppPersistedState;
  completedOutboxIds: string[];
  failedOutbox: SyncPushFailure[];
  report: SyncSimulationReport;
}

export interface SyncPullInput {
  deviceId: string;
  workspaceId: string;
  state: AppPersistedState;
}

export interface SyncPullResult {
  success: boolean;
  state: AppPersistedState;
  report: SyncSimulationReport;
  /** Invoice finalize intents to clear after successful batch persist (03B2). */
  pendingInvoiceIntentClears?: string[];
}

export interface SyncAcknowledgeInput {
  outboxIds: string[];
}

export interface SyncInvoiceNumberReservation {
  year: number;
  sequenceNumber: number;
  formatted: string;
}

export interface SyncBlobReference {
  blobId: string;
  mimeType?: string;
  size?: number;
}

export interface SyncAdapterStatus {
  syncState: SyncState;
  pendingChanges: number;
  lastSyncedAt?: string;
  lastError?: string;
}

export interface SyncAdapter {
  readonly providerKind: SyncProviderKind;
  pushChanges(input: SyncPushInput): Promise<SyncPushResult>;
  pullChanges(input: SyncPullInput): Promise<SyncPullResult>;
  acknowledgeChanges(input: SyncAcknowledgeInput): Promise<void>;
  reserveInvoiceNumber(workspaceId: string): Promise<SyncInvoiceNumberReservation>;
  uploadBlob(
    workspaceId: string,
    blob: Blob,
    metadata?: Record<string, string>,
  ): Promise<SyncBlobReference>;
  downloadBlob(blobId: string): Promise<Blob | null>;
  getSyncStatus(): SyncAdapterStatus;
}
