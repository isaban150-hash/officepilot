/**
 * BANKABGLEICH-V1 BLOCK 1 — Kontoauszug einlesen und verstehen.
 *
 * Geprueft wird, was der Nutzer am Ende sieht: wie viele Bewegungen erkannt
 * wurden, in welche Richtung sie gehen, und welche Zeilen ehrlich als
 * „nicht verstanden" ausgewiesen werden statt still zu verschwinden.
 */
import { describe, expect, it } from 'vitest';
import { parseBankAmountToCents } from './bankAmountParse';
import {
  decodeBankStatementBytes,
  detectDelimiter,
  parseBankStatementCsv,
  splitCsv,
} from './bankStatementCsvService';

const KOPF_SEMIKOLON = 'Buchungstag;Wertstellung;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;IBAN;Betrag';

function csv(...zeilen: string[]): string {
  return zeilen.join('\n');
}

function erfolg(text: string, name = 'auszug.csv') {
  const ergebnis = parseBankStatementCsv(text, name);
  if (!ergebnis.ok) throw new Error(`Erwartet: lesbar, bekam: ${ergebnis.problem}`);
  return ergebnis.preview;
}

/* ====================================================================== */
describe('A — CSV-Grundlagen', () => {
  it('A1 — Semikolon getrennt', () => {
    const preview = erfolg(
      csv(KOPF_SEMIKOLON, '04.10.2026;04.10.2026;Mueller Bau;Rechnung RE-1;DE02;1.234,56'),
    );
    expect(preview.delimiter).toBe(';');
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]?.amountCents).toBe(123456);
  });

  it('A2 — Komma getrennt, wenn eindeutig', () => {
    const preview = erfolg(csv('Datum,Name,Verwendungszweck,Betrag', '04.10.2026,Mueller Bau,Miete,123.45'));
    expect(preview.delimiter).toBe(',');
    expect(preview.rows[0]?.amountCents).toBe(12345);
  });

  it('A3 — Trennzeichen innerhalb von Anfuehrungszeichen bleibt Text', () => {
    const preview = erfolg(
      csv(KOPF_SEMIKOLON, '04.10.2026;04.10.2026;Mueller Bau;"Rechnung 1; Rechnung 2";DE02;100,00'),
    );
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]?.purpose).toBe('Rechnung 1; Rechnung 2');
  });

  it('A4 — doppeltes Anfuehrungszeichen ist ein Zeichen', () => {
    const preview = erfolg(
      csv(KOPF_SEMIKOLON, '04.10.2026;04.10.2026;Firma;"Projekt ""Nord""";DE02;100,00'),
    );
    expect(preview.rows[0]?.purpose).toBe('Projekt "Nord"');
  });

  it('A5 — BOM am Dateianfang stoert die Kopfzeile nicht', () => {
    const inhalt = csv(KOPF_SEMIKOLON, '04.10.2026;04.10.2026;Firma;Zweck;DE02;100,00');
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(inhalt)]);
    const text = decodeBankStatementBytes(bytes);
    expect(text).not.toBeNull();
    expect(erfolg(text!).rows).toHaveLength(1);
  });

  it('A6 — Leerzeilen werden uebergangen, nicht als Fehler gemeldet', () => {
    const preview = erfolg(
      csv(KOPF_SEMIKOLON, '', '04.10.2026;04.10.2026;Firma;Zweck;DE02;100,00', '', ''),
    );
    expect(preview.rows).toHaveLength(1);
    expect(preview.issues).toEqual([]);
  });

  it('A7 — CRLF liest sich wie LF', () => {
    const preview = erfolg(
      [KOPF_SEMIKOLON, '04.10.2026;04.10.2026;Firma;Zweck;DE02;100,00'].join('\r\n'),
    );
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]?.counterparty).toBe('Firma');
  });

  it('A8 — Windows-1252 wird gelesen, wenn es kein gueltiges UTF-8 ist', () => {
    /* 0xFC ist „ü" in Windows-1252 und allein kein gueltiges UTF-8. */
    const bytes = new Uint8Array([...new TextEncoder().encode('M'), 0xfc, ...new TextEncoder().encode('ller')]);
    expect(decodeBankStatementBytes(bytes)).toBe('Müller');
  });

  it('A9 — splitCsv und detectDelimiter einzeln', () => {
    expect(splitCsv('a;b\nc;d', ';')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(detectDelimiter('a;b;c')).toBe(';');
    expect(detectDelimiter('a,b,c')).toBe(',');
    expect(detectDelimiter('nur eine spalte')).toBeNull();
  });
});

