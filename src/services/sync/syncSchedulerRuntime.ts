/**
 * SYNC-AUTOMATIK-01A — der Planer mit den echten Abhängigkeiten.
 *
 * Genau ein aktiver Planer: Er startet, wenn ein angemeldeter Nutzer in einem
 * bereiten Workspace arbeitet, und endet bei Abmeldung oder Workspace-Wechsel
 * vollständig — alle Zeitgeber, Ereignisse, Kanäle.
 */
import { isSupabaseConfigured } from '../../lib/supabase';
import {
  isBusinessStateWriteLocked,
  isLocalStateStaleInThisTab,
  subscribeLocalMutations,
  watchOtherTabWrites,
} from '../persistenceService';
import { getActiveStorageKey } from '../storage/storageScopeService';
import { getWorkspaceStoreSnapshot } from '../workspace/workspaceStore';
import { getSyncClient } from './syncClientService';
import { getSyncOutboxSnapshot } from './syncOutboxService';
import { pushPendingChangesFromUi, runSyncFromUi } from './syncUiService';
import {
  createSyncScheduler,
  type SyncScheduler,
  type SyncSchedulerDeps,
  type SyncSchedulerOptions,
  type SyncSchedulerStatus,
} from './syncScheduler';

let active: SyncScheduler | null = null;
let activeUnsubscribe: (() => void) | null = null;
let stopWatchingOtherTabs: (() => void) | null = null;
let currentStatus: SyncSchedulerStatus | null = null;
const statusListeners = new Set<(status: SyncSchedulerStatus | null) => void>();

function publishStatus(status: SyncSchedulerStatus | null): void {
  currentStatus = status;
  for (const listener of [...statusListeners]) {
    try {
      listener(status);
    } catch {
      /* Anzeige darf den Planer nie stören */
    }
  }
}

export function buildBrowserSyncSchedulerDeps(workspaceId: string): SyncSchedulerDeps {
  const hasWindow = typeof window !== 'undefined';
  const hasDocument = typeof document !== 'undefined';
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const locks = nav && 'locks' in nav && nav.locks ? (nav.locks as unknown as SyncSchedulerDeps['locks']) : null;
  return {
    runSync: runSyncFromUi,
    // 01A-FIX1 — Anlass lokale Änderung: nur senden.
    runPushOnly: pushPendingChangesFromUi,
    getOutbox: getSyncOutboxSnapshot,
    subscribeLocalChanges: subscribeLocalMutations,
    isOnline: () => (nav ? nav.onLine !== false : true),
    isVisible: () => (hasDocument ? document.visibilityState !== 'hidden' : true),
    canSync: () =>
      isSupabaseConfigured() &&
      getSyncClient().syncPolicy !== 'disabled' &&
      getWorkspaceStoreSnapshot()?.id === workspaceId &&
      !isLocalStateStaleInThisTab() &&
      !isBusinessStateWriteLocked(getActiveStorageKey()),
    now: () => Date.now(),
    random: Math.random,
    windowTarget: hasWindow ? window : null,
    documentTarget: hasDocument ? document : null,
    locks,
    createChannel:
      typeof BroadcastChannel === 'function'
        ? (name: string) => {
            try {
              return new BroadcastChannel(name) as unknown as ReturnType<NonNullable<SyncSchedulerDeps['createChannel']>>;
            } catch {
              return null;
            }
          }
        : null,
  };
}

/** Startet den Planer für genau diesen Nutzer/Workspace; ein vorheriger wird beendet. */
export function startAutomaticSync(
  options: SyncSchedulerOptions,
  deps: SyncSchedulerDeps = buildBrowserSyncSchedulerDeps(options.workspaceId),
): () => void {
  stopAutomaticSync();
  const scheduler = createSyncScheduler(options, deps);
  active = scheduler;
  activeUnsubscribe = scheduler.subscribe(publishStatus);
  stopWatchingOtherTabs = watchOtherTabWrites();
  return () => {
    if (active === scheduler) stopAutomaticSync();
  };
}

export function stopAutomaticSync(): void {
  activeUnsubscribe?.();
  activeUnsubscribe = null;
  stopWatchingOtherTabs?.();
  stopWatchingOtherTabs = null;
  active?.stop();
  active = null;
  publishStatus(null);
}

export function isAutomaticSyncActive(): boolean {
  return active !== null;
}

export function getAutomaticSyncStatus(): SyncSchedulerStatus | null {
  return currentStatus;
}

export function subscribeAutomaticSyncStatus(
  listener: (status: SyncSchedulerStatus | null) => void,
): () => void {
  statusListeners.add(listener);
  listener(currentStatus);
  return () => {
    statusListeners.delete(listener);
  };
}
