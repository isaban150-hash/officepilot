import type { TranslationKey } from '../i18n';
import type {
  CompanyProfile,
  CustomerBilling,
  InvoiceDraft,
  Vorgang,
  VorgangInvoice,
} from '../types/models';
import { INVOICE_DRAFT_LABEL } from './invoiceNumberService';
import { getTaxRateForStatus } from './invoiceTaxService';
import { getAbschlagDeductionsTotal } from './invoiceDeductions';
import {
  fromCents,
  isValidMoneyNumber,
  lineTotalCents,
  sumCents,
  taxCentsFromNet,
  toCents,
} from './invoiceMoney';

function isFinalizedInvoiceStatus(invoice: VorgangInvoice): boolean {
  return invoice.status === 'vorbereitet' || invoice.status === 'versendet';
}

export interface InvoiceValidationIssue {
  code: string;
  messageKey: TranslationKey;
}

export interface InvoiceValidationResult {
  blockingErrors: InvoiceValidationIssue[];
  warnings: InvoiceValidationIssue[];
}

export interface InvoiceApprovalOptions {
  reverseCharge13bConfirmed?: boolean;
}

function hasUsableAddress(parts: { street?: string; zip?: string; city?: string }): boolean {
  return Boolean(parts.street?.trim() && parts.zip?.trim() && parts.city?.trim());
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  const time = Date.parse(`${value.trim()}T00:00:00.000Z`);
  return Number.isFinite(time);
}

function customerBlocks(billing: CustomerBilling, errors: InvoiceValidationIssue[]): void {
  if (!billing.name?.trim()) {
    errors.push({ code: 'customer_name', messageKey: 'invoice.validation.customerName' });
  }
  if (!hasUsableAddress(billing)) {
    errors.push({ code: 'customer_address', messageKey: 'invoice.validation.customerAddress' });
  }
}

function companyBlocks(company: CompanyProfile, errors: InvoiceValidationIssue[]): void {
  if (!company.companyName?.trim()) {
    errors.push({ code: 'company_name', messageKey: 'invoice.validation.companyName' });
  }
  if (!hasUsableAddress(company)) {
    errors.push({ code: 'company_address', messageKey: 'invoice.validation.companyAddress' });
  }
}

function companyWarnings(company: CompanyProfile, warnings: InvoiceValidationIssue[]): void {
  if (!company.iban?.trim()) {
    warnings.push({ code: 'company_iban', messageKey: 'invoice.validation.warn.iban' });
  }
  if (!company.phone?.trim() && !company.email?.trim()) {
    warnings.push({ code: 'company_contact', messageKey: 'invoice.validation.warn.contact' });
  }
  if (!company.logoDataUrl?.trim()) {
    warnings.push({ code: 'company_logo', messageKey: 'invoice.validation.warn.logo' });
  }
  if (!company.skontoEnabled && !company.defaultSkonto?.trim()) {
    warnings.push({ code: 'skonto', messageKey: 'invoice.validation.warn.skonto' });
  }
}

/**
 * Central approval validation for invoice drafts.
 * Does not invent missing customer/company/tax data.
 */