/* ====================================================================== */
describe('B — Betraege', () => {
  it('B1 — deutsche Schreibweise', () => {
    expect(parseBankAmountToCents('123,45')).toBe(12345);
    expect(parseBankAmountToCents('1.234,56')).toBe(123456);
  });

  it('B2 — negative Betraege in allen ueblichen Schreibweisen', () => {
    expect(parseBankAmountToCents('-123,45')).toBe(-12345);
    expect(parseBankAmountToCents('-1.234,56')).toBe(-123456);
    expect(parseBankAmountToCents('123,45-')).toBe(-12345);
    expect(parseBankAmountToCents('(123,45)')).toBe(-12345);
  });

  it('B3 — Punkt als Dezimaltrenner', () => {
    expect(parseBankAmountToCents('123.45')).toBe(12345);
    expect(parseBankAmountToCents('-123.45')).toBe(-12345);
    expect(parseBankAmountToCents('1,234.56')).toBe(123456);
  });

  it('B4 — Tausenderpunkt ohne Cent bleibt Tausender', () => {
    /* `1.234` ist eintausendzweihundertvierunddreissig, nicht 1,234 Euro. */
    expect(parseBankAmountToCents('1.234')).toBe(123400);
    expect(parseBankAmountToCents('1234')).toBe(123400);
  });

  it('B5 — Waehrungshinweis und Leerzeichen stoeren nicht', () => {
    expect(parseBankAmountToCents('1.234,56 €')).toBe(123456);
    expect(parseBankAmountToCents('1 234,56')).toBe(123456);
    expect(parseBankAmountToCents(' 100,00 EUR ')).toBe(10000);
  });

  it('B6 — Unlesbares bleibt unlesbar statt geraten', () => {
    expect(parseBankAmountToCents('')).toBeNull();
    expect(parseBankAmountToCents('abc')).toBeNull();
    expect(parseBankAmountToCents('12,3456')).toBeNull();
    expect(parseBankAmountToCents('1.23.45')).toBeNull();
    expect(parseBankAmountToCents('12-34')).toBeNull();
    expect(parseBankAmountToCents(null)).toBeNull();
  });
});

/* ====================================================================== */
describe('C — Datum', () => {
  it('C1 — TT.MM.JJJJ und ISO ergeben denselben Tag', () => {
    const deutsch = erfolg(csv(KOPF_SEMIKOLON, '04.10.2026;;Firma;Zweck;;100,00'));
    const iso = erfolg(csv(KOPF_SEMIKOLON, '2026-10-04;;Firma;Zweck;;100,00'));
    expect(deutsch.rows[0]?.bookingDate).toBe('2026-10-04');
    expect(iso.rows[0]?.bookingDate).toBe('2026-10-04');
  });

  it('C2 — unlesbares Datum macht die Zeile zur Pruefzeile, nicht zur Luege', () => {
    const preview = erfolg(
      csv(KOPF_SEMIKOLON, 'demnaechst;;Firma;Zweck;;100,00', '04.10.2026;;Firma2;Zweck;;50,00'),
    );
    expect(preview.rows).toHaveLength(1);
    expect(preview.issues).toHaveLength(1);
    expect(preview.issues[0]).toMatchObject({ rowNumber: 2, problem: 'date_unreadable' });
  });

  it('C3 — Wertstellung wird uebernommen, wenn lesbar', () => {
    const preview = erfolg(csv(KOPF_SEMIKOLON, '04.10.2026;06.10.2026;Firma;Zweck;;100,00'));
    expect(preview.rows[0]?.valueDate).toBe('2026-10-06');
  });
});

