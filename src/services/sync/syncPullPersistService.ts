import type { AppPersistedState } from '../../types/models';
import type { SyncCoordinatorReport } from '../../types/sync';
import type { OrderAmendmentIntentClearKey } from '../orderAmendment/orderAmendmentCloudPullMergeService';
import { clearOrderAmendmentConfirmIntents } from '../orderAmendment/orderAmendmentConfirmIntentService';
import { clearMatchedInvoiceFinalizeIntents } from '../invoice/invoiceCloudPullMergeService';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  captureBusinessContentBeforeSyncApply,
  getLocalMutationRevision,
  savePersistedState,
  seedSyncChangeTrackerFromCurrentStores,
} from '../persistenceService';
import { getSyncCoordinator } from './syncCoordinator';
import { getSyncOutboxSnapshot } from './syncOutboxService';
import { rebaseSyncCandidateOntoLocalChanges } from './syncLocalRebaseService';
import { reconcileInvoicePaymentTasks } from '../invoice/invoicePaymentTaskSync';

/**
 * SYNC-AUTOMATIK-01A — der lokale Stand beim Start eines Laufs.
 *
 * Ohne ihn lässt sich beim Anwenden nicht erkennen, ob inzwischen gespeichert
 * wurde. Wer einen Lauf über ein `await` hinweg führt, erfasst ihn **vor** dem
 * ersten `await`, im selben synchronen Abschnitt wie den Lauf-Snapshot.
 */
export interface SyncRunBase {
  state: AppPersistedState;
  revision: number;
}

export function captureSyncRunBase(): SyncRunBase {
  return { state: buildPersistedStateSnapshot(), revision: getLocalMutationRevision() };
}

export type ApplySyncPullCandidateResult = {
  persisted: boolean;
  report: SyncCoordinatorReport;
  /**
   * 01A — während des Laufs wurde lokal gespeichert; diese Änderungen sind
   * erhalten, aber noch nicht gesendet. Der Planer stösst einen Folgelauf an.
   */
  localChangesDuringRun?: boolean;
};

function clonePersistedState(state: AppPersistedState): AppPersistedState {
  return structuredClone(state);
}

function withReportError(
  report: SyncCoordinatorReport,
  outboxId: string,
  message: string,
  options?: { fatal?: boolean },
): SyncCoordinatorReport {
  const next: SyncCoordinatorReport = {
    ...report,
    errors: [...report.errors, { outboxId, message }],
  };
  if (options?.fatal !== false) {
    next.errorCount = report.errorCount + 1;
  }
  return next;
}

function withReportWarning(
  report: SyncCoordinatorReport,
  outboxId: string,
  message: string,
): SyncCoordinatorReport {
  // Clear failures are non-fatal: visible in errors[], do not bump errorCount / fail toast.
  return {
    ...report,
    errors: [...report.errors, { outboxId, message }],
  };
}

/**
 * ORDER-AMENDMENT-01B3B: apply pull candidate exactly once.
 * - hydrate stores + persist
 * - on persist failure: restore previous stores, no intent clears
 * - on success: clear invoice + amendment intents independently (clear failure = warning)
 */
