/**
 * FINANZCORE-05D — offene Posten und rechnerischer Saldo eines Kunden.
 *
 * Dieses Modul **rechnet nichts neu**. Es fasst zusammen, was
 * `calculatePaymentSummary` je Rechnung bereits entschieden hat: offener
 * Betrag, Überzahlung, Status. Damit gilt für den Kundensaldo automatisch
 * dieselbe Wahrheit wie für die globale Finanzsicht, für die Detailseite und
 * für die Rechnungsliste — Skonto, Storno und die Überzahlungsregeln aus 05C
 * eingeschlossen. Eine zweite Rechenregel wäre eine zweite Wahrheit, und die
 * würde irgendwann von der ersten abweichen, ohne dass es jemand merkt.
 *
 * Insbesondere wird **nicht** `amount − bezahlt` gerechnet: Bei einer per
 * Skonto ausgeglichenen Rechnung entstünde daraus eine Restforderung, die
 * fachlich nicht existiert.
 *
 * Bewusst **keine** Verrechnung. Eine Überzahlung auf Rechnung B verringert
 * die Forderung aus Rechnung A nicht; sie erscheint getrennt als Guthaben. Der
 * Saldo ist eine Zusammenfassung, keine Buchung — siehe `netBalance`.
 *
 * Kein gespeicherter Saldo, keine Spalte, kein Snapshot: Alles wird bei jedem
 * Lesen aus Rechnungen und Zahlungen abgeleitet. Eine Zahlung, die gebucht
 * oder zurückgenommen wird, ist damit sofort im Saldo sichtbar, und ein Reload
 * kann nichts Veraltetes zeigen.
 */
import {
  formatPaymentCurrency,
  getOverdueDays,
  isInvoiceCancelled,
  isSentInvoice,
} from '../invoicePaymentService';
import { buildInvoiceReachPath } from '../invoiceNavigation';
import type { InvoiceOverviewItem } from '../invoiceOverviewService';
import type { InvoicePaymentStatus } from '../../types/models';

/* -------------------------------------------------------------------------- */
/* Altersstruktur                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Die Altersklassen.
 *
 * Die Regel ist die vorhandene: `isInvoiceOverdue` verlangt ein
 * Fälligkeitsdatum **und** den Versandstatus, sonst ist eine Rechnung nicht
 * überfällig. Zahlung wird erst nach dem Versand erwartet
 * (`isExpectingPayment`).
 *
 * `notSent` (01H) benennt genau diesen zweiten Grund. Bis 01H lag eine noch
 * nicht versendete Rechnung unter „Nicht fällig" — auch mit längst vergangenem
 * Datum in `paymentDueDate`, was sich wie ein Rechenfehler las. Die
 * Fälligkeitslogik bleibt unverändert; nur die Schublade sagt jetzt, warum
 * nichts drängt.
 *
 * `notDue` bleibt der Sammelzustand für versendete Rechnungen, die nicht
 * überfällig sind — auch für solche **ohne** Fälligkeitsdatum. Ein fehlendes
 * Datum durch irgendein angenommenes zu ersetzen, hiesse eine Frist zu
 * erfinden, die der Kunde nie bekommen hat.
 */
export type ReceivablesAgingBucket =
  | 'notSent'
  | 'notDue'
  | 'days1to30'
  | 'days31to60'
  | 'days61to90'
  | 'over90';

export const RECEIVABLES_AGING_BUCKETS: readonly ReceivablesAgingBucket[] = [
  'notSent',
  'notDue',
  'days1to30',
  'days31to60',
  'days61to90',
  'over90',
];

export type ReceivablesAging = Record<ReceivablesAgingBucket, number>;

/**
 * Die Klasse zu einer Zahl überfälliger Tage.
 *
 * `getOverdueDays` ist die vorhandene, kanonische Quelle und liefert 0, sobald
 * eine Rechnung nicht überfällig ist. Hier wird daraus nur eine Schublade —
 * keine zweite Definition von „überfällig".
 */
export function resolveAgingBucket(overdueDays: number): ReceivablesAgingBucket {
  if (overdueDays <= 0) return 'notDue';
  if (overdueDays <= 30) return 'days1to30';
  if (overdueDays <= 60) return 'days31to60';
  if (overdueDays <= 90) return 'days61to90';
  return 'over90';
}

function emptyAging(): ReceivablesAging {
  return { notSent: 0, notDue: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 };
}

/* -------------------------------------------------------------------------- */
/* Ergebnisform                                                               */
/* -------------------------------------------------------------------------- */