/* ====================================================================== */
describe('D — Spaltenerkennung', () => {
  it('D1 — typische Bezeichnungsvarianten werden gefunden', () => {
    const preview = erfolg(csv('Buchungsdatum;Auftraggeber;Buchungstext;Umsatz', '04.10.2026;Firma;Zweck;100,00'));
    expect(preview.columns.bookingDate).toBe('Buchungsdatum');
    expect(preview.columns.counterparty).toBe('Auftraggeber');
    expect(preview.columns.purpose).toBe('Buchungstext');
    expect(preview.columns.amount).toBe('Umsatz');
  });

  it('D2 — Buchungstag gewinnt gegen ein allgemeines Datum', () => {
    const preview = erfolg(csv('Datum;Buchungstag;Betrag', '01.01.2026;04.10.2026;100,00'));
    expect(preview.columns.bookingDate).toBe('Buchungstag');
    expect(preview.rows[0]?.bookingDate).toBe('2026-10-04');
  });

  it('D3 — fehlendes Buchungsdatum wird benannt, nicht geraten', () => {
    const ergebnis = parseBankStatementCsv(csv('Verwendungszweck;Betrag', 'Zweck;100,00'), 'x.csv');
    expect(ergebnis).toMatchObject({ ok: false, problem: 'missing_required_column', detail: 'bookingDate' });
  });

  it('D4 — fehlender Betrag wird benannt', () => {
    const ergebnis = parseBankStatementCsv(csv('Buchungstag;Verwendungszweck', '04.10.2026;Zweck'), 'x.csv');
    expect(ergebnis).toMatchObject({ ok: false, problem: 'missing_required_column', detail: 'amount' });
  });

  it('D5 — gar keine erkennbare Kopfzeile', () => {
    const ergebnis = parseBankStatementCsv(csv('alpha;beta;gamma', '1;2;3'), 'x.csv');
    expect(ergebnis).toMatchObject({ ok: false, problem: 'no_header' });
  });

  it('D6 — ohne Trennzeichen', () => {
    expect(parseBankStatementCsv('nur eine zeile ohne trenner', 'x.csv')).toMatchObject({
      ok: false,
      problem: 'no_delimiter',
    });
  });

  it('D7 — optionale Spalten duerfen fehlen', () => {
    const preview = erfolg(csv('Buchungstag;Betrag', '04.10.2026;100,00'));
    expect(preview.rows[0]?.counterparty).toBeUndefined();
    expect(preview.rows[0]?.purpose).toBeUndefined();
    expect(preview.rows[0]?.counterpartyIban).toBeUndefined();
    expect(preview.columns.valueDate).toBeUndefined();
  });

  it('D8 — getrennte Soll-/Haben-Spalten ergeben ein Vorzeichen', () => {
    const preview = erfolg(
      csv('Buchungstag;Name;Verwendungszweck;Soll;Haben', '04.10.2026;Firma;Zweck;;1.000,00', '05.10.2026;Firma;Zweck;250,00;'),
    );
    expect(preview.rows[0]?.amountCents).toBe(100000);
    expect(preview.rows[1]?.amountCents).toBe(-25000);
  });
});

