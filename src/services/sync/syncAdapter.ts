import type { AppPersistedState } from '../../types/models';
import type {
  SyncOutboxEntry,
  SyncSimulationReport,
  SyncState,
} from '../../types/sync';
import type { OrderAmendmentIntentClearKey } from '../orderAmendment/orderAmendmentCloudPullMergeService';
import type { SyncRunIdentity, SyncRunIdentityChangeReason } from './syncRunIdentityService';

export type SyncProviderKind = 'local' | 'supabase' | 'firebase' | 'node' | 'json';

export interface SyncPushInput {
  deviceId: string;
  workspaceId: string;
  state: AppPersistedState;
  outbox: SyncOutboxEntry[];
  /**
   * DOKUMENTE-01 R1 — die Ursprungsidentität des Laufs (Konto, Betrieb, Sicht, Sitzung). Fehlt sie, hält der
   * Adapter sie selbst beim Start fest. Jede Sendung des Laufs ist an sie gebunden.
   */
  runIdentity?: SyncRunIdentity;
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
  /**
   * DOKUMENTE-01 R1 — während des Laufs wechselte Konto, Betrieb oder Sicht. Ab dem ersten Unterschied wurde
   * nichts mehr gesendet; noch offene Aufträge sind unverändert.
   */
  identityChanged?: boolean;
  /** DOKUMENTE-01 R1 — woran der Wechsel erkannt wurde. */
  identityChangeReason?: SyncRunIdentityChangeReason;
  /** DOKUMENTE-01 R2 — zurückgehaltene Aufträge (Ursprung unbekannt oder fremd), unverändert und nicht gesendet. */
  heldOutboxIds?: string[];
  /** DOKUMENTE-01 R1 — die Identität, an die dieser Lauf gebunden war; der Abruf desselben Laufs nimmt sie mit. */
  runIdentity?: SyncRunIdentity;
}

export interface SyncPullInput {
  deviceId: string;
  workspaceId: string;
  state: AppPersistedState;
  /** DOKUMENTE-01 R1 — dieselbe Laufidentität wie beim Senden; jede Abfrage ist an sie gebunden. */
  runIdentity?: SyncRunIdentity;
}

export interface SyncPullResult {
  success: boolean;
  state: AppPersistedState;
  report: SyncSimulationReport;
  /** Invoice finalize intents to clear after successful batch persist (03B2). */
  pendingInvoiceIntentClears?: string[];
  /** Amendment confirm intents to clear after successful batch persist (01B3B). */
  pendingAmendmentIntentClears?: OrderAmendmentIntentClearKey[];
  /**
   * When true, UI/Bootstrap must not persist the pull candidate
   * (e.g. global amendment-pull failure → keep pre-pull state).
   */
  skipPersist?: boolean;
  /** DOKUMENTE-01 R1 — während des Abrufs wechselte Konto, Betrieb oder Sicht; nichts davon wird übernommen. */
  identityChanged?: boolean;
  /** DOKUMENTE-01 R1 — woran der Wechsel erkannt wurde (auch: Startidentität nicht bestätigt). */
  identityChangeReason?: SyncRunIdentityChangeReason;
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
