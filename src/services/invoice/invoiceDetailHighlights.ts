/**
 * BROWSER-ACCEPTANCE-FIX 01 / C2 — die Kurzangaben oben in der Rechnungsansicht.
 *
 * „Noch offen: 40,00 €" sagt bereits, dass die Rechnung offen ist; ein
 * zusätzliches „Offen" wiederholte denselben Zustand. Der Status erscheint
 * deshalb nur, wenn er etwas hinzufügt (teilbezahlt, überfällig …).
 * Reine Darstellung — die Statuslogik bleibt unverändert.
 */
import type { InvoicePaymentStatus } from '../../types/models';

export function buildInvoiceDetailHighlights(input: {
  status: InvoicePaymentStatus;
  openAmount: number;
  openAmountText: string;
  statusText: string;
}): string[] {
  if (input.openAmount <= 0) return [input.statusText];
  if (input.status === 'offen') return [input.openAmountText];
  return [input.openAmountText, input.statusText];
}
