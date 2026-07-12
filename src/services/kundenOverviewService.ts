import { getAllInvoiceOverview } from './invoiceOverviewService';
import { getAllVorgaenge } from './vorgangService';

export interface KundeOverviewEntry {
  name: string;
  orderCount: number;
  openInvoiceCount: number;
  latestOrderTitle?: string;
}

function normalizeName(value: string): string {
  return value.trim();
}

export function getKundenOverview(today?: Date | string): KundeOverviewEntry[] {
  const byName = new Map<string, KundeOverviewEntry>();

  for (const vorgang of getAllVorgaenge()) {
    const name = normalizeName(vorgang.customer);
    if (!name || name.toLowerCase() === 'unbekannt') continue;
    const existing = byName.get(name) ?? {
      name,
      orderCount: 0,
      openInvoiceCount: 0,
      latestOrderTitle: vorgang.title,
    };
    existing.orderCount += 1;
    if (!existing.latestOrderTitle) existing.latestOrderTitle = vorgang.title;
    byName.set(name, existing);
  }

  for (const invoice of getAllInvoiceOverview(today)) {
    const name = normalizeName(invoice.customer);
    if (!name) continue;
    const existing = byName.get(name) ?? {
      name,
      orderCount: 0,
      openInvoiceCount: 0,
    };
    if (invoice.paymentSummary.status === 'offen' || invoice.paymentSummary.status === 'ueberfaellig' || invoice.paymentSummary.status === 'teilbezahlt') {
      existing.openInvoiceCount += 1;
    }
    byName.set(name, existing);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
}
