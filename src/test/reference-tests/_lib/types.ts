/**
 * TEST-ARCHITECTURE-01 — Referenzfall-Soll (mehrere Goldpfade).
 * Ebene 1 Document Case bleibt unter document-cases/.
 */

import type { OrderUnit } from '../../../types/models';

export type ReferenceDamagePrevented = string;

export type ReferenceCaseKind =
  | 'contract-accept'
  | 'order-amendment'
  | 'incoming-invoice'
  | 'authority-letter'
  | 'delivery-note';

export interface AcceptJourneyExpected {
  companyName: string;
  customerContains: string;
  projectTitleMatch?: string;
  baustelleContains: string;
  orderValueApprox: number;
  minPositions: number;
  gewerk: string;
  hauptleistungenMustInclude: string[];
  requireArchive: boolean;
  requireDocLink: boolean;
  requireProofsMin: number;
  requireBillingPrep: boolean;
  progressBillingAllowed?: boolean;
  finalInvoicePlanned?: boolean;
}

export interface ContractUiVisibilityExpected {
  auftragskarte: {
    gewerkContains: string;
    hauptleistungContains: string;
    roleLabelContains: string;
    roleSeparatedFromGewerk: boolean;
  };
  vorgang: {
    scopeGewerkContains: string;
    hauptleistungContains: string;
    proofsNotEmpty: boolean;
    billingOverviewHint: boolean;
    billingPrepPanel: boolean;
  };
  archive: {
    documentLinkedVisible: boolean;
  };
}

/** @deprecated alias — WV-LV-01 expected.json key `uiVisibility` */
export type UiVisibilityExpected = ContractUiVisibilityExpected;

export interface AmendmentJourneyExpected {
  vorgangId: string;
  draftTitle: string;
  draftReason: string;
  newPositionDescription: string;
  newPositionQuantity: number;
  newPositionUnit: OrderUnit;
  newPositionUnitPrice: number;
  originalPositionId: string;
  originalPositionDescription: string;
  originalPlannedQuantity: number;
  requireConfirmFirst: boolean;
  requirePlanLockedAfterConfirm: boolean;
  requireLocalSourceDraftLink: boolean;
}

export interface AmendmentUiVisibilityExpected {
  panelVisible: boolean;
  confirmedListVisible: boolean;
  confirmedBadgeVisible: boolean;
  statusBestaetigtVisible: boolean;
  amendmentTitleVisible: boolean;
  newPositionVisibleInDetails: boolean;
  orderSummaryAmendmentCount: number;
  originTraceable: boolean;
}

export interface IncomingInvoiceJourneyExpected {
  companyName: string;
  classifiedKindAllowed: string[];
  supplierContains: string;
  invoiceNumber: string;
  issueDateContains: string;
  amountApprox: number;
  dueDateContains?: string;
  requireArchive: boolean;
  requireExpense: boolean;
  requireExpenseLinkedInbox: boolean;
  requireArchiveOnExpense: boolean;
  expectedPaymentStatus: 'offen' | 'teilbezahlt' | 'bezahlt' | 'ueberfaellig' | 'storniert';
}

export interface IncomingInvoiceUiVisibilityExpected {
  understandingPanelVisible: boolean;
  supplierVisible: boolean;
  invoiceNumberVisible: boolean;
  issueDateVisible: boolean;
  amountVisible: boolean;
  dueDateVisible: boolean;
  paymentStatusVisible: boolean;
  archiveLinkVisible: boolean;
  expenseCardVisible: boolean;
}

export interface AuthorityLetterJourneyExpected {
  companyName: string;
  classifiedKindAllowed: string[];
  /** Organisation / Behörde (Absender). */
  authorityContains: string;
  /** Optional — nicht jeder Nachweisbrief hat eine strukturierte Frist in der UI. */
  deadlineContains?: string;
  primaryCaseContains: string;
  meaningsRequired: string[];
  nextStepContains?: string[];
  requireArchive: boolean;
  forbidVorgang: boolean;
  forbidExpense: boolean;
  forbidContractPositions: boolean;
  forbidBillingPrep: boolean;
}

export interface AuthorityLetterUiVisibilityExpected {
  overviewVisible: boolean;
  authorityVisible: boolean;
  deadlineVisible: boolean;
  obligationVisible: boolean;
  nextStepVisible: boolean;
  understandingPanelVisible: boolean;
  documentKindVisible: boolean;
}

