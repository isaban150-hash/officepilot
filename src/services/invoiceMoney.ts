/** Cent-based money helpers for invoice totals (no raw float pass-through). */

export function isValidMoneyNumber(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Round a euro amount to the nearest cent. */
export function roundMoney(amount: number): number {
  if (!isValidMoneyNumber(amount)) return NaN;
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export function toCents(amount: number): number {
  if (!isValidMoneyNumber(amount)) return NaN;
  return Math.round((amount + Number.EPSILON) * 100);
}

export function fromCents(cents: number): number {
  if (!Number.isFinite(cents)) return NaN;
  return cents / 100;
}

/** Line total in cents: quantity × unit price, then round once. */
export function lineTotalCents(quantity: number, unitPrice: number): number {
  if (!isValidMoneyNumber(quantity) || !isValidMoneyNumber(unitPrice)) return NaN;
  return toCents(quantity * unitPrice);
}

export function lineTotalMoney(quantity: number, unitPrice: number): number {
  return fromCents(lineTotalCents(quantity, unitPrice));
}

export function sumCents(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

/** VAT in cents from net cents and percent rate (e.g. 19). */
export function taxCentsFromNet(netCents: number, taxRatePercent: number): number {
  if (!Number.isFinite(netCents) || !Number.isFinite(taxRatePercent)) return NaN;
  if (taxRatePercent <= 0) return 0;
  return Math.round((netCents * taxRatePercent) / 100);
}

/**
 * BEREICH-7-V1 — Weiterberechnungspreis in Cent: Einkaufsnetto plus optionaler
 * prozentualer Aufschlag.
 *
 * **Genau eine Rundung.** Zuerst den Aufschlag zu runden und ihn dann zu
 * addieren wäre eine zweite Rundungsstelle und würde bei krummen Sätzen um
 * einen Cent abweichen — deshalb steht hier ein einziger `Math.round` über dem
 * fertigen Produkt, wie in `taxCentsFromNet` auch.
 *
 * Aufschlag `0` ergibt den Einkaufspreis **exakt** und nicht nur ungefähr:
 * Der Faktor ist dann 1, und `Math.round` eines ganzzahligen Centbetrags ist
 * dieser Betrag.
 *
 * Ein negativer Satz ist kein Rabattmodell, sondern ein Eingabefehler, und
 * wird deshalb hier nicht abgefangen, sondern vom Dienst abgewiesen.
 */
export function rebillPriceCents(netCents: number, markupPercent: number): number {
  if (!Number.isFinite(netCents) || !Number.isFinite(markupPercent)) return NaN;
  if (markupPercent === 0) return netCents;
  return Math.round((netCents * (100 + markupPercent)) / 100);
}
