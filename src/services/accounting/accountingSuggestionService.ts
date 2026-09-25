/**
 * STEUERBERATER-06A — der Kontierungsvorschlag.
 *
 * **Dieser Dienst schlägt keine Kontonummer vor, und das ist Absicht.**
 *
 * Im Repository liegt kein verifizierter SKR03-/SKR04-Kontenkatalog: keine
 * Kontendatei, keine Kontentabelle, keine Zuordnung von Ausgabenkategorien zu
 * Sachkonten. Eine Nummer hier hineinzuschreiben hiesse, sie aus dem Gedächtnis
 * zu erfinden. Eine falsche Kontonummer ist schlimmer als gar keine: Sie sieht
 * aus wie eine Auskunft, wandert über die Bestätigung in die Buchhaltung und
 * fällt erst beim Steuerberater auf — oder gar nicht.
 *
 * Lieber kein Konto als ein falsches. Der Vorschlag liefert deshalb genau das,
 * was sich aus vorhandenen, belegten Daten wirklich ableiten lässt:
 *
 *   - den **Buchungstext** aus Lieferant/Kunde und Belegnummer,
 *   - die **Steuerbehandlung**, unverändert vom Beleg übernommen,
 *   - einen **Prüfstand**, der bei unklarer Steuerlage ausdrücklich
 *     „Klärung nötig" sagt,
 *   - und eine **Begründung** in Produktsprache.
 *
 * Die Kontonummer bleibt leer und wird vom Nutzer eingetragen. Sobald ein
 * geprüfter Kontenkatalog vorliegt, greift er genau hier an: Die Signatur
 * bleibt, nur `accountNumber` und `accountLabel` bekommen dann Inhalt.
 *
 * Und in jedem Fall gilt: Ein Vorschlag ist **nie** `confirmed`. Der Typ
 * `AccountingSuggestion` schliesst den Wert aus.
 */
import { isCreditNoteExpense } from '../expensePaymentCalculations';
import { isInvoiceCancelled } from '../invoicePaymentService';
import type { Expense } from '../../types/expense';
import type { VorgangInvoice } from '../../types/models';
import type { AccountingSuggestion, AccountingTaxTreatment } from '../../types/accounting';

/** Zeichenlänge, ab der ein Freitext im Buchungstext gekürzt wird. */
const BOOKING_TEXT_MAX = 60;

/**
 * Kürzt und säubert einen Textbaustein für den Buchungstext.
 *
 * Buchungstexte laufen später in die Buchhaltung und in Auswertungen. Ein
 * langer Freitext aus einem Beleg gehört dort nicht hinein — weder aus
 * Platzgründen noch inhaltlich: Was jemand als Notiz an eine Ausgabe geschrieben
 * hat, ist nicht für den Steuerberater bestimmt. Übernommen werden deshalb nur
 * Felder, die ohnehin Identifikationsmerkmale sind (Lieferant, Kunde,
 * Belegnummer), und auch die gekürzt.
 */
function tidy(value: string | undefined | null): string {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  if (trimmed.length <= BOOKING_TEXT_MAX) return trimmed;
  return `${trimmed.slice(0, BOOKING_TEXT_MAX - 1).trimEnd()}…`;
}

function joinBookingText(...parts: Array<string | undefined | null>): string {
  return parts.map(tidy).filter(Boolean).join(' · ');
}

/**
 * Ist diese Steuerbehandlung eine belastbare Grundlage?
 *
 * `unclear` heisst „unbekannt" (05B) und ist genau das Gegenteil einer
 * Grundlage. Daraus darf keine Sicherheit entstehen — der Beleg geht in die
 * Klärung, nicht in die Prüfung.
 */
export function isClearTaxTreatment(value: AccountingTaxTreatment): boolean {
  return value !== 'unclear';
}

export interface ExpenseSuggestionContext {
  readonly expense: Expense;
}

export interface InvoiceSuggestionContext {
  readonly invoice: VorgangInvoice;
  readonly customerName?: string;
}

/**
 * Der Vorschlag für einen Eingangsbeleg.
 *
 * Kategorie und Lieferant fliessen in den Buchungstext und in die Begründung,
 * **nicht** in eine Kontonummer: „Material" oder „Tankbeleg" ist eine
 * Ablagekategorie des Betriebs, kein Sachkonto. Die Zuordnung dazwischen ist
 * eine steuerliche Entscheidung und gehört dem Betrieb beziehungsweise seinem
 * Steuerberater.
 */
export function suggestExpenseAccounting(context: ExpenseSuggestionContext): AccountingSuggestion {
  const { expense } = context;
  const taxTreatment = expense.taxStatus as AccountingTaxTreatment;
  const creditNote = isCreditNoteExpense(expense);

  const bookingText = joinBookingText(
    expense.supplierName,
    expense.invoiceNumber || expense.title,
  );

  /*
   * Die Gutschrift bleibt eine Gutschrift. Ihr negativer Betrag wird nicht
   * umgeschrieben und nicht „geglättet" (05B-FIX2); der Buchungstext benennt
   * sie, damit sie in der Buchhaltung nicht als gewöhnliche Ausgabe landet.
   */
  if (creditNote) {
    return {
      accountNumber: '',
      accountLabel: '',
      taxTreatment,
      bookingText: joinBookingText('Gutschrift', bookingText),
      reason: 'accounting.reason.expenseCreditNote',
      status: 'needs_clarification',
    };
  }

  if (!isClearTaxTreatment(taxTreatment)) {
    return {
      accountNumber: '',
      accountLabel: '',
      taxTreatment,
      bookingText,
      reason: 'accounting.reason.taxUnclear',
      status: 'needs_clarification',
    };
  }

  return {
    accountNumber: '',
    accountLabel: '',
    taxTreatment,
    bookingText,
    reason: 'accounting.reason.noAccountCatalog',
    status: 'needs_review',
  };
}

/**
 * Der Vorschlag für eine Ausgangsrechnung.
 *
 * Verwendet wird nur, was der Beleg ohnehin trägt: Kunde, Rechnungsnummer,
 * Steuerstatus. Keine neue Rechnungssteuerlogik — §13b, 7 % und Steuerfreiheit
 * kommen unverändert aus `invoice.taxStatus`.
 */
export function suggestInvoiceAccounting(context: InvoiceSuggestionContext): AccountingSuggestion {
  const { invoice } = context;
  const taxTreatment = invoice.taxStatus as AccountingTaxTreatment;
  const kunde = context.customerName ?? invoice.customerSnapshot?.name ?? '';
  const bookingText = joinBookingText(kunde, invoice.number);

  /*
   * Eine stornierte Rechnung verschwindet nicht. Sie bleibt kontierbar und
   * nachvollziehbar, wird aber ausdrücklich als Klärungsfall geführt: Wie ein
   * Storno zu buchen ist, entscheidet nicht die Software.
   */
  if (isInvoiceCancelled(invoice)) {
    return {
      accountNumber: '',
      accountLabel: '',
      taxTreatment,
      bookingText: joinBookingText('Storno', bookingText),
      reason: 'accounting.reason.invoiceCancelled',
      status: 'needs_clarification',
    };
  }

  if (!isClearTaxTreatment(taxTreatment)) {
    return {
      accountNumber: '',
      accountLabel: '',
      taxTreatment,
      bookingText,
      reason: 'accounting.reason.taxUnclear',
      status: 'needs_clarification',
    };
  }

  return {
    accountNumber: '',
    accountLabel: '',
    taxTreatment,
    bookingText,
    reason: 'accounting.reason.noAccountCatalog',
    status: 'needs_review',
  };
}