export interface DeliveryNoteJourneyExpected {
  companyName: string;
  classifiedKindAllowed: string[];
  supplierContains: string;
  deliveryNoteNumberContains: string;
  deliveryDateContains?: string;
  baustelleContains: string;
  vorgangId: string;
  vorgangTitleContains: string;
  positionDescriptionContains: string[];
  quantityHintsContains: string[];
  originalPositionId: string;
  originalPlannedQuantity: number;
  requireArchive: boolean;
  requireVorgangLink: boolean;
  requireConfirmFirst: boolean;
  forbidPlanChange: boolean;
  forbidInvoiceChange: boolean;
  forbidQuantityChange: boolean;
  forbidAmendment: boolean;
  forbidBillingPrep: boolean;
  forbidExpense: boolean;
}

export interface DeliveryNoteUiVisibilityExpected {
  overviewVisible: boolean;
  documentKindVisible: boolean;
  deliveryPrimaryCaseVisible: boolean;
  supplierVisible: boolean;
  deliveryDateVisible: boolean;
  orderVisible: boolean;
  positionHintsVisible: boolean;
  quantityHintsVisible: boolean;
  understandingPanelVisible: boolean;
  archiveVisible: boolean;
  orderLinkVisible: boolean;
}

interface ReferenceCaseBase {
  caseId: string;
  kind: ReferenceCaseKind;
  damagePrevented: ReferenceDamagePrevented[];
  knownGaps?: string[];
}

export interface ContractAcceptReferenceCase extends ReferenceCaseBase {
  kind: 'contract-accept';
  documentCaseId: string;
  layers: Array<'stable-pipeline' | 'accept-journey' | 'ui-visibility'>;
  acceptJourney: AcceptJourneyExpected;
  uiVisibility: ContractUiVisibilityExpected;
}

export interface OrderAmendmentReferenceCase extends ReferenceCaseBase {
  kind: 'order-amendment';
  layers: Array<'amendment-journey' | 'ui-visibility'>;
  baseOrderSource: 'seeded-confirmed-order';
  amendmentJourney: AmendmentJourneyExpected;
  amendmentUiVisibility: AmendmentUiVisibilityExpected;
}

export interface IncomingInvoiceReferenceCase extends ReferenceCaseBase {
  kind: 'incoming-invoice';
  documentCaseId: string;
  layers: Array<'stable-pipeline' | 'invoice-journey' | 'ui-visibility'>;
  invoiceJourney: IncomingInvoiceJourneyExpected;
  invoiceUiVisibility: IncomingInvoiceUiVisibilityExpected;
}

export interface AuthorityLetterReferenceCase extends ReferenceCaseBase {
  kind: 'authority-letter';
  documentCaseId: string;
  layers: Array<'stable-pipeline' | 'authority-journey' | 'ui-visibility'>;
  authorityJourney: AuthorityLetterJourneyExpected;
  authorityUiVisibility: AuthorityLetterUiVisibilityExpected;
}

export interface DeliveryNoteReferenceCase extends ReferenceCaseBase {
  kind: 'delivery-note';
  documentCaseId: string;
  layers: Array<'stable-pipeline' | 'delivery-journey' | 'ui-visibility'>;
  deliveryJourney: DeliveryNoteJourneyExpected;
  deliveryUiVisibility: DeliveryNoteUiVisibilityExpected;
}

export type ReferenceCaseExpected =
  | ContractAcceptReferenceCase
  | OrderAmendmentReferenceCase
  | IncomingInvoiceReferenceCase
  | AuthorityLetterReferenceCase
  | DeliveryNoteReferenceCase;

export function isContractAcceptReference(
  value: ReferenceCaseExpected,
): value is ContractAcceptReferenceCase {
  return value.kind === 'contract-accept';
}

export function isOrderAmendmentReference(
  value: ReferenceCaseExpected,
): value is OrderAmendmentReferenceCase {
  return value.kind === 'order-amendment';
}

export function isIncomingInvoiceReference(
  value: ReferenceCaseExpected,
): value is IncomingInvoiceReferenceCase {
  return value.kind === 'incoming-invoice';
}

export function isAuthorityLetterReference(
  value: ReferenceCaseExpected,
): value is AuthorityLetterReferenceCase {
  return value.kind === 'authority-letter';
}

export function isDeliveryNoteReference(
  value: ReferenceCaseExpected,
): value is DeliveryNoteReferenceCase {
  return value.kind === 'delivery-note';
}
