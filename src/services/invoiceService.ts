import { addInvoiceToVorgang, getVorgangById } from './vorgangService';
import { archiveOutgoingInvoice } from './invoiceArchiveService';
import { createCompanyProfileSnapshot } from './companyProfileService';
import {
  getNextAbschlagNumber,
  getBilledQuantity,
  getOpenQuantity,
  isPositionBillable,
} from './orderBillingRules';
import {
  getNextInvoiceNumberPreview,
  INVOICE_DRAFT_LABEL,
  reserveNextInvoiceNumber,
} from './invoiceNumberService';
import type {
  AbschlagDeduction,
  CompanyProfile,
  CompanySetup,
  CustomerBilling,
  InvoiceDocumentType,
  InvoiceDraft,
  InvoiceDraftMetadataChanges,
  InvoiceDraftPosition,
  InvoiceTotals,
  OrderPosition,
  TaxStatus,
  Vorgang,
  VorgangInvoice,
  VorgangInvoiceLine,
} from '../types/models';
import {
  buildLegalNotices,
  buildSkontoText,
  getTaxRateForStatus,
} from './invoiceTaxService';
import {
  prefillsOpenQuantity,
  usesAbschlagDeductions,
  usesAbschlagNumber,
} from './invoiceTypeService';

const COUNTED_STATUSES: VorgangInvoice['status'][] = ['vorbereitet', 'versendet'];

export { buildLegalNotices, getTaxRateForStatus } from './invoiceTaxService';

export function getVorgangCustomerBilling(vorgang: Vorgang): CustomerBilling {
  if (vorgang.customerBilling) {
    return { ...vorgang.customerBilling };
  }
  return {
    name: vorgang.customer,
    contactPerson: '',
    street: '',
    zip: '',
    city: '',
    email: '',
    phone: '',
  };
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(isoDate);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildDefaultPaymentTerms(profile: CompanyProfile): string {
  if (profile.defaultPaymentTerms.trim()) {
    return profile.defaultPaymentTerms.trim();
  }
  return `Zahlbar innerhalb von ${profile.defaultPaymentDays} Tagen ohne Abzug.`;
}

export function getPreviousAbschlagDeductions(vorgang: Vorgang): AbschlagDeduction[] {
  return vorgang.invoices
    .filter((inv) => inv.type === 'abschlag' && COUNTED_STATUSES.includes(inv.status))
    .map((inv) => ({
      invoiceId: inv.id,
      invoiceNumber: inv.number,
      abschlagNumber: inv.abschlagNumber,
      date: inv.issueDate ?? inv.date,
      subtotal: inv.subtotal,
      amount: inv.amount,
    }));
}

function buildDraftMetadata(
  vorgang: Vorgang,
  setup: CompanySetup,
  type: InvoiceDraft['type'],
): Pick<
  InvoiceDraft,
  | 'issueDate'
  | 'servicePeriodFrom'
  | 'servicePeriodTo'
  | 'paymentDueDate'
  | 'paymentTermsText'
  | 'skontoText'
  | 'customerBilling'
  | 'companySnapshot'
  | 'legalNotices'
  | 'previousAbschlagDeductions'
  | 'invoiceNumberPreview'
> {
  const profile = createCompanyProfileSnapshot();
  const issueDate = new Date().toISOString().slice(0, 10);

  return {
    issueDate,
    servicePeriodFrom: issueDate,
    servicePeriodTo: issueDate,
    paymentDueDate: addDays(issueDate, profile.defaultPaymentDays),
    paymentTermsText: buildDefaultPaymentTerms(profile),
    skontoText: buildSkontoText(profile),
    customerBilling: getVorgangCustomerBilling(vorgang),
    companySnapshot: profile,
    legalNotices: buildLegalNotices(setup.taxStatus, profile),
    previousAbschlagDeductions:
      usesAbschlagDeductions(type) ? getPreviousAbschlagDeductions(vorgang) : [],
    invoiceNumberPreview: INVOICE_DRAFT_LABEL,
  };
}

export function enrichDraftWithPreviewNumber(draft: InvoiceDraft): InvoiceDraft {
  return {
    ...draft,
    invoiceNumberPreview: getNextInvoiceNumberPreview(),
  };
}

export {
  canAddOrderPosition,
  canDeleteOrderPosition,
  canEditOrderPositionField,
  getBilledQuantity,
  getNextAbschlagNumber,
  getOpenQuantity,
  getPositionBillingStatus,
  hasFinalSchlussrechnung,
  hasSchlussrechnung,
  isPositionBillable,
} from './orderBillingRules';

function buildDraftPosition(
  vorgang: Vorgang,
  orderPosition: OrderPosition,
  initialQuantity: number,
): InvoiceDraftPosition {
  const billedQuantity = getBilledQuantity(vorgang, orderPosition.id);
  const openQuantity = getOpenQuantity(vorgang, orderPosition.id);
  const billable = isPositionBillable(orderPosition, vorgang.materialSource);

  return {
    id: `draft-pos-${orderPosition.id}`,
    orderPositionId: orderPosition.id,
    description: orderPosition.description,
    plannedQuantity: orderPosition.plannedQuantity,
    billedQuantity,
    openQuantity,
    quantity: billable ? initialQuantity : 0,
    unit: orderPosition.unit,
    unitLabel: orderPosition.unitLabel,
    unitPrice: orderPosition.unitPrice,
    category: orderPosition.category,
    billable,
  };
}

function buildBaseDraft(
  vorgang: Vorgang,
  setup: CompanySetup,
  type: InvoiceDraft['type'],
  positions: InvoiceDraftPosition[],
  abschlagNumber?: number,
): InvoiceDraft {
  return {
    id: `draft-${Date.now()}`,
    vorgangId: vorgang.id,
    vorgangTitle: vorgang.title,
    customer: vorgang.customer,
    baustelle: vorgang.baustelle,
    type,
    abschlagNumber,
    taxStatus: setup.taxStatus,
    materialSource: vorgang.materialSource,
    positions,
    introText: '',
    closingText: '',
    ...buildDraftMetadata(vorgang, setup, type),
  };
}

function initialQuantityForType(
  vorgang: Vorgang,
  orderPosition: OrderPosition,
  type: InvoiceDocumentType,
): number {
  if (!prefillsOpenQuantity(type)) return 0;
  return getOpenQuantity(vorgang, orderPosition.id);
}

function buildPositionsForType(
  vorgang: Vorgang,
  type: InvoiceDocumentType,
): InvoiceDraftPosition[] {
  return vorgang.orderPositions.map((op) =>
    buildDraftPosition(vorgang, op, initialQuantityForType(vorgang, op, type)),
  );
}

export function buildInvoiceDraftForType(
  vorgangId: string,
  setup: CompanySetup,
  type: InvoiceDocumentType,
): InvoiceDraft | null {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang || vorgang.orderPositions.length === 0) return null;

  if (type === 'abschlag') {
    return buildBaseDraft(
      vorgang,
      setup,
      'abschlag',
      buildPositionsForType(vorgang, 'abschlag'),
      getNextAbschlagNumber(vorgang),
    );
  }

  if (type === 'schluss') {
    return buildBaseDraft(
      vorgang,
      setup,
      'schluss',
      buildPositionsForType(vorgang, 'schluss'),
    );
  }

  return buildBaseDraft(vorgang, setup, type, buildPositionsForType(vorgang, type));
}

