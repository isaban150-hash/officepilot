import type { AbschlagDeduction } from '../types/models';
import { fromCents, toCents } from './invoiceMoney';

/** Sum of abschlag deduction amounts (cent-safe). Shared by totals + schluss display. */
export function getAbschlagDeductionsTotal(deductions: AbschlagDeduction[]): number {
  const cents = deductions.reduce((sum, item) => {
    const value = toCents(item.amount);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
  return fromCents(cents);
}
