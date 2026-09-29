/**
 * SYNC-AUTOMATIK-01A — der zentrale Planer für automatische Synchronisation.
 *
 * Keine zweite Sync-Engine: Ein vollständiger Lauf ist `runSyncFromUi`, ein
 * reiner Sendelauf `pushPendingChangesFromUi` — beide über dieselbe Queue
 * (`runQueuedSyncOperation`), denselben Coordinator und denselben sicheren
 * Apply-Weg, der lokale Änderungen aus dem Lauf-Fenster erhält
 * (`syncLocalRebaseService`). Der Planer entscheidet nur, **wann** und
 * **welcher** Lauf beginnt.
 *
 * Auslöser:
 *   1. Lokale Speicherung: 3 s Ruhe (trailing debounce), spätestens nach 15 s.
 *      Nur senden, kein vollständiger Abruf (01A-FIX1). Ausnahme: Das Senden
 *      stösst auf einen Versionskonflikt — dann folgt gezielt ein
 *      vollständiger Abgleich, weil erst er den Cloud-Stand zur Entscheidung
 *      liefert.
 *   2. Offline → online: sofort (Push der wartenden Änderungen, dann Pull).
 *   3. App-Start/Anmeldung: bleibt beim Bootstrap; der Planer startet danach
 *      und zählt diesen Lauf als letzten vollständigen Abgleich.
 *   4. Tab sichtbar/fokussiert: nur, wenn der letzte vollständige Abgleich
 *      mindestens 30 s zurückliegt.
 *   5. Alle 90 s — nur online, sichtbar und mit bereitem Workspace. Im
 *      Hintergrund läuft kein Zeitgeber.
 *   6. Mehrere Tabs: `navigator.locks` pro Workspace und Benutzer; ein Tab
 *      wartet, bis der andere fertig ist. `BroadcastChannel` meldet
 *      abgeschlossene Läufe. Keine selbstgebaute localStorage-Zeitsperre.
 *
 * Wiederholen: nur bei vorübergehenden Fehlern, nach 5 / 15 / 45 / 120 s,
 * danach nicht mehr automatisch. Konflikte, blockierte Aufträge, fehlende
 * Anmeldung oder Berechtigung, Prüffehler und lokale Speicherfehler werden nie
 * automatisch wiederholt — sie brauchen eine Entscheidung oder ein Neuladen.
 */
import type { SyncCoordinatorReport, SyncOutboxEntry } from '../../types/sync';

export const SYNC_DEBOUNCE_MS = 3_000;
export const SYNC_MAX_WAIT_MS = 15_000;
export const SYNC_FOCUS_MIN_INTERVAL_MS = 30_000;
export const SYNC_PERIODIC_INTERVAL_MS = 90_000;
export const SYNC_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000, 120_000];
/** Höchstens so viel Anteil wird zufällig aufgeschlagen, damit Tabs/Geräte nicht gleichzeitig wiederholen. */
const RETRY_JITTER_RATIO = 0.1;

export type SyncTrigger = 'change' | 'reconnect' | 'focus' | 'periodic' | 'retry' | 'escalate';

/** 01A-FIX1 — `push`: nur wartende Änderungen senden. `full`: senden, dann vollständig abrufen. */
export type SyncRunMode = 'push' | 'full';

export function syncModeForTrigger(trigger: Exclude<SyncTrigger, 'retry'>): SyncRunMode {
  return trigger === 'change' ? 'push' : 'full';
}

export interface PushOnlyRunResult {
  report: SyncCoordinatorReport;
  /** Das Senden ist auf einen Versionskonflikt gestossen. */
  needsFullSync: boolean;
}

export type SyncRunOutcome = 'ok' | 'retryable' | 'stop';

