/**
 * GO-LIVE-SECURITY-01 — E-Rechnungen unter derselben fachlichen Regel wie PDF und Druck.
 *
 * XRechnung und ZUGFeRD sind verbindliche Ausgaben derselben Rechnung. Ohne
 * gültigen, bestätigten Leistungszeitraum verweigert der PDF-Validator Druck
 * und PDF; dieselben Codes sperren hier die E-Rechnung, für jede Rolle. Das gilt
 * für eine neu erzeugte Datei ebenso wie für eine bereits abgelegte: Auch die
 * zweite Auslieferung ist eine Ausgabe.
 *
 * Die Regel steht damit nur an einer Stelle (`validateFinalizedInvoiceForPdf`).
 * Wer bestätigen darf, bestätigt zuerst — wie beim PDF.
 */
import { validateFinalizedInvoiceForPdf } from '../invoiceValidationService';
import type { VorgangInvoice } from '../../types/models';

export const SERVICE_PERIOD_OUTPUT_CODES = [
  'service_period',
  'service_period_order',
  'service_period_unconfirmed',
] as const;

export type ServicePeriodOutputCode = (typeof SERVICE_PERIOD_OUTPUT_CODES)[number];

const CODES: ReadonlySet<string> = new Set(SERVICE_PERIOD_OUTPUT_CODES);

/** Die Sperrgründe zum Leistungszeitraum — leer, wenn die Ausgabe daran nicht scheitert. */
export function findServicePeriodOutputBlockers(invoice: VorgangInvoice): ServicePeriodOutputCode[] {
  return validateFinalizedInvoiceForPdf(invoice)
    .blockingErrors.map((error) => error.code)
    .filter((code): code is ServicePeriodOutputCode => CODES.has(code));
}
