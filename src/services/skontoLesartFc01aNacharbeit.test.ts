/**
 * FC01A-Nacharbeit (A4) — die Skontofrist ist die Tagesangabe, die zum Skontosatz gehört.
 *
 * Gefunden in der Fachprüfung: Die Lesart nahm die erste Tagesangabe *nach* dem Satz. Bei
 * „Bei Zahlung innerhalb von 10 Tagen 2 % Skonto, sonst 30 Tage netto" waren das 30 Tage —
 * eine Zahlung am 25. Tag galt als fristgerechtes Skonto (Abschlag beglichen, keine Mahnung,
 * Umsatzsteuer der Schlussrechnung gemindert). Jetzt: Tagesangabe im selben Satz, keine
 * Nettofrist, unter mehreren die nächstliegende; über Satzgrenzen wird nichts zusammengesetzt.
 *
 * Dieselbe Beispieltabelle prüft `supabase/tests/fc01a_nacharbeit.sql` gegen den Server
 * (`workspace_skonto_terms`) — Client und Server lesen jeden Text gleich.
 */
import { describe, expect, it } from 'vitest';
import { parseSkontoFromText } from './invoiceTaxService';

const SKONTO_LESART_BEISPIELE: ReadonlyArray<readonly [string, { percent: number; days: number } | null]> = [
  ['Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.', { percent: 2, days: 10 }],
  ['Bei Zahlung innerhalb von 1 Tag gewähren wir 2 % Skonto.', { percent: 2, days: 1 }],
  ['3 % Skonto bei Zahlung innerhalb von 10 Tagen', { percent: 3, days: 10 }],
  ['2,5 % Skonto bei Zahlung innerhalb von 14 Tagen', { percent: 2.5, days: 14 }],
  // Der Befund: zwei Fristen — die Nettofrist ist nie die Skontofrist.
  ['Bei Zahlung innerhalb von 10 Tagen 2 % Skonto, sonst 30 Tage netto', { percent: 2, days: 10 }],
  ['30 Tage netto, 10 Tage 2 % Skonto', { percent: 2, days: 10 }],
  ['Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto. Zahlbar innerhalb von 30 Tagen ohne Abzug.', { percent: 2, days: 10 }],
  ['Zahlungsziel 30 Tage, bei Zahlung innerhalb 8 Tagen 3 % Skonto', { percent: 3, days: 8 }],
  ['Skonto: 2 % innerhalb von 8 Tagen, Zahlungsziel: 30 Tage netto', { percent: 2, days: 8 }],
  ['Zahlbar innerhalb 30 Tagen ohne Abzug oder innerhalb 10 Tagen mit 3 % Skonto', { percent: 3, days: 10 }],
  ['Bei Zahlung innerhalb von 10 Tagen 2 % Skonto, bei Zahlung innerhalb von 20 Tagen 1 % Skonto', { percent: 2, days: 10 }],
  // Geschützte Leerzeichen (aus einer Textverarbeitung kopiert) zählen wie normale.
  ['2 % Skonto bei Zahlung innerhalb von 10 Tagen', { percent: 2, days: 10 }],
  // Mehrzeilig: dieselbe Lesart im Client und im Server (bisher las der Server hier kein Skonto).
  ['Zahlbar innerhalb 30 Tagen netto.\nBei Zahlung innerhalb 10 Tagen 2 % Skonto.', { percent: 2, days: 10 }],
  // Kein belastbares Skonto — nichts wird geraten.
  ['14 Tage netto, 2,5 % Skonto', null],
  ['Zahlungsziel 30 Tage, 2 % Skonto', null],
  ['2 % Skonto.\nZahlbar innerhalb von 30 Tagen.', null],
  ['Zahlbar innerhalb von 30 Tagen. 2 % Skonto.', null],
  ['Bei Zahlung bis zum 15.10.2026 2 % Skonto', null],
  ['Tagung am Montag, 2 % Rabatt', null],
  ['2 % Skonto innerhalb 0 Tagen', null],
  ['0 % Skonto innerhalb 10 Tagen', null],
  ['2 %', null],
  ['10 Tage', null],
  ['', null],
];

describe('FC01A-Nacharbeit A4 — Skontosatz und Skontofrist gehören zusammen', () => {
  it.each(SKONTO_LESART_BEISPIELE)('%j', (text, erwartet) => {
    expect(parseSkontoFromText(text)).toEqual(erwartet);
  });
});
