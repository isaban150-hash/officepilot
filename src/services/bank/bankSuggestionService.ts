/**
 * BANKABGLEICH-V1 BLOCK 3 — welche Rechnung oder Ausgabe zu einer
 * Bankbewegung gehören könnte.
 *
 * **Keine Geldwirkung.** Dieser Dienst liest ausschliesslich. Er ruft keine
 * Zahlungsfunktion auf, ändert keinen Zahlungsstatus, erzeugt keine Zahlung
 * und speichert nichts. Er beantwortet eine einzige Frage — „könnte das
 * zusammengehören?" — und überlässt die Antwort dem Nutzer.
 *
 * Alles ist deterministisch: dieselben Daten ergeben dieselben Vorschläge.
 * Keine Schätzung, keine Wahrscheinlichkeit, kein Modell.
 */
import { getAllInvoiceOverview } from '../invoiceOverviewService';
import { getAllExpenseOverview } from '../expenseOverviewService';
import { toCents } from '../invoiceMoney';
import { listBankTransactions } from './bankTransactionStore';
import { findReconciliationForTransaction } from './bankReconciliationStore';
import type { BankTransaction } from '../../types/bankTransaction';
import type {
  BankSuggestionCandidate,
  BankSuggestionGrade,
  BankSuggestionReason,
  BankSuggestionResult,
} from '../../types/bankSuggestion';

/* -------------------------------------------------------------------------- */
/* Normalisierung                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Die Vergleichsform einer Beleg- oder Rechnungsnummer.
 *
 * Nur Trennzeichen fallen weg: `RE-2026-0014`, `RE 2026 0014` und
 * `RE/2026/0014` werden dieselbe Nummer. Ziffern bleiben unangetastet —
 * `RE-2026-14` und `RE-2026-0014` bleiben deshalb **verschieden**. Eine
 * Normalisierung, die führende Nullen schluckt, würde zwei echte Rechnungen
 * zusammenziehen, und das wäre bei Geld der teuerste Fehler.
 */
