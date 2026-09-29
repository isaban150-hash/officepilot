/**
 * SYNC-AUTOMATIK-01A — der automatische Planer.
 *
 * Alle Zeiten über Fake-Timer, alle Browser-Anteile (online, sichtbar, Locks,
 * BroadcastChannel, Ereignisse) als steuerbare Ersatzteile. Der Sync-Lauf
 * selbst ist ein Zähler — was ein Lauf tut, prüft `syncSaveDuringRun01a`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncCoordinatorReport, SyncOutboxEntry } from '../../types/sync';
import {
  SYNC_RETRY_DELAYS_MS,
  buildSyncLockName,
  classifySyncRun,
  createSyncScheduler,
  type SyncScheduler,
  type SyncSchedulerDeps,
} from './syncScheduler';

function report(overrides: Partial<SyncCoordinatorReport> = {}): SyncCoordinatorReport {
  return {
    startedAt: '2026-09-26T10:00:00.000Z',
    finishedAt: '2026-09-26T10:00:01.000Z',
    durationMs: 1000,
    pullCount: 1,
    pushCount: 0,
    mergedEntityCount: 0,
    conflictCount: 0,
    errorCount: 0,
    completedOutboxCount: 0,
    syncedEntities: [],
    conflicts: [],
    errors: [],
    retryAttempts: 0,
    uploadCount: 0,
    downloadCount: 0,
    ...overrides,
  } as SyncCoordinatorReport;
}

function outboxEntry(overrides: Partial<SyncOutboxEntry>): SyncOutboxEntry {
  return {
    id: 'o-1',
    entityType: 'customer',
    entityId: 'c-1',
    operation: 'update',
    version: 1,
    queuedAt: '2026-09-26T10:00:00.000Z',
    retryCount: 1,
    status: 'error',
    ...overrides,
  } as SyncOutboxEntry;
}

class FakeEvents {
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
  count(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

/** Web-Locks-Ersatz mit echter Warteschlange je Name — wie `navigator.locks.request`. */
class FakeLocks {
  private readonly tails = new Map<string, Promise<unknown>>();
  readonly requested: string[] = [];
  request<T>(name: string, callback: () => Promise<T>): Promise<T> {
    this.requested.push(name);
    const tail = this.tails.get(name) ?? Promise.resolve();
    const run = tail.then(callback, callback);
    this.tails.set(name, run.catch(() => undefined));
    return run;
  }
}

interface Harness {
  deps: SyncSchedulerDeps;
  /** Alle Läufe; aufgeteilt in vollständige Abgleiche und reine Sendeläufe (01A-FIX1). */
  runs: number;
  fullRuns: number;
  pushRuns: number;
  /** Nächster Sendelauf stösst auf einen Versionskonflikt. */
  nextPushNeedsFullSync: boolean;
  online: boolean;
  visible: boolean;
  canSync: boolean;
  outbox: SyncOutboxEntry[];
  nextReports: Array<SyncCoordinatorReport | Error>;
  /** Lauf-Dauer in ms (Fake-Timer). */
  runDurationMs: number;
  inFlight: number;
  maxInFlight: number;
  localChange(): void;
  windowEvents: FakeEvents;
  documentEvents: FakeEvents;
  channels: Array<{ name: string; posted: unknown[]; closed: boolean; onmessage: ((event: { data: unknown }) => void) | null }>;
  localChangeListeners: Set<() => void>;
  locks: FakeLocks;
}

