import { MOCK_VORGAENGE } from '../data/mockData';
import { buildOrderPositionsFromInbox } from './orderPositionFactory';
import {
  canDeleteOrderPosition,
  canEditOrderPositionField,
  canAddOrderPosition,
  getBilledQuantity,
  hasFinalSchlussrechnung,
} from './invoiceService';
import { setInboxVorgangLink } from './inboxService';
import { persistAll } from './persistenceService';
import type {
  CustomerBilling,
  InboxItem,
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

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function cloneCustomerBilling(billing: CustomerBilling): CustomerBilling {
  return { ...billing };
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
    })),
  });

  if (!normalized.customerBilling) {
    normalized.customerBilling = defaultCustomerBilling(normalized);
  }

  return normalized;
}

export function getAllVorgaenge(): Vorgang[] {
  return vorgaenge.map(cloneVorgang);
}

export function getVorgangById(id: string): Vorgang | undefined {
  const v = vorgaenge.find((x) => x.id === id);
  return v ? cloneVorgang(v) : undefined;
}

export function buildVorgangDraftFromInbox(
  item: InboxItem,
  defaultMaterial: MaterialStandard = 'unclear',
): VorgangDraft {
  const leistung = item.recognizedData.Leistung;
  const kunde = item.recognizedData.Kunde ?? item.sender;
  const baustelle = item.recognizedData.Baustelle ?? 'Unbekannte Baustelle';

  let title = item.vorgangTitle?.trim();
  if (!title) {
    title = leistung?.trim() || item.title.replace(/^Gerade erfasst: /, '');
  }

  return {
    title,
    customer: kunde,
    baustelle,
    materialSource: defaultMaterial,
  };
}

export function findSimilarVorgaenge(draft: VorgangDraft): Vorgang[] {
  const customerNorm = normalize(draft.customer);
  const baustelleNorm = normalize(draft.baustelle);

  return getAllVorgaenge().filter((v) => {
    const sameCustomer = normalize(v.customer) === customerNorm;
    const sameBaustelle =
      normalize(v.baustelle) === baustelleNorm ||
      normalize(v.baustelle).includes(baustelleNorm) ||
      baustelleNorm.includes(normalize(v.baustelle));
    const titleOverlap =
      normalize(v.title).includes(normalize(draft.customer)) ||
      normalize(draft.title).includes(normalize(v.customer));

    return sameCustomer || (sameCustomer && sameBaustelle) || (sameBaustelle && titleOverlap);
  });
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
): { vorgang: Vorgang; inbox: InboxItem } | null {
  if (isInboxLinkedToVorgang(item)) return null;

  const baseDraft = buildVorgangDraftFromInbox(item, defaultMaterial);
  const draft: VorgangDraft = { ...baseDraft, ...optionalDraft };
  const doc = buildDocumentFromInbox(item);

  const newVorgang: Vorgang = {
    id: `v-${Date.now()}`,
    title: draft.title,
    customer: draft.customer,
    baustelle: draft.baustelle,
    status: 'neu',
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
    orderPositions: buildOrderPositionsFromInbox(item),
    documents: [doc],
    tasks: [],
    photos: [],
    invoices: [],
    createdFromInboxId: item.id,
  };

  vorgaenge = [newVorgang, ...vorgaenge];
  persistAll();

  const linkedInbox = setInboxVorgangLink(item.id, newVorgang.id, newVorgang.title, 'created');
  if (!linkedInbox) return null;

  return { vorgang: cloneVorgang(newVorgang), inbox: linkedInbox };
}

export function linkInboxToExistingVorgang(
  item: InboxItem,
  vorgangId: string,
): { vorgang: Vorgang; inbox: InboxItem } | null {
  if (isInboxLinkedToVorgang(item)) return null;

  const index = vorgaenge.findIndex((v) => v.id === vorgangId);
  if (index === -1) return null;

  const vorgang = cloneVorgang(vorgaenge[index]);
  appendDocumentIfNew(vorgang, buildDocumentFromInbox(item));
  updateVorgangInStore(vorgang);

  const linkedInbox = setInboxVorgangLink(item.id, vorgang.id, vorgang.title, 'linked');
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

export function resetVorgaenge(): void {
  vorgaenge = MOCK_VORGAENGE.map(normalizeVorgang);
}

export { buildOrderPositionsFromInbox, parseOfferAmount } from './orderPositionFactory';
