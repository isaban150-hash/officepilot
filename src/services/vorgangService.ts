import { MOCK_VORGAENGE } from '../data/mockData';
import { buildOrderPositionsFromInbox } from './orderPositionFactory';
import {
  canAddOrderPosition,
  canDeleteOrderPosition,
  canEditOrderPositionField,
  getBilledQuantity,
  hasFinalSchlussrechnung,
} from './orderBillingRules';
import {
  buildVorgangDraftFromInbox as buildDraftFromInbox,
  findSimilarVorgaenge as findSimilarInList,
} from './vorgangMatchingService';
import { resolveInboxItemForLinking, setInboxVorgangLink } from './inboxVorgangLinkService';
import { persistAll } from './persistenceService';
import { generateEntityId, withNewEntitySync, filterSyncActive, isEntitySyncActive } from './sync/syncMetaService';
import type {
  ContractExtractedFields,
  CustomerBilling,
  InboxItem,
  InvoicePayment,
  InvoicePaymentStatus,
  MaterialStandard,
  OrderPosition,
  OrderPositionEditableField,
  OrderPositionInput,
  Vorgang,
  VorgangDocument,
  VorgangDraft,
  VorgangInvoice,
} from '../types/models';

export type OrderPositionMutationResult =
  | { success: true; vorgang: Vorgang }
  | { success: false; errorKey: string };

let vorgaenge: Vorgang[] = [];

export function getVorgangStoreSnapshot(): Vorgang[] {
  return vorgaenge.map(cloneVorgang);
}

export function hydrateVorgangStore(items: Vorgang[]): void {
  vorgaenge = items.map(normalizeVorgang);
}

function cloneCustomerBilling(billing: CustomerBilling): CustomerBilling {
  return { ...billing };
}

function cloneInvoicePayment(payment: InvoicePayment): InvoicePayment {
  return { ...payment };
}

function cloneVorgangInvoice(invoice: VorgangInvoice): VorgangInvoice {
  return {
    ...invoice,
    positions: (invoice.positions ?? []).map((p) => ({ ...p })),
    legalNotices: invoice.legalNotices ? [...invoice.legalNotices] : undefined,
    previousAbschlagDeductions: invoice.previousAbschlagDeductions
      ? invoice.previousAbschlagDeductions.map((item) => ({ ...item }))
      : undefined,
    customerSnapshot: invoice.customerSnapshot
      ? cloneCustomerBilling(invoice.customerSnapshot)
      : undefined,
    companySnapshot: invoice.companySnapshot ? { ...invoice.companySnapshot } : undefined,
    payments: (invoice.payments ?? []).map(cloneInvoicePayment),
  };
}

function cloneVorgang(v: Vorgang): Vorgang {
  return {
    ...v,
    customerBilling: v.customerBilling ? cloneCustomerBilling(v.customerBilling) : undefined,
    orderPositions: (v.orderPositions ?? []).map((p) => ({ ...p })),
    documents: v.documents.map((d) => ({ ...d })),
    tasks: v.tasks.map((t) => ({ ...t })),
    photos: v.photos.map((p) => ({ ...p })),
    invoices: (v.invoices ?? []).map(cloneVorgangInvoice),
  };
}