function createHarness(options: { locks?: FakeLocks } = {}): Harness {
  const windowEvents = new FakeEvents();
  const documentEvents = new FakeEvents();
  const localChangeListeners = new Set<() => void>();
  const locks = options.locks ?? new FakeLocks();
  const harness = {} as Harness;
  Object.assign(harness, {
    runs: 0,
    fullRuns: 0,
    pushRuns: 0,
    nextPushNeedsFullSync: false,
    online: true,
    visible: true,
    canSync: true,
    outbox: [],
    nextReports: [],
    runDurationMs: 0,
    inFlight: 0,
    maxInFlight: 0,
    windowEvents,
    documentEvents,
    channels: [],
    localChangeListeners,
    locks,
    localChange() {
      for (const listener of [...localChangeListeners]) listener();
    },
  });
  const simulateRun = async (): Promise<SyncCoordinatorReport> => {
    harness.runs += 1;
    harness.inFlight += 1;
    harness.maxInFlight = Math.max(harness.maxInFlight, harness.inFlight);
    if (harness.runDurationMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, harness.runDurationMs));
    }
    harness.inFlight -= 1;
    const next = harness.nextReports.shift();
    if (next instanceof Error) throw next;
    return next ?? report();
  };
  harness.deps = {
    runSync: async () => {
      harness.fullRuns += 1;
      return simulateRun();
    },
    runPushOnly: async () => {
      harness.pushRuns += 1;
      const needsFullSync = harness.nextPushNeedsFullSync;
      harness.nextPushNeedsFullSync = false;
      return { report: await simulateRun(), needsFullSync };
    },
    getOutbox: () => harness.outbox,
    subscribeLocalChanges: (listener) => {
      localChangeListeners.add(listener);
      return () => localChangeListeners.delete(listener);
    },
    isOnline: () => harness.online,
    isVisible: () => harness.visible,
    canSync: () => harness.canSync,
    now: () => Date.now(),
    random: () => 0,
    windowTarget: windowEvents,
    documentTarget: documentEvents,
    locks,
    createChannel: (name) => {
      const channel = {
        name,
        posted: [] as unknown[],
        closed: false,
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage(message: unknown) {
          channel.posted.push(message);
        },
        close() {
          channel.closed = true;
        },
      };
      harness.channels.push(channel);
      return channel;
    },
  };
  return harness;
}

const OPTIONS = { userId: 'user-01a', workspaceId: 'ws-01a' };