export interface SyncSchedulerStatus {
  running: boolean;
  /** Wartet eine lokale Änderung auf den nächsten Lauf (Entprellung)? */
  changeQueued: boolean;
  /** Ist eine automatische Wiederholung geplant? */
  retryScheduled: boolean;
  /** Wurden alle automatischen Wiederholungen aufgebraucht? */
  retriesExhausted: boolean;
  lastOutcome: SyncRunOutcome | null;
  lastFullSyncAt: number | null;
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

interface ChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

interface EventSourceLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface SyncSchedulerDeps {
  /** Vollständiger Lauf: senden, dann abrufen. */
  runSync: () => Promise<SyncCoordinatorReport>;
  /** Nur senden (Anlass: lokale Änderung). */
  runPushOnly: () => Promise<PushOnlyRunResult>;
  /** Der Sendestand nach dem Lauf — für die Einordnung der Fehler. */
  getOutbox: () => SyncOutboxEntry[];
  subscribeLocalChanges: (listener: () => void) => () => void;
  isOnline: () => boolean;
  isVisible: () => boolean;
  /** Angemeldet, Workspace bereit, Speicher schreibbar, dieser Tab nicht veraltet. */
  canSync: () => boolean;
  now: () => number;
  random: () => number;
  windowTarget: EventSourceLike | null;
  documentTarget: EventSourceLike | null;
  locks: LockManagerLike | null;
  createChannel: ((name: string) => ChannelLike | null) | null;
}

export interface SyncSchedulerOptions {
  userId: string;
  workspaceId: string;
}

export interface SyncScheduler {
  stop(): void;
  getStatus(): SyncSchedulerStatus;
  subscribe(listener: (status: SyncSchedulerStatus) => void): () => void;
  /** Für die Tests und die Einordnung: der Lock-Name dieses Planers. */
  readonly lockName: string;
}

export function buildSyncLockName(workspaceId: string, userId: string): string {
  return `officetakt-sync:${workspaceId}:${userId}`;
}

const NON_RETRYABLE_MESSAGE =
  /auth|jwt|token|anmeld|401|403|permission|berechtig|forbidden|not allowed|nicht erlaubt|row-level security|rls|valid|ungültig|22p02|23514|23502|konfigur|configured|beta/i;

/**
 * Das Ergebnis eines Laufs einordnen. Bewusst vorsichtig: Nur was eindeutig
 * vorübergehend ist, wird wiederholt.
 */
export function classifySyncRun(report: SyncCoordinatorReport, outbox: SyncOutboxEntry[]): SyncRunOutcome {
  const failedEntries = outbox.filter((entry) => entry.status === 'error' || entry.status === 'failed');
  // Ein Versionskonflikt ist kein Fehler, sondern eine offene Entscheidung — nie wiederholen.
  const blockedIds = new Set(outbox.filter((entry) => entry.status === 'blocked').map((entry) => entry.id));
  const hardErrors = report.errors.filter(
    (error) =>
      error.outboxId !== 'invoice-intent-clear-warning' &&
      error.outboxId !== 'amendment-intent-clear-warning' &&
      !blockedIds.has(error.outboxId),
  );
  if (failedEntries.length === 0 && (report.errorCount === 0 || hardErrors.length === 0)) return 'ok';

  // Lokaler Speicher (auch: veralteter Tab) — wiederholen hilft nicht.
  if (hardErrors.some((error) => error.outboxId === 'local-persist' || error.outboxId === 'adapter')) return 'stop';
  if (hardErrors.some((error) => NON_RETRYABLE_MESSAGE.test(error.message))) return 'stop';
  if (failedEntries.some((entry) => entry.lastErrorRetryable === false)) {
    // Gemischt: solange ein vorübergehender Fehler dabei ist, lohnt der nächste Versuch.
    return failedEntries.some((entry) => entry.lastErrorRetryable !== false) ? 'retryable' : 'stop';
  }
  if (failedEntries.some((entry) => NON_RETRYABLE_MESSAGE.test(entry.lastErrorMessage ?? ''))) return 'stop';
  return 'retryable';
}

export function createSyncScheduler(options: SyncSchedulerOptions, deps: SyncSchedulerDeps): SyncScheduler {
  const lockName = buildSyncLockName(options.workspaceId, options.userId);
  const listeners = new Set<(status: SyncSchedulerStatus) => void>();
  const cleanups: Array<() => void> = [];

  let stopped = false;
  let running = false;
  /** Während eines Laufs angefallener Anlass; `full` hat Vorrang vor `push`. */
  let followUp: SyncRunMode | null = null;
  /** Welche Art der zuletzt gescheiterte Lauf war — die Wiederholung bleibt dabei. */
  let retryMode: SyncRunMode = 'full';
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let periodicTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryIndex = 0;
  let retriesExhausted = false;
  let lastOutcome: SyncRunOutcome | null = null;
  // Der Bootstrap hat soeben vollständig abgeglichen (Auslöser 3).
  let lastFullSyncAt: number | null = deps.now();

  function status(): SyncSchedulerStatus {
    return {
      running,
      changeQueued: debounceTimer !== null || maxWaitTimer !== null,
      retryScheduled: retryTimer !== null,
      retriesExhausted,
      lastOutcome,
      lastFullSyncAt,
    };
  }

  function publish(): void {
    const snapshot = status();
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        /* Anzeigefehler berühren den Planer nicht */
      }
    }
  }

  function clearChangeTimers(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    if (maxWaitTimer !== null) clearTimeout(maxWaitTimer);
    debounceTimer = null;
    maxWaitTimer = null;
  }

  function clearRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function mayContactCloud(): boolean {
    return !stopped && deps.isOnline() && deps.canSync();
  }

  function scheduleRetry(): void {
    clearRetry();
    if (retryIndex >= SYNC_RETRY_DELAYS_MS.length) {
      retriesExhausted = true;
      return;
    }
    const base = SYNC_RETRY_DELAYS_MS[retryIndex];
    const delay = base + Math.floor(base * RETRY_JITTER_RATIO * Math.max(0, Math.min(1, deps.random())));
    retryIndex += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void requestRun('retry');
    }, delay);
  }

  function withLock<T>(run: () => Promise<T>): Promise<T> {
    // Wartet, bis ein anderer Tab desselben Workspace/Benutzers fertig ist.
    return deps.locks ? deps.locks.request(lockName, run) : run();
  }

  function mergeFollowUp(mode: SyncRunMode): void {
    followUp = followUp === 'full' || mode === 'full' ? 'full' : 'push';
  }

  async function requestRun(trigger: SyncTrigger): Promise<void> {
    if (stopped) return;
    const mode: SyncRunMode = trigger === 'retry' ? retryMode : syncModeForTrigger(trigger);
    if (running) {
      // Nie parallel: der laufende Lauf zieht einen Folgelauf nach sich.
      if (trigger === 'change' || trigger === 'reconnect' || trigger === 'escalate') mergeFollowUp(mode);
      return;
    }
    if (!mayContactCloud()) return;

    // Ein vollständiger Lauf sendet auch; eine wartende Änderung ist damit erledigt.
    if (mode === 'full' || trigger === 'change') clearChangeTimers();
    if (trigger !== 'retry') clearRetry();
    running = true;
    followUp = null;
    publish();

    let outcome: SyncRunOutcome;
    let escalate = false;
    try {
      if (mode === 'push') {
        const result = await withLock(() => deps.runPushOnly());
        outcome = classifySyncRun(result.report, deps.getOutbox());
        escalate = result.needsFullSync;
      } else {
        const report = await withLock(() => deps.runSync());
        outcome = classifySyncRun(report, deps.getOutbox());
      }
    } catch {
      outcome = 'retryable';
    }
    running = false;
    if (stopped) return;
    lastOutcome = outcome;

    if (outcome === 'ok') {
      retryIndex = 0;
      retriesExhausted = false;
      clearRetry();
      if (mode === 'full') {
        // Nur ein vollständiger Abgleich zählt für die 30-s-Regel und für andere Tabs.
        lastFullSyncAt = deps.now();
        channel?.postMessage({ type: 'synced', at: lastFullSyncAt });
      }
    } else if (outcome === 'retryable') {
      retryMode = mode;
      scheduleRetry();
    } else {
      // Entscheidung oder Neuladen nötig — kein automatischer Versuch.
      clearRetry();
    }
    publish();

    if (stopped) return;
    if (escalate) mergeFollowUp('full');
    const next = followUp;
    followUp = null;
    if (next === 'full') {
      // Reconnect oder Konflikt während des Laufs: jetzt vollständig abgleichen.
      void requestRun(escalate ? 'escalate' : 'reconnect');
    } else if (next === 'push') {
      // Während des Laufs gespeichert: wieder normal entprellen.
      onLocalChange();
    }
  }

  function onLocalChange(): void {
    if (stopped) return;
    if (running) {
      mergeFollowUp('push');
      return;
    }
    // Offline: nichts planen, keine Anfrage. Der Wechsel zu online holt es nach.
    if (!deps.isOnline()) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void requestRun('change');
    }, SYNC_DEBOUNCE_MS);
    if (maxWaitTimer === null) {
      maxWaitTimer = setTimeout(() => {
        maxWaitTimer = null;
        void requestRun('change');
      }, SYNC_MAX_WAIT_MS);
    }
    publish();
  }

  function startPeriodic(): void {
    if (periodicTimer !== null || stopped) return;
    periodicTimer = setInterval(() => {
      if (!deps.isVisible() || !deps.isOnline()) return;
      if (retryTimer !== null) return; // die Wiederholung hat ihren eigenen Takt
      void requestRun('periodic');
    }, SYNC_PERIODIC_INTERVAL_MS);
  }

  function stopPeriodic(): void {
    if (periodicTimer !== null) clearInterval(periodicTimer);
    periodicTimer = null;
  }

  function onOnline(): void {
    retryIndex = 0;
    retriesExhausted = false;
    clearRetry();
    void requestRun('reconnect');
    if (deps.isVisible()) startPeriodic();
  }

  function onOffline(): void {
    clearChangeTimers();
    clearRetry();
    publish();
  }

  function onVisibleOrFocus(): void {
    if (!deps.isVisible()) {
      // Im Hintergrund kein Zeitgeber.
      stopPeriodic();
      return;
    }
    if (deps.isOnline()) startPeriodic();
    const elapsed = lastFullSyncAt === null ? Infinity : deps.now() - lastFullSyncAt;
    if (elapsed >= SYNC_FOCUS_MIN_INTERVAL_MS) void requestRun('focus');
  }

  const channel = deps.createChannel ? deps.createChannel(lockName) : null;
  if (channel) {
    channel.onmessage = (event) => {
      const data = event.data as { type?: string; at?: number } | null;
      // Ein anderer Tab hat eben vollständig abgeglichen: kein sofortiger Doppel-Pull beim Fokus.
      if (data?.type === 'synced' && typeof data.at === 'number') {
        lastFullSyncAt = Math.max(lastFullSyncAt ?? 0, data.at);
      }
    };
    cleanups.push(() => {
      channel.onmessage = null;
      channel.close();
    });
  }

  cleanups.push(deps.subscribeLocalChanges(onLocalChange));
  if (deps.windowTarget) {
    const target = deps.windowTarget;
    target.addEventListener('online', onOnline);
    target.addEventListener('offline', onOffline);
    target.addEventListener('focus', onVisibleOrFocus);
    cleanups.push(() => {
      target.removeEventListener('online', onOnline);
      target.removeEventListener('offline', onOffline);
      target.removeEventListener('focus', onVisibleOrFocus);
    });
  }
  if (deps.documentTarget) {
    const target = deps.documentTarget;
    target.addEventListener('visibilitychange', onVisibleOrFocus);
    cleanups.push(() => target.removeEventListener('visibilitychange', onVisibleOrFocus));
  }
  if (deps.isVisible() && deps.isOnline()) startPeriodic();

  return {
    lockName,
    stop() {
      if (stopped) return;
      stopped = true;
      clearChangeTimers();
      clearRetry();
      stopPeriodic();
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch {
          /* Aufräumen bleibt vollständig */
        }
      }
      listeners.clear();
    },
    getStatus: status,
    subscribe(listener) {
      listeners.add(listener);
      listener(status());
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