function defaultCustomerBilling(vorgang: Vorgang): CustomerBilling {
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

function normalizeVorgang(v: Vorgang): Vorgang {
  const normalized = cloneVorgang({
    ...v,
    orderPositions: v.orderPositions ?? [],
    invoices: (v.invoices ?? []).map((inv) => ({
      ...inv,
      type: inv.type ?? 'abschlag',
      positions: inv.positions ?? [],
      subtotal: inv.subtotal ?? inv.amount ?? 0,
      taxStatus: inv.taxStatus ?? 'standard_19',
      createdAt: inv.createdAt ?? inv.date,
      legalNotices: inv.legalNotices ?? [],
      previousAbschlagDeductions: inv.previousAbschlagDeductions ?? [],
      payments: inv.payments ?? [],
    })),
  });

  if (!normalized.customerBilling) {
    normalized.customerBilling = defaultCustomerBilling(normalized);
  }

  return normalized;
}

export function getAllVorgaenge(): Vorgang[] {
  return filterSyncActive(vorgaenge).map(cloneVorgang);
}

export function getVorgangById(id: string): Vorgang | undefined {
  const v = vorgaenge.find((x) => x.id === id && isEntitySyncActive(x));
  return v ? cloneVorgang(v) : undefined;
}

export function buildVorgangDraftFromInbox(
  item: InboxItem,
  defaultMaterial: MaterialStandard = 'unclear',
): VorgangDraft {
  return buildDraftFromInbox(item, defaultMaterial);
}

export function findSimilarVorgaenge(draft: VorgangDraft): Vorgang[] {
  return findSimilarInList(draft, getAllVorgaenge());
}

function inboxDocumentName(item: InboxItem): string {
  return item.sourceFileName ?? item.title;
}

function buildDocumentFromInbox(item: InboxItem): VorgangDocument {
  return {
    id: `d-inbox-${item.id}-${Date.now()}`,
    name: inboxDocumentName(item),
    type: item.documentType,
    date: item.receivedAt,
    paperFiling: { ...item.paperFiling },
  };
}

function appendDocumentIfNew(vorgang: Vorgang, doc: VorgangDocument): void {
  const exists = vorgang.documents.some(
    (d) => d.name === doc.name && d.date === doc.date,
  );
  if (!exists) {
    vorgang.documents.push(doc);
  }
}

function updateVorgangInStore(updated: Vorgang): Vorgang {
  vorgaenge = vorgaenge.map((v) => (v.id === updated.id ? updated : v));
  persistAll();
  return cloneVorgang(updated);
}

export function isInboxLinkedToVorgang(item: InboxItem): boolean {
  return Boolean(
    item.vorgangId &&
      (item.vorgangLinkStatus === 'linked' || item.vorgangLinkStatus === 'created'),
  );
}

export function createVorgangFromInbox(
  item: InboxItem,
  optionalDraft?: Partial<VorgangDraft>,
  defaultMaterial: MaterialStandard = 'unclear',
  options?: { skipDefaultPositions?: boolean },
): { vorgang: Vorgang; inbox: InboxItem } | null {
  const currentItem = resolveInboxItemForLinking(item);
  if (isInboxLinkedToVorgang(currentItem)) return null;

  const baseDraft = buildVorgangDraftFromInbox(currentItem, defaultMaterial);
  const draft: VorgangDraft = { ...baseDraft, ...optionalDraft };
  const doc = buildDocumentFromInbox(currentItem);

  const newVorgang: Vorgang = withNewEntitySync(
    {
      id: generateEntityId('v'),
      title: draft.title,
      customer: draft.customer,
      baustelle: draft.baustelle,
      status: 'neu' as const,
      materialSource: draft.materialSource,
      customerBilling: {
        name: draft.customer,
        contactPerson: '',
        street: '',
        zip: '',
        city: '',
        email: '',
        phone: '',
      },
      orderPositions: options?.skipDefaultPositions ? [] : buildOrderPositionsFromInbox(currentItem),
      documents: [doc],
      tasks: [],
      photos: [],
      invoices: [],
      createdFromInboxId: item.id,
    },
    'vorgang',
  );

  vorgaenge = [newVorgang, ...vorgaenge];
  persistAll();

  const linkedInbox = setInboxVorgangLink(currentItem.id, newVorgang.id, newVorgang.title, 'created');
  if (!linkedInbox) return null;

  return { vorgang: cloneVorgang(newVorgang), inbox: linkedInbox };
}

export function linkInboxToExistingVorgang(
  item: InboxItem,
  vorgangId: string,
): { vorgang: Vorgang; inbox: InboxItem } | null {
  const currentItem = resolveInboxItemForLinking(item);
  if (isInboxLinkedToVorgang(currentItem)) return null;

  const index = vorgaenge.findIndex((v) => v.id === vorgangId);
  if (index === -1) return null;

  const vorgang = cloneVorgang(vorgaenge[index]);
  appendDocumentIfNew(vorgang, buildDocumentFromInbox(currentItem));
  updateVorgangInStore(vorgang);

  const linkedInbox = setInboxVorgangLink(currentItem.id, vorgang.id, vorgang.title, 'linked');
  if (!linkedInbox) return null;

  return { vorgang, inbox: linkedInbox };
}

export function addInvoiceToVorgang(vorgangId: string, invoice: VorgangInvoice): VorgangInvoice | null {
  const index = vorgaenge.findIndex((v) => v.id === vorgangId);
  if (index === -1) return null;

  const vorgang = cloneVorgang(vorgaenge[index]);
  vorgang.invoices = [invoice, ...vorgang.invoices];
  updateVorgangInStore(vorgang);
  return { ...invoice };
}

export function getVorgangInvoice(
  vorgangId: string,
  invoiceId: string,
): VorgangInvoice | undefined {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return undefined;
  const invoice = vorgang.invoices.find((item) => item.id === invoiceId);
  return invoice ? { ...invoice } : undefined;
}

export function updateInvoiceArchiveDocumentId(
  vorgangId: string,
  invoiceId: string,
  archiveDocumentId: string,
): VorgangInvoice | null {
  const index = vorgaenge.findIndex((v) => v.id === vorgangId);
  if (index === -1) return null;

  const vorgang = cloneVorgang(vorgaenge[index]);
  const invoiceIndex = vorgang.invoices.findIndex((item) => item.id === invoiceId);
  if (invoiceIndex === -1) return null;

  const updatedInvoice: VorgangInvoice = {
    ...vorgang.invoices[invoiceIndex],
    archiveDocumentId,
  };
  vorgang.invoices = [
    ...vorgang.invoices.slice(0, invoiceIndex),
    updatedInvoice,
    ...vorgang.invoices.slice(invoiceIndex + 1),
  ];
  updateVorgangInStore(vorgang);
  return { ...updatedInvoice };
}

function updateInvoicePaymentFields(
  vorgangId: string,
  invoiceId: string,
  payments: InvoicePayment[],
  paymentStatus: InvoicePaymentStatus,
): VorgangInvoice | null {
  const index = vorgaenge.findIndex((v) => v.id === vorgangId);
  if (index === -1) return null;

  const vorgang = cloneVorgang(vorgaenge[index]);
  const invoiceIndex = vorgang.invoices.findIndex((item) => item.id === invoiceId);
  if (invoiceIndex === -1) return null;

  const current = vorgang.invoices[invoiceIndex];
  const updatedInvoice: VorgangInvoice = {
    ...current,
    payments: payments.map(cloneInvoicePayment),
    paymentStatus,
  };

  vorgang.invoices = [
    ...vorgang.invoices.slice(0, invoiceIndex),
    updatedInvoice,
    ...vorgang.invoices.slice(invoiceIndex + 1),
  ];
  updateVorgangInStore(vorgang);
  return cloneVorgangInvoice(updatedInvoice);
}

export function addPaymentToInvoice(
  vorgangId: string,
  invoiceId: string,
  payment: InvoicePayment,
  paymentStatus: InvoicePaymentStatus,
): VorgangInvoice | null {
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) return null;

  return updateInvoicePaymentFields(
    vorgangId,
    invoiceId,
    [...(invoice.payments ?? []), cloneInvoicePayment(payment)],
    paymentStatus,
  );
}