/* ====================================================================== */
describe('E — Bewegungen', () => {
  it('E1 — Eingang und Ausgang behalten ihr Vorzeichen', () => {
    const preview = erfolg(
      csv(
        KOPF_SEMIKOLON,
        '04.10.2026;04.10.2026;Kunde Nord;Zahlung RE-2026-014;DE11;2.380,00',
        '05.10.2026;05.10.2026;Baustoff GmbH;Eingangsrechnung;DE22;-1.190,50',
      ),
    );
    expect(preview.rows[0]?.amountCents).toBe(238000);
    expect(preview.rows[1]?.amountCents).toBe(-119050);
  });

  it('E2 — Gegenpartei, Zweck und IBAN werden uebernommen', () => {
    const preview = erfolg(
      csv(KOPF_SEMIKOLON, '04.10.2026;04.10.2026;Kunde Nord;Zahlung RE-14;DE89370400440532013000;100,00'),
    );
    expect(preview.rows[0]).toMatchObject({
      counterparty: 'Kunde Nord',
      purpose: 'Zahlung RE-14',
      counterpartyIban: 'DE89370400440532013000',
    });
  });

  it('E3 — zu kurze Zeile wird gemeldet, nicht halb uebernommen', () => {
    const preview = erfolg(
      csv(KOPF_SEMIKOLON, '04.10.2026;04.10.2026;Firma', '05.10.2026;05.10.2026;Firma;Zweck;DE02;100,00'),
    );
    expect(preview.rows).toHaveLength(1);
    expect(preview.issues[0]).toMatchObject({ rowNumber: 2, problem: 'column_count_mismatch' });
  });

  it('E4 — unlesbarer Betrag macht die Zeile zur Pruefzeile', () => {
    const preview = erfolg(
      csv(KOPF_SEMIKOLON, '04.10.2026;;Firma;Zweck;;keine Ahnung', '05.10.2026;;Firma;Zweck;;100,00'),
    );
    expect(preview.rows).toHaveLength(1);
    expect(preview.issues[0]).toMatchObject({ problem: 'amount_unreadable' });
  });

  it('E5 — gueltige Zeilen bleiben trotz Problemzeilen sichtbar', () => {
    const preview = erfolg(
      csv(
        KOPF_SEMIKOLON,
        '04.10.2026;;A;Zweck;;100,00',
        'kaputt;;B;Zweck;;100,00',
        '06.10.2026;;C;Zweck;;-50,00',
      ),
    );
    expect(preview.rows).toHaveLength(2);
    expect(preview.issues).toHaveLength(1);
  });

  it('E6 — Zeilennummern entsprechen der Datei inklusive Kopfzeile', () => {
    const preview = erfolg(csv(KOPF_SEMIKOLON, '04.10.2026;;A;Zweck;;100,00', 'kaputt;;B;Zweck;;100,00'));
    expect(preview.rows[0]?.rowNumber).toBe(2);
    expect(preview.issues[0]?.rowNumber).toBe(3);
  });
});

/* ====================================================================== */
describe('F — Dubletten innerhalb der Datei', () => {
  it('F1 — identische Bewegungen werden markiert, nicht entfernt', () => {
    const preview = erfolg(
      csv(
        KOPF_SEMIKOLON,
        '04.10.2026;;Vermieter;Miete Oktober;;-800,00',
        '04.10.2026;;Vermieter;Miete Oktober;;-800,00',
      ),
    );
    /* Beide bleiben sichtbar — zwei echte gleiche Buchungen gibt es wirklich. */
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows.every((row) => row.possibleDuplicate)).toBe(true);
    expect(preview.duplicateCount).toBe(2);
  });

  it('F2 — unterschiedlicher Zweck ist keine Dublette', () => {
    const preview = erfolg(
      csv(
        KOPF_SEMIKOLON,
        '04.10.2026;;Vermieter;Miete Oktober;;-800,00',
        '04.10.2026;;Vermieter;Nebenkosten;;-800,00',
      ),
    );
    expect(preview.rows.some((row) => row.possibleDuplicate)).toBe(false);
    expect(preview.duplicateCount).toBe(0);
  });

  it('F3 — gleicher Betrag am gleichen Tag bei anderer Gegenpartei bleibt eigenstaendig', () => {
    const preview = erfolg(
      csv(KOPF_SEMIKOLON, '04.10.2026;;Kunde A;Zahlung;;500,00', '04.10.2026;;Kunde B;Zahlung;;500,00'),
    );
    expect(preview.duplicateCount).toBe(0);
  });
});
