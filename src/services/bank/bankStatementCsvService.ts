/**
 * BANKABGLEICH-V1 BLOCK 1 — einen Kontoauszug als CSV lesen und verstehen.
 *
 * OfficeTakt konnte CSV bisher nur **schreiben** (Buchungsexport für den
 * Steuerberater). Gelesen wurde nie eine Tabelle. Dieser Dienst ist der erste
 * Leser und bewusst eng gefasst: typische deutsche Bankexporte, eine
 * Kopfzeile, ein Trennzeichen. Was er nicht sicher versteht, lehnt er ab und
 * sagt warum — er rät nicht.
 *
 * Nichts hier speichert etwas. Das Ergebnis ist eine Vorschau, die mit dem
 * Verlassen der Seite verschwindet.
 */
import { toCanonicalIsoDay } from '../../utils/documentDateDisplay';
import { parseBankAmountToCents } from './bankAmountParse';
import { normalizeAccountIdentifier } from './bankAccountStore';
import type {
  BankStatementColumnMapping,
  BankStatementParseResult,
  BankStatementRow,
  BankStatementRowIssue,
} from '../../types/bankStatement';

/* -------------------------------------------------------------------------- */
/* Zeichensatz                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Deutsche Bankexporte kommen in UTF-8 oder in Windows-1252. Beide sind
 * unterscheidbar, ohne zu raten: UTF-8 wird **streng** dekodiert, und nur wenn
 * das fehlschlägt, ist es keine gültige UTF-8-Datei — dann bleibt
 * Windows-1252, der einzige andere in der Praxis vorkommende Fall.
 *
 * Bewusst keine Häufigkeitsanalyse über Umlaute: Eine Heuristik, die sich
 * irrt, liefert stillschweigend „MÃ¼ller" statt „Müller" — und bei
 * Gegenparteien ist das später ein falscher Abgleich.
 */