export function removePaymentFromInvoice(
  vorgangId: string,
  invoiceId: string,
  paymentId: string,
  paymentStatus: InvoicePaymentStatus,
): VorgangInvoice | null {
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) return null;

  const payments = (invoice.payments ?? []).filter((payment) => payment.id !== paymentId);
  if (payments.length === (invoice.payments ?? []).length) {
    return null;
  }

  return updateInvoicePaymentFields(vorgangId, invoiceId, payments, paymentStatus);
}

function normalizeDescription(description: string): string {
  const trimmed = description.trim();
  return trimmed || 'Neue Position';
}

function validateOrderPositionInput(
  input: OrderPositionInput,
  minPlannedQuantity = 0,
): string | null {
  if (input.plannedQuantity < 0) return 'position.plannedNegative';
  if (input.plannedQuantity < minPlannedQuantity) return 'position.plannedBelowBilled';
  if (input.unitPrice < 0) return 'position.priceNegative';
  return null;
}

export function addOrderPosition(
  vorgangId: string,
  input: OrderPositionInput,
): OrderPositionMutationResult {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return { success: false, errorKey: 'position.vorgangNotFound' };
  if (!canAddOrderPosition(vorgang)) {
    return { success: false, errorKey: 'position.schlussLocked' };
  }

  const validationError = validateOrderPositionInput(input);
  if (validationError) return { success: false, errorKey: validationError };

  const position: OrderPosition = {
    id: `op-${Date.now()}`,
    description: normalizeDescription(input.description),
    plannedQuantity: input.plannedQuantity,
    unit: input.unit,
    unitLabel: input.unitLabel,
    unitPrice: input.unitPrice,
    category: input.category ?? 'arbeit',
    billable: input.billable ?? true,
  };

  const updated = cloneVorgang(vorgang);
  updated.orderPositions = [...updated.orderPositions, position];
  return { success: true, vorgang: updateVorgangInStore(updated) };
}

