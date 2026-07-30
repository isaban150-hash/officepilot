import { addInvoiceToVorgang, getVorgangById } from './vorgangService';
import { archiveOutgoingInvoice } from './invoiceArchiveService';
import { createCompanyProfileSnapshot } from './companyProfileService';
import {
  getNextAbschlagNumber,
  getBilledQuantity,
  getBillableOpenQuantity,
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
  InvoiceCalculationMode,
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
  isFixedAmountAbschlag,
  resolveInvoiceCalculationMode,
} from './invoiceCalculationMode';
import {
  buildLegalNotices,
  getTaxRateForStatus,
} from './invoiceTaxService';
import {
  prefillsOpenQuantity,
  usesAbschlagDeductions,
  usesAbschlagNumber,
} from './invoiceTypeService';
import { getAbschlagDeductionsTotal } from './invoiceDeductions';
import {
  fromCents,
  lineTotalCents,
  lineTotalMoney,
  roundMoney,
  sumCents,
  taxCentsFromNet,
  toCents,
} from './invoiceMoney';
import {
  validateInvoiceDraftForApproval,
  type InvoiceApprovalOptions,
  type InvoiceValidationResult,
} from './invoiceValidationService';

const COUNTED_STATUSES: VorgangInvoice['status'][] = ['vorbereitet', 'versendet'];

export { buildLegalNotices, getTaxRateForStatus } from './invoiceTaxService';
export { getAbschlagDeductionsTotal } from './invoiceDeductions';
export { validateInvoiceDraftForApproval } from './invoiceValidationService';
export { INVOICE_DRAFT_LABEL } from './invoiceNumberService';
export {
  isFixedAmountAbschlag,
  resolveInvoiceCalculationMode,
  FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION,
} from './invoiceCalculationMode';

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
    skontoText: '',
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
  getBillableOpenQuantity,
  getNextAbschlagNumber,
  getOpenQuantity,
  getPositionBillingStatus,
  hasFinalSchlussrechnung,
  hasAbschlagsrechnung,
  hasSchlussrechnung,
  isPositionBillable,
} from './orderBillingRules';

function buildDraftPosition(
  vorgang: Vorgang,
  orderPosition: OrderPosition,
  initialQuantity: number,
): InvoiceDraftPosition {
  const billedQuantity = getBilledQuantity(vorgang, orderPosition.id);
  const openQuantity = getBillableOpenQuantity(vorgang, orderPosition.id);
  const billable = isPositionBillable(orderPosition, vorgang.materialSource);

  return {
    id: `draft-pos-${orderPosition.id}`,
    orderPositionId: orderPosition.id,
    description: orderPosition.description,
    plannedQuantity: orderPosition.plannedQuantity,
    executedQuantity: orderPosition.executedQuantity,
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
  const draft: InvoiceDraft = {
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
    calculationMode: type === 'abschlag' ? 'quantity_based' : undefined,
    introText: '',
    closingText: '',
    ...buildDraftMetadata(vorgang, setup, type),
  };
  // Freeze amendment revision at Schluss preparation time (ORDER-AMENDMENT-01B2).
  if (type === 'schluss') {
    const sequences = (vorgang.confirmedOrderAmendments ?? []).map((item) => item.sequenceNo);
    draft.expectedAmendmentSequence =
      sequences.length > 0 ? Math.max(...sequences) : 0;
  }
  return draft;
}

function initialQuantityForType(
  vorgang: Vorgang,
  orderPosition: OrderPosition,
  type: InvoiceDocumentType,
): number {
  if (!prefillsOpenQuantity(type)) return 0;
  return getBillableOpenQuantity(vorgang, orderPosition.id);
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

/**
 * Switch Abschlag draft between quantity_based and fixed_amount.
 * Clears the inactive calculation basis so totals never double-count.
 */
export function setAbschlagDraftCalculationMode(
  draft: InvoiceDraft,
  mode: InvoiceCalculationMode,
  setup: CompanySetup,
): InvoiceDraft {
  if (draft.type !== 'abschlag') return draft;

  if (mode === 'fixed_amount') {
    return {
      ...draft,
      calculationMode: 'fixed_amount',
      positions: [],
      fixedAmountNet:
        draft.calculationMode === 'fixed_amount' && draft.fixedAmountNet != null
          ? draft.fixedAmountNet
          : undefined,
    };
  }

  const rebuilt = buildAbschlagDraft(draft.vorgangId, setup);
  if (!rebuilt) {
    return {
      ...draft,
      calculationMode: 'quantity_based',
      fixedAmountNet: undefined,
    };
  }

  return {
    ...rebuilt,
    id: draft.id,
    calculationMode: 'quantity_based',
    fixedAmountNet: undefined,
    issueDate: draft.issueDate,
    servicePeriodFrom: draft.servicePeriodFrom,
    servicePeriodTo: draft.servicePeriodTo,
    paymentDueDate: draft.paymentDueDate,
    paymentTermsText: draft.paymentTermsText,
    skontoText: draft.skontoText,
    introText: draft.introText,
    closingText: draft.closingText,
    vorgangTitle: draft.vorgangTitle,
    baustelle: draft.baustelle,
    customerBilling: draft.customerBilling,
    companySnapshot: draft.companySnapshot,
    taxStatus: draft.taxStatus,
    legalNotices: draft.legalNotices,
    invoiceNumberPreview: draft.invoiceNumberPreview,
    previousAbschlagDeductions: draft.previousAbschlagDeductions,
  };
}

export function updateInvoiceDraftFixedAmountNet(
  draft: InvoiceDraft,
  fixedAmountNet: number,
): InvoiceDraft {
  if (!isFixedAmountAbschlag(draft)) return draft;
  return {
    ...draft,
    fixedAmountNet,
  };
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
      // Confirm-first: accept only 0 ≤ quantity ≤ billableOpen (openQuantity).
      if (!Number.isFinite(quantity) || quantity < 0 || quantity > p.openQuantity) {
        return p;
      }
      return { ...p, quantity };
    }),
  };
}

