/**
 * SYNC-AUTOMATIK-01A-FIX1 — Befund A: Eine normale Speicherung sendet nur.
 *
 * Browserbefund: Nach jedem Speichern folgte dem Senden der vollständige
 * Abruf (rund zehn Abrufe), auch Sekunden nach dem letzten Abgleich.
 *
 * Geprüft über den produktiven Weg: echter Planer (Fake-Timer), echte
 * Speicher, `pushPendingChangesFromUi` / `runSyncFromUi`. Nur der Cloud-Adapter
 * ist ein steuerbarer Ersatz, der Sende- und Abrufvorgänge zählt.
 *
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeLocalMutations } from '../persistenceService';
import { createCustomer, updateCustomer } from '../customerService';
import { getCustomerById } from '../customerStoreService';
import { bootstrapBusinessState } from '../storage/storageBootstrapService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from './syncOutboxService';
import { resetSyncChangeTrackerForTests } from './syncChangeTrackerService';
import { createSyncClient, hydrateSyncClient, resetSyncClientForTests } from './syncClientService';
import { getSyncCoordinator, resetSyncCoordinatorForTests } from './syncCoordinator';
import { pushPendingChangesFromUi, runSyncFromUi } from './syncUiService';
import { resetSyncOperationQueueForTests } from './syncOperationQueue';
import { createEmptySyncSimulationReport } from './syncSimulationReportService';
import { createSyncScheduler, type SyncScheduler } from './syncScheduler';
import { resetTestStores } from '../../test/resetStores';
import type { SyncAdapter, SyncPushInput } from './syncAdapter';
import type { Customer } from '../../types/models';

const WORKSPACE = 'ws-push-only-01afix1';

function createCountingAdapter() {
  const server = new Map<string, { name: string; rowVersion: number }>();
  const counts = { push: 0, pull: 0 };
  let holdPush = false;
  let pushStarted: (() => void) | null = null;
  let releasePush: (() => void) | null = null;

  const adapter: SyncAdapter = {
    providerKind: 'supabase',
    async pushChanges(input: SyncPushInput) {
      counts.push += 1;
      pushStarted?.();
      if (holdPush) {
        await new Promise<void>((resolve) => {
          releasePush = resolve;
        });
      }
      const completed: string[] = [];
      let customers = [...(input.state.customers ?? [])];
      const outbox = (input.outbox ?? []).map((entry) => ({ ...entry }));
      for (const entry of outbox) {
        if (entry.entityType !== 'customer' || (entry.status !== 'pending' && entry.status !== 'error')) continue;
        const customer = customers.find((candidate) => candidate.id === entry.entityId);
        if (!customer) continue;
        const expected = customer.sync?.version ?? 0;
        const current = server.get(customer.id)?.rowVersion ?? 0;
        if (expected !== current) {
          entry.status = 'blocked';
          continue;
        }
        server.set(customer.id, { name: customer.name, rowVersion: current + 1 });
        customers = customers.map((candidate) =>
          candidate.id === customer.id
            ? ({
                ...candidate,
                sync: { version: current + 1, updatedAt: '2026-09-26T10:00:00.000Z', deleted: false, deviceId: input.deviceId, workspaceId: WORKSPACE },
              } as Customer)
            : candidate,
        );
        entry.status = 'completed';
        completed.push(entry.id);
      }
      return {
        success: true,
        state: { ...input.state, customers, syncOutbox: outbox },
        completedOutboxIds: completed,
        failedOutbox: [],
        report: createEmptySyncSimulationReport(new Date().toISOString()),
      };
    },
    async pullChanges(input) {
      counts.pull += 1;
      return { success: true, state: input.state, report: createEmptySyncSimulationReport(new Date().toISOString()) };
    },
    async acknowledgeChanges() {},
    async reserveInvoiceNumber() {
      throw new Error('not used');
    },
    async uploadBlob() {
      throw new Error('not used');
    },
    async downloadBlob() {
      return null;
    },
    getSyncStatus() {
      return { syncState: 'idle', pendingChanges: 0 };
    },
  };

  return {
    adapter,
    server,
    counts,
    holdNextPush(): Promise<void> {
      holdPush = true;
      return new Promise<void>((resolve) => {
        pushStarted = resolve;
      });
    },
    releasePush() {
      holdPush = false;
      pushStarted = null;
      releasePush?.();
      releasePush = null;
    },
  };
}

class Events {
  private readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
}

function newCustomer(name: string): Customer {
  const created = createCustomer({ name, street: 'Beispielstraße 1', zip: '20000', city: 'Beispielstadt' });
  if (!created.success) throw new Error('create failed');
  return created.customer;
}

describe('SYNC-AUTOMATIK-01A-FIX1 — Speichern sendet nur, ohne vollständigen Abruf', () => {
  let cloud: ReturnType<typeof createCountingAdapter>;
  let scheduler: SyncScheduler | null = null;
  let windowEvents: Events;
  let documentEvents: Events;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T10:00:00.000Z'));
    localStorage.clear();
    resetTestStores();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
    resetSyncCoordinatorForTests();
    resetSyncOperationQueueForTests();
    hydrateSyncClient({ ...createSyncClient(), workspaceId: WORKSPACE, syncPolicy: 'cloud_ready' });
    bootstrapBusinessState({ userId: 'user-push-only', workspaceId: WORKSPACE });
    cloud = createCountingAdapter();
    getSyncCoordinator().setAdapter(cloud.adapter);
    windowEvents = new Events();
    documentEvents = new Events();
  });

  afterEach(() => {
    scheduler?.stop();
    scheduler = null;
    vi.useRealTimers();
  });

  function startScheduler(): SyncScheduler {
    scheduler = createSyncScheduler(
      { userId: 'user-push-only', workspaceId: WORKSPACE },
      {
        runSync: runSyncFromUi,
        runPushOnly: pushPendingChangesFromUi,
        getOutbox: getSyncOutboxSnapshot,
        subscribeLocalChanges: subscribeLocalMutations,
        isOnline: () => true,
        isVisible: () => true,
        canSync: () => true,
        now: () => Date.now(),
        random: () => 0,
        windowTarget: windowEvents,
        documentTarget: documentEvents,
        locks: null,
        createChannel: null,
      },
    );
    return scheduler;
  }

  it('1+2: normaler Save → nach 3 s gesendet, kein Abruf', async () => {
    startScheduler();
    const customer = newCustomer('Beispiel Senden GmbH');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(cloud.counts).toEqual({ push: 0, pull: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(cloud.counts).toEqual({ push: 1, pull: 0 });
    expect(cloud.server.get(customer.id)).toEqual({ name: 'Beispiel Senden GmbH', rowVersion: 1 });
    expect(getCustomerById(customer.id)?.sync?.version).toBe(1);
    expect(getSyncOutboxSnapshot().every((entry) => entry.status === 'completed')).toBe(true);
  });

  it('3: mehrere Saves → ein Sendelauf, kein Abruf', async () => {
    startScheduler();
    const customer = newCustomer('Beispiel Mehrfach GmbH');
    await vi.advanceTimersByTimeAsync(1_000);
    updateCustomer(customer.id, { city: 'Nordstadt' });
    await vi.advanceTimersByTimeAsync(1_000);
    updateCustomer(customer.id, { phone: '040 111' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(cloud.counts).toEqual({ push: 1, pull: 0 });
  });

  it('4: zweiter Save 6 s später → wieder nur senden', async () => {
    startScheduler();
    const customer = newCustomer('Beispiel Später GmbH');
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    updateCustomer(customer.id, { name: 'Beispiel Später GmbH – geändert' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(cloud.counts).toEqual({ push: 2, pull: 0 });
    expect(cloud.server.get(customer.id)).toEqual({ name: 'Beispiel Später GmbH – geändert', rowVersion: 2 });
  });

  it('5: Reconnect → senden und vollständig abrufen', async () => {
    startScheduler();
    newCustomer('Beispiel Offline GmbH');
    windowEvents.dispatch('online');
    await vi.advanceTimersByTimeAsync(0);
    expect(cloud.counts).toEqual({ push: 1, pull: 1 });
  });

  it('6: Fokus ab 30 s → vollständiger Abgleich', async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(30_000);
    windowEvents.dispatch('focus');
    await vi.advanceTimersByTimeAsync(0);
    expect(cloud.counts.pull).toBe(1);
  });

  it('7: 90-s-Takt → vollständiger Abgleich', async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(cloud.counts.pull).toBe(1);
  });

  it('8: manueller Sync → vollständiger Abgleich', async () => {
    newCustomer('Beispiel Manuell GmbH');
    await runSyncFromUi();
    expect(cloud.counts).toEqual({ push: 1, pull: 1 });
  });

  it('9: Save während eines Sendelaufs bleibt erhalten und wird danach gesendet', async () => {
    startScheduler();
    const customer = newCustomer('Beispiel Rennen GmbH');
    const pushReached = cloud.holdNextPush();
    await vi.advanceTimersByTimeAsync(3_000);
    await pushReached;

    // Während des Sendens gespeichert.
    expect(updateCustomer(customer.id, { name: 'Beispiel Rennen GmbH – neuer' }).success).toBe(true);
    cloud.releasePush();
    await vi.advanceTimersByTimeAsync(0);

    expect(getCustomerById(customer.id)?.name).toBe('Beispiel Rennen GmbH – neuer');
    expect(getCustomerById(customer.id)?.sync?.version).toBe(1);
    const offen = getSyncOutboxSnapshot().filter((entry) => entry.entityId === customer.id && entry.status === 'pending');
    expect(offen).toHaveLength(1);

    // Der Folgelauf sendet — wieder ohne Abruf — genau die neue Fassung.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(cloud.server.get(customer.id)).toEqual({ name: 'Beispiel Rennen GmbH – neuer', rowVersion: 2 });
    expect(cloud.counts.pull).toBe(0);
  });

  it('nichts zu senden → keine Cloud-Anfrage, kein Speichern', async () => {
    const result = await pushPendingChangesFromUi();
    expect(result.needsFullSync).toBe(false);
    expect(cloud.counts).toEqual({ push: 0, pull: 0 });
  });

  it('Versionskonflikt beim Senden → gezielt ein vollständiger Abgleich', async () => {
    startScheduler();
    const customer = newCustomer('Beispiel Konflikt GmbH');
    // Ein anderes Gerät war schneller: die Cloud kennt schon Version 3.
    cloud.server.set(customer.id, { name: 'Anderes Gerät', rowVersion: 3 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(cloud.counts.push).toBeGreaterThanOrEqual(1);
    expect(cloud.counts.pull).toBe(1);
    expect(getSyncOutboxSnapshot().some((entry) => entry.entityId === customer.id && entry.status === 'blocked')).toBe(true);
  });
});
