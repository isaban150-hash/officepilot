/**
 * FINANZCORE-05E — die finanzielle Sicht auf einen Auftrag.
 *
 * Zwei Fragen, die gern verwechselt werden und hier bewusst **getrennt**
 * beantwortet werden:
 *
 *   1. **Abrechnungsfortschritt** — wie viel des Auftrags ist fakturiert?
 *      Gemessen in **Netto**, gegen den abrechenbaren Auftragswert.
 *   2. **Zahlungsstand** — wie viel der gestellten Forderungen ist bezahlt?
 *      Gemessen in **Brutto**, denn eine Forderung wird brutto beglichen.
 *
 * Die beiden Maßstäbe dürfen nicht vermischt werden. `orderPositions` tragen
 * Nettopreise, `invoice.amount` ist der Bruttobetrag der Forderung. Ein
 * „bezahlt 11.900 von 10.000 Auftragswert" wäre ein Rechenfehler, kein
 * Befund. Deshalb nennt jedes Feld seine Einheit im Namen (`…Net`) oder gehört
 * eindeutig zum Zahlungsblock.
 *
 * Dieses Modul **erfindet keine Formel**. Es benutzt durchgehend die
 * vorhandenen kanonischen Funktionen:
 *
 *   - `getCurrentBillableOrderNetCents` — der abrechenbare Auftragswert
 *   - `invoiceBilledNetCents` / `getBilledNetCentsForVorgang` — der bereits
 *     abgerechnete Nettowert, bei dem die Schlussrechnung ihre Abschläge
 *     bereits abzieht, sodass jeder Euro genau einmal zählt
 *   - `isBillingEffective` — was überhaupt abrechnend wirkt (nicht storniert,
 *     nicht Entwurf)
 *   - `hasSchlussrechnung` — die aktive Schlussrechnung
 *   - `calculatePaymentSummary` — offener Betrag, Überzahlung, Status je Rechnung
 *
 * Nichts wird gespeichert: kein Auftragssaldo, keine Summenspalte. Alles
 * entsteht bei jedem Lesen neu, damit eine Zahlung sofort durchschlägt und ein
 * veralteter Wert gar nicht erst existieren kann.
 *
 * Und wie in 05D wird **nicht verrechnet**: Eine Überzahlung auf Rechnung B
 * schließt Rechnung A nicht.
 */
import { fromCents, sumCents, toCents } from '../invoiceMoney';
import {
  getCurrentBillableOrderNetCents,
  hasSchlussrechnung,
  isBillingEffective,
} from '../orderBillingRules';
import { getBilledNetCentsForVorgang, invoiceBilledNetCents } from './orderCostService';
import { calculatePaymentSummary, getOverdueDays } from '../invoicePaymentService';
import { getInvoiceDocumentTitle } from '../invoiceTypeService';
import { getVorgangById } from '../vorgangService';
import type { InvoiceDocumentType, InvoicePaymentStatus, Vorgang, VorgangInvoice } from '../../types/models';

/* -------------------------------------------------------------------------- */
/* Eine Rechnung im Auftragsverlauf                                           */
/* -------------------------------------------------------------------------- */

export interface OrderInvoiceEntry {
  readonly invoiceId: string;
  readonly number: string;
  readonly type: InvoiceDocumentType;
  /** Fertige deutsche Bezeichnung („Abschlagsrechnung 2"), nie der Enum-Wert. */
  readonly typeLabel: string;
  readonly issueDate?: string;
  readonly dueDate?: string;
  /** Brutto-Forderung dieser Rechnung — bei der Schlussrechnung nach Abzügen. */
  readonly invoiceAmount: number;
  /** Ihr Beitrag zum Abrechnungsfortschritt, netto und abzugsbereinigt. */
  readonly billedNet: number;
  readonly paidAmount: number;
  readonly openAmount: number;
  readonly overpaidAmount: number;
  readonly status: InvoicePaymentStatus;
  readonly overdueDays: number;
  readonly cancelled: boolean;
  /** Entwurf oder storniert: bleibt sichtbar, zählt in keiner aktiven Summe. */
  readonly countsAsActive: boolean;
  readonly isFinalInvoice: boolean;
}

/* -------------------------------------------------------------------------- */
/* Ergebnis                                                                   */
/* -------------------------------------------------------------------------- */

