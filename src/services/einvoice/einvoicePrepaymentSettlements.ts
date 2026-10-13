/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N02/D1) — der Zahlungsstand der Abschläge, die
 * eine Schlussrechnung abzieht, für den E-Rechnungs-Builder.
 *
 * Der Builder bleibt rein und kennt keine Zahlungen. XRechnung, ZUGFeRD und die
 * Vorprüfung holen den Stand hier — aus demselben lokalen Rechnungsbestand, aus dem
 * auch der offene Betrag jedes Abschlags kommt.
 */
import type { VorgangInvoice } from '../../types/models';
import { resolveAbschlagSettlements } from '../invoice/abschlagSettlement';
import { findInvoiceById } from '../invoice/invoiceRegistryService';
import type { CanonicalPrepaymentSettlement } from './canonicalEInvoice';

export function prepaymentSettlementsFor(
  invoice: Pick<VorgangInvoice, 'previousAbschlagDeductions'>,
  findInvoice: (invoiceId: string) => VorgangInvoice | undefined = findInvoiceById,
): CanonicalPrepaymentSettlement[] {
  return resolveAbschlagSettlements(invoice.previousAbschlagDeductions, findInvoice).map((entry) => ({
    invoiceId: entry.invoiceId,
    paid: entry.paid,
    skonto: entry.skonto,
    settled: entry.settled,
  }));
}
