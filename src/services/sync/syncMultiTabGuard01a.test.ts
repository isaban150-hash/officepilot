/**
 * SYNC-AUTOMATIK-01A — localStorage: ein älterer Tab überschreibt keinen
 * neueren Stand eines anderen Tabs. Dazu: globale Statusanzeige und das
 * Starten/Beenden des Planers.
 *
 * Ein zweiter Tab wird nachgestellt, indem sein Schreiben direkt im Speicher
 * geschieht — Bestand plus Schreibgeneration, genau wie ein anderer Tab es
 * täte. Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPersistedStateSnapshot,
  isLocalStateStaleInThisTab,
  persistAll,
  persistSyncOutboxNow,
  resetWriteGenerationsForTests,
  watchOtherTabWrites,
} from '../persistenceService';
import { getPersistenceHealthSnapshot } from '../persistenceHealthService';
import { createCustomer } from '../customerService';
import { bootstrapBusinessState } from '../storage/storageBootstrapService';
import { getActiveStorageKey } from '../storage/storageScopeService';
import { resetSyncOutboxForTests } from './syncOutboxService';
import { resetSyncChangeTrackerForTests } from './syncChangeTrackerService';
import { createSyncClient, hydrateSyncClient, resetSyncClientForTests } from './syncClientService';
import { resetSyncCoordinatorForTests } from './syncCoordinator';
import { resetTestStores } from '../../test/resetStores';
import { deriveSyncIndicatorState } from './syncIndicatorService';
import type { SyncStatusSummary } from './syncUiService';
import type { SyncSchedulerStatus } from './syncScheduler';
import type { SyncOutboxEntry } from '../../types/sync';
import type { AppPersistedState } from '../../types/models';
import {
  getAutomaticSyncStatus,
  isAutomaticSyncActive,
  startAutomaticSync,
  stopAutomaticSync,
} from './syncSchedulerRuntime';
import type { SyncSchedulerDeps } from './syncScheduler';

const WORKSPACE = 'ws-multitab-01a';

/** So speichert ein anderer Tab fachlich: fachliche Revision und Schreibzähler steigen (01A-FIX3). */
function otherTabWrites(mutate: (state: AppPersistedState) => AppPersistedState): void {
  const key = getActiveStorageKey();
  const stored = JSON.parse(localStorage.getItem(key)!) as AppPersistedState & {
    businessRevision?: number;
    writeGeneration?: number;
  };
  const { businessRevision, writeGeneration, ...rest } = stored;
  localStorage.setItem(
    key,
    JSON.stringify({
      businessRevision: (businessRevision ?? 0) + 1,
      writeGeneration: (writeGeneration ?? 0) + 1,
      ...mutate(rest as AppPersistedState),
    }),
  );
}

function storedState(): AppPersistedState {
  return JSON.parse(localStorage.getItem(getActiveStorageKey())!) as AppPersistedState;
}