export type OrderPaymentState = 'noActiveClaim' | 'open' | 'overpaid' | 'settled';

export interface OrderFinancials {
  readonly vorgangId: string;

  /* --- Abrechnungsfortschritt, netto --- */

  /**
   * Der abrechenbare Netto-Auftragswert.
   *
   * `null` heißt **„kein belastbarer fester Auftragswert"** — der Auftrag führt
   * keine abrechenbaren Positionen. Dann wird keiner erfunden und aus den
   * Rechnungen auch keiner rückwärts erklärt; die abhängigen Werte bleiben
   * ebenfalls `null`.
   *
   * Nicht identisch mit dem sichtbaren Vertragswert: Stellt der Auftraggeber
   * das Material, ist diese Position nicht abrechenbar und zählt nicht mit
   * (`isPositionBillable`). Das ist die bestehende Regel, keine neue.
   */
  readonly orderValueNet: number | null;
  /** Bereits abgerechnet, netto. Die Schlussrechnung zieht ihre Abschläge ab. */
  readonly invoicedNet: number;
  /**
   * `orderValueNet − invoicedNet`. **Ohne `Math.max(0, …)`** — ein überzogener
   * Auftrag muss als negativer Rest sichtbar bleiben, sonst verschwindet die
   * Information hinter einer 0. Dieselbe Haltung wie
   * `getRemainingFixedAmountBillableNetCents`.
   */
  readonly remainingBillableNet: number | null;
  readonly invoicedPercent: number | null;
  /** `invoicedNet > orderValueNet` — ein Prüfhinweis, kein Fehler. */
  readonly isOverInvoiced: boolean;

  /* --- Zahlungsstand, brutto --- */

  readonly paidAmount: number;
  readonly openReceivables: number;
  readonly overdueReceivables: number;
  readonly overpaidCredit: number;
  /** `openReceivables − overpaidCredit`. Rechnerisch, keine Buchung. */
  readonly netReceivable: number;

  /* --- Zähler --- */

  readonly invoiceCount: number;
  readonly activeInvoiceCount: number;
  readonly openInvoiceCount: number;
  readonly overdueInvoiceCount: number;
  readonly overpaidInvoiceCount: number;
  readonly cancelledInvoiceCount: number;

  /* --- Zustand --- */

  readonly hasFinalInvoice: boolean;
  /** Vollständig fakturiert — sagt **nichts** über bezahlt. */
  readonly isFullyInvoiced: boolean;
  /**
   * 01H — rechnerisch ist der Auftragswert erreicht, aber nur mit Hilfe von
   * Abschlägen und ohne wirksame Schlussrechnung. Das ist Fortschritt, kein
   * Abschluss: Die Schlussrechnung steht noch aus.
   */
  readonly awaitsFinalInvoice: boolean;
  /** Alle gestellten Forderungen ausgeglichen — sagt **nichts** über fakturiert. */
  readonly isFinanciallySettled: boolean;
  /**
   * 01H — der Zahlungsstand als eine Aussage für die Oberfläche. Abgeleitet
   * aus denselben Summen wie oben, keine eigene Rechnung:
   *
   *   - `noActiveClaim` — keine wirksame Rechnung (auch: nur Stornos). Das ist
   *     weder „offen" noch „bezahlt": Es wird schlicht nichts gefordert.
   *   - `open` — auf mindestens eine wirksame Rechnung steht etwas aus.
   *   - `overpaid` — nichts offen, aber irgendwo zu viel gezahlt.
   *   - `settled` — nichts offen, nichts zu viel (`isFinanciallySettled`).
   */
  readonly paymentState: OrderPaymentState;

  readonly invoices: readonly OrderInvoiceEntry[];
}

/* -------------------------------------------------------------------------- */

function toEntry(invoice: VorgangInvoice, today: Date | string): OrderInvoiceEntry {
  const summary = calculatePaymentSummary(invoice, today);
  const active = isBillingEffective(invoice);
  return {
    invoiceId: invoice.id,
    number: invoice.number,
    type: invoice.type,
    typeLabel: getInvoiceDocumentTitle(invoice.type, invoice.abschlagNumber),
    issueDate: invoice.issueDate ?? invoice.date,
    dueDate: invoice.paymentDueDate,
    invoiceAmount: invoice.amount,
    billedNet: active ? fromCents(invoiceBilledNetCents(invoice)) : 0,
    paidAmount: summary.paidAmount,
    openAmount: active ? summary.openAmount : 0,
    overpaidAmount: active ? summary.overpaidAmount : 0,
    status: summary.status,
    overdueDays: getOverdueDays(invoice, today),
    cancelled: invoice.paymentStatus === 'storniert' || Boolean(invoice.cancelledAt),
    countsAsActive: active,
    isFinalInvoice: invoice.type === 'schluss',
  };
}

