/**
 * FINANZ-CORE-01A (Bericht 20) — welche Buchungsmonate ein Sendeauftrag berührt (`SyncOutboxEntry.affectedMonths`).
 *
 * Die Abschlusssperre liest die Monate eines unbestätigten Auftrags aus den Fakten (Belegdatum, Zahlungsdatum).
 * Manche Aufträge haben ihren alten Monat danach nicht mehr in der Hand: Eine Datumsänderung verschiebt den Beleg,
 * eine Rücknahme entfernt die Zahlung lokal. Deshalb merkt sich der Auftrag beim Einreihen, welche Monate er
 * berührt. Leicht und ohne Fachimporte — Änderungsverfolger und Zahlungsdienste nutzen es ohne Zyklus.
 */
import { toBusinessDay } from '../businessDateService';

const MONAT = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `YYYY-MM` eines Datums (`YYYY-MM-DD…`), sonst `null`. */
export function bookingMonthOf(date: string | null | undefined): string | null {
  const month = (date ?? '').slice(0, 7);
  return MONAT.test(month) ? month : null;
}

/** Geschäftsmonat eines Zeitstempels (Storno, Rücknahme). */
export function businessMonthOf(timestamp: string | null | undefined): string | null {
  return timestamp ? bookingMonthOf(toBusinessDay(timestamp)) : null;
}

/** Vereinigte, sortierte Monate; ohne gültigen Monat `undefined` (das Feld bleibt dann weg). */
export function affectedMonthsOf(...months: (string | null | undefined)[]): string[] | undefined {
  const valid = [...new Set(months.filter((month): month is string => typeof month === 'string' && MONAT.test(month)))].sort();
  return valid.length > 0 ? valid : undefined;
}

/** Buchungsmonate eines Belegs: Belegdatum und Storno (Geschäftstag). Zahlungen reisen als eigene Aufträge. */
export function expenseBookingMonths(expense: { issueDate?: string; cancelledAt?: string } | undefined): (string | null)[] {
  if (!expense) return [];
  return [bookingMonthOf(expense.issueDate), businessMonthOf(expense.cancelledAt)];
}
