/**
 * SYNC-AUTOMATIK-01A — der Zustand der globalen Statusanzeige.
 *
 * Vier Begriffe, keine Technik: Synchronisiert · Wird synchronisiert ·
 * Offline – wird später übertragen · Aktion erforderlich. Reine Ableitung aus
 * dem bestehenden Sync-Überblick (`summarizeSyncStatus`) und dem Planer.
 */
import type { SyncOutboxEntry } from '../../types/sync';
import type { SyncStatusSummary } from './syncUiService';
import type { SyncSchedulerStatus } from './syncScheduler';
import { isSupabaseSyncAllowed } from './cloudSyncAllowlist';

export type SyncIndicatorState = 'synced' | 'syncing' | 'offline' | 'action';

export const SYNC_INDICATOR_LABEL_KEYS: Record<SyncIndicatorState, string> = {
  synced: 'sync.indicator.synced',
  syncing: 'sync.indicator.syncing',
  offline: 'sync.indicator.offline',
  action: 'sync.indicator.action',
};

export function deriveSyncIndicatorState(input: {
  online: boolean;
  staleTab: boolean;
  summary: SyncStatusSummary;
  outbox: SyncOutboxEntry[];
  scheduler: SyncSchedulerStatus | null;
}): SyncIndicatorState {
  const { summary, scheduler } = input;
  if (!input.online || summary.kind === 'offline') return 'offline';
  // Dieser Tab muss neu geladen werden — das ist eine Handlung des Nutzers.
  if (input.staleTab) return 'action';
  if (summary.kind === 'conflict') return 'action';
  // Blockiert (nicht Testmodus) löst sich nicht von selbst.
  const blocked = input.outbox.some(
    (entry) =>
      entry.status === 'blocked' && entry.blockedReason !== 'beta_mode' && isSupabaseSyncAllowed(entry.entityType),
  );
  if (blocked) return 'action';
  if (summary.kind === 'failed') {
    // Eine geplante automatische Wiederholung ist noch in Arbeit; aufgebraucht heisst: handeln.
    return scheduler?.retryScheduled || scheduler?.running ? 'syncing' : 'action';
  }
  if (scheduler?.running || scheduler?.changeQueued || summary.kind === 'syncing') return 'syncing';
  const pending = input.outbox.some(
    (entry) => entry.status === 'pending' && isSupabaseSyncAllowed(entry.entityType),
  );
  if (pending) return 'syncing';
  return 'synced';
}
