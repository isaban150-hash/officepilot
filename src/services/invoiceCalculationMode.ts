/**
 * PAUSCHALER-ABSCHLAG-01 — calculation mode helpers shared by totals, validation, print.
 */
import type {
  InvoiceCalculationMode,
  InvoiceDocumentType,
  InvoiceDraft,
  VorgangInvoice,
} from '../types/models';

export const FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION =
  'Pauschale Abschlagszahlung gemäß Baufortschritt';

export function resolveInvoiceCalculationMode(
  entity: Pick<InvoiceDraft, 'type' | 'calculationMode'> | Pick<VorgangInvoice, 'type' | 'calculationMode'>,
): InvoiceCalculationMode {
  if (entity.calculationMode === 'fixed_amount') return 'fixed_amount';
  if (entity.calculationMode === 'quantity_based') return 'quantity_based';
  return 'quantity_based';
}

export function isFixedAmountAbschlag(
  entity: Pick<InvoiceDraft, 'type' | 'calculationMode'> | Pick<VorgangInvoice, 'type' | 'calculationMode'>,
): boolean {
  return entity.type === 'abschlag' && resolveInvoiceCalculationMode(entity) === 'fixed_amount';
}

export function assertCalculationModeAllowed(
  type: InvoiceDocumentType,
  mode: InvoiceCalculationMode,
): boolean {
  if (mode === 'fixed_amount') return type === 'abschlag';
  return true;
}
