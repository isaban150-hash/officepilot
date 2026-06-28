import { getAbschlagDeductionsTotal, calculateInvoiceTotals, getTaxRateForStatus } from './invoiceService';
import type {
  CompanySetup,
  InvoiceDraft,
  InvoicePrintDeductionLine,
  InvoicePrintModel,
  InvoicePrintPosition,
  TaxStatus,
  VorgangInvoice,
} from '../types/models';

function documentTitle(type: InvoiceDraft['type'], abschlagNumber?: number): string {
  if (type === 'schluss') return 'Schlussrechnung';
  return abschlagNumber ? `Abschlagsrechnung ${abschlagNumber}` : 'Abschlagsrechnung';
}

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
      unit: position.unit,
      unitPrice: position.unitPrice,
      lineTotal: position.quantity * position.unitPrice,
    }));
}

function documentTitleFromInvoice(invoice: VorgangInvoice): string {
  if (invoice.type === 'schluss') return 'Schlussrechnung';
  return invoice.abschlagNumber
    ? `Abschlagsrechnung ${invoice.abschlagNumber}`
    : 'Abschlagsrechnung';
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
    unit: position.unit,
    unitPrice: position.unitPrice,
    lineTotal: position.lineTotal,
  }));
}

export function buildInvoicePrintModelFromInvoice(invoice: VorgangInvoice): InvoicePrintModel {
  if (!invoice.companySnapshot || !invoice.customerSnapshot) {
    throw new Error('Invoice snapshots missing – cannot render finalized invoice.');
  }

  const taxRate = getTaxRateForStatus(invoice.taxStatus);
  const taxAmount = invoice.subtotal * (taxRate / 100);
  const grossTotal = invoice.subtotal + taxAmount;
  const deductions = invoice.previousAbschlagDeductions ?? [];
  const deductionsTotal = getAbschlagDeductionsTotal(deductions);
  const amountDue =
    invoice.type === 'schluss' ? Math.max(0, grossTotal - deductionsTotal) : grossTotal;

  return {
    type: invoice.type,
    documentTitle: documentTitleFromInvoice(invoice),
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
  const grossTotal = totals.subtotal + totals.tax;
  const deductionsTotal = getAbschlagDeductionsTotal(draft.previousAbschlagDeductions);
  const amountDue = Math.max(0, grossTotal - deductionsTotal);

  return {
    type: draft.type,
    documentTitle: documentTitle(draft.type, draft.abschlagNumber),
    invoiceNumber: draft.invoiceNumberPreview,
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
      amountDue: draft.type === 'schluss' ? amountDue : grossTotal,
    },
    taxStatus: draft.taxStatus,
    taxNotices: [...draft.legalNotices],
    paymentDueDate: draft.paymentDueDate,
    paymentTermsText: draft.paymentTermsText,
    skontoText: draft.skontoText,
    footerNotes: draft.companySnapshot.invoiceFooterNotes,
  };
}

export function getTaxStatusLabel(taxStatus: TaxStatus): string {
  switch (taxStatus) {
    case 'kleinunternehmer_19':
      return '§19 Kleinunternehmer';
    case 'reverse_charge_13b':
      return '§13b Reverse Charge';
    case 'standard_19':
      return 'Normalbesteuerung (19 % USt)';
    default:
      return 'Steuerstatus unklar – bitte prüfen';
  }
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
