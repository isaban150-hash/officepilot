import { getAllVorgaenge } from './vorgangService';
import { getInvoiceStoreSnapshot } from './invoice/invoiceStore';
import { isFinalizedInvoice } from './invoiceArchiveService';
import {
  calculatePaymentSummary,
  isInvoiceCancelled,
} from './invoicePaymentService';
import type {
  InvoicePaymentStatus,
  PaymentSummary,
  VorgangInvoice,
} from '../types/models';

export type InvoiceOverviewFilter =
  | 'all'
  | 'offen'
  | 'teilbezahlt'
  | 'ueberfaellig'
  | 'bezahlt'
  | 'storniert';

export interface InvoiceOverviewItem {
  /**
   * MANUAL-INVOICE-01B2c — `null` ist die normale Rechnung ohne Auftrag. Sie
   * ist ein vollwertiger Beleg im Bestand; nur der Auftrag ist keiner.
   */
  vorgangId: string | null;
  /** Leer, wenn es keinen Auftrag gibt — kein Platzhaltertext. */
  vorgangTitle: string;
  customer: string;
  baustelle: string;
  invoice: VorgangInvoice;
  paymentSummary: PaymentSummary;
}

export interface InvoiceOverviewTotals {
  openReceivables: number;
  overdueReceivables: number;
  paidTotal: number;
  openInvoiceCount: number;
  totalInvoiceCount: number;
  overdueInvoiceCount: number;
}

const STATUS_SORT_ORDER: Record<InvoicePaymentStatus, number> = {
  ueberfaellig: 0,
  offen: 1,
  teilbezahlt: 2,
  bezahlt: 3,
  storniert: 4,
};

function buildOverviewItem(
  vorgangId: string | null,
  vorgangTitle: string,
  customer: string,
  baustelle: string,
  invoice: VorgangInvoice,
  today?: Date | string,
): InvoiceOverviewItem {
  return {
    vorgangId,
    vorgangTitle,
    customer: invoice.customerSnapshot?.name ?? customer,
    baustelle: invoice.baustelle ?? baustelle,
    invoice,
    paymentSummary: calculatePaymentSummary(invoice, today),
  };
}

export function getAllInvoiceOverview(today?: Date | string): InvoiceOverviewItem[] {
  const items: InvoiceOverviewItem[] = [];

  for (const vorgang of getAllVorgaenge()) {
    for (const invoice of vorgang.invoices ?? []) {
      if (!isFinalizedInvoice(invoice)) continue;
      items.push(
        buildOverviewItem(
          vorgang.id,
          vorgang.title,
          vorgang.customer,
          vorgang.baustelle,
          invoice,
          today,
        ),
      );
    }
  }

  /*
   * MANUAL-INVOICE-01B2c — die Rechnungen ohne Auftrag. Sie hängen an keinem
   * Vorgang und fehlten deshalb in jeder Liste, jeder Summe und jedem offenen
   * Posten, obwohl sie ein finalisierter Beleg mit Nummer sind. Kunde und
   * Baustelle kommen allein aus der Rechnung; ein Auftragstitel existiert
   * nicht und wird nicht erfunden.
   */
  for (const entry of getInvoiceStoreSnapshot()) {
    if (entry.vorgangId !== null) continue;
    if (!isFinalizedInvoice(entry.invoice)) continue;
    items.push(buildOverviewItem(null, '', '', '', entry.invoice, today));
  }

  return sortInvoiceOverviewItems(items);
}

/**
 * MANUAL-INVOICE-01B2c — nur Rechnungen **mit** Auftrag haben heute eine
 * Detailroute (`/vorgaenge/:vorgangId/rechnungen/:invoiceId`). Wer eine Route
 * oder einen Vorgangsbezug braucht, filtert hiermit — und sagt damit auch
 * ehrlich, dass die freie Rechnung dort noch keinen Weg hat. Summen, Listen
 * und offene Posten brauchen den Filter nicht.
 */
export function hasVorgangRoute(
  item: InvoiceOverviewItem,
): item is InvoiceOverviewItem & { vorgangId: string } {
  return item.vorgangId !== null;
}

export function sortInvoiceOverviewItems(items: InvoiceOverviewItem[]): InvoiceOverviewItem[] {
  return [...items].sort((a, b) => {
    const statusDiff =
      STATUS_SORT_ORDER[a.paymentSummary.status] - STATUS_SORT_ORDER[b.paymentSummary.status];
    if (statusDiff !== 0) return statusDiff;

    const dueA = a.invoice.paymentDueDate ?? '9999-12-31';
    const dueB = b.invoice.paymentDueDate ?? '9999-12-31';
    return dueA.localeCompare(dueB);
  });
}

export function filterInvoiceOverview(
  items: InvoiceOverviewItem[],
  filter: InvoiceOverviewFilter,
): InvoiceOverviewItem[] {
  if (filter === 'all') return items;
  return items.filter((item) => item.paymentSummary.status === filter);
}

export function searchInvoiceOverview(
  items: InvoiceOverviewItem[],
  query: string,
): InvoiceOverviewItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;

  return items.filter((item) => {
    const haystack = [
      item.invoice.number,
      item.customer,
      item.vorgangTitle,
      item.baustelle,
      item.invoice.vorgangTitle ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

export function getOpenInvoices(today?: Date | string): InvoiceOverviewItem[] {
  return getAllInvoiceOverview(today).filter(
    (item) => item.paymentSummary.status === 'offen',
  );
}

export function getOverdueInvoices(today?: Date | string): InvoiceOverviewItem[] {
  return getAllInvoiceOverview(today).filter(
    (item) => item.paymentSummary.status === 'ueberfaellig',
  );
}

export function getPaidInvoices(today?: Date | string): InvoiceOverviewItem[] {
  return getAllInvoiceOverview(today).filter(
    (item) => item.paymentSummary.status === 'bezahlt',
  );
}

export function getPartialInvoices(today?: Date | string): InvoiceOverviewItem[] {
  return getAllInvoiceOverview(today).filter(
    (item) => item.paymentSummary.status === 'teilbezahlt',
  );
}

export function summarizeInvoiceOverview(
  items: InvoiceOverviewItem[] = getAllInvoiceOverview(),
): InvoiceOverviewTotals {
  let openReceivables = 0;
  let overdueReceivables = 0;
  let paidTotal = 0;
  let openInvoiceCount = 0;
  let overdueInvoiceCount = 0;

  for (const item of items) {
    const { paymentSummary } = item;
    paidTotal += paymentSummary.paidAmount;

    if (isInvoiceCancelled(item.invoice)) {
      continue;
    }

    if (paymentSummary.openAmount > 0) {
      openReceivables += paymentSummary.openAmount;
      openInvoiceCount += 1;
    }

    if (paymentSummary.status === 'ueberfaellig') {
      overdueReceivables += paymentSummary.openAmount;
      overdueInvoiceCount += 1;
    }
  }

  return {
    openReceivables,
    overdueReceivables,
    paidTotal,
    openInvoiceCount,
    totalInvoiceCount: items.length,
    overdueInvoiceCount,
  };
}

export function applyInvoiceOverviewFilters(
  items: InvoiceOverviewItem[],
  filter: InvoiceOverviewFilter,
  query: string,
): InvoiceOverviewItem[] {
  return searchInvoiceOverview(filterInvoiceOverview(items, filter), query);
}
