import type { SyncCoordinatorReport, SyncOutboxEntry, SyncState } from '../../types/sync';
import type { SyncAdapterStatus } from './syncAdapter';
import { buildPersistedStateSnapshot, persistAll } from '../persistenceService';
import { getSyncClient } from './syncClientService';
import { getSyncOutboxSnapshot, hasPendingCompanyCloudBackup } from './syncOutboxService';
import { getSyncCoordinator } from './syncCoordinator';
import { applySyncPullCandidateSafely } from './syncPullPersistService';
import { runQueuedSyncOperation } from './syncOperationQueue';
import { createSyncAdapter, isSyncProviderAvailable } from './syncAdapterFactory';
import { isSupabaseConfigured } from '../../lib/supabase';
import { bootstrapWorkspaceCloudSyncIfNeeded } from '../workspace/workspaceCloudBootstrapService';
import { isSupabaseSyncAllowed } from './cloudSyncAllowlist';
import { describeSyncOutboxEntry, type SyncOutboxDescription } from './syncOutboxDescriptionService';
import {
  getPendingWorkspaceSettingsConflict,
  resolveWorkspaceSettingsConflict,
  type WorkspaceSettingsDecision,
  type WorkspaceSettingsFieldConflict,
} from '../workspace/workspaceSettingsConflictService';

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
  /**
   * FINANZ-SYNC-BLOCKER-01B — die nicht übertragenen Aufträge, benannt.
   *
   * Hier stehen auch die `error`-Einträge. Die Liste oben führte nur
   * `pending` und `blocked`, weshalb die Seite von genau den Einträgen, die
   * schiefgegangen waren, nur die Anzahl zeigen konnte.
   */
  failedOutboxEntries: SyncOutboxDescription[];
  /** Offener Feldkonflikt der Betriebseinstellungen, falls einer ansteht. */
  settingsConflict: WorkspaceSettingsFieldConflict[] | null;
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
  const failedOutboxEntries = outbox
    .filter(
      (entry) =>
        entry.status === 'error' || entry.status === 'failed' || entry.status === 'blocked',
    )
    .map(describeSyncOutboxEntry);

  return {
    deviceId: syncClient.deviceId,
    workspaceId: syncClient.workspaceId,
    syncPolicy: syncClient.syncPolicy,
    status,
    lastReport: coordinator.getLastReport(),
    outbox,
    outboxCounts: countOutbox(outbox),
    pendingOutboxEntries,
    failedOutboxEntries,
    settingsConflict: getPendingWorkspaceSettingsConflict()?.undecided ?? null,
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
    /*
     * FINANZ-SYNC-BLOCKER-01B — dieser Weg beginnt immer an einem Knopf, den
     * ein Mensch gedrückt hat. Das automatische Limit gilt für Selbstläufe, und
     * ein ausdrücklicher Versuch muss auch danach noch etwas bewirken.
     */
    const result = await getSyncCoordinator().retrySync(buildPersistedStateSnapshot(), {
      manual: true,
    });
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

/* -------------------------------------------------------------------------- */
/* REAL-PRODUCT-TEST-01D — verständlicher Gesamtstatus                        */
/* -------------------------------------------------------------------------- */

export type SyncStatusKind =
  | 'offline'
  | 'syncing'
  | 'failed'
  /** 01G — es steht eine Entscheidung aus; das ist kein Fehler. */
  | 'conflict'
  | 'waiting'
  | 'synced'
  | 'idle';

export interface SyncStatusSummary {
  /** 01G — blockierte Auftraege, die auf eine Entscheidung warten. */
  conflictCount: number;
  kind: SyncStatusKind;
  /** Änderungen, die noch nicht übertragen sind (ausstehend oder wartend). */
  waitingCount: number;
  /** Änderungen, deren Übertragung fehlgeschlagen ist. */
  failedCount: number;
  /** Im letzten Lauf automatisch behandelte Konflikte. */
  mergedCount: number;
}

const SYNCING: SyncState[] = ['checking', 'uploading', 'downloading', 'merging'];

/**
 * Der Engine-Zustand `synced` heißt nur: Der letzte Lauf hatte keine
 * fehlgeschlagene Sendung. Wartende Einträge und automatisch behandelte
 * Konflikte sind davon unabhängig — der Nutzer muss sie trotzdem sehen.
 * Reine Ableitung aus dem Snapshot, keine Änderung an der Engine.
 */
export function summarizeSyncStatus(
  snapshot: Pick<SyncUiSnapshot, 'status' | 'outbox' | 'lastReport' | 'isOffline'> &
    Partial<Pick<SyncUiSnapshot, 'settingsConflict'>>,
): SyncStatusSummary {
  /* Nur-lokale Entitäten (z. B. Papierregister, Gedächtnis) warten auf nichts — sie werden nie gesendet. */
  const waitingCount = snapshot.outbox.filter(
    (entry) => (entry.status === 'pending' || entry.status === 'blocked') && isSupabaseSyncAllowed(entry.entityType),
  ).length;
  const failedCount = snapshot.outbox.filter(
    (entry) => entry.status === 'error' || entry.status === 'failed',
  ).length;
  /*
   * FINANZ-SYNC-BLOCKER-01G — ein Konflikt ist kein technischer Fehler.
   *
   * Vorher stand im Kopf „Fehler", weil der Lauf nach einem Versionskonflikt in
   * den Fehlerzustand ging — während der Fehlerzähler null zeigte, weil ein
   * blockierter Auftrag weder `error` noch `failed` ist. Beides zugleich war
   * für den Betrieb nicht lesbar.
   *
   * Gezählt wird nur, was der Nutzer auch entscheiden **kann**. Ein Auftrag, der
   * im Testmodus blockiert ist oder für den es keine Auflösung gibt, wartet
   * weiterhin — ihn zur „Entscheidung nötig" zu erklären, wäre derselbe
   * halbfertige Zustand, nur an anderer Stelle.
   */
  const conflictCount =
    (snapshot.settingsConflict?.length ?? 0) > 0
      ? snapshot.outbox.filter(
          (entry) => entry.status === 'blocked' && entry.entityType === 'workspace_settings',
        ).length
      : 0;
  const mergedCount = snapshot.lastReport?.conflictCount ?? 0;
  const state = snapshot.status.syncState;

  let kind: SyncStatusKind;
  if (snapshot.isOffline) kind = 'offline';
  else if (SYNCING.includes(state)) kind = 'syncing';
  else if (failedCount > 0 || (state === 'error' && conflictCount === 0)) kind = 'failed';
  else if (conflictCount > 0) kind = 'conflict';
  else if (state === 'error') kind = 'failed';
  else if (state === 'synced') kind = waitingCount > 0 ? 'waiting' : 'synced';
  else kind = 'idle';

  return { kind, waitingCount, failedCount, mergedCount, conflictCount };
}

/**
 * FINANZ-SYNC-BLOCKER-01B — die Entscheidung des Nutzers zu den
 * Betriebseinstellungen übernehmen und den blockierten Auftrag freigeben.
 */
export function resolveSettingsConflictFromUi(decision: WorkspaceSettingsDecision): boolean {
  const aufgeloest = resolveWorkspaceSettingsConflict(decision);
  /*
   * FINANZ-SYNC-BLOCKER-01G — erst speichern, dann melden.
   *
   * Die Auflösung schrieb bisher nur in die Speicher. Zwischen Klick und dem
   * nächsten Persistenzlauf war der dauerhafte Stand ein anderer als der
   * angezeigte — in der Abnahme sah man den neuen Wert, während gespeichert
   * noch der alte samt blockiertem Auftrag stand. Eine Erfolgsmeldung darf
   * nicht vor dem Zustandswechsel kommen.
   */
  if (aufgeloest) persistAll();
  return aufgeloest;
}