export function applyAllOpenPositionsToDraft(draft: InvoiceDraft): InvoiceDraft {
  return {
    ...draft,
    positions: draft.positions.map((position) => ({
      ...position,
      quantity: position.billable ? position.openQuantity : 0,
    })),
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

export function calculateInvoiceTotals(draft: InvoiceDraft, setup: CompanySetup): InvoiceTotals {
  const taxRate = getTaxRateForStatus(draft.taxStatus ?? setup.taxStatus);
  let subtotalCents: number;

  if (isFixedAmountAbschlag(draft)) {
    const net = draft.fixedAmountNet;
    subtotalCents =
      net != null && Number.isFinite(net) && net > 0 ? toCents(roundMoney(net)) : 0;
  } else {
    const lineCents = draft.positions
      .filter((p) => p.quantity > 0)
      .map((p) => lineTotalCents(p.quantity, p.unitPrice))
      .filter((cents) => Number.isFinite(cents));
    subtotalCents = sumCents(lineCents);
  }

  const taxCents = taxCentsFromNet(subtotalCents, taxRate);
  const grossCents = subtotalCents + taxCents;
  const deductionsCents = toCents(getAbschlagDeductionsTotal(draft.previousAbschlagDeductions));
  const safeDeductions = Number.isFinite(deductionsCents) ? deductionsCents : 0;
  // Schluss/Abschlag: keep prior clamp so over-deduction does not go negative.
  const amountDueCents = usesAbschlagDeductions(draft.type)
    ? Math.max(0, grossCents - safeDeductions)
    : grossCents - safeDeductions;

  return {
    subtotal: fromCents(subtotalCents),
    taxRate,
    tax: fromCents(taxCents),
    total: fromCents(amountDueCents),
  };
}

export type FinalizeInvoiceResult =
  | { ok: true; invoice: VorgangInvoice }
  | {
      ok: false;
      reason: 'validation_failed' | 'vorgang_missing' | 'save_failed';
      validation?: InvoiceValidationResult;
    };

export type BuildInvoiceFinalizationCandidateResult =
  | { ok: true; invoice: VorgangInvoice }
  | {
      ok: false;
      reason: 'validation_failed' | 'vorgang_missing';
      validation?: InvoiceValidationResult;
    };

function validateDraftForFinalize(
  vorgangId: string,
  draft: InvoiceDraft,
  options: InvoiceApprovalOptions = {},
):
  | { ok: true; vorgang: Vorgang }
  | {
      ok: false;
      reason: 'validation_failed' | 'vorgang_missing';
      validation?: InvoiceValidationResult;
    } {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) {
    return { ok: false, reason: 'vorgang_missing' };
  }

  // Full approval validation for Rechnung and fixed-amount Abschlag.
  // Quantity-based Abschlag/Schluss keep prior finalize gate (reverse_charge only),
  // matching historical offline/test finalize behaviour.
  const fixedAbschlag = isFixedAmountAbschlag(draft);
  if (draft.type === 'rechnung' || fixedAbschlag || draft.taxStatus === 'reverse_charge_13b') {
    const validation = validateInvoiceDraftForApproval(
      draft,
      draft.companySnapshot,
      vorgang,
      options,
    );
    const blockers =
      draft.type === 'rechnung' || fixedAbschlag
        ? validation.blockingErrors
        : validation.blockingErrors.filter((e) => e.code === 'reverse_charge_unconfirmed');
    if (blockers.length > 0) {
      return {
        ok: false,
        reason: 'validation_failed',
        validation: { ...validation, blockingErrors: blockers },
      };
    }
  }

  return { ok: true, vorgang };
}

/**
 * Builds a finalized invoice candidate without reserving a local number
 * and without persisting. Used by cloud finalize orchestrator.
 */
export function buildInvoiceFinalizationCandidate(
  vorgangId: string,
  draft: InvoiceDraft,
  setup: CompanySetup,
  clientInvoiceId: string,
  options: InvoiceApprovalOptions = {},
): BuildInvoiceFinalizationCandidateResult {
  const validated = validateDraftForFinalize(vorgangId, draft, options);
  if (!validated.ok) {
    return validated;
  }

  const totals = calculateInvoiceTotals(draft, setup);
  const now = new Date().toISOString();
  const issueDate = draft.issueDate || now.slice(0, 10);
  const fixedAmount = isFixedAmountAbschlag(draft);

  const positions: VorgangInvoiceLine[] = fixedAmount
    ? []
    : draft.positions
        .filter((p) => p.quantity > 0)
        .map((p) => ({
          id: `inv-line-${clientInvoiceId}-${p.orderPositionId}`,
          orderPositionId: p.orderPositionId,
          description: p.description,
          quantity: p.quantity,
          unit: p.unit,
          unitLabel: p.unitLabel,
          unitPrice: roundMoney(p.unitPrice),
          lineTotal: lineTotalMoney(p.quantity, p.unitPrice),
        }));

  const invoice: VorgangInvoice = {
    id: clientInvoiceId,
    number: INVOICE_DRAFT_LABEL,
    type: draft.type,
    abschlagNumber: usesAbschlagNumber(draft.type) ? draft.abschlagNumber : undefined,
    positions,
    calculationMode: fixedAmount
      ? 'fixed_amount'
      : draft.type === 'abschlag'
        ? 'quantity_based'
        : undefined,
    fixedAmountNet: fixedAmount ? roundMoney(draft.fixedAmountNet ?? 0) : undefined,
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
    // Frozen at draft creation for Schluss — never recomputed here (01B2).
    expectedAmendmentSequence:
      draft.type === 'schluss'
        ? draft.expectedAmendmentSequence ?? 0
        : undefined,
  };

  return { ok: true, invoice };
}

/** Stable fingerprint of finalizeable content (excludes number / client id / timestamps). */
export function buildInvoiceFinalizationContentFingerprint(
  draft: InvoiceDraft,
  setup: CompanySetup,
): string {
  const totals = calculateInvoiceTotals(draft, setup);
  return buildInvoiceContentFingerprintPayload({
    type: draft.type,
    abschlagNumber: draft.abschlagNumber ?? null,
    taxStatus: draft.taxStatus ?? setup.taxStatus,
    issueDate: draft.issueDate ?? null,
    servicePeriodFrom: draft.servicePeriodFrom ?? null,
    servicePeriodTo: draft.servicePeriodTo ?? null,
    paymentDueDate: draft.paymentDueDate ?? null,
    paymentTermsText: draft.paymentTermsText ?? '',
    skontoText: draft.skontoText ?? '',
    introText: draft.introText ?? '',
    closingText: draft.closingText ?? '',
    baustelle: draft.baustelle ?? '',
    vorgangTitle: draft.vorgangTitle ?? '',
    customerBilling: draft.customerBilling,
    subtotal: totals.subtotal,
    amount: totals.total,
    calculationMode: resolveInvoiceCalculationMode(draft),
    fixedAmountNet: isFixedAmountAbschlag(draft)
      ? roundMoney(draft.fixedAmountNet ?? 0)
      : null,
    expectedAmendmentSequence:
      draft.type === 'schluss' ? (draft.expectedAmendmentSequence ?? 0) : null,
    positions: isFixedAmountAbschlag(draft)
      ? []
      : draft.positions
          .filter((p) => p.quantity > 0)
          .map((p) => ({
            orderPositionId: p.orderPositionId,
            description: p.description,
            quantity: p.quantity,
            unit: p.unit,
            unitLabel: p.unitLabel ?? null,
            unitPrice: roundMoney(p.unitPrice),
            lineTotal: lineTotalMoney(p.quantity, p.unitPrice),
            billable: p.billable,
          })),
  });
}

/**
 * Content fingerprint from a finalized VorgangInvoice (for intent reconciliation on pull).
 * Shape matches buildInvoiceFinalizationContentFingerprint (billable assumed true for lines).
 */
export function buildInvoiceContentFingerprintFromInvoice(invoice: VorgangInvoice): string {
  return buildInvoiceContentFingerprintPayload({
    type: invoice.type,
    abschlagNumber: invoice.abschlagNumber ?? null,
    taxStatus: invoice.taxStatus,
    issueDate: invoice.issueDate ?? null,
    servicePeriodFrom: invoice.servicePeriodFrom ?? null,
    servicePeriodTo: invoice.servicePeriodTo ?? null,
    paymentDueDate: invoice.paymentDueDate ?? null,
    paymentTermsText: invoice.paymentTermsText ?? '',
    skontoText: invoice.skontoText ?? '',
    introText: invoice.introText ?? '',
    closingText: invoice.closingText ?? '',
    baustelle: invoice.baustelle ?? '',
    vorgangTitle: invoice.vorgangTitle ?? '',
    customerBilling: invoice.customerSnapshot ?? {
      name: '',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    },
    subtotal: invoice.subtotal,
    amount: invoice.amount,
    calculationMode: resolveInvoiceCalculationMode(invoice),
    fixedAmountNet: isFixedAmountAbschlag(invoice)
      ? roundMoney(invoice.fixedAmountNet ?? 0)
      : null,
    expectedAmendmentSequence:
      invoice.type === 'schluss' ? (invoice.expectedAmendmentSequence ?? 0) : null,
    positions: isFixedAmountAbschlag(invoice)
      ? []
      : (invoice.positions ?? []).map((p) => ({
          orderPositionId: p.orderPositionId,
          description: p.description,
          quantity: p.quantity,
          unit: p.unit,
          unitLabel: p.unitLabel ?? null,
          unitPrice: roundMoney(p.unitPrice),
          lineTotal: roundMoney(p.lineTotal),
          billable: true,
        })),
  });
}

function buildInvoiceContentFingerprintPayload(payload: {
  type: InvoiceDocumentType;
  abschlagNumber: number | null;
  taxStatus: TaxStatus;
  issueDate: string | null;
  servicePeriodFrom: string | null;
  servicePeriodTo: string | null;
  paymentDueDate: string | null;
  paymentTermsText: string;
  skontoText: string;
  introText: string;
  closingText: string;
  baustelle: string;
  vorgangTitle: string;
  customerBilling: CustomerBilling;
  subtotal: number;
  amount: number;
  calculationMode: InvoiceCalculationMode;
  fixedAmountNet: number | null;
  expectedAmendmentSequence: number | null;
  positions: Array<{
    orderPositionId: string;
    description: string;
    quantity: number;
    unit: string;
    unitLabel: string | null;
    unitPrice: number;
    lineTotal: number;
    billable: boolean;
  }>;
}): string {
  return JSON.stringify(payload);
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
  options: InvoiceApprovalOptions = {},
): FinalizeInvoiceResult {
  // Legacy local finalize path (tests / offline fallback). UI cloud path must not use this.
  const candidate = buildInvoiceFinalizationCandidate(
    vorgangId,
    draft,
    setup,
    `inv-${Date.now()}`,
    options,
  );
  if (!candidate.ok) {
    return candidate;
  }

  const reservation = reserveNextInvoiceNumber();
  const invoice: VorgangInvoice = {
    ...candidate.invoice,
    number: reservation.formatted,
    invoiceSequenceNumber: reservation.sequenceNumber,
  };

  const saved = addInvoiceToVorgang(vorgangId, invoice);
  if (!saved) {
    return { ok: false, reason: 'save_failed' };
  }

  const archiveResult = archiveOutgoingInvoice(vorgangId, saved, setup.companyName);
  if (archiveResult.success) {
    return { ok: true, invoice: archiveResult.invoice };
  }

  return { ok: true, invoice: saved };
}