export function updateOrderPosition(
  vorgangId: string,
  positionId: string,
  changes: Partial<OrderPositionInput>,
): OrderPositionMutationResult {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return { success: false, errorKey: 'position.vorgangNotFound' };

  const index = vorgang.orderPositions.findIndex((p) => p.id === positionId);
  if (index === -1) return { success: false, errorKey: 'position.notFound' };

  if (hasFinalSchlussrechnung(vorgang)) {
    return { success: false, errorKey: 'position.schlussLocked' };
  }

  const current = vorgang.orderPositions[index];
  const billedQuantity = getBilledQuantity(vorgang, positionId);

  const fieldMap: [keyof OrderPositionInput, OrderPositionEditableField][] = [
    ['description', 'description'],
    ['plannedQuantity', 'plannedQuantity'],
    ['unit', 'unit'],
    ['unitPrice', 'unitPrice'],
    ['category', 'category'],
    ['billable', 'billable'],
  ];

  for (const [inputKey, editableField] of fieldMap) {
    if (changes[inputKey] !== undefined && !canEditOrderPositionField(vorgang, positionId, editableField)) {
      return { success: false, errorKey: 'position.fieldLocked' };
    }
  }

  const next: OrderPosition = {
    ...current,
    description:
      changes.description !== undefined
        ? normalizeDescription(changes.description)
        : current.description,
    plannedQuantity: changes.plannedQuantity ?? current.plannedQuantity,
    unit: changes.unit ?? current.unit,
    unitPrice: changes.unitPrice ?? current.unitPrice,
    category: changes.category ?? current.category,
    billable: changes.billable ?? current.billable,
  };

  const validationError = validateOrderPositionInput(next, billedQuantity);
  if (validationError) return { success: false, errorKey: validationError };

  const updated = cloneVorgang(vorgang);
  updated.orderPositions = [
    ...updated.orderPositions.slice(0, index),
    next,
    ...updated.orderPositions.slice(index + 1),
  ];
  return { success: true, vorgang: updateVorgangInStore(updated) };
}

export function removeOrderPosition(
  vorgangId: string,
  positionId: string,
): OrderPositionMutationResult {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return { success: false, errorKey: 'position.vorgangNotFound' };

  if (!canDeleteOrderPosition(vorgang, positionId)) {
    return { success: false, errorKey: 'position.deleteBlocked' };
  }

  const updated = cloneVorgang(vorgang);
  updated.orderPositions = updated.orderPositions.filter((p) => p.id !== positionId);
  return { success: true, vorgang: updateVorgangInStore(updated) };
}

export type VorgangCardMode = 'none' | 'create' | 'link' | 'open';

export function getVorgangCardMode(item: InboxItem): VorgangCardMode {
  if (item.isAdvertisement) return 'none';
  if (isInboxLinkedToVorgang(item)) return 'open';

  if (
    item.documentType === 'kundenauftrag' ||
    item.recommendedAction === 'auftrag_annehmen'
  ) {
    return 'create';
  }

  if (
    item.documentType === 'eingangsrechnung' ||
    item.recommendedAction === 'zuordnen' ||
    item.recommendedAction === 'zahlung_pruefen'
  ) {
    return 'link';
  }

  return 'none';
}

function emptyCustomerBilling(customer: string): CustomerBilling {
  return {
    name: customer,
    contactPerson: '',
    street: '',
    zip: '',
    city: '',
    email: '',
    phone: '',
  };
}

export function applyContractFieldsToVorgang(
  vorgangId: string,
  fields: ContractExtractedFields,
): { success: true; vorgang: Vorgang } | { success: false; errorKey: string } {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return { success: false, errorKey: 'position.vorgangNotFound' };

  const updated = cloneVorgang(vorgang);
  const title = fields.bauvorhaben ?? fields.projektname;
  if (title && (!updated.title.trim() || updated.title.startsWith('Gerade erfasst'))) {
    updated.title = title;
  }
  if (
    fields.baustellenadresse &&
    (!updated.baustelle.trim() || updated.baustelle === 'Unbekannte Baustelle')
  ) {
    updated.baustelle = fields.baustellenadresse;
  }
  if (fields.auftraggeber && !updated.customer.trim()) {
    updated.customer = fields.auftraggeber;
  }

  const billing = { ...emptyCustomerBilling(updated.customer), ...(updated.customerBilling ?? {}) };
  if (fields.ansprechpartner) billing.contactPerson = fields.ansprechpartner;
  if (fields.telefon) billing.phone = fields.telefon;
  if (fields.email) billing.email = fields.email;
  if (fields.auftraggeber) billing.name = fields.auftraggeber;
  updated.customerBilling = billing;

  return { success: true, vorgang: updateVorgangInStore(updated) };
}

export function resetVorgaenge(): void {
  vorgaenge = MOCK_VORGAENGE.map(normalizeVorgang);
}

export { buildOrderPositionsFromInbox, parseOfferAmount } from './orderPositionFactory';
