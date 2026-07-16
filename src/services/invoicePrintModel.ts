import { calculateInvoiceTotals } from './invoiceService';
import { getAbschlagDeductionsTotal } from './invoiceDeductions';
import { fromCents, taxCentsFromNet, toCents } from './invoiceMoney';
import { formatOrderUnitDisplay } from './orderUnitMapper';
import { getTaxRateForStatus } from './invoiceTaxService';
import { getInvoiceDocumentTitle, usesAbschlagDeductions } from './invoiceTypeService';
import type {
  CompanySetup,
  InvoiceDraft,
  InvoicePrintDeductionLine,
  InvoicePrintModel,
  InvoicePrintPosition,
  VorgangInvoice,
} from '../types/models';

export { getTaxStatusLabel } from './invoiceTaxService';

function buildDeductionLines(draft: InvoiceDraft): InvoicePrintDeductionLine[] {
  return draft.previousAbschlagDeductions.map((item, index) => ({
    label: item.abschlagNumber ? `Abschlag ${item.abschlagNumber}` : `Abschlag ${index + 1}`,
    invoiceNumber: item.invoiceNumber,
    amount: item.amount,
  }));
}

function buildPositions(draft: InvoiceDraft): InvoicePrintPosition[] {
  return draft.positions
    .filter((position) => position.quantity > 0)
    .map((position, index) => ({
      index: index + 1,
      description: position.description,
      quantity: position.quantity,
      unit: formatOrderUnitDisplay(position.unit, position.unitLabel),
      unitPrice: position.unitPrice,
      lineTotal: position.quantity * position.unitPrice,
    }));
}

function buildDeductionLinesFromInvoice(invoice: VorgangInvoice): InvoicePrintDeductionLine[] {
  return (invoice.previousAbschlagDeductions ?? []).map((item, index) => ({
    label: item.abschlagNumber ? `Abschlag ${item.abschlagNumber}` : `Abschlag ${index + 1}`,
    invoiceNumber: item.invoiceNumber,
    amount: item.amount,
  }));
}

function buildPositionsFromInvoice(invoice: VorgangInvoice): InvoicePrintPosition[] {
  return invoice.positions.map((position, index) => ({
    index: index + 1,
    description: position.description,
    quantity: position.quantity,
    unit: formatOrderUnitDisplay(position.unit, position.unitLabel),
    unitPrice: position.unitPrice,
    lineTotal: position.lineTotal,
  }));
}

export function buildInvoicePrintModelFromInvoice(invoice: VorgangInvoice): InvoicePrintModel {
  if (!invoice.companySnapshot || !invoice.customerSnapshot) {
    throw new Error('Invoice snapshots missing – cannot render finalized invoice.');
  }

  const taxRate = getTaxRateForStatus(invoice.taxStatus);
  const subtotalCents = toCents(invoice.subtotal);
  const taxCents = taxCentsFromNet(subtotalCents, taxRate);
  const taxAmount = fromCents(taxCents);
  const grossTotal = fromCents(subtotalCents + taxCents);
  const deductions = invoice.previousAbschlagDeductions ?? [];
  const deductionsTotal = getAbschlagDeductionsTotal(deductions);
  const amountDue = usesAbschlagDeductions(invoice.type)
    ? Math.max(0, fromCents(subtotalCents + taxCents - toCents(deductionsTotal)))
    : fromCents(subtotalCents + taxCents);

  return {
    type: invoice.type,
    documentTitle: getInvoiceDocumentTitle(invoice.type, invoice.abschlagNumber),
    invoiceNumber: invoice.number,
    issueDate: invoice.issueDate ?? invoice.date,
    company: { ...invoice.companySnapshot },
    customer: { ...invoice.customerSnapshot },
    projectTitle: invoice.vorgangTitle ?? '—',
    projectSite: invoice.baustelle ?? '',
    servicePeriodFrom: invoice.servicePeriodFrom ?? invoice.issueDate ?? invoice.date,
    servicePeriodTo: invoice.servicePeriodTo ?? invoice.issueDate ?? invoice.date,
    introText: invoice.introText ?? '',
    closingText: invoice.closingText ?? '',
    positions: buildPositionsFromInvoice(invoice),
    summary: {
      subtotalNet: invoice.subtotal,
      taxRate,
      taxAmount,
      grossTotal,
      deductionLines: buildDeductionLinesFromInvoice(invoice),
      deductionsTotal,
      amountDue,
    },
    taxStatus: invoice.taxStatus,
    taxNotices: [...(invoice.legalNotices ?? [])],
    paymentDueDate: invoice.paymentDueDate ?? '',
    paymentTermsText: invoice.paymentTermsText ?? '',
    skontoText: invoice.skontoText ?? '',
    footerNotes: invoice.companySnapshot.invoiceFooterNotes,
  };
}

export function buildInvoicePrintModel(
  draft: InvoiceDraft,
  setup: CompanySetup,
): InvoicePrintModel {
  const totals = calculateInvoiceTotals(draft, setup);
  const grossTotal = fromCents(toCents(totals.subtotal) + toCents(totals.tax));
  const deductionsTotal = getAbschlagDeductionsTotal(draft.previousAbschlagDeductions);
  const amountDue = Math.max(0, fromCents(toCents(grossTotal) - toCents(deductionsTotal)));

  return {
    type: draft.type,
    documentTitle: getInvoiceDocumentTitle(draft.type, draft.abschlagNumber),
    invoiceNumber: draft.invoiceNumberPreview || 'ENTWURF',
    issueDate: draft.issueDate,
    company: { ...draft.companySnapshot },
    customer: { ...draft.customerBilling },
    projectTitle: draft.vorgangTitle,
    projectSite: draft.baustelle,
    servicePeriodFrom: draft.servicePeriodFrom,
    servicePeriodTo: draft.servicePeriodTo,
    introText: draft.introText,
    closingText: draft.closingText,
    positions: buildPositions(draft),
    summary: {
      subtotalNet: totals.subtotal,
      taxRate: totals.taxRate,
      taxAmount: totals.tax,
      grossTotal,
      deductionLines: buildDeductionLines(draft),
      deductionsTotal,
      amountDue: usesAbschlagDeductions(draft.type) ? amountDue : grossTotal,
    },
    taxStatus: draft.taxStatus,
    taxNotices: [...draft.legalNotices],
    paymentDueDate: draft.paymentDueDate,
    paymentTermsText: draft.paymentTermsText,
    skontoText: draft.skontoText,
    footerNotes: draft.companySnapshot.invoiceFooterNotes,
  };
}

export function formatInvoiceCurrency(value: number): string {
  return `${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

export function formatInvoiceDate(value: string): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('de-DE');
  } catch {
    return value;
  }
}
