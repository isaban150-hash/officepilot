/**
 * MANUAL-INVOICE-UI-01B1B — die Freigabe-Regeln, die eine Seite dem Nutzer
 * zeigt: der Steuer-Blocker und die Übersetzung eines Coordinator-Ausgangs in
 * Hinweis + Sperrverhalten.
 *
 * Herausgezogen aus `RechnungPage`, damit die Rechnung ohne Auftrag exakt
 * dieselben Regeln bekommt — keine zweite, abweichende Fassung. Rein: kein
 * Zustand, kein Store, kein Toast; die Seite entscheidet nur noch, **wo** sie
 * den Hinweis zeigt.
 */
import type { StartInvoiceDraftFinalizationResult } from './invoiceFinalizationCoordinator';
import type { TaxStatus } from '../../types/models';
import type { TranslationKey } from '../../i18n';

/**
 * Was die Steuerentscheidung noch blockiert. `unclear` ist keine Entscheidung;
 * §13b verlangt die ausdrückliche Bestätigung — nie eine gespeicherte oder
 * rekonstruierte Auswahl. Bewusst keine zweite, abweichende Regel.
 */
export function taxDecisionBlocker(
  taxStatus: TaxStatus,
  reverseCharge13bConfirmed: boolean,
): TranslationKey | null {
  if (taxStatus === 'unclear') return 'invoice.validation.taxStatus';
  if (taxStatus === 'reverse_charge_13b' && !reverseCharge13bConfirmed) {
    return 'invoice.validation.reverseChargeConfirmRequired';
  }
  return null;
}

export interface FinalizationFailureUx {
  /** Der Hinweis für den Nutzer — nie ein technischer Grund. */
  messageKey: TranslationKey;
  /**
   * Ob die Freigabe wieder geöffnet werden darf. Nur bei ausdrücklich
   * erlaubter Wiederholung oder nachweislich nicht übertragenem Zustand
   * (`cloudState === 'not_committed'`). Alles andere — `confirmed`, `conflict`,
   * vor allem `unknown` — bleibt gesperrt: Dort könnte serverseitig bereits
   * eine Rechnung liegen, und ein zweiter Versuch erzeugte eine zweite.
   */
  unlock: boolean;
  /** Der Nutzer muss neu laden, damit der Wiederaufnahmeweg greift. */
  reloadRequired: boolean;
}

export function mapFinalizationFailureToUx(
  result: Extract<StartInvoiceDraftFinalizationResult, { ok: false }>,
): FinalizationFailureUx {
  let messageKey: TranslationKey;
  if (result.reason === 'offline_or_unconfigured') {
    messageKey = 'invoice.approve.offline';
  } else if (result.reason === 'auth_missing') {
    messageKey = 'invoice.approve.auth';
  } else if (
    result.reason === 'workspace_missing' ||
    result.reason === 'workspace_changed' ||
    result.reason === 'scope_mismatch'
  ) {
    messageKey = 'invoice.approve.workspace';
  } else if (
    result.reason === 'conflict' ||
    result.reason === 'idempotency_conflict' ||
    result.reason === 'possible_existing_invoice'
  ) {
    messageKey = 'invoice.approve.conflict';
  } else if (result.reason === 'local_persist_failed' || result.reason === 'persist_failed') {
    messageKey = 'invoice.approve.localPersistPending';
  } else {
    messageKey = 'invoice.approve.failed';
  }

  const unlock = result.recovery === 'retry_allowed' || result.cloudState === 'not_committed';
  return { messageKey, unlock, reloadRequired: result.recovery === 'reload_required' };
}
