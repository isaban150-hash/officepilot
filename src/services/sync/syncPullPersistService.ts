import type { AppPersistedState } from '../../types/models';
import type { SyncCoordinatorReport } from '../../types/sync';
import type { OrderAmendmentIntentClearKey } from '../orderAmendment/orderAmendmentCloudPullMergeService';
import { clearOrderAmendmentConfirmIntents } from '../orderAmendment/orderAmendmentConfirmIntentService';
import { clearMatchedInvoiceFinalizeIntents } from '../invoice/invoiceCloudPullMergeService';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  savePersistedState,
  seedSyncChangeTrackerFromCurrentStores,
} from '../persistenceService';
import { getSyncCoordinator } from './syncCoordinator';
import { getSyncOutboxSnapshot } from './syncOutboxService';

export type ApplySyncPullCandidateResult = {
  persisted: boolean;
  report: SyncCoordinatorReport;
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
  const candidateOutbox = input.state.syncOutbox ?? [];
  const knownOutboxIds = new Set(candidateOutbox.map((outboxEntry) => outboxEntry.id));
  const addedDuringPull = getSyncOutboxSnapshot().filter(
    (outboxEntry) => !knownOutboxIds.has(outboxEntry.id),
  );
  const stateToApply: AppPersistedState = {
    ...input.state,
    syncOutbox: [...candidateOutbox, ...addedDuringPull],
  };

  try {
    applyStateToStores(stateToApply);
    const saved = savePersistedState(stateToApply);
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

  coordinator.publishLastReport(report);
  return { persisted: true, report };
}