describe('SYNC-AUTOMATIK-01A — Schutz vor älteren Tabs', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWriteGenerationsForTests();
    resetTestStores();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
    resetSyncCoordinatorForTests();
    hydrateSyncClient({ ...createSyncClient(), workspaceId: WORKSPACE });
    bootstrapBusinessState({ userId: 'user-multitab-01a', workspaceId: WORKSPACE });
  });

  afterEach(() => {
    resetWriteGenerationsForTests();
  });

  it('eigene Speicherungen laufen unverändert durch', () => {
    expect(persistAll().success).toBe(true);
    expect(persistAll().success).toBe(true);
    expect(isLocalStateStaleInThisTab()).toBe(false);
  });

  it('hat ein anderer Tab neuer gespeichert, wird nicht überschrieben — mit klarer Meldung', () => {
    expect(persistAll().success).toBe(true);
    otherTabWrites((state) => ({ ...state, customers: [...(state.customers ?? []), { id: 'c-anderer-tab', name: 'Anderer Tab GmbH' } as never] }));

    const result = createCustomer({ name: 'Älterer Tab GmbH', street: 'Beispielweg 1', zip: '20000', city: 'Beispielstadt' });
    expect(result.success).toBe(false);
    // Der neuere Stand des anderen Tabs ist unangetastet.
    expect(storedState().customers?.map((customer) => customer.id)).toContain('c-anderer-tab');
    expect(storedState().customers?.some((customer) => customer.name === 'Älterer Tab GmbH')).toBe(false);
    expect(isLocalStateStaleInThisTab()).toBe(true);
    expect(getPersistenceHealthSnapshot().staleTab).toBe(true);

    // Auch der Sendenachweis schreibt nicht über den neueren Bestand.
    expect(persistSyncOutboxNow()).toBe(false);
    expect(storedState().customers?.map((customer) => customer.id)).toContain('c-anderer-tab');
  });

  it('nach dem Neuladen arbeitet der Tab auf dem neuen Stand weiter', () => {
    expect(persistAll().success).toBe(true);
    otherTabWrites((state) => state);
    expect(persistAll().success).toBe(false);

    bootstrapBusinessState({ userId: 'user-multitab-01a', workspaceId: WORKSPACE });
    expect(isLocalStateStaleInThisTab()).toBe(false);
    expect(persistAll().success).toBe(true);
  });

  it('älterer Bestand ohne Schreibgeneration bleibt beschreibbar', () => {
    expect(persistAll().success).toBe(true);
    const key = getActiveStorageKey();
    const {
      businessRevision: _revision,
      writeGeneration: _generation,
      ...ohneGeneration
    } = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
    localStorage.setItem(key, JSON.stringify(ohneGeneration));
    expect(persistAll().success).toBe(true);
    expect(localStorage.getItem(key)!.startsWith('{"businessRevision":')).toBe(true);
  });

  it('ein Speichern bleibt genau ein Schreibvorgang', () => {
    const spy = vi.spyOn(localStorage, 'setItem');
    try {
      expect(persistAll().success).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('der andere Tab wird sofort bemerkt, nicht erst beim nächsten Speichern', () => {
    expect(persistAll().success).toBe(true);
    const stop = watchOtherTabWrites();
    try {
      otherTabWrites((state) => state);
      window.dispatchEvent(new StorageEvent('storage', { key: getActiveStorageKey() }));
      expect(isLocalStateStaleInThisTab()).toBe(true);
      expect(getPersistenceHealthSnapshot()).toMatchObject({ hasFailure: true, staleTab: true });
    } finally {
      stop();
    }
  });

  it('der Snapshot bleibt vom Schutz unberührt (reines Lesen)', () => {
    otherTabWrites((state) => state);
    expect(() => buildPersistedStateSnapshot()).not.toThrow();
  });
});

function summary(overrides: Partial<SyncStatusSummary> = {}): SyncStatusSummary {
  return { kind: 'synced', waitingCount: 0, failedCount: 0, mergedCount: 0, conflictCount: 0, ...overrides };
}

function schedulerStatus(overrides: Partial<SyncSchedulerStatus> = {}): SyncSchedulerStatus {
  return {
    running: false,
    changeQueued: false,
    retryScheduled: false,
    retriesExhausted: false,
    lastOutcome: 'ok',
    lastFullSyncAt: 0,
    ...overrides,
  };
}

function entry(overrides: Partial<SyncOutboxEntry>): SyncOutboxEntry {
  return {
    id: 'o-1',
    entityType: 'customer',
    entityId: 'c-1',
    operation: 'update',
    version: 1,
    queuedAt: '2026-09-26T10:00:00.000Z',
    retryCount: 0,
    status: 'pending',
    ...overrides,
  } as SyncOutboxEntry;
}

describe('SYNC-AUTOMATIK-01A — globale Statusanzeige', () => {
  const base = { online: true, staleTab: false, outbox: [] as SyncOutboxEntry[], scheduler: schedulerStatus() };

  it('vier Zustände, ohne Technikbegriffe', () => {
    expect(deriveSyncIndicatorState({ ...base, summary: summary() })).toBe('synced');
    expect(deriveSyncIndicatorState({ ...base, scheduler: schedulerStatus({ running: true }), summary: summary() })).toBe('syncing');
    expect(deriveSyncIndicatorState({ ...base, scheduler: schedulerStatus({ changeQueued: true }), summary: summary() })).toBe('syncing');
    expect(deriveSyncIndicatorState({ ...base, outbox: [entry({})], summary: summary({ kind: 'waiting', waitingCount: 1 }) })).toBe('syncing');
    expect(deriveSyncIndicatorState({ ...base, online: false, outbox: [entry({})], summary: summary() })).toBe('offline');
    expect(deriveSyncIndicatorState({ ...base, summary: summary({ kind: 'conflict', conflictCount: 1 }) })).toBe('action');
    expect(deriveSyncIndicatorState({ ...base, outbox: [entry({ status: 'blocked' })], summary: summary({ kind: 'waiting' }) })).toBe('action');
    expect(deriveSyncIndicatorState({ ...base, staleTab: true, summary: summary() })).toBe('action');
  });

  it('Fehler mit geplanter Wiederholung: wird synchronisiert — Wiederholungen aufgebraucht: Aktion erforderlich', () => {
    const failed = summary({ kind: 'failed', failedCount: 1 });
    expect(deriveSyncIndicatorState({ ...base, scheduler: schedulerStatus({ retryScheduled: true }), summary: failed })).toBe('syncing');
    expect(deriveSyncIndicatorState({ ...base, scheduler: schedulerStatus({ retriesExhausted: true }), summary: failed })).toBe('action');
  });

  it('Testmodus-Blockade und nur lokale Einträge lösen keine Handlungsaufforderung aus', () => {
    expect(
      deriveSyncIndicatorState({ ...base, outbox: [entry({ status: 'blocked', blockedReason: 'beta_mode' })], summary: summary() }),
    ).toBe('synced');
  });
});

describe('SYNC-AUTOMATIK-01A — Planer starten und beenden', () => {
  afterEach(() => {
    stopAutomaticSync();
    vi.useRealTimers();
  });

  function fakeDeps(counter: { runs: number; listeners: number }): SyncSchedulerDeps {
    return {
      runSync: async () => {
        counter.runs += 1;
        return { errorCount: 0, errors: [], conflicts: [] } as never;
      },
      getOutbox: () => [],
      subscribeLocalChanges: () => {
        counter.listeners += 1;
        return () => {
          counter.listeners -= 1;
        };
      },
      isOnline: () => true,
      isVisible: () => true,
      canSync: () => true,
      now: () => Date.now(),
      random: () => 0,
      windowTarget: null,
      documentTarget: null,
      locks: null,
      createChannel: null,
    };
  }

  it('Test 19: Abmeldung / Workspace-Wechsel beendet den Planer vollständig', async () => {
    vi.useFakeTimers();
    const first = { runs: 0, listeners: 0 };
    const second = { runs: 0, listeners: 0 };
    const stopFirst = startAutomaticSync({ userId: 'u-1', workspaceId: 'ws-a' }, fakeDeps(first));
    expect(isAutomaticSyncActive()).toBe(true);
    expect(getAutomaticSyncStatus()).not.toBeNull();
    expect(first.listeners).toBe(1);

    // Workspace-Wechsel: der alte Planer endet, bevor der neue beginnt.
    const stopSecond = startAutomaticSync({ userId: 'u-1', workspaceId: 'ws-b' }, fakeDeps(second));
    expect(first.listeners).toBe(0);
    expect(second.listeners).toBe(1);
    // Das verspätete Aufräumen des alten Effekts beendet nicht den neuen.
    stopFirst();
    expect(isAutomaticSyncActive()).toBe(true);

    // Abmeldung.
    stopSecond();
    expect(isAutomaticSyncActive()).toBe(false);
    expect(getAutomaticSyncStatus()).toBeNull();
    expect(second.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(first.runs + second.runs).toBe(0);
  });
});
