import { addInvoiceToVorgang, getVorgangById } from './vorgangService';
import { createCompanyProfileSnapshot } from './companyProfileService';
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
  InvoiceDraft,
  InvoiceDraftPosition,
  InvoiceTotals,
  MaterialStandard,
  OrderPosition,
  OrderPositionEditableField,
  PositionBillingStatus,
  TaxStatus,
  Vorgang,
  VorgangInvoice,
  VorgangInvoiceLine,
} from '../types/models';

const COUNTED_STATUSES: VorgangInvoice['status'][] = ['vorbereitet', 'versendet'];

export function getTaxRateForStatus(status: TaxStatus | string): number {
  switch (status) {
    case 'standard_19':
      return 19;
    case 'kleinunternehmer_19':
      return 0;
    case 'reverse_charge_13b':
      return 0;
    default:
      return 19;
  }
}

export function buildLegalNotices(taxStatus: TaxStatus): string[] {
  switch (taxStatus) {
    case 'kleinunternehmer_19':
      return ['Gemäß § 19 UStG wird keine Umsatzsteuer ausgewiesen.'];
    case 'reverse_charge_13b':
      return [
        'Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.',
        'Bitte prüfen oder Steuerberater/Ansprechpartner fragen.',
      ];
    default:
      return [];
  }
}

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
    skontoText: profile.defaultSkonto,
    customerBilling: getVorgangCustomerBilling(vorgang),
    companySnapshot: profile,
    legalNotices: buildLegalNotices(setup.taxStatus),
    previousAbschlagDeductions:
      type === 'schluss' ? getPreviousAbschlagDeductions(vorgang) : [],
    invoiceNumberPreview: INVOICE_DRAFT_LABEL,
  };
}

export function enrichDraftWithPreviewNumber(draft: InvoiceDraft): InvoiceDraft {
  return {
    ...draft,
    invoiceNumberPreview: getNextInvoiceNumberPreview(),
  };
}

export function isPositionBillable(
  position: OrderPosition,
  materialSource: MaterialStandard,
): boolean {
  if (position.category !== 'material') return true;

  switch (materialSource) {
    case 'auftraggeber':
      return false;
    case 'betrieb':
      return true;
    case 'gemischt':
      return position.billable ?? true;
    case 'unclear':
    default:
      return true;
  }
}

export function getBilledQuantity(vorgang: Vorgang, orderPositionId: string): number {
  return vorgang.invoices
    .filter((inv) => COUNTED_STATUSES.includes(inv.status))
    .flatMap((inv) => inv.positions ?? [])
    .filter((p) => p.orderPositionId === orderPositionId)
    .reduce((sum, p) => sum + p.quantity, 0);
}

export function getOpenQuantity(vorgang: Vorgang, orderPositionId: string): number {
  const orderPosition = vorgang.orderPositions.find((p) => p.id === orderPositionId);
  if (!orderPosition) return 0;
  return Math.max(0, orderPosition.plannedQuantity - getBilledQuantity(vorgang, orderPositionId));
}

export function getNextAbschlagNumber(vorgang: Vorgang): number {
  const numbers = vorgang.invoices
    .filter(
      (inv) =>
        inv.type === 'abschlag' &&
        COUNTED_STATUSES.includes(inv.status) &&
        typeof inv.abschlagNumber === 'number',
    )
    .map((inv) => inv.abschlagNumber as number);

  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

export function hasSchlussrechnung(vorgang: Vorgang): boolean {
  return vorgang.invoices.some(
    (inv) => inv.type === 'schluss' && COUNTED_STATUSES.includes(inv.status),
  );
}

export function hasFinalSchlussrechnung(vorgang: Vorgang): boolean {
  return hasSchlussrechnung(vorgang);
}

export function getPositionBillingStatus(
  vorgang: Vorgang,
  orderPositionId: string,
): PositionBillingStatus | null {
  const orderPosition = vorgang.orderPositions.find((p) => p.id === orderPositionId);
  if (!orderPosition) return null;

  const billedQuantity = getBilledQuantity(vorgang, orderPositionId);
  const openQuantity = Math.max(0, orderPosition.plannedQuantity - billedQuantity);

  return {
    orderPositionId,
    billedQuantity,
    openQuantity,
    plannedQuantity: orderPosition.plannedQuantity,
    hasBilling: billedQuantity > 0,
    isFullyBilled: billedQuantity >= orderPosition.plannedQuantity,
  };
}

export function canAddOrderPosition(vorgang: Vorgang): boolean {
  return !hasFinalSchlussrechnung(vorgang);
}

export function canDeleteOrderPosition(vorgang: Vorgang, orderPositionId: string): boolean {
  if (hasFinalSchlussrechnung(vorgang)) return false;
  return getBilledQuantity(vorgang, orderPositionId) === 0;
}

export function canEditOrderPositionField(
  vorgang: Vorgang,
  orderPositionId: string,
  field: OrderPositionEditableField,
): boolean {
  if (hasFinalSchlussrechnung(vorgang)) return false;

  const billedQuantity = getBilledQuantity(vorgang, orderPositionId);

  if (billedQuantity === 0) {
    return true;
  }

  if (field === 'description' || field === 'plannedQuantity') {
    return true;
  }

  return false;
}

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
    type,
    abschlagNumber,
    taxStatus: setup.taxStatus,
    materialSource: vorgang.materialSource,
    positions,
    ...buildDraftMetadata(vorgang, setup, type),
  };
}

export function buildAbschlagDraft(vorgangId: string, setup: CompanySetup): InvoiceDraft | null {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang || vorgang.orderPositions.length === 0) return null;

  return buildBaseDraft(
    vorgang,
    setup,
    'abschlag',
    vorgang.orderPositions.map((op) => buildDraftPosition(vorgang, op, 0)),
    getNextAbschlagNumber(vorgang),
  );
}

export function buildSchlussrechnungDraft(vorgangId: string, setup: CompanySetup): InvoiceDraft | null {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang || vorgang.orderPositions.length === 0) return null;

  return buildBaseDraft(
    vorgang,
    setup,
    'schluss',
    vorgang.orderPositions.map((op) => {
      const openQuantity = getOpenQuantity(vorgang, op.id);
      return buildDraftPosition(vorgang, op, openQuantity);
    }),
  );
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

export function getAbschlagDeductionsTotal(deductions: AbschlagDeduction[]): number {
  return deductions.reduce((sum, item) => sum + item.amount, 0);
}

export function calculateInvoiceTotals(draft: InvoiceDraft, setup: CompanySetup): InvoiceTotals {
  const subtotal = draft.positions.reduce((sum, p) => sum + p.quantity * p.unitPrice, 0);
  const taxRate = getTaxRateForStatus(setup.taxStatus);
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
      unitPrice: p.unitPrice,
      lineTotal: p.quantity * p.unitPrice,
    }));

  const issueDate = draft.issueDate || now.slice(0, 10);

  const invoice: VorgangInvoice = {
    id: `inv-${Date.now()}`,
    number: reservation.formatted,
    invoiceSequenceNumber: reservation.sequenceNumber,
    type: draft.type,
    abschlagNumber: draft.type === 'abschlag' ? draft.abschlagNumber : undefined,
    positions,
    subtotal: totals.subtotal,
    taxStatus: setup.taxStatus,
    amount: totals.total,
    status: 'vorbereitet',
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
  };

  return addInvoiceToVorgang(vorgangId, invoice);
}
