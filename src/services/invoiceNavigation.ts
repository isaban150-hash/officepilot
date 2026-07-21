/**
 * Canonical app routes for invoices.
 * Detail: `/vorgaenge/:vorgangId/rechnungen/:invoiceId`
 * Create: `/vorgaenge/:vorgangId/rechnung`
 * Overview: `/rechnungen/offen`
 */

export function buildInvoiceDetailPath(vorgangId: string, invoiceId: string): string {
  return `/vorgaenge/${vorgangId}/rechnungen/${invoiceId}`;
}

export function buildInvoiceCreatePath(vorgangId: string): string {
  return `/vorgaenge/${vorgangId}/rechnung`;
}

export function buildOpenInvoicesPath(): string {
  return '/rechnungen/offen';
}