export function applySyncPullCandidateSafely(input: {
  state: AppPersistedState;
  report: SyncCoordinatorReport;
  pendingInvoiceIntentClears?: string[];
  pendingAmendmentIntentClears?: OrderAmendmentIntentClearKey[];
  /** 01A — Stand beim Laufstart; fehlt er, gilt der bisherige Weg. */
  base?: SyncRunBase;
}): ApplySyncPullCandidateResult {
  const coordinator = getSyncCoordinator();
  const previous = clonePersistedState(buildPersistedStateSnapshot());
  let report = { ...input.report, errors: [...input.report.errors] };

  /**
   * OUTBOX-PRESERVE-ON-PULL-01 — die lokale Outbox ist Zustellungswahrheit und
   * darf beim Anwenden eines Cloud-Kandidaten nicht rückwärts laufen.
   *
   * `applyStateToStores` ersetzt sie über `hydrateSyncOutbox` vollständig durch
   * die des Kandidaten. Der Kandidat entsteht aber deutlich früher: Zwischen
   * seinem Aufbau und diesem Aufruf liegen mehrere `await`s des Pull-Pfads
   * (Nachträge, Rechnungen, Dokumente). Jeder Eintrag, der in diesem Fenster
   * entsteht — ein soeben angelegter Kunde, ein neuer Vorgang —, verschwände
   * sonst lautlos: Die Fachdaten blieben sichtbar, ihr Versandauftrag nicht.
   *
   * Der Snapshot wird deshalb **hier** gelesen, unmittelbar vor dem Anwenden.
   * Zwischen dieser Zeile und `applyStateToStores` liegt bewusst kein `await`,
   * sodass in diesem Abschnitt kein Eintrag dazwischenkommen kann.
   *
   * **Nur ergänzen, nicht ersetzen** — und die Richtung ist wichtig: Für
   * Einträge, die der Kandidat kennt, ist **er** der neuere Stand. Der Push
   * dieses Laufs markiert `completed` und `blocked` ausschliesslich in seiner
   * eigenen Kopie; `acknowledgeChanges` schreibt sie nicht in den Store. Würde
   * der Store gewinnen, ginge jedes Push-Ergebnis verloren und bereits
   * gesendete Einträge liefen endlos erneut.
   *
   * Übernommen werden deshalb genau die Einträge, die der Kandidat **nicht**
   * kennt: die im `await`-Fenster neu hinzugekommenen.
   *
   * Bewusst nur hier und nicht in `applyStateToStores`: Backup-Wiederherstellung,
   * Notfall-Import und Bootstrap wenden absichtlich eine fremde Outbox an.
   */
  /*
   * SYNC-AUTOMATIK-01A — wurde seit dem Laufstart lokal gespeichert, trägt der
   * Speicher neuere Fachdaten als der Kandidat. Dann wird der Kandidat auf den
   * aktuellen Stand gesetzt statt ihn zu ersetzen — auch hier ohne `await`
   * zwischen Lesen und Anwenden.
   */
  const localChangesDuringRun =
    input.base !== undefined && input.base.revision !== getLocalMutationRevision();
  let stateToApply: AppPersistedState;
  if (localChangesDuringRun) {
    stateToApply = rebaseSyncCandidateOntoLocalChanges({
      base: input.base!.state,
      local: previous,
      candidate: input.state,
    }).state;
  } else {
    const candidateOutbox = input.state.syncOutbox ?? [];
    const knownOutboxIds = new Set(candidateOutbox.map((outboxEntry) => outboxEntry.id));
    const addedDuringPull = getSyncOutboxSnapshot().filter(
      (outboxEntry) => !knownOutboxIds.has(outboxEntry.id),
    );
    stateToApply = {
      ...input.state,
      syncOutbox: [...candidateOutbox, ...addedDuringPull],
    };
  }

  try {
    // 01A-FIX3 — ob die Übernahme fachlich etwas ändert, entscheidet der Vergleich der Speicher.
    const businessContentBefore = captureBusinessContentBeforeSyncApply();
    applyStateToStores(stateToApply);
    const saved = savePersistedState(stateToApply, { businessContentBefore });
    if (!saved) {
      applyStateToStores(previous);
      const message = 'Lokale Sync-Persistenz fehlgeschlagen.';
      report = withReportError(report, 'local-persist', message);
      coordinator.markLocalPersistFailed(message, report);
      return { persisted: false, report };
    }
    /**
     * REAL-DEVICE-CLOUD-COMPANY-TRACKER-ECHO-FIX-01 — erst nach bestätigter
     * Persistierung: die Tracker-Baseline muss den tatsächlich hydrierten
     * Store-Zustand abbilden, nicht den rohen Remote-Kandidaten. Sonst meldet
     * der nächste `persistAll()` die reine Normalisierung als Firmenänderung.
     * Im Fehlerfall stellt `applyStateToStores(previous)` die Baseline
     * unverändert wieder her — `previous` stammt bereits aus
     * `buildPersistedStateSnapshot()` und ist damit normalisiert.
     */
    seedSyncChangeTrackerFromCurrentStores();
  } catch (error) {
    try {
      applyStateToStores(previous);
    } catch {
      /* best-effort rollback */
    }
    const message =
      error instanceof Error
        ? error.message
        : 'Lokale Sync-Persistenz fehlgeschlagen.';
    report = withReportError(report, 'local-persist', message);
    coordinator.markLocalPersistFailed(message, report);
    return { persisted: false, report };
  }

  const invoiceKeys = input.pendingInvoiceIntentClears ?? [];
  const amendmentKeys = input.pendingAmendmentIntentClears ?? [];

  try {
    clearMatchedInvoiceFinalizeIntents(invoiceKeys);
  } catch (error) {
    report = withReportWarning(
      report,
      'invoice-intent-clear-warning',
      error instanceof Error
        ? error.message
        : 'Invoice-Finalize-Intents konnten nach Persistenz nicht gelöscht werden.',
    );
  }

  try {
    clearOrderAmendmentConfirmIntents(amendmentKeys);
  } catch (error) {
    report = withReportWarning(
      report,
      'amendment-intent-clear-warning',
      error instanceof Error
        ? error.message
        : 'Nachtrags-Confirm-Intents konnten nach Persistenz nicht gelöscht werden.',
    );
  }

  /*
   * P0/P1-INTEGRITAET 01B / P1 — Zahlungen oder Stornos, die erst mit diesem
   * Abgleich sichtbar wurden (anderes Gerät), schliessen ihre
   * Überfälligkeitsaufgabe hier: nach bestätigter Persistenz und gesetzter
   * Tracker-Baseline, damit die Erledigung als normale Änderung übertragen wird.
   * 02B: ebenso eine Rücknahme auf einem anderen Gerät (neue Episode) und ein
   * neuer Stand nach Teilzahlung.
   */
  try {
    reconcileInvoicePaymentTasks();
  } catch (error) {
    report = withReportWarning(
      report,
      'payment-task-reconcile-warning',
      error instanceof Error
        ? error.message
        : 'Überfälligkeitsaufgaben bezahlter Rechnungen konnten nicht geschlossen werden.',
    );
  }

  coordinator.publishLastReport(report);
  return { persisted: true, report, localChangesDuringRun };
}