/**
 * Reihenfolge des Rechnungsverlaufs: nach Rechnungsdatum, bei gleichem Datum
 * nach Nummer. Das ist die Abrechnungsfolge, wie sie entstanden ist — die
 * Schlussrechnung steht dadurch von selbst am Ende.
 */
function compareEntries(a: OrderInvoiceEntry, b: OrderInvoiceEntry): number {
  const aDate = a.issueDate ?? '';
  const bDate = b.issueDate ?? '';
  if (aDate !== bDate) return aDate.localeCompare(bDate);
  return a.number.localeCompare(b.number);
}

/**
 * Die finanzielle Sicht auf **einen** Auftrag.
 *
 * Rein: dieselbe Auftragsfassung ergibt immer dasselbe Ergebnis. Die
 * Rechnungen kommen aus `vorgang.invoices` — das ist die technische
 * Zugehörigkeit selbst, kein Namensabgleich und keine Heuristik. Eine freie
 * Rechnung ohne Auftrag kann hier gar nicht erst auftauchen.
 */
export function summarizeOrderFinancials(
  vorgang: Vorgang,
  today: Date | string = new Date(),
): OrderFinancials {
  const entries = (vorgang.invoices ?? []).map((invoice) => toEntry(invoice, today));
  entries.sort(compareEntries);
  const active = entries.filter((entry) => entry.countsAsActive);

  /* --- Abrechnungsfortschritt (netto) --- */

  const orderValueCents = getCurrentBillableOrderNetCents(vorgang);
  /*
   * Kein abrechenbarer Auftragswert: Der Auftrag führt keine abrechenbaren
   * Positionen — etwa weil er gar keine hat, oder weil der Auftraggeber das
   * gesamte Material stellt. Beides ist ein echter Zustand, keine Null.
   */
  const hasOrderValue =
    (vorgang.orderPositions ?? []).length > 0 && orderValueCents > 0;
  const orderValueNet = hasOrderValue ? fromCents(orderValueCents) : null;

  const invoicedCents = getBilledNetCentsForVorgang(vorgang);
  const invoicedNet = fromCents(invoicedCents);

  const remainingBillableNet = hasOrderValue
    ? fromCents(orderValueCents - invoicedCents)
    : null;
  const invoicedPercent = hasOrderValue
    ? Math.round((invoicedCents / orderValueCents) * 1000) / 10
    : null;
  const isOverInvoiced = hasOrderValue && invoicedCents > orderValueCents;

  /* --- Zahlungsstand (brutto) --- */

  const paidCents = sumCents(active.map((entry) => toCents(entry.paidAmount)));
  const openCents = sumCents(active.map((entry) => toCents(entry.openAmount)));
  const overdueCents = sumCents(
    active
      .filter((entry) => entry.status === 'ueberfaellig')
      .map((entry) => toCents(entry.openAmount)),
  );
  /*
   * Ein Guthaben entsteht nur aus tatsächlich geflossenem Geld — dieselbe
   * Absicherung wie im Kundensaldo (05D). Ohne sie ergäbe ein negativer
   * Belegbetrag über `max(0, bezahlt − betrag)` ein Guthaben, das niemand
   * gezahlt hat.
   */
  const overpaidEntries = active.filter(
    (entry) => entry.overpaidAmount > 0 && entry.paidAmount > 0,
  );
  const overpaidCents = sumCents(overpaidEntries.map((entry) => toCents(entry.overpaidAmount)));

  const openReceivables = fromCents(openCents);
  const overpaidCredit = fromCents(overpaidCents);

  /* --- Zustand --- */

  const hasFinalInvoice = hasSchlussrechnung(vorgang);
  /*
   * „Vollständig fakturiert" hat zwei Wege:
   *
   *   - Eine **wirksame Schlussrechnung**. Für die Engine ist das der
   *     Abschluss: `canAddOrderPosition` und `canEditOrderPositionField`
   *     sperren danach. Nach einem Storno ist sie nicht mehr wirksam, und der
   *     Auftrag ist folgerichtig wieder offen (FINAL-INVOICE-CANCELLATION-
   *     REBILLING-01A).
   *   - Oder der abrechenbare Wert ist durch **endgültige** Rechnungen
   *     erreicht — normale Rechnungen und Teilrechnungen.
   *
   * 01H — Abschläge zählen für den zweiten Weg nicht mit. Ein Abschlag ist
   * vorläufig: Er wird mit der Schlussrechnung abgerechnet
   * (`usesAbschlagDeductions`), bis dahin ist nichts endgültig. Bis 01H reichte
   * `remainingBillableNet <= 0`, und ein einzelner pauschaler Abschlag in Höhe
   * des Auftragswerts zeigte „Vollständig abgerechnet" (Befund „Delbrück").
   * Der rechnerische Fortschritt bleibt davon unberührt: `invoicedNet`,
   * `remainingBillableNet` und `invoicedPercent` zählen Abschläge weiterhin.
   *
   * Ohne belastbaren Auftragswert und ohne Schlussrechnung wird nichts
   * behauptet.
   */
  const definitiveCents = sumCents(
    active.filter((entry) => entry.type !== 'abschlag').map((entry) => toCents(entry.billedNet)),
  );
  const isFullyInvoiced =
    hasFinalInvoice || (hasOrderValue && definitiveCents >= orderValueCents);
  const awaitsFinalInvoice =
    !isFullyInvoiced && hasOrderValue && invoicedCents >= orderValueCents;

  /*
   * „Finanziell ausgeglichen" ist ausdrücklich **etwas anderes**: Es sagt, dass
   * auf die gestellten Rechnungen nichts mehr aussteht und nichts zu viel
   * liegt. Ein vollständig abgerechneter, aber unbezahlter Auftrag ist
   * `isFullyInvoiced && !isFinanciallySettled`.
   *
   * Ohne eine einzige wirksame Rechnung gilt ein Auftrag nicht als
   * ausgeglichen — es ist schlicht noch nichts gefordert worden.
   */
  const isFinanciallySettled =
    active.length > 0 && openCents === 0 && overpaidCents === 0;

  /*
   * 01H — bis hierher leitete die Oberfläche „Zahlungen noch offen" allein aus
   * `!isFinanciallySettled` ab. Ein Auftrag mit nur stornierten Rechnungen
   * (Befund AU-2026-0006) und eine Überzahlung zeigten so „noch offen" neben
   * „Offen 0,00 €". Offen ist nur, was als offener Betrag dasteht.
   */
  const paymentState: OrderPaymentState =
    active.length === 0
      ? 'noActiveClaim'
      : openCents > 0
        ? 'open'
        : overpaidCents > 0
          ? 'overpaid'
          : 'settled';

  return {
    vorgangId: vorgang.id,
    orderValueNet,
    invoicedNet,
    remainingBillableNet,
    invoicedPercent,
    isOverInvoiced,
    paidAmount: fromCents(paidCents),
    openReceivables,
    overdueReceivables: fromCents(overdueCents),
    overpaidCredit,
    netReceivable: fromCents(openCents - overpaidCents),
    invoiceCount: entries.length,
    activeInvoiceCount: active.length,
    openInvoiceCount: active.filter((entry) => entry.openAmount > 0).length,
    overdueInvoiceCount: active.filter((entry) => entry.status === 'ueberfaellig').length,
    overpaidInvoiceCount: overpaidEntries.length,
    cancelledInvoiceCount: entries.filter((entry) => entry.cancelled).length,
    hasFinalInvoice,
    isFullyInvoiced,
    awaitsFinalInvoice,
    isFinanciallySettled,
    paymentState,
    invoices: entries,
  };
}

/** Bequemer Zugriff über die Auftragskennung; `undefined`, wenn es ihn nicht gibt. */
export function getOrderFinancials(
  vorgangId: string,
  today: Date | string = new Date(),
): OrderFinancials | undefined {
  const vorgang = getVorgangById(vorgangId);
  return vorgang ? summarizeOrderFinancials(vorgang, today) : undefined;
}