export function buildRechnungDraft(vorgangId: string, setup: CompanySetup): InvoiceDraft | null {
  return buildInvoiceDraftForType(vorgangId, setup, 'rechnung');
}

export function buildAbschlagDraft(vorgangId: string, setup: CompanySetup): InvoiceDraft | null {
  return buildInvoiceDraftForType(vorgangId, setup, 'abschlag');
}

export function buildSchlussrechnungDraft(vorgangId: string, setup: CompanySetup): InvoiceDraft | null {
  return buildInvoiceDraftForType(vorgangId, setup, 'schluss');
}

export function updateInvoiceDraftTaxStatus(
  draft: InvoiceDraft,
  taxStatus: TaxStatus,
): InvoiceDraft {
  return {
    ...draft,
    taxStatus,
    legalNotices: buildLegalNotices(taxStatus, draft.companySnapshot),
  };
}
export function updateDraftPositionQuantity(
  draft: InvoiceDraft,
  positionId: string,
  quantity: number,
): InvoiceDraft {
  return {
    ...draft,
    positions: draft.positions.map((p) => {
      if (p.id !== positionId) return p;
      if (!p.billable) return p;
      return { ...p, quantity: Math.max(0, quantity) };
    }),
  };
}

export function updateInvoiceDraftMetadata(
  draft: InvoiceDraft,
  changes: InvoiceDraftMetadataChanges,
): InvoiceDraft {
  const next: InvoiceDraft = { ...draft };

  if (changes.issueDate !== undefined) next.issueDate = changes.issueDate;
  if (changes.servicePeriodFrom !== undefined) {
    next.servicePeriodFrom = changes.servicePeriodFrom;
  }
  if (changes.servicePeriodTo !== undefined) next.servicePeriodTo = changes.servicePeriodTo;
  if (changes.paymentDueDate !== undefined) next.paymentDueDate = changes.paymentDueDate;
  if (changes.paymentTermsText !== undefined) next.paymentTermsText = changes.paymentTermsText;
  if (changes.skontoText !== undefined) next.skontoText = changes.skontoText;
  if (changes.introText !== undefined) next.introText = changes.introText;
  if (changes.closingText !== undefined) next.closingText = changes.closingText;
  if (changes.projectTitle !== undefined) next.vorgangTitle = changes.projectTitle;
  if (changes.projectSite !== undefined) next.baustelle = changes.projectSite;
  if (changes.customerBilling) {
    next.customerBilling = { ...next.customerBilling, ...changes.customerBilling };
  }

  return next;
}

