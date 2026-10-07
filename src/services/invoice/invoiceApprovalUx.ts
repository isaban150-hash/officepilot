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
import {
  detectFinancialActionDenial,
  financialActionDenialLabelKey,
} from '../auth/financialActionDenial';

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
  } else if (result.reason === 'draft_not_synced') {
    // CLOUD-SYNC S5 — der Entwurf ist noch nicht vollständig in der Cloud; nichts wurde begonnen.
    messageKey = 'invoiceDraftCloud.approve.notSynced';
  } else if (result.reason === 'draft_conflict') {
    messageKey = 'invoiceDraftCloud.approve.conflict';
  } else if (result.reason === 'draft_ended') {
    messageKey = 'invoiceDraftCloud.approve.ended';
  } else if (result.reason === 'draft_binding_rejected') {
    // CLOUD-SYNC S5 — anderswo geändert oder verworfen; nachweislich keine Rechnung erstellt.
    messageKey = 'invoiceDraftCloud.approve.changedElsewhere';
  } else if (result.reason === 'draft_finalized_elsewhere') {
    // CLOUD-SYNC S5 — ein anderes Gerät hat diesen Entwurf bereits freigegeben; keine zweite Rechnung.
    messageKey = 'invoiceDraftCloud.approve.finalizedElsewhere';
  } else if (
    result.reason === 'pull_incomplete' ||
    result.reason === 'pull_failed' ||
    result.reason === 'merge_conflict'
  ) {
    /*
     * RECHNUNGSINTEGRITAET-03B2 — der Preflight ist fail-closed: Solange der
     * Abgleich mit der Cloud unvollständig ist, kennt OfficeTakt den aktuellen
     * Abrechnungsstand nicht und gibt nichts frei. Das ist richtig — nur hiess
     * es bisher „Freigabe fehlgeschlagen", und der Nutzer stand ohne Hinweis da.
     */
    messageKey = 'invoice.approve.syncIncomplete';
  } else if (result.reason === 'quantity_exceeds_available') {
    /*
     * RECHNUNGSINTEGRITAET-03B — der Server kennt den aktuellen
     * Abrechnungsstand; ein zweites Gerät kann die Menge inzwischen verbraucht
     * haben. Die Meldung sagt, was zu tun ist, statt nur zu scheitern.
     */
    messageKey = 'invoice.approve.quantityExceeded';
  } else if (result.reason === 'financial_action_denied') {
    /*
     * R1-SEC-01 Nacharbeit 1 — der Server hat die Freigabe nicht erlaubt. Der
     * allgemeine Satz „Freigabe fehlgeschlagen" liess offen, woran es lag; der
     * Nutzer konnte fehlende Berechtigung, nicht freigegebenes Konto und
     * abgelaufene Lizenz nicht unterscheiden.
     *
     * Der Grund steht bereits in `result.message` (dem rohen Servertext) und
     * wird mit **derselben** zentralen Klassifikation gelesen wie überall
     * sonst — keine zweite Fehlerlogik. Angezeigt wird nie der Rohtext,
     * sondern der vorhandene Satz zu diesem Grund.
     */
    const denial = detectFinancialActionDenial(result.message);
    messageKey = denial
      ? financialActionDenialLabelKey(denial)
      : 'invoice.approve.notAllowed';
  } else if (result.reason === 'server_integrity_rejected') {
    messageKey = 'invoice.approve.serverRejected';
  } else if (result.reason === 'local_persist_failed' || result.reason === 'persist_failed') {
    messageKey = 'invoice.approve.localPersistPending';
  } else {
    messageKey = 'invoice.approve.failed';
  }

  const unlock = result.recovery === 'retry_allowed' || result.cloudState === 'not_committed';
  return { messageKey, unlock, reloadRequired: result.recovery === 'reload_required' };
}
