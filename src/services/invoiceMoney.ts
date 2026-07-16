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