export function validateInvoiceDraftForApproval(
  draft: InvoiceDraft,
  _companyProfile: CompanyProfile,
  vorgang: Vorgang | undefined,
  options: InvoiceApprovalOptions = {},
): InvoiceValidationResult {
  const blockingErrors: InvoiceValidationIssue[] = [];
  const warnings: InvoiceValidationIssue[] = [];

  // Prefer draft snapshots (what will be stored).
  customerBlocks(draft.customerBilling, blockingErrors);
  companyBlocks(draft.companySnapshot, blockingErrors);
  companyWarnings(draft.companySnapshot, warnings);

  if (!draft.issueDate?.trim() || !isIsoDate(draft.issueDate)) {
    blockingErrors.push({ code: 'issue_date', messageKey: 'invoice.validation.issueDate' });
  }
  if (
    !draft.servicePeriodFrom?.trim() ||
    !draft.servicePeriodTo?.trim() ||
    !isIsoDate(draft.servicePeriodFrom) ||
    !isIsoDate(draft.servicePeriodTo)
  ) {
    blockingErrors.push({
      code: 'service_period',
      messageKey: 'invoice.validation.servicePeriod',
    });
  }
  if (!draft.paymentDueDate?.trim() || !isIsoDate(draft.paymentDueDate)) {
    blockingErrors.push({
      code: 'payment_due',
      messageKey: 'invoice.validation.paymentDueDate',
    });
  } else if (
    draft.issueDate &&
    isIsoDate(draft.issueDate) &&
    draft.paymentDueDate < draft.issueDate
  ) {
    blockingErrors.push({
      code: 'payment_due_before_issue',
      messageKey: 'invoice.validation.paymentDueBeforeIssue',
    });
  }

  const activePositions = draft.positions.filter((p) => p.billable && p.quantity > 0);
  if (activePositions.length === 0) {
    blockingErrors.push({ code: 'no_positions', messageKey: 'invoice.validation.noPositions' });
  }

  for (const position of draft.positions) {
    if (!position.billable || position.quantity <= 0) continue;
    if (!position.description?.trim()) {
      blockingErrors.push({
        code: 'position_description',
        messageKey: 'invoice.validation.positionDescription',
      });
    }
    if (!isValidMoneyNumber(position.quantity) || position.quantity <= 0) {
      blockingErrors.push({
        code: 'position_quantity',
        messageKey: 'invoice.validation.positionQuantity',
      });
    }
    if (!position.unit) {
      blockingErrors.push({
        code: 'position_unit',
        messageKey: 'invoice.validation.positionUnit',
      });
    }
    if (!isValidMoneyNumber(position.unitPrice) || position.unitPrice < 0) {
      blockingErrors.push({
        code: 'position_price',
        messageKey: 'invoice.validation.positionPrice',
      });
    } else {
      const lineCents = lineTotalCents(position.quantity, position.unitPrice);
      if (!Number.isFinite(lineCents)) {
        blockingErrors.push({
          code: 'position_line_total',
          messageKey: 'invoice.validation.positionPrice',
        });
      }
    }
  }

  if (!draft.taxStatus || draft.taxStatus === 'unclear') {
    blockingErrors.push({ code: 'tax_status', messageKey: 'invoice.validation.taxStatus' });
  }

  const taxRate = getTaxRateForStatus(draft.taxStatus);
  if (
    (draft.taxStatus === 'standard_19' || draft.taxStatus === 'standard_7') &&
    taxRate <= 0
  ) {
    blockingErrors.push({ code: 'tax_rate', messageKey: 'invoice.validation.taxRate' });
  }

  if (draft.taxStatus === 'reverse_charge_13b' && !options.reverseCharge13bConfirmed) {
    blockingErrors.push({
      code: 'reverse_charge_unconfirmed',
      messageKey: 'invoice.validation.reverseChargeConfirmRequired',
    });
  }

  const positionCents = draft.positions
    .filter((p) => p.quantity > 0)
    .map((p) => lineTotalCents(p.quantity, p.unitPrice));
  const subtotalCents = sumCents(positionCents.filter(Number.isFinite));
  const taxCents = taxCentsFromNet(subtotalCents, taxRate);
  const grossCents = subtotalCents + taxCents;
  const deductionsCents = toCents(getAbschlagDeductionsTotal(draft.previousAbschlagDeductions));
  const amountDueCents = grossCents - (Number.isFinite(deductionsCents) ? deductionsCents : 0);
  const subtotal = fromCents(subtotalCents);
  const tax = fromCents(taxCents);
  const total = fromCents(amountDueCents);

  if (!isValidMoneyNumber(subtotal) || !isValidMoneyNumber(tax) || !isValidMoneyNumber(total)) {
    blockingErrors.push({ code: 'totals_invalid', messageKey: 'invoice.validation.totalsInvalid' });
  } else if (draft.type === 'rechnung' && amountDueCents < 0) {
    // Schluss/Abschlag keep existing clamp behaviour; only normal invoices hard-block.
    blockingErrors.push({ code: 'totals_negative', messageKey: 'invoice.validation.totalsNegative' });
  }

  if (draft.type === 'rechnung' && !vorgang?.title?.trim()) {
    warnings.push({ code: 'vorgang_title', messageKey: 'invoice.validation.warn.project' });
  }

  // Deduplicate by code
  const dedupe = (items: InvoiceValidationIssue[]) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    });
  };

  return {
    blockingErrors: dedupe(blockingErrors),
    warnings: dedupe(warnings),
  };
}