/** Eine offene Rechnung, wie sie in der Kundenakte erscheint. */
export interface CustomerOpenItem {
  readonly invoiceId: string;
  readonly number: string;
  readonly vorgangId: string | null;
  readonly vorgangTitle: string;
  readonly issueDate?: string;
  readonly dueDate?: string;
  readonly invoiceAmount: number;
  readonly paidAmount: number;
  readonly openAmount: number;
  readonly status: InvoicePaymentStatus;
  readonly overdueDays: number;
  readonly agingBucket: ReceivablesAgingBucket;
  readonly route: string;
}

/** Eine Rechnung, auf die mehr gezahlt wurde als sie fordert. */
export interface CustomerOverpaidItem {
  readonly invoiceId: string;
  readonly number: string;
  readonly vorgangId: string | null;
  readonly invoiceAmount: number;
  readonly paidAmount: number;
  readonly overpaidAmount: number;
  readonly route: string;
}

export interface CustomerReceivablesSummary {
  /** Summe aller offenen Beträge nicht stornierter Rechnungen. */
  readonly openReceivables: number;
  /** Davon der offene Betrag der überfälligen Rechnungen. */
  readonly overdueReceivables: number;
  /** Summe aller Überzahlungen — rechnerisches Guthaben, keine Buchung. */
  readonly overpaidCredit: number;
  /** `openReceivables − overpaidCredit`. Positiv: der Kunde schuldet. */
  readonly netBalance: number;
  readonly openInvoiceCount: number;
  readonly overdueInvoiceCount: number;
  readonly partialInvoiceCount: number;
  readonly overpaidInvoiceCount: number;
  readonly aging: ReceivablesAging;
  readonly openItems: readonly CustomerOpenItem[];
  readonly overpaidItems: readonly CustomerOverpaidItem[];
  /** Nichts offen, nichts zu viel gezahlt — für den Leerzustand der Oberfläche. */
  readonly isSettled: boolean;
}

/* -------------------------------------------------------------------------- */
/* Zusammenfassung                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Sortierung der offenen Posten: erst die überfälligen, älteste Fälligkeit
 * zuerst, danach die übrigen nach nächster Fälligkeit. Eine Rechnung ohne
 * Fälligkeitsdatum steht am Ende — sie drängt nicht.
 */
function compareOpenItems(a: CustomerOpenItem, b: CustomerOpenItem): number {
  const aOverdue = a.overdueDays > 0;
  const bOverdue = b.overdueDays > 0;
  if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
  if (aOverdue && bOverdue) return b.overdueDays - a.overdueDays;
  const aDue = a.dueDate ?? '9999-12-31';
  const bDue = b.dueDate ?? '9999-12-31';
  if (aDue !== bDue) return aDue.localeCompare(bDue);
  return a.number.localeCompare(b.number);
}

/**
 * Fasst die Rechnungen **eines** Kunden zusammen.
 *
 * Welche Rechnungen zu ihm gehören, entscheidet der Aufrufer — die
 * Kundenzuordnung ist eine eigene Regel (`resolveInvoiceCustomerId`) und wird
 * hier nicht noch einmal getroffen. Diese Funktion ist damit rein: dieselbe
 * Liste ergibt immer dasselbe Ergebnis.
 */