export function decodeBankStatementBytes(bytes: Uint8Array): string | null {
  let nutzBytes = bytes;
  /* UTF-8-BOM gehört nicht zum Inhalt. */
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    nutzBytes = bytes.subarray(3);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(nutzBytes);
  } catch {
    /* Kein gültiges UTF-8 — der zweite und letzte Versuch. */
  }

  try {
    return new TextDecoder('windows-1252', { fatal: true }).decode(nutzBytes);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Zerlegt den Text in Zeilen aus Feldern — mit korrektem Quoting.
 *
 * Innerhalb von `"…"` ist ein Trennzeichen Text, ein Zeilenumbruch gehört zum
 * Feld, und `""` ist ein Anführungszeichen. Ohne diese Regel zerfällt jeder
 * Verwendungszweck mit Semikolon in zwei Spalten.
 */
export function splitCsv(text: string, delimiter: string): string[][] {
  const zeilen: string[][] = [];
  let felder: string[] = [];
  let feld = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const zeichen = text[i];

    if (inQuotes) {
      if (zeichen === '"') {
        if (text[i + 1] === '"') {
          feld += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        feld += zeichen;
      }
      continue;
    }

    if (zeichen === '"') {
      inQuotes = true;
    } else if (zeichen === delimiter) {
      felder.push(feld);
      feld = '';
    } else if (zeichen === '\r') {
      /* CRLF: das \n übernimmt den Zeilenwechsel. */
    } else if (zeichen === '\n') {
      felder.push(feld);
      zeilen.push(felder);
      felder = [];
      feld = '';
    } else {
      feld += zeichen;
    }
  }

  if (feld !== '' || felder.length > 0) {
    felder.push(feld);
    zeilen.push(felder);
  }

  return zeilen;
}

/**
 * Semikolon oder Komma — entschieden an der Kopfzeile, nicht geraten.
 *
 * Gezählt wird außerhalb von Anführungszeichen, und das Trennzeichen muss die
 * Kopfzeile in mindestens zwei Spalten teilen. Bei Gleichstand gewinnt das
 * Semikolon: Es ist in deutschen Exporten die Regel, und ein Komma erscheint
 * dort meist als Dezimaltrenner.
 */
export function detectDelimiter(kopfzeile: string): ';' | ',' | null {
  const zaehle = (zeichen: string): number => {
    let anzahl = 0;
    let inQuotes = false;
    for (let i = 0; i < kopfzeile.length; i += 1) {
      const c = kopfzeile[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === zeichen && !inQuotes) anzahl += 1;
    }
    return anzahl;
  };

  const semikolon = zaehle(';');
  const komma = zaehle(',');
  if (semikolon === 0 && komma === 0) return null;
  return semikolon >= komma ? ';' : ',';
}

/* -------------------------------------------------------------------------- */
/* Spalten                                                                     */
/* -------------------------------------------------------------------------- */

/** Vergleichsform einer Überschrift: ohne Zierrat, damit „Betrag (EUR)" trifft. */
function normalisiereKopf(wert: string): string {
  return wert
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Die Überschriften, die deutsche Banken tatsächlich schreiben.
 *
 * Reihenfolge ist Rangfolge: Die erste Übereinstimmung gewinnt. Deshalb steht
 * `buchungstag` vor `datum` — wo eine Datei beides führt, ist der Buchungstag
 * gemeint und nicht irgendein Datum.
 */
const SPALTEN: Record<keyof BankStatementColumnMapping, string[]> = {
  bookingDate: ['buchungstag', 'buchungsdatum', 'belegdatum', 'datum'],
  /*
   * BLOCK 2 — das **eigene** Konto. Sparkassen- und VR-Exporte fuehren es als
   * ``Auftragskonto``. Bewusst nicht ``Kontonummer``: Dort steht in denselben
   * Exporten das Konto der **Gegenpartei**, und eine Verwechslung wuerde jede
   * Bewegung dem falschen Konto zuordnen.
   */
  ownAccount: ['auftragskonto', 'eigeneskonto', 'eigeneiban', 'kontoinhaberiban'],
  valueDate: ['wertstellung', 'valuta', 'valutadatum', 'wertstellungstag'],
  amount: ['betrag', 'umsatz', 'betrageur', 'umsatzeur', 'betragineur'],
  debit: ['soll', 'belastung', 'auszahlung'],
  credit: ['haben', 'gutschrift', 'einzahlung'],
  counterparty: [
    'beguenstigterzahlungspflichtiger',
    'zahlungspflichtiger',
    'zahlungsempfaenger',
    'beguenstigter',
    'auftraggeber',
    'empfaenger',
    'namezahlungsbeteiligter',
    'beguenstigterauftraggeber',
    'name',
  ],
  counterpartyIban: ['ibanzahlungsbeteiligter', 'ibangegenpartei', 'gegenkontoiban', 'iban', 'gegenkonto', 'kontonummer'],
  purpose: ['verwendungszweck', 'buchungstext', 'beschreibung', 'vorgangverwendungszweck', 'verwendungszwecke'],
  bankReference: ['kundenreferenz', 'mandatsreferenz', 'bankreferenz', 'endtoendreferenz', 'referenz'],
};

function findeSpalte(kopf: string[], kandidaten: string[]): number {
  const normalisiert = kopf.map(normalisiereKopf);
  for (const kandidat of kandidaten) {
    const treffer = normalisiert.indexOf(kandidat);
    if (treffer !== -1) return treffer;
  }
  return -1;
}

/* -------------------------------------------------------------------------- */
/* Dublettenhinweis innerhalb der Datei                                        */
/* -------------------------------------------------------------------------- */

/**
 * Ein Fingerabdruck über die fachlichen Felder einer Bewegung.
 *
 * Zwei echte gleiche Buchungen am selben Tag gibt es wirklich — zwei
 * Monatsmieten, zwei gleiche Abschläge. Sie werden deshalb **markiert und
 * nicht entfernt**. Block 1 entscheidet nichts, er zeigt nur, was auffällt.
 */
function fingerabdruck(row: BankStatementRow): string {
  const leise = (wert: string | undefined): string =>
    (wert ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return [row.bookingDate, String(row.amountCents), leise(row.counterparty), leise(row.purpose)].join('|');
}

/* -------------------------------------------------------------------------- */
/* Einlesen                                                                    */
/* -------------------------------------------------------------------------- */

const AUSZUG_LAENGE = 120;

function feld(zeile: string[], index: number): string {
  if (index < 0) return '';
  return (zeile[index] ?? '').trim();
}

/** Nur übernehmen, was wirklich dasteht — ein leeres Feld ist kein leerer Text. */
function optional(wert: string): string | undefined {
  return wert ? wert : undefined;
}

export function parseBankStatementCsv(text: string, fileName: string): BankStatementParseResult {
  if (!text.trim()) {
    return { ok: false, problem: 'no_rows' };
  }

  const ersteZeile = text.split(/\r?\n/).find((zeile) => zeile.trim().length > 0) ?? '';
  const delimiter = detectDelimiter(ersteZeile);
  if (!delimiter) {
    return { ok: false, problem: 'no_delimiter' };
  }

  const zeilen = splitCsv(text, delimiter).filter(
    (zeile) => zeile.some((wert) => wert.trim().length > 0),
  );
  if (zeilen.length === 0) {
    return { ok: false, problem: 'no_rows' };
  }

  const kopf = (zeilen[0] ?? []).map((wert) => wert.trim());
  const indizes = {
    bookingDate: findeSpalte(kopf, SPALTEN.bookingDate),
    ownAccount: findeSpalte(kopf, SPALTEN.ownAccount),
    valueDate: findeSpalte(kopf, SPALTEN.valueDate),
    amount: findeSpalte(kopf, SPALTEN.amount),
    debit: findeSpalte(kopf, SPALTEN.debit),
    credit: findeSpalte(kopf, SPALTEN.credit),
    counterparty: findeSpalte(kopf, SPALTEN.counterparty),
    counterpartyIban: findeSpalte(kopf, SPALTEN.counterpartyIban),
    purpose: findeSpalte(kopf, SPALTEN.purpose),
    bankReference: findeSpalte(kopf, SPALTEN.bankReference),
  };

  /*
   * Ohne erkannte Überschriften ist die Datei keine Kopfzeilen-CSV. Auf
   * Spaltenpositionen auszuweichen hiesse raten — und dann steht irgendwann
   * ein Datum im Betragsfeld.
   */
  const kopfErkannt =
    indizes.bookingDate !== -1 ||
    indizes.amount !== -1 ||
    indizes.purpose !== -1 ||
    indizes.counterparty !== -1;
  if (!kopfErkannt) {
    return { ok: false, problem: 'no_header' };
  }

  if (indizes.bookingDate === -1) {
    return { ok: false, problem: 'missing_required_column', detail: 'bookingDate' };
  }

  /* Entweder eine Betragsspalte oder ein Soll/Haben-Paar — sonst fehlt das Geld. */
  const hatSollHaben = indizes.debit !== -1 && indizes.credit !== -1;
  if (indizes.amount === -1 && !hatSollHaben) {
    return { ok: false, problem: 'missing_required_column', detail: 'amount' };
  }

  const columns: BankStatementColumnMapping = {
    bookingDate: kopf[indizes.bookingDate] ?? '',
    ...(indizes.ownAccount !== -1 ? { ownAccount: kopf[indizes.ownAccount] } : {}),
    ...(indizes.valueDate !== -1 ? { valueDate: kopf[indizes.valueDate] } : {}),
    ...(indizes.amount !== -1 ? { amount: kopf[indizes.amount] } : {}),
    ...(hatSollHaben ? { debit: kopf[indizes.debit], credit: kopf[indizes.credit] } : {}),
    ...(indizes.counterparty !== -1 ? { counterparty: kopf[indizes.counterparty] } : {}),
    ...(indizes.counterpartyIban !== -1 ? { counterpartyIban: kopf[indizes.counterpartyIban] } : {}),
    ...(indizes.purpose !== -1 ? { purpose: kopf[indizes.purpose] } : {}),
    ...(indizes.bankReference !== -1 ? { bankReference: kopf[indizes.bankReference] } : {}),
  };

  const rows: BankStatementRow[] = [];
  const issues: BankStatementRowIssue[] = [];

  for (let i = 1; i < zeilen.length; i += 1) {
    const zeile = zeilen[i] ?? [];
    /* 1-basiert und inklusive Kopfzeile — so zählt auch das Tabellenprogramm. */
    const rowNumber = i + 1;
    const auszug = zeile.join(delimiter).slice(0, AUSZUG_LAENGE);

    if (zeile.length < kopf.length) {
      issues.push({ rowNumber, problem: 'column_count_mismatch', excerpt: auszug });
      continue;
    }

    const bookingDate = toCanonicalIsoDay(feld(zeile, indizes.bookingDate));
    if (!bookingDate) {
      issues.push({ rowNumber, problem: 'date_unreadable', excerpt: auszug });
      continue;
    }

    let amountCents: number | null;
    if (indizes.amount !== -1) {
      amountCents = parseBankAmountToCents(feld(zeile, indizes.amount));
    } else {
      /*
       * Getrennte Soll-/Haben-Spalten: Genau eine der beiden trägt einen Wert.
       * Soll ist ein Abgang und wird negativ — unabhängig davon, ob die Bank
       * dort selbst ein Minus schreibt.
       */
      const sollRoh = feld(zeile, indizes.debit);
      const habenRoh = feld(zeile, indizes.credit);
      const soll = sollRoh ? parseBankAmountToCents(sollRoh) : null;
      const haben = habenRoh ? parseBankAmountToCents(habenRoh) : null;
      if (soll !== null && haben !== null) amountCents = null;
      else if (soll !== null) amountCents = -Math.abs(soll);
      else if (haben !== null) amountCents = Math.abs(haben);
      else amountCents = null;
    }

    if (amountCents === null) {
      issues.push({ rowNumber, problem: 'amount_unreadable', excerpt: auszug });
      continue;
    }

    const valueDate = indizes.valueDate !== -1 ? toCanonicalIsoDay(feld(zeile, indizes.valueDate)) : null;

    rows.push({
      id: `row-${rowNumber}`,
      rowNumber,
      bookingDate,
      ...(valueDate ? { valueDate } : {}),
      amountCents,
      ...(optional(feld(zeile, indizes.counterparty)) ? { counterparty: feld(zeile, indizes.counterparty) } : {}),
      ...(optional(feld(zeile, indizes.counterpartyIban))
        ? { counterpartyIban: feld(zeile, indizes.counterpartyIban) }
        : {}),
      ...(optional(feld(zeile, indizes.purpose)) ? { purpose: feld(zeile, indizes.purpose) } : {}),
      ...(optional(feld(zeile, indizes.bankReference))
        ? { bankReference: feld(zeile, indizes.bankReference) }
        : {}),
    });
  }

  if (rows.length === 0 && issues.length === 0) {
    return { ok: false, problem: 'no_rows' };
  }

  /* Dublettenhinweis: alle Beteiligten markieren, keine entfernen. */
  const nachFingerabdruck = new Map<string, BankStatementRow[]>();
  for (const row of rows) {
    const schluessel = fingerabdruck(row);
    const gruppe = nachFingerabdruck.get(schluessel);
    if (gruppe) gruppe.push(row);
    else nachFingerabdruck.set(schluessel, [row]);
  }
  let duplicateCount = 0;
  for (const gruppe of nachFingerabdruck.values()) {
    if (gruppe.length < 2) continue;
    duplicateCount += gruppe.length;
    for (const row of gruppe) row.possibleDuplicate = true;
  }

  /*
   * Der Kontoschluessel gilt fuer die ganze Datei: Ein Kontoauszug ist der
   * Auszug **eines** Kontos. Gelesen wird die erste gefuellte Zelle der
   * Auftragskonto-Spalte; fehlt die Spalte, bleibt der Schluessel leer.
   */
  let accountKey = '';
  if (indizes.ownAccount !== -1) {
    for (let i = 1; i < zeilen.length; i += 1) {
      const wert = feld(zeilen[i] ?? [], indizes.ownAccount);
      if (wert) {
        accountKey = normalizeAccountIdentifier(wert);
        break;
      }
    }
  }

  return {
    ok: true,
    preview: { fileName, accountKey, delimiter, columns, rows, issues, duplicateCount },
  };
}