describe('SYNC-AUTOMATIK-01A — Planer', () => {
  let harness: Harness;
  let scheduler: SyncScheduler | null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T10:00:00.000Z'));
    harness = createHarness();
    scheduler = null;
  });

  afterEach(() => {
    scheduler?.stop();
    vi.useRealTimers();
  });

  function start(): SyncScheduler {
    scheduler = createSyncScheduler(OPTIONS, harness.deps);
    return scheduler;
  }

  it('Test 5: Save → Auto-Sync nach 3 Sekunden', async () => {
    start();
    harness.localChange();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(harness.runs).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.runs).toBe(1);
  });

  it('Test 6: mehrere Saves kurz hintereinander → ein Lauf', async () => {
    start();
    for (let index = 0; index < 5; index += 1) {
      harness.localChange();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(harness.runs).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.runs).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.runs).toBe(1);
  });

  it('Test 7: fortlaufende Saves → spätestens nach 15 Sekunden', async () => {
    start();
    for (let elapsed = 0; elapsed < 15_000; elapsed += 2_000) {
      harness.localChange();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    // Der Nutzer speichert alle 2 s — die Entprellung allein käme nie zum Zug.
    expect(harness.runs).toBe(1);
  });

  it('Test 8: offline → keine Cloud-Anfrage', async () => {
    harness.online = false;
    start();
    harness.localChange();
    await vi.advanceTimersByTimeAsync(60_000);
    harness.documentEvents.dispatch('visibilitychange');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(harness.runs).toBe(0);
  });

  it('Test 9: offline gespeichert → online → automatischer Sync sofort', async () => {
    harness.online = false;
    start();
    harness.localChange();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.runs).toBe(0);
    harness.online = true;
    harness.windowEvents.dispatch('online');
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.runs).toBe(1);
  });

  it('Test 10: Fokus unter 30 Sekunden nach dem letzten Abgleich → kein Full Pull', async () => {
    start();
    await vi.advanceTimersByTimeAsync(29_000);
    harness.windowEvents.dispatch('focus');
    harness.documentEvents.dispatch('visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.runs).toBe(0);
  });

  it('Test 11: Fokus ab 30 Sekunden → Full Sync', async () => {
    start();
    await vi.advanceTimersByTimeAsync(30_000);
    harness.windowEvents.dispatch('focus');
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.runs).toBe(1);
    // Unmittelbar danach erneut Fokus: jetzt wieder unter 30 s.
    harness.documentEvents.dispatch('visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.runs).toBe(1);
  });

  it('Test 12: sichtbarer Tab → Abgleich alle 90 Sekunden', async () => {
    start();
    await vi.advanceTimersByTimeAsync(89_999);
    expect(harness.runs).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.runs).toBe(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(harness.runs).toBe(2);
  });

  it('Test 13: Tab im Hintergrund → kein Zeitgeber-Sync', async () => {
    start();
    harness.visible = false;
    harness.documentEvents.dispatch('visibilitychange');
    await vi.advanceTimersByTimeAsync(10 * 90_000);
    expect(harness.runs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // Wieder sichtbar und lange her → sofort ein Abgleich, danach wieder im Takt.
    harness.visible = true;
    harness.documentEvents.dispatch('visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.runs).toBe(1);
  });

  it('Test 14: keine parallelen Läufe — eine Änderung während des Laufs führt zu genau einem Folgelauf', async () => {
    harness.runDurationMs = 10_000;
    start();
    harness.localChange();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.runs).toBe(1);
    // Während des Laufs: Fokus, Online-Ereignis, Änderungen.
    await vi.advanceTimersByTimeAsync(1_000);
    harness.localChange();
    harness.windowEvents.dispatch('online');
    harness.localChange();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(harness.maxInFlight).toBe(1);
    // Folgelauf erst nach Ende des ersten, wieder entprellt.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.runs).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.maxInFlight).toBe(1);
    expect(harness.runs).toBe(2);
  });

  it('Test 15: vorübergehender Fehler → Wiederholung nach 5 / 15 / 45 / 120 s, danach Schluss', async () => {
    const netzfehler = report({ errorCount: 1, errors: [{ outboxId: 'coordinator', message: 'Failed to fetch' }] });
    harness.visible = false; // kein 90-s-Takt dazwischen
    harness.nextReports = [netzfehler, netzfehler, netzfehler, netzfehler, netzfehler];
    const s = start();
    harness.online = false;
    harness.online = true;
    harness.windowEvents.dispatch('online');
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.runs).toBe(1);

    const erwartet = [...SYNC_RETRY_DELAYS_MS];
    for (const [index, delay] of erwartet.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(harness.runs).toBe(1 + index);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.runs).toBe(2 + index);
    }
    expect(s.getStatus().retriesExhausted).toBe(true);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(harness.runs).toBe(5);
  });

  it('Retry-Jitter bleibt klein und nach oben begrenzt', async () => {
    harness.deps = { ...harness.deps, random: () => 1 };
    harness.visible = false;
    harness.nextReports = [report({ errorCount: 1, errors: [{ outboxId: 'coordinator', message: 'timeout' }] })];
    start();
    harness.windowEvents.dispatch('online');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.runs).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.runs).toBe(2);
  });

  it('Test 16: blockiert / Konflikt / Anmeldung / Prüfung / lokaler Speicherfehler → kein Auto-Retry', async () => {
    harness.visible = false;
    const blocked = outboxEntry({ id: 'o-blocked', status: 'blocked', lastErrorMessage: 'Versionskonflikt customer' });
    const faelle: Array<{ report: SyncCoordinatorReport; outbox: SyncOutboxEntry[] }> = [
      { report: report({ errorCount: 1, conflictCount: 1, errors: [{ outboxId: 'o-blocked', message: 'Versionskonflikt' }] }), outbox: [blocked] },
      { report: report({ errorCount: 1, errors: [{ outboxId: 'o-1', message: 'x' }] }), outbox: [outboxEntry({ lastErrorRetryable: false, lastErrorMessage: 'Keine Berechtigung' })] },
      { report: report({ errorCount: 1, errors: [{ outboxId: 'coordinator', message: 'JWT expired' }] }), outbox: [] },
      { report: report({ errorCount: 1, errors: [{ outboxId: 'coordinator', message: 'new row violates row-level security policy' }] }), outbox: [] },
      { report: report({ errorCount: 1, errors: [{ outboxId: 'o-1', message: 'invalid input syntax' }] }), outbox: [outboxEntry({ lastErrorMessage: 'invalid input syntax' })] },
      { report: report({ errorCount: 1, errors: [{ outboxId: 'local-persist', message: 'Lokale Sync-Persistenz fehlgeschlagen.' }] }), outbox: [] },
    ];
    for (const fall of faelle) {
      expect(classifySyncRun(fall.report, fall.outbox)).not.toBe('retryable');
    }

    harness.nextReports = [faelle[0].report];
    harness.outbox = faelle[0].outbox;
    const s = start();
    harness.windowEvents.dispatch('online');
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.runs).toBe(1);
    expect(s.getStatus().retryScheduled).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(harness.runs).toBe(1);
  });

  it('vorübergehende Fehler werden als wiederholbar erkannt', () => {
    expect(classifySyncRun(report({ errorCount: 1, errors: [{ outboxId: 'coordinator', message: 'Failed to fetch' }] }), [])).toBe('retryable');
    expect(classifySyncRun(report({ errorCount: 1, errors: [{ outboxId: 'o-1', message: '503' }] }), [outboxEntry({ lastErrorRetryable: true, lastErrorMessage: '503' })])).toBe('retryable');
    expect(classifySyncRun(report(), [])).toBe('ok');
  });

  it('veralteter Tab oder nicht bereiter Workspace → keine Anfrage', async () => {
    harness.canSync = false;
    start();
    harness.localChange();
    harness.windowEvents.dispatch('online');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(harness.runs).toBe(0);
  });

  it('Test 17: Web Lock pro Workspace + Benutzer verhindert parallele Tab-Syncs', async () => {
    const locks = new FakeLocks();
    const tabA = createHarness({ locks });
    const tabB = createHarness({ locks });
    let gemeinsamAktiv = 0;
    let gemeinsamMax = 0;
    for (const tab of [tabA, tabB]) {
      tab.deps = {
        ...tab.deps,
        runSync: async () => {
          tab.runs += 1;
          gemeinsamAktiv += 1;
          gemeinsamMax = Math.max(gemeinsamMax, gemeinsamAktiv);
          await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
          gemeinsamAktiv -= 1;
          return report();
        },
      };
    }
    const a = createSyncScheduler(OPTIONS, tabA.deps);
    const b = createSyncScheduler(OPTIONS, tabB.deps);
    try {
      tabA.windowEvents.dispatch('online');
      tabB.windowEvents.dispatch('online');
      await vi.advanceTimersByTimeAsync(0);
      expect(gemeinsamAktiv).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(gemeinsamAktiv).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(tabA.runs + tabB.runs).toBe(2);
      expect(gemeinsamMax).toBe(1);
      expect(new Set(locks.requested)).toEqual(new Set([buildSyncLockName('ws-01a', 'user-01a')]));
      expect(buildSyncLockName('ws-01a', 'user-01a')).toBe('officetakt-sync:ws-01a:user-01a');
      // Abgeschlossene Läufe werden an andere Tabs gemeldet.
      expect(tabA.channels[0].posted).toContainEqual(expect.objectContaining({ type: 'synced' }));
    } finally {
      a.stop();
      b.stop();
    }
  });

  it('ein anderer Tab hat eben abgeglichen → Fokus löst keinen Doppel-Pull aus', async () => {
    start();
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    // (der 90-s-Takt ist noch nicht dran)
    harness.channels[0].onmessage?.({ data: { type: 'synced', at: Date.now() } });
    harness.windowEvents.dispatch('focus');
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.runs).toBe(0);
  });

  it('Test 19: Stop (Abmeldung/Workspace-Wechsel) räumt Zeitgeber, Ereignisse und Kanal vollständig ab', async () => {
    const s = start();
    harness.localChange();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(harness.windowEvents.count()).toBeGreaterThan(0);
    expect(harness.documentEvents.count()).toBeGreaterThan(0);
    expect(harness.localChangeListeners.size).toBe(1);

    s.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.windowEvents.count()).toBe(0);
    expect(harness.documentEvents.count()).toBe(0);
    expect(harness.localChangeListeners.size).toBe(0);
    expect(harness.channels[0].closed).toBe(true);

    harness.localChange();
    harness.windowEvents.dispatch('online');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(harness.runs).toBe(0);
  });

  it('Stop während eines laufenden Laufs plant nichts mehr nach', async () => {
    harness.runDurationMs = 5_000;
    harness.nextReports = [report({ errorCount: 1, errors: [{ outboxId: 'coordinator', message: 'Failed to fetch' }] })];
    const s = start();
    harness.windowEvents.dispatch('online');
    await vi.advanceTimersByTimeAsync(1_000);
    harness.localChange();
    s.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(harness.runs).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('SYNC-AUTOMATIK-01A-FIX1 — Anlass bestimmt die Art des Laufs', () => {
  let harness: Harness;
  let scheduler: SyncScheduler | null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T10:00:00.000Z'));
    harness = createHarness();
    scheduler = null;
  });

  afterEach(() => {
    scheduler?.stop();
    vi.useRealTimers();
  });

  function start(): SyncScheduler {
    scheduler = createSyncScheduler(OPTIONS, harness.deps);
    return scheduler;
  }

  it('1+2: normaler Save → nach 3 s nur senden, kein vollständiger Abgleich', async () => {
    start();
    harness.localChange();
    await vi.advanceTimersByTimeAsync(3_000);
    expect({ push: harness.pushRuns, full: harness.fullRuns }).toEqual({ push: 1, full: 0 });
  });

  it('3: mehrere Saves → ein einziger Sendelauf', async () => {
    start();
    for (let index = 0; index < 4; index += 1) {
      harness.localChange();
      await vi.advanceTimersByTimeAsync(500);
    }
    await vi.advanceTimersByTimeAsync(3_000);
    expect({ push: harness.pushRuns, full: harness.fullRuns }).toEqual({ push: 1, full: 0 });
  });

  it('4: zweiter Save 6 s später → wieder nur senden', async () => {
    start();
    harness.localChange();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    harness.localChange();
    await vi.advanceTimersByTimeAsync(3_000);
    expect({ push: harness.pushRuns, full: harness.fullRuns }).toEqual({ push: 2, full: 0 });
  });

  it('Sendeläufe zählen nicht als vollständiger Abgleich (30-s-Regel bleibt ehrlich)', async () => {
    start();
    await vi.advanceTimersByTimeAsync(27_000);
    harness.localChange();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.pushRuns).toBe(1);
    // 30 s nach dem letzten *vollständigen* Abgleich: Fokus gleicht vollständig ab.
    harness.windowEvents.dispatch('focus');
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.fullRuns).toBe(1);
  });

  it('5: Reconnect → senden und vollständig abrufen', async () => {
    start();
    harness.windowEvents.dispatch('online');
    await vi.advanceTimersByTimeAsync(0);
    expect({ push: harness.pushRuns, full: harness.fullRuns }).toEqual({ push: 0, full: 1 });
  });

  it('6: Fokus ab 30 s → vollständiger Abgleich', async () => {
    start();
    await vi.advanceTimersByTimeAsync(30_000);
    harness.documentEvents.dispatch('visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect({ push: harness.pushRuns, full: harness.fullRuns }).toEqual({ push: 0, full: 1 });
  });

  it('7: 90-s-Takt → vollständiger Abgleich', async () => {
    start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect({ push: harness.pushRuns, full: harness.fullRuns }).toEqual({ push: 0, full: 1 });
  });

  it('Versionskonflikt beim Senden → gezielt ein vollständiger Abgleich, danach Ruhe', async () => {
    start();
    harness.nextPushNeedsFullSync = true;
    harness.localChange();
    await vi.advanceTimersByTimeAsync(3_000);
    expect({ push: harness.pushRuns, full: harness.fullRuns }).toEqual({ push: 1, full: 1 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.fullRuns).toBe(1);
  });

  it('Reconnect während eines Sendelaufs → danach vollständig, nicht nur senden', async () => {
    harness.runDurationMs = 2_000;
    start();
    harness.localChange();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.pushRuns).toBe(1);
    harness.windowEvents.dispatch('online');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.fullRuns).toBe(1);
    expect(harness.maxInFlight).toBe(1);
  });

  it('Wiederholung eines gescheiterten Sendelaufs bleibt ein Sendelauf', async () => {
    harness.visible = false;
    harness.nextReports = [report({ errorCount: 1, errors: [{ outboxId: 'coordinator', message: 'Failed to fetch' }] })];
    start();
    harness.localChange();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(SYNC_RETRY_DELAYS_MS[0]);
    expect({ push: harness.pushRuns, full: harness.fullRuns }).toEqual({ push: 2, full: 0 });
  });
});