export function summarizeCustomerReceivables(
  items: readonly InvoiceOverviewItem[],
  today: Date | string = new Date(),
): CustomerReceivablesSummary {
  const aging = emptyAging();
  const openItems: CustomerOpenItem[] = [];
  const overpaidItems: CustomerOverpaidItem[] = [];

  let openReceivables = 0;
  let overdueReceivables = 0;
  let overpaidCredit = 0;
  let overdueInvoiceCount = 0;
  let partialInvoiceCount = 0;

  for (const item of items) {
    const { invoice, paymentSummary } = item;

    /*
     * Storno zuerst. Eine stornierte Rechnung ist keine Forderung mehr —
     * `getOpenAmount` liefert dafür bereits 0, aber hier steht es ausdrücklich,
     * damit sie auch nicht als Guthaben auftauchen kann. Bereits geflossenes
     * Geld bleibt in der Zahlungshistorie der Rechnung sichtbar; der
     * Kundensaldo macht daraus keine neue Tatsache.
     */
    if (isInvoiceCancelled(invoice)) continue;

    const open = paymentSummary.openAmount;
    const paid = paymentSummary.paidAmount;

    if (open > 0) {
      const overdueDays = getOverdueDays(invoice, today);
      /*
       * Unversendet ist kein Alter, sondern der Grund, warum es keines gibt.
       * `getOverdueDays` liefert dafür ohnehin 0 — dieselbe Quelle, nur eine
       * ehrlichere Schublade.
       */
      const bucket: ReceivablesAgingBucket = isSentInvoice(invoice)
        ? resolveAgingBucket(overdueDays)
        : 'notSent';

      openReceivables += open;
      aging[bucket] += open;

      /*
       * `ueberfaellig` ist der kanonische Status; dieselbe Quelle benutzt die
       * globale Übersicht. Keine zweite Fristenrechnung.
       */
      if (paymentSummary.status === 'ueberfaellig') {
        overdueReceivables += open;
        overdueInvoiceCount += 1;
      }

      /*
       * Teilbezahlt heisst hier: Es ist Geld geflossen und es steht noch etwas
       * aus. Bewusst am Betrag festgemacht und nicht am Statuswort — eine
       * teilbezahlte Rechnung, die zugleich überfällig ist, trägt den Status
       * `ueberfaellig` und wäre über das Wort nicht mehr zu sehen. Die Zähler
       * sind verschiedene Blickwinkel auf dieselbe Rechnung und überschneiden
       * sich absichtlich; innerhalb eines Zählers wird nichts doppelt gezählt.
       */
      if (paid > 0) partialInvoiceCount += 1;

      openItems.push({
        invoiceId: invoice.id,
        number: invoice.number,
        vorgangId: item.vorgangId,
        vorgangTitle: item.vorgangTitle,
        issueDate: invoice.issueDate ?? invoice.date,
        dueDate: invoice.paymentDueDate,
        invoiceAmount: paymentSummary.totalDue,
        paidAmount: paid,
        openAmount: open,
        status: paymentSummary.status,
        overdueDays,
        agingBucket: bucket,
        route: buildInvoiceReachPath(item.vorgangId, invoice.id),
      });
    }

    /*
     * Ein Guthaben entsteht nur aus tatsächlich geflossenem Geld.
     *
     * `paid > 0` ist die Absicherung gegen einen Beleg mit negativem Betrag:
     * `max(0, bezahlt − betrag)` ergäbe bei −119 und null Zahlungen genau 119
     * — ein Guthaben, das nie jemand gezahlt hat. Genau diese Verwechslung war
     * der Befund von 05B-FIX2 auf der Ausgabenseite. Für eine echte
     * Überzahlung ist die Bedingung immer erfüllt, sie ändert dort also nichts.
     */
    if (paymentSummary.overpaidAmount > 0 && paid > 0) {
      overpaidCredit += paymentSummary.overpaidAmount;
      overpaidItems.push({
        invoiceId: invoice.id,
        number: invoice.number,
        vorgangId: item.vorgangId,
        invoiceAmount: paymentSummary.totalDue,
        paidAmount: paid,
        overpaidAmount: paymentSummary.overpaidAmount,
        route: buildInvoiceReachPath(item.vorgangId, invoice.id),
      });
    }
  }

  openItems.sort(compareOpenItems);
  overpaidItems.sort((a, b) => a.number.localeCompare(b.number));

  const round = (value: number): number => Math.round(value * 100) / 100;
  const roundedOpen = round(openReceivables);
  const roundedCredit = round(overpaidCredit);

  return {
    openReceivables: roundedOpen,
    overdueReceivables: round(overdueReceivables),
    overpaidCredit: roundedCredit,
    /*
     * Rein rechnerisch. Ein negativer Wert bedeutet, dass beim Kunden mehr
     * Geld liegt als er schuldet — nicht, dass eine Rechnung dadurch beglichen
     * wäre. Jede Rechnung behält ihren eigenen offenen Betrag.
     */
    netBalance: round(roundedOpen - roundedCredit),
    openInvoiceCount: openItems.length,
    overdueInvoiceCount,
    partialInvoiceCount,
    overpaidInvoiceCount: overpaidItems.length,
    aging: {
      notSent: round(aging.notSent),
      notDue: round(aging.notDue),
      days1to30: round(aging.days1to30),
      days31to60: round(aging.days31to60),
      days61to90: round(aging.days61to90),
      over90: round(aging.over90),
    },
    openItems,
    overpaidItems,
    isSettled: roundedOpen === 0 && roundedCredit === 0,
  };
}

/** Anzeigefertige Beträge — dieselbe Währungsformatierung wie überall sonst. */
export function formatReceivablesAmount(value: number): string {
  return formatPaymentCurrency(value);
}
