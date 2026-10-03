/**
 * R1-SEC-01 — die serverseitigen Ablehnungen finanzwirksamer Aktionen, in
 * Nutzersprache übersetzbar.
 *
 * Der Server weist eine Finanzaktion mit einem stabilen Code ab
 * (`finance_forbidden_role`, `finance_account_blocked`, …). Dieser Code ist für
 * Menschen nicht gemacht: Er enthält englische Bezeichner und steht in einer
 * PostgreSQL-Fehlermeldung. Angezeigt wird deshalb nie der Rohtext, sondern ein
 * Satz, der sagt, **was zu tun ist**.
 *
 * Alle fünf Fälle sind endgültig: Ein erneuter Versuch mit demselben Konto
 * ändert nichts. Wer sie als wiederholbar einstuft, baut eine Endlosschleife —
 * dieselbe Falle wie bei der Geldintegrität in 05B2.
 */
import type { TranslationKey } from '../../i18n';

export type FinancialActionDenial =
  /** Rolle `member`: mitarbeiten ja, über Geld entscheiden nein. */
  | 'forbidden_role'
  /** Konto gesperrt. */
  | 'account_blocked'
  /** Konto noch nicht freigegeben (Registrierung wartet auf Prüfung). */
  | 'account_not_approved'
  /** Lizenz abgelaufen — oder ihr Ablaufdatum liegt in der Vergangenheit. */
  | 'license_expired'
  /** Keine aktive Lizenz hinterlegt. */
  | 'license_inactive';

const CODES: ReadonlyArray<readonly [string, FinancialActionDenial]> = [
  ['finance_forbidden_role', 'forbidden_role'],
  ['finance_account_blocked', 'account_blocked'],
  ['finance_account_not_approved', 'account_not_approved'],
  ['finance_license_expired', 'license_expired'],
  ['finance_license_inactive', 'license_inactive'],
];

/**
 * Erkennt eine Autorisierungsablehnung in einer Servermeldung.
 *
 * `null` heisst: Das ist keine Ablehnung dieser Art — der Aufrufer behandelt
 * den Fehler wie bisher.
 */
export function detectFinancialActionDenial(
  message: string | null | undefined,
): FinancialActionDenial | null {
  if (!message) return null;
  for (const [code, denial] of CODES) {
    if (message.includes(code)) return denial;
  }
  return null;
}

export function isFinancialActionDenial(message: string | null | undefined): boolean {
  return detectFinancialActionDenial(message) !== null;
}

export function financialActionDenialLabelKey(denial: FinancialActionDenial): TranslationKey {
  return `financeGuard.${denial}` as TranslationKey;
}