/**
 * Reuses draft approval rules for PDF export of finalized invoices.
 * Draft / non-final invoices are rejected; nothing is invented.
 */
export function validateFinalizedInvoiceForPdf(
  invoice: VorgangInvoice,
): InvoiceValidationResult {
  if (!isFinalizedInvoiceStatus(invoice)) {
    return {
      blockingErrors: [
        { code: 'not_finalized', messageKey: 'invoice.pdf.notFinalized' },
      ],
      warnings: [],
    };
  }

  const number = invoice.number?.trim() ?? '';
  if (!number || number === INVOICE_DRAFT_LABEL || number === 'ENTWURF') {
    return {
      blockingErrors: [
        { code: 'draft_number', messageKey: 'invoice.pdf.draftNumber' },
      ],
      warnings: [],
    };
  }

  if (!invoice.companySnapshot || !invoice.customerSnapshot) {
    return {
      blockingErrors: [
        { code: 'snapshots_missing', messageKey: 'invoice.pdf.snapshotsMissing' },
      ],
      warnings: [],
    };
  }

  const draft = finalizedInvoiceToValidationDraft(invoice);
  return validateInvoiceDraftForApproval(draft, invoice.companySnapshot, undefined, {
    // Already approved — do not re-require interactive §13b checkbox.
    reverseCharge13bConfirmed: true,
  });
}

function finalizedInvoiceToValidationDraft(invoice: VorgangInvoice): InvoiceDraft {
  const company = invoice.companySnapshot!;
  const customer = invoice.customerSnapshot!;
  return {
    id: invoice.id,
    vorgangId: '',
    vorgangTitle: invoice.vorgangTitle ?? '',
    customer: customer.name,
    baustelle: invoice.baustelle ?? '',
    type: invoice.type,
    abschlagNumber: invoice.abschlagNumber,
    taxStatus: invoice.taxStatus,
    materialSource: 'betrieb',
    positions: invoice.positions.map((position) => ({
      id: position.id,
      orderPositionId: position.orderPositionId,
      description: position.description,
      plannedQuantity: position.quantity,
      billedQuantity: 0,
      openQuantity: position.quantity,
      quantity: position.quantity,
      unit: position.unit,
      unitLabel: position.unitLabel,
      unitPrice: position.unitPrice,
      category: 'arbeit' as const,
      billable: true,
    })),
    issueDate: invoice.issueDate ?? invoice.date,
    servicePeriodFrom: invoice.servicePeriodFrom ?? invoice.issueDate ?? invoice.date,
    servicePeriodTo: invoice.servicePeriodTo ?? invoice.issueDate ?? invoice.date,
    paymentDueDate: invoice.paymentDueDate ?? '',
    paymentTermsText: invoice.paymentTermsText ?? '',
    skontoText: invoice.skontoText ?? '',
    customerBilling: { ...customer },
    companySnapshot: { ...company },
    legalNotices: [...(invoice.legalNotices ?? [])],
    previousAbschlagDeductions: [...(invoice.previousAbschlagDeductions ?? [])],
    invoiceNumberPreview: invoice.number,
    introText: invoice.introText ?? '',
    closingText: invoice.closingText ?? '',
  };
}
