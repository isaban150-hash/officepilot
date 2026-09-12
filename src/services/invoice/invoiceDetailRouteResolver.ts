import type { VorgangInvoice } from '../../types/models';
import { findInvoiceLocatorById } from './invoiceRegistryService';
import { getVorgangById, getVorgangInvoice } from '../vorgangService';

/**
 * MANUAL-INVOICE-UI-01B2 — die Auflösung einer Rechnung für die Detailseite.
 *
 * Zwei Routen, eine Seite:
 *
 *   * `/rechnungen/:invoiceId` — global. Aufgelöst über die First-Class-
 *     Registry (`findInvoiceLocatorById`); der Ablageort kommt aus dem
 *     Speicher, nicht aus der URL. Eine Rechnung ohne Auftrag ergibt
 *     `vorgangId: null`, eine Vorgangsrechnung ihren echten Vorgang.
 *   * `/vorgaenge/:id/rechnungen/:invoiceId` — der bestehende Vorgangsweg.
 *     Aufgelöst **im** angegebenen Vorgang. Steht die Rechnung anderswo,
 *     ist das ein Widerspruch: fail closed, nie „irgendeine" Rechnung.
 *
 * Kein Fake-Vorgang, keine Sentinel-Kennung. `null` heisst „ohne Auftrag".
 */
export type InvoiceDetailRouteResolution =
  | { kind: 'found'; invoice: VorgangInvoice; vorgangId: string | null }
  | { kind: 'not_found' }
  /** Alte Route, aber die Rechnung gehört nicht zu diesem Vorgang. */
  | { kind: 'mismatch' };

export function resolveInvoiceDetailRoute(params: {
  routeVorgangId: string | undefined;
  invoiceId: string | undefined;
}): InvoiceDetailRouteResolution {
  const invoiceId = params.invoiceId?.trim() ?? '';
  if (!invoiceId) return { kind: 'not_found' };

  if (params.routeVorgangId !== undefined) {
    const routeVorgangId = params.routeVorgangId.trim();
    if (!routeVorgangId || !getVorgangById(routeVorgangId)) return { kind: 'not_found' };

    const scoped = getVorgangInvoice(routeVorgangId, invoiceId);
    if (scoped) return { kind: 'found', invoice: scoped, vorgangId: routeVorgangId };

    // Existiert die Kennung woanders, ist die URL falsch — nicht die Rechnung.
    return findInvoiceLocatorById(invoiceId) ? { kind: 'mismatch' } : { kind: 'not_found' };
  }

  const entry = findInvoiceLocatorById(invoiceId);
  if (!entry) return { kind: 'not_found' };
  return { kind: 'found', invoice: { ...entry.invoice }, vorgangId: entry.vorgangId };
}
