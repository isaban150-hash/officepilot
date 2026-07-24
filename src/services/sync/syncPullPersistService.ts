import type { AppPersistedState } from '../../types/models';
import type { SyncCoordinatorReport } from '../../types/sync';
import type { OrderAmendmentIntentClearKey } from '../orderAmendment/orderAmendmentCloudPullMergeService';
import { clearOrderAmendmentConfirmIntents } from '../orderAmendment/orderAmendmentConfirmIntentService';
import { clearMatchedInvoiceFinalizeIntents } from '../invoice/invoiceCloudPullMergeService';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  savePersistedState,
} from '../persistenceService';
import { getSyncCoordinator } from './syncCoordinator';

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

  try {
    applyStateToStores(input.state);
    const saved = savePersistedState(input.state);
    if (!saved) {
      applyStateToStores(previous);
      const message = 'Lokale Sync-Persistenz fehlgeschlagen.';
      report = withReportError(report, 'local-persist', message);
      coordinator.markLocalPersistFailed(message, report);
      return { persisted: false, report };
    }
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