export function normalizeDocumentNumber(wert: string | null | undefined): string {
  return (wert ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Ab welcher Länge eine Nummer im Verwendungszweck als Nummer gilt.
 *
 * Eine zweistellige „14" steckt in jedem zweiten Zweck und wäre kein Signal,
 * sondern Zufall. Sechs Zeichen entsprechen dem kürzesten Format, das
 * OfficeTakt selbst erzeugt (Präfix plus Zähler), und schliessen Zufall
 * praktisch aus.
 */
const MIN_NUMMERNLAENGE = 6;

/**
 * Die Vergleichsform eines Firmennamens.
 *
 * Bewusst **ohne unscharfen Vergleich**: Gross-/Kleinschreibung, Leerraum und
 * die gängigen Rechtsformzusätze fallen weg, mehr nicht. „Müller Bau" und
 * „Meyer Bau GmbH" bleiben damit verschieden — genau so soll es sein. Ein
 * Namensalgorithmus, der ähnlich klingende Firmen gleichsetzt, würde Geld
 * dem falschen Kunden zuordnen.
 */
export function normalizePartyName(wert: string | null | undefined): string {
  const RECHTSFORMEN = new Set([
    'gmbh',
    'mbh',
    'ag',
    'kg',
    'ug',
    'ohg',
    'gbr',
    'ek',
    'eg',
    'co',
    'und',
    '&',
  ]);
  return (wert ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9&\s]/g, ' ')
    .split(/\s+/)
    .filter((wort) => wort.length > 0 && !RECHTSFORMEN.has(wort))
    .join(' ')
    .trim();
}

/** Steckt die Nummer im Verwendungszweck? */
function nummerImZweck(nummer: string, zweck: string | undefined): boolean {
  const gesucht = normalizeDocumentNumber(nummer);
  if (gesucht.length < MIN_NUMMERNLAENGE) return false;
  return normalizeDocumentNumber(zweck).includes(gesucht);
}

/**
 * Nennt die Gegenpartei dieselbe Firma?
 *
 * Gleichheit oder vollständige Enthaltensein des kürzeren im längeren Namen —
 * „Westfalen Projektbau" in „Westfalen Projektbau GmbH & Co KG". Ein
 * einzelnes gemeinsames Wort genügt ausdrücklich nicht.
 */
function gegenparteiPasst(gegenpartei: string | undefined, partei: string): boolean {
  const a = normalizePartyName(gegenpartei);
  const b = normalizePartyName(partei);
  if (!a || !b) return false;
  if (a === b) return true;
  const [kurz, lang] = a.length <= b.length ? [a, b] : [b, a];
  /* Zu kurze Reste dürfen nicht zufällig treffen. */
  if (kurz.length < 4) return false;
  return lang.startsWith(`${kurz} `) || lang.includes(` ${kurz} `) || lang.endsWith(` ${kurz}`) || lang === kurz;
}

/* -------------------------------------------------------------------------- */
/* Bewertung                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Aus den Gründen wird die Stufe — und zwar nach einer Regel, die man einem
 * Handwerker erklären kann:
 *
 * - Nummer **und** Betrag stimmen → sehr passend. Beides zusammen ist kaum
 *   Zufall.
 * - Nur eines davon, dafür eindeutig → passend.
 * - Der Betrag allein → möglich. Drei Rechnungen über 500 Euro gibt es
 *   wirklich, und dann ist nichts entschieden.
 */
function bewerte(reasons: BankSuggestionReason[]): BankSuggestionGrade {
  const nummer = reasons.includes('invoice_number_in_purpose');
  const betrag = reasons.includes('amount_matches_open');
  const partei = reasons.includes('counterparty_matches');

  if (nummer && betrag) return 'sehr_passend';
  if (nummer) return 'passend';
  if (betrag && partei) return 'passend';
  return 'moeglich';
}

const STUFENRANG: Record<BankSuggestionGrade, number> = {
  sehr_passend: 0,
  passend: 1,
  moeglich: 2,
};

/* -------------------------------------------------------------------------- */
/* Kandidatensuche                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Ein Posten kommt nur in Frage, wenn er überhaupt noch Geld erwartet.
 *
 * Gelesen wird der **offene** Betrag der bestehenden Zahlungsrechnung, nicht
 * der Gesamtbetrag: Eine Rechnung über 1.000 Euro, auf die schon 600 gezahlt
 * sind, erwartet 400 — und genau 400 ist der passende Bankeingang.
 */
function istOffen(openAmount: number): boolean {
  /*
   * `Number.isFinite` ist hier kein Zierrat: Der Typ verspricht `number`,
   * zur Laufzeit liefert die Zahlungsrechnung aber `null`, wenn einem Beleg
   * der Betrag fehlt. Ohne diese Pruefung waere das Ergebnis `NaN` — und ein
   * NaN-Vergleich entscheidet still und immer gleich.
   */
  if (typeof openAmount !== 'number' || !Number.isFinite(openAmount)) return false;
  return toCents(openAmount) > 0;
}

function pruefeKandidat(
  transaction: BankTransaction,
  targetType: 'invoice' | 'expense',
  targetId: string,
  documentNumber: string,
  partyName: string,
  openAmount: number,
  documentDate: string | undefined,
): BankSuggestionCandidate | null {
  const openCents = toCents(openAmount);
  const bewegungCents = Math.abs(transaction.amountCents);

  const reasons: BankSuggestionReason[] = [];
  if (nummerImZweck(documentNumber, transaction.purpose)) {
    reasons.push('invoice_number_in_purpose');
  }
  if (openCents === bewegungCents) {
    reasons.push('amount_matches_open');
  }
  if (gegenparteiPasst(transaction.counterparty, partyName)) {
    reasons.push('counterparty_matches');
  }

  /*
   * Ohne ein tragendes Signal gibt es keinen Vorschlag. Ein Kandidat allein
   * aufgrund eines plausiblen Datums wäre geraten.
   */
  if (reasons.length === 0) return null;

  /* Der abweichende Betrag wird genannt, nicht verschwiegen. */
  if (!reasons.includes('amount_matches_open')) {
    reasons.push('amount_differs');
  }

  /*
   * Zeitliche Plausibilität schwächt ab, schliesst aber nicht aus: Eine
   * Zahlung vor dem Belegdatum kommt vor (Vorkasse, nachträglich erfasster
   * Beleg) und soll sichtbar bleiben — mit Hinweis.
   */
  if (documentDate && transaction.bookingDate < documentDate.slice(0, 10)) {
    reasons.push('date_before_document');
  }

  return {
    targetType,
    targetId,
    documentNumber,
    partyName,
    openCents,
    grade: bewerte(reasons),
    reasons,
  };
}

/* -------------------------------------------------------------------------- */
/* Öffentliche Schnittstelle                                                   */
/* -------------------------------------------------------------------------- */

/** Höchstens so viele Kandidaten je Bewegung — mehr hilft bei einer Entscheidung nicht. */
const MAX_KANDIDATEN = 5;

/**
 * Die Vorschläge für eine Liste von Bankbewegungen.
 *
 * Rechnungen und Ausgaben werden **einmal** gelesen und für alle Bewegungen
 * wiederverwendet — kein Aufruf je Zeile.
 */
export function buildBankSuggestions(
  transactions: BankTransaction[] = listBankTransactions(),
): Map<string, BankSuggestionResult> {
  /*
   * Beide Übersichten liefern Beleg und Zahlungsstand in einem Zug und
   * stammen aus den Stores des aktuellen Betriebs — die Betriebstrennung
   * entsteht dadurch von selbst, ohne eigene Filterung.
   */
  const rechnungen = getAllInvoiceOverview().filter((item) => istOffen(item.paymentSummary.openAmount));
  const ausgaben = getAllExpenseOverview().filter((item) => istOffen(item.paymentSummary.openAmount));

  const ergebnis = new Map<string, BankSuggestionResult>();

  for (const transaction of transactions) {
    /*
     * BLOCK 4 — eine bereits bestaetigte Bewegung bekommt keine neuen
     * Vorschlaege mehr. Sie ist erledigt, und ein weiterer Vorschlag waere
     * eine Einladung zur zweiten Zuordnung.
     */
    if (findReconciliationForTransaction(transaction.id)) {
      ergebnis.set(transaction.id, {
        bankTransactionId: transaction.id,
        direction: transaction.amountCents > 0 ? 'incoming' : 'outgoing',
        candidates: [],
        ambiguous: false,
      });
      continue;
    }

    /*
     * Die Richtung ist verbindlich und wird nicht vermischt: Geld, das
     * hereinkommt, bezahlt eine Ausgangsrechnung; Geld, das hinausgeht,
     * bezahlt eine Ausgabe. Eine Bewegung von 0 gibt es nicht.
     */
    const eingang = transaction.amountCents > 0;
    const kandidaten: BankSuggestionCandidate[] = [];

    if (eingang) {
      for (const item of rechnungen) {
        const kandidat = pruefeKandidat(
          transaction,
          'invoice',
          item.invoice.id,
          item.invoice.number,
          item.customer,
          item.paymentSummary.openAmount,
          item.invoice.issueDate ?? item.invoice.date,
        );
        if (kandidat) kandidaten.push(kandidat);
      }
    } else {
      for (const item of ausgaben) {
        const kandidat = pruefeKandidat(
          transaction,
          'expense',
          item.expense.id,
          item.expense.invoiceNumber,
          item.expense.supplierName,
          item.paymentSummary.openAmount,
          item.expense.issueDate,
        );
        if (kandidat) kandidaten.push(kandidat);
      }
    }

    kandidaten.sort((a, b) =>
      STUFENRANG[a.grade] === STUFENRANG[b.grade]
        ? a.documentNumber.localeCompare(b.documentNumber, 'de')
        : STUFENRANG[a.grade] - STUFENRANG[b.grade],
    );

    /*
     * Mehrdeutig heisst: Es gibt mehr als einen Kandidaten auf der besten
     * Stufe. Dann hat OfficeTakt die Frage **nicht** beantwortet und sagt das
     * auch — ein willkürlich erster Treffer wäre eine Behauptung.
     */
    const beste = kandidaten[0]?.grade;
    const ambiguous =
      beste !== undefined && kandidaten.filter((kandidat) => kandidat.grade === beste).length > 1;

    ergebnis.set(transaction.id, {
      bankTransactionId: transaction.id,
      direction: eingang ? 'incoming' : 'outgoing',
      candidates: kandidaten.slice(0, MAX_KANDIDATEN),
      ambiguous,
    });
  }

  return ergebnis;
}
