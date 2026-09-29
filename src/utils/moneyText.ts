/**
 * BROWSER-ACCEPTANCE-FIX 01 / C5 — erkannte Beträge einheitlich anzeigen.
 *
 * Die Erkennung liefert Rohtext („240,00 EUR", „70,51 €", „5.000,00 EUR").
 * Gespeichert bleibt er, wie er erkannt wurde; nur die Anzeige wird
 * vereinheitlicht — und nur, wenn der Text **sicher** ein Euro-Betrag in
 * deutscher Schreibweise ist:
 *
 *   * genau eine Währungsangabe (€, EUR oder Euro), vorn oder hinten
 *   * Zahl im deutschen Format: Tausenderpunkte nur in Dreiergruppen,
 *     höchstens zwei Nachkommastellen nach dem Komma
 *
 * Alles andere (ohne Währung, „240.00", „1,234.56", Text, mehrere Zahlen)
 * bleibt unverändert. Lieber roh als eine falsche Zahl.
 */
import { formatEuroAmount } from './displayFormat';

const CURRENCY = '(?:€|EUR|Euro)';
const GERMAN_NUMBER = '(\\d{1,3}(?:\\.\\d{3})+|\\d+)(?:,(\\d{1,2}))?';
const SAFE_EURO = new RegExp(
  `^(?:${CURRENCY}\\s*${GERMAN_NUMBER}|${GERMAN_NUMBER}\\s*${CURRENCY})$`,
  'i',
);

export function parseSafeEuroText(raw: string | null | undefined): number | null {
  const text = (raw ?? '').replace(/\u00a0/g, ' ').trim();
  const match = SAFE_EURO.exec(text);
  if (!match) return null;
  const integer = match[1] ?? match[3];
  const decimals = match[1] !== undefined ? match[2] : match[4];
  if (!integer) return null;
  const value = Number(`${integer.replace(/\./g, '')}.${(decimals ?? '0').padEnd(2, '0')}`);
  return Number.isFinite(value) ? value : null;
}

export function formatRecognizedMoneyText(raw: string): string {
  const value = parseSafeEuroText(raw);
  return value === null ? raw : formatEuroAmount(value);
}
