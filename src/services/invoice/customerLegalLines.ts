/**
 * FINANZ-CORE-01A (AUS-11) — Pflichtangaben zum Rechnungsempfänger, die bisher
 * weder im PDF noch im Druck standen: das Land (außerhalb Deutschlands) und
 * die USt-IdNr. des Empfängers (§ 14a Abs. 1 UStG bei Reverse Charge im
 * Binnenmarkt; bei § 13b verlangt sie auch die XRechnung).
 *
 * Nur aus dem eingefrorenen Beleg-Snapshot, nie aus dem heutigen
 * Kundenstamm. Fehlt eine Angabe, entsteht keine Zeile.
 */
import type { CustomerBilling } from '../../types/models';

function countryNameDe(code: string): string {
  try {
    return new Intl.DisplayNames(['de'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function buildCustomerLegalLines(
  customer: Pick<CustomerBilling, 'countryCode' | 'vatId'>,
): string[] {
  const lines: string[] = [];
  const code = customer.countryCode?.trim().toUpperCase();
  if (code && code !== 'DE') lines.push(countryNameDe(code));
  const vatId = customer.vatId?.trim();
  if (vatId) lines.push(`USt-IdNr.: ${vatId}`);
  return lines;
}