export function getAbschlagDeductionsTotal(deductions: AbschlagDeduction[]): number {
  return deductions.reduce((sum, item) => sum + item.amount, 0);
}

export function calculateInvoiceTotals(draft: InvoiceDraft, setup: CompanySetup): InvoiceTotals {
  const subtotal = draft.positions.reduce((sum, p) => sum + p.quantity * p.unitPrice, 0);
  const taxRate = getTaxRateForStatus(draft.taxStatus ?? setup.taxStatus);
  const tax = subtotal * (taxRate / 100);
  const gross = subtotal + tax;
  const deductions = getAbschlagDeductionsTotal(draft.previousAbschlagDeductions);
  return { subtotal, taxRate, tax, total: Math.max(0, gross - deductions) };
}

export function getOverbillingWarnings(draft: InvoiceDraft): string[] {
  return draft.positions
    .filter((p) => p.billable && p.quantity > p.openQuantity)
    .map(
      (p) =>
        `${p.description}: ${p.quantity} eingegeben, aber nur ${p.openQuantity} ${p.unit} offen.`,
    );
}

function cloneCustomerBilling(billing: CustomerBilling): CustomerBilling {
  return { ...billing };
}

function cloneCompanySnapshot(profile: CompanyProfile): CompanyProfile {
  return { ...profile, logoDataUrl: profile.logoDataUrl };
}

export function finalizeInvoiceDraft(
  vorgangId: string,
  draft: InvoiceDraft,
  setup: CompanySetup,
): VorgangInvoice | null {
  const totals = calculateInvoiceTotals(draft, setup);
  const now = new Date().toISOString();
  const reservation = reserveNextInvoiceNumber();

  const positions: VorgangInvoiceLine[] = draft.positions
    .filter((p) => p.quantity > 0)
    .map((p) => ({
      id: `inv-line-${p.orderPositionId}-${Date.now()}`,
      orderPositionId: p.orderPositionId,
      description: p.description,
      quantity: p.quantity,
      unit: p.unit,
      unitLabel: p.unitLabel,
      unitPrice: p.unitPrice,
      lineTotal: p.quantity * p.unitPrice,
    }));

  const issueDate = draft.issueDate || now.slice(0, 10);

  const invoice: VorgangInvoice = {
    id: `inv-${Date.now()}`,
    number: reservation.formatted,
    invoiceSequenceNumber: reservation.sequenceNumber,
    type: draft.type,
    abschlagNumber: usesAbschlagNumber(draft.type) ? draft.abschlagNumber : undefined,
    positions,
    subtotal: totals.subtotal,
    taxStatus: draft.taxStatus ?? setup.taxStatus,
    amount: totals.total,
    status: 'vorbereitet',
    paymentStatus: 'offen',
    payments: [],
    date: issueDate,
    createdAt: now,
    issueDate,
    servicePeriodFrom: draft.servicePeriodFrom,
    servicePeriodTo: draft.servicePeriodTo,
    paymentDueDate: draft.paymentDueDate,
    paymentTermsText: draft.paymentTermsText,
    skontoText: draft.skontoText,
    customerSnapshot: cloneCustomerBilling(draft.customerBilling),
    companySnapshot: cloneCompanySnapshot(draft.companySnapshot),
    legalNotices: [...draft.legalNotices],
    previousAbschlagDeductions: draft.previousAbschlagDeductions.map((item) => ({ ...item })),
    introText: draft.introText,
    closingText: draft.closingText,
    baustelle: draft.baustelle,
    vorgangTitle: draft.vorgangTitle,
  };

  const saved = addInvoiceToVorgang(vorgangId, invoice);
  if (!saved) return null;

  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return saved;

  const archiveResult = archiveOutgoingInvoice(vorgangId, saved, setup.companyName);
  if (archiveResult.success) {
    return archiveResult.invoice;
  }

  return saved;
}
