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
import {
  canTransitionVorgangStatus,
  migrateVorgangStatus,
} from './vorgangLifecycleService';
import { persistAll } from './persistenceService';
import { generateEntityId, withNewEntitySync, withUpdatedEntitySync, withTombstonedEntity, filterSyncActive, isEntitySyncActive } from './sync/syncMetaService';
import type {
  ContractExtractedFields,
  CompanyDocument,
  CustomerBilling,
  InboxItem,
  InvoicePayment,
  InvoicePaymentStatus,
  MaterialStandard,
  ContractConfirmationSnapshot,
  ContractNegotiationState,
  OrderPosition,
  OrderPositionEditableField,
  OrderPositionInput,
  Vorgang,
  VorgangDocument,
  VorgangDraft,
  VorgangInvoice,
  VorgangStatus,
} from '../types/models';
import {
  alignOrderPositionsToConfirmation,
  buildOrderPositionsFromSnapshot,
  isSnapshotAlignable,
  orderPositionsMatchSnapshot,
} from './contractPositionAlignService';

export type OrderPositionMutationResult =
  | { success: true; vorgang: Vorgang }
  | { success: false; errorKey: string };

export type VorgangStatusUpdateResult =
  | { success: true; vorgang: Vorgang }
  | { success: false; errorKey: 'vorgang.notFound' | 'vorgang.status.invalidTransition' };

export type VorgangNegotiationUpdateResult =
  | { success: true; vorgang: Vorgang }
  | { success: false; errorKey: 'vorgang.notFound' };

export type VorgangConfirmationUpdateResult =
  | { success: true; vorgang: Vorgang }
  | {
      success: false;
      errorKey:
        | 'vorgang.notFound'
        | 'vorgang.status.invalidTransition'
        | 'confirmation.snapshotImmutable'
        | 'confirmation.alreadyExists'
        | 'confirmation.alignFailed';
    };

export type VorgangExecutionStartResult =
  | { success: true; vorgang: Vorgang }
  | {
      success: false;
      errorKey:
        | 'vorgang.notFound'
        | 'vorgang.status.invalidTransition'
        | 'execution.notBeauftragt'
        | 'execution.snapshotRequired'
        | 'execution.alreadyStarted';
    };

export type ExecutedQuantityUpdateResult =
  | { success: true; vorgang: Vorgang }
  | {
      success: false;
      errorKey:
        | 'position.vorgangNotFound'
        | 'position.notFound'
        | 'execution.qty.notAllowed'
        | 'execution.qty.invalid';
    };

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

function cloneDraftSnapshot(
  draft: NonNullable<ContractNegotiationState['draft']>,
): NonNullable<ContractNegotiationState['draft']> {
  return { ...draft, sendConfirmed: false as const };
}

function cloneNegotiation(state: ContractNegotiationState): ContractNegotiationState {
  return {
    ...state,
    notes: [...(state.notes ?? [])],
    generalHints: [...(state.generalHints ?? [])],
    priceProposals: (state.priceProposals ?? []).map((p) => ({ ...p })),
    positionProposals: (state.positionProposals ?? []).map((p) => ({ ...p })),
    draft: state.draft ? cloneDraftSnapshot(state.draft) : state.draft,
    draftHistory: (state.draftHistory ?? []).map(cloneDraftSnapshot),
  };
}

function cloneContractConfirmation(
  snapshot: ContractConfirmationSnapshot,
): ContractConfirmationSnapshot {
  return {
    ...snapshot,
    immutable: true,
    positions: snapshot.positions.map((p) => ({ ...p })),
    negotiation: {
      notes: [...snapshot.negotiation.notes],
      generalHints: [...snapshot.negotiation.generalHints],
      priceProposals: snapshot.negotiation.priceProposals.map((p) => ({ ...p })),
      positionProposals: snapshot.negotiation.positionProposals.map((p) => ({ ...p })),
      drafts: snapshot.negotiation.drafts.map(cloneDraftSnapshot),
    },
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
    negotiation: v.negotiation ? cloneNegotiation(v.negotiation) : undefined,
    contractConfirmation: v.contractConfirmation
      ? cloneContractConfirmation(v.contractConfirmation)
      : undefined,
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

function normalizeNegotiation(
  state: ContractNegotiationState | undefined,
): ContractNegotiationState | undefined {
  if (!state) return undefined;
  return {
    startedAt: state.startedAt,
    closed: state.closed === true,
    completedAt: state.completedAt,
    notes: state.notes ?? [],
    generalHints: state.generalHints ?? [],
    priceProposals: state.priceProposals ?? [],
    positionProposals: state.positionProposals ?? [],
    draft: state.draft
      ? { ...state.draft, sendConfirmed: false as const }
      : state.draft ?? null,
    draftHistory: (state.draftHistory ?? []).map((draft) => ({
      ...draft,
      sendConfirmed: false as const,
    })),
  };
}

function normalizeContractConfirmation(
  snapshot: ContractConfirmationSnapshot | undefined,
): ContractConfirmationSnapshot | undefined {
  if (!snapshot) return undefined;
  return cloneContractConfirmation({
    ...snapshot,
    immutable: true,
    positions: snapshot.positions ?? [],
    negotiation: {
      notes: snapshot.negotiation?.notes ?? [],
      generalHints: snapshot.negotiation?.generalHints ?? [],
      priceProposals: snapshot.negotiation?.priceProposals ?? [],
      positionProposals: snapshot.negotiation?.positionProposals ?? [],
      drafts: snapshot.negotiation?.drafts ?? [],
    },
  });
}

function normalizeVorgang(v: Vorgang): Vorgang {
  const normalized = cloneVorgang({
    ...v,
    status: migrateVorgangStatus(v.status),
    orderPositions: v.orderPositions ?? [],
    negotiation: normalizeNegotiation(v.negotiation),
    contractConfirmation: normalizeContractConfirmation(v.contractConfirmation),
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

  // Legacy: confirmed Vorgänge must keep operative positions aligned to snapshot.
  if (normalized.contractConfirmation) {
    const aligned = alignOrderPositionsToConfirmation(
      normalized.orderPositions,
      normalized.contractConfirmation,
    );
    if (aligned.changed) {
      normalized.orderPositions = aligned.positions;
    }
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

function buildDocumentFromInbox(item: InboxItem, companyDocumentId?: string): VorgangDocument {
  return {
    id: companyDocumentId ?? `d-inbox-${item.id}`,
    companyDocumentId,
    name: inboxDocumentName(item),
    type: item.documentType,
    date: item.receivedAt,
    paperFiling: { ...item.paperFiling },
  };
}

export function attachCompanyDocumentToVorgang(
  vorgangId: string,
  companyDocument: CompanyDocument,
  inboxItem?: InboxItem,
): void {
  const index = vorgaenge.findIndex((v) => v.id === vorgangId && isEntitySyncActive(v));
  if (index === -1) return;

  const vorgang = cloneVorgang(vorgaenge[index]);
  const refDoc = buildDocumentFromInbox(
    inboxItem ?? {
      id: companyDocument.sourceInboxItemId ?? companyDocument.id,
      title: companyDocument.title,
      documentType: 'sonstiges',
      sender: companyDocument.issuer,
      priority: 'mittel',
      deadline: companyDocument.validUntil,
      recommendedAction: 'archivieren',
      digitalFolder: companyDocument.digitalFolder,
      paperFiling: companyDocument.paperFolder,
      status: 'abgelegt',
      receivedAt: companyDocument.documentDate ?? companyDocument.createdAt,
      recognizedData: {},
      officePilotSuggestion: '',
      nextTaskLabel: '',
      securityHint: '',
      sourceFileName: companyDocument.originalFileName,
    },
    companyDocument.id,
  );
  refDoc.companyDocumentId = companyDocument.id;
  refDoc.name = companyDocument.title;
  refDoc.type =
    companyDocument.category === 'vertrag'
      ? 'kundenauftrag'
      : companyDocument.category === 'steuer'
        ? 'eingangsrechnung'
        : 'sonstiges';

  const existingIndex = vorgang.documents.findIndex(
    (d) =>
      d.companyDocumentId === companyDocument.id ||
      (inboxItem && d.id === `d-inbox-${inboxItem.id}`),
  );
  if (existingIndex >= 0) {
    vorgang.documents[existingIndex] = {
      ...vorgang.documents[existingIndex],
      ...refDoc,
      id: vorgang.documents[existingIndex].id,
    };
  } else {
    appendDocumentIfNew(vorgang, refDoc);
  }

  updateVorgangInStore(vorgang);
}

function appendDocumentIfNew(vorgang: Vorgang, doc: VorgangDocument): void {
  const exists = vorgang.documents.some(
    (d) =>
      (doc.companyDocumentId && d.companyDocumentId === doc.companyDocumentId) ||
      (d.name === doc.name && d.date === doc.date),
  );
  if (!exists) {
    vorgang.documents.push(doc);
  }
}

function updateVorgangInStore(updated: Vorgang): Vorgang {
  const next = isEntitySyncActive(updated)
    ? withUpdatedEntitySync(updated, 'vorgang')
    : updated;
  vorgaenge = vorgaenge.map((v) => (v.id === next.id ? next : v));
  persistAll();
  return cloneVorgang(next);
}

export function deleteVorgang(
  vorgangId: string,
): { success: true; vorgang: Vorgang } | { success: false; errorKey: string } {
  const index = vorgaenge.findIndex((v) => v.id === vorgangId && isEntitySyncActive(v));
  if (index === -1) return { success: false, errorKey: 'vorgang.notFound' };

  const tombstoned = withTombstonedEntity(cloneVorgang(vorgaenge[index]), 'vorgang');
  vorgaenge = vorgaenge.map((v) => (v.id === vorgangId ? tombstoned : v));
  persistAll();
  return { success: true, vorgang: cloneVorgang(tombstoned) };
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
      status: 'eingegangen' as const,
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

export function updateVorgangStatus(
  vorgangId: string,
  nextStatus: VorgangStatus,
): VorgangStatusUpdateResult {
  const index = vorgaenge.findIndex((v) => v.id === vorgangId && isEntitySyncActive(v));
  if (index === -1) {
    return { success: false, errorKey: 'vorgang.notFound' };
  }

  const current = normalizeVorgang(vorgaenge[index]!);
  if (!canTransitionVorgangStatus(current.status, nextStatus)) {
    return { success: false, errorKey: 'vorgang.status.invalidTransition' };
  }

  const updated = cloneVorgang({
    ...current,
    status: migrateVorgangStatus(nextStatus),
  });
  return { success: true, vorgang: updateVorgangInStore(updated) };
}

/**
 * Atomically moves beauftragt → in_bearbeitung and sets executionStartedAt.
 * Does not touch snapshot, orderPositions, negotiation, or documents.
 */
export function startVorgangExecutionAt(
  vorgangId: string,
  startedAt: string,
): VorgangExecutionStartResult {
  const index = vorgaenge.findIndex((v) => v.id === vorgangId && isEntitySyncActive(v));
  if (index === -1) {
    return { success: false, errorKey: 'vorgang.notFound' };
  }

  const current = cloneVorgang(vorgaenge[index]!);
  const status = migrateVorgangStatus(current.status);

  if (current.executionStartedAt || status === 'in_bearbeitung') {
    return { success: false, errorKey: 'execution.alreadyStarted' };
  }
  if (status !== 'beauftragt') {
    return { success: false, errorKey: 'execution.notBeauftragt' };
  }
  if (!current.contractConfirmation) {
    return { success: false, errorKey: 'execution.snapshotRequired' };
  }
  if (!canTransitionVorgangStatus(status, 'in_bearbeitung')) {
    return { success: false, errorKey: 'vorgang.status.invalidTransition' };
  }
  if (!startedAt || Number.isNaN(Date.parse(startedAt))) {
    return { success: false, errorKey: 'vorgang.status.invalidTransition' };
  }

  const updated = cloneVorgang({
    ...current,
    status: 'in_bearbeitung',
    executionStartedAt: startedAt,
  });
  return { success: true, vorgang: updateVorgangInStore(updated) };
}

export function canUpdateExecutedQuantity(vorgang: Vorgang): boolean {
  return vorgang.status === 'in_bearbeitung' && Boolean(vorgang.executionStartedAt);
}

/**
 * Updates only executedQuantity on one position.
 * Does not change plannedQuantity, prices, snapshot, or billing.
 */
export function updateOrderPositionExecutedQuantity(
  vorgangId: string,
  positionId: string,
  executedQuantity: number | undefined,
): ExecutedQuantityUpdateResult {
  const index = vorgaenge.findIndex((v) => v.id === vorgangId && isEntitySyncActive(v));
  if (index === -1) {
    return { success: false, errorKey: 'position.vorgangNotFound' };
  }

  const current = cloneVorgang(vorgaenge[index]!);
  if (!canUpdateExecutedQuantity(current)) {
    return { success: false, errorKey: 'execution.qty.notAllowed' };
  }

  const positionIndex = current.orderPositions.findIndex((p) => p.id === positionId);
  if (positionIndex === -1) {
    return { success: false, errorKey: 'position.notFound' };
  }

  if (executedQuantity !== undefined) {
    if (!Number.isFinite(executedQuantity) || executedQuantity < 0) {
      return { success: false, errorKey: 'execution.qty.invalid' };
    }
  }

  const nextPositions = current.orderPositions.map((position, i) => {
    if (i !== positionIndex) return position;
    const next = { ...position };
    if (executedQuantity === undefined) {
      delete next.executedQuantity;
    } else {
      next.executedQuantity = executedQuantity;
    }
    return next;
  });

  const updated = cloneVorgang({
    ...current,
    orderPositions: nextPositions,
  });
  return { success: true, vorgang: updateVorgangInStore(updated) };
}

/** Persists negotiation proposals on the Vorgang without touching linked contract documents. */
export function saveVorgangNegotiation(
  vorgangId: string,
  negotiation: ContractNegotiationState | undefined,
): VorgangNegotiationUpdateResult {
  const index = vorgaenge.findIndex((v) => v.id === vorgangId && isEntitySyncActive(v));
  if (index === -1) {
    return { success: false, errorKey: 'vorgang.notFound' };
  }

  const current = normalizeVorgang(vorgaenge[index]!);
  const updated = cloneVorgang({
    ...current,
    negotiation: negotiation ? normalizeNegotiation(negotiation) : undefined,
  });
  return { success: true, vorgang: updateVorgangInStore(updated) };
}

/**
 * Atomically: freeze snapshot, align orderPositions from snapshot, close negotiation, set beauftragt.
 * Refuses overwrite if a snapshot already exists. No partial writes on failure.
 */
export function saveVorgangContractConfirmation(
  vorgangId: string,
  snapshot: ContractConfirmationSnapshot,
  negotiation: ContractNegotiationState,
): VorgangConfirmationUpdateResult {
  const index = vorgaenge.findIndex((v) => v.id === vorgangId && isEntitySyncActive(v));
  if (index === -1) {
    return { success: false, errorKey: 'vorgang.notFound' };
  }

  // Read raw (pre-normalize) so failed confirms never leave side effects from migration.
  const current = cloneVorgang(vorgaenge[index]!);
  if (current.contractConfirmation) {
    return { success: false, errorKey: 'confirmation.alreadyExists' };
  }
  if (!canTransitionVorgangStatus(migrateVorgangStatus(current.status), 'beauftragt')) {
    return { success: false, errorKey: 'vorgang.status.invalidTransition' };
  }

  const frozen = normalizeContractConfirmation({
    ...snapshot,
    immutable: true,
  });
  if (!frozen || !isSnapshotAlignable(frozen)) {
    return { success: false, errorKey: 'confirmation.alignFailed' };
  }

  const alignedPositions = buildOrderPositionsFromSnapshot(frozen, current.orderPositions);
  if (!orderPositionsMatchSnapshot(alignedPositions, frozen)) {
    return { success: false, errorKey: 'confirmation.alignFailed' };
  }

  const updated = cloneVorgang({
    ...current,
    status: 'beauftragt',
    orderPositions: alignedPositions,
    negotiation: normalizeNegotiation(negotiation),
    contractConfirmation: frozen,
  });
  return { success: true, vorgang: updateVorgangInStore(updated) };
}

/** Guard: existing confirmation snapshots must never be replaced. */
export function replaceVorgangContractConfirmation(
  vorgangId: string,
  _snapshot: ContractConfirmationSnapshot,
): VorgangConfirmationUpdateResult {
  const current = getVorgangById(vorgangId);
  if (!current) {
    return { success: false, errorKey: 'vorgang.notFound' };
  }
  if (current.contractConfirmation) {
    return { success: false, errorKey: 'confirmation.snapshotImmutable' };
  }
  return { success: false, errorKey: 'confirmation.snapshotImmutable' };
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

export type UpsertFinalizedInvoiceResult =
  | { ok: true; invoice: VorgangInvoice; action: 'inserted' | 'noop' }
  | {
      ok: false;
      reason: 'vorgang_missing' | 'id_content_conflict' | 'number_id_conflict';
    };

function immutableInvoiceFingerprint(invoice: VorgangInvoice): string {
  return JSON.stringify({
    id: invoice.id,
    number: invoice.number,
    invoiceSequenceNumber: invoice.invoiceSequenceNumber ?? null,
    type: invoice.type,
    abschlagNumber: invoice.abschlagNumber ?? null,
    subtotal: invoice.subtotal,
    amount: invoice.amount,
    taxStatus: invoice.taxStatus,
    date: invoice.date,
    issueDate: invoice.issueDate ?? null,
    positions: (invoice.positions ?? []).map((p) => ({
      id: p.id,
      orderPositionId: p.orderPositionId,
      description: p.description,
      quantity: p.quantity,
      unit: p.unit,
      unitPrice: p.unitPrice,
      lineTotal: p.lineTotal,
    })),
  });
}

/**
 * Idempotent local adoption of a cloud-finalized invoice.
 * Never silently overwrites divergent immutable content.
 */
export function upsertFinalizedInvoiceOnVorgang(
  vorgangId: string,
  invoice: VorgangInvoice,
): UpsertFinalizedInvoiceResult {
  const index = vorgaenge.findIndex((v) => v.id === vorgangId && isEntitySyncActive(v));
  if (index === -1) {
    return { ok: false, reason: 'vorgang_missing' };
  }

  const vorgang = cloneVorgang(vorgaenge[index]!);
  const byId = vorgang.invoices.find((item) => item.id === invoice.id);
  if (byId) {
    if (immutableInvoiceFingerprint(byId) === immutableInvoiceFingerprint(invoice)) {
      return { ok: true, invoice: { ...byId }, action: 'noop' };
    }
    return { ok: false, reason: 'id_content_conflict' };
  }

  const byNumber = vorgang.invoices.find(
    (item) => item.number === invoice.number && item.id !== invoice.id,
  );
  if (byNumber) {
    return { ok: false, reason: 'number_id_conflict' };
  }

  vorgang.invoices = [invoice, ...vorgang.invoices];
  updateVorgangInStore(vorgang);
  return { ok: true, invoice: { ...invoice }, action: 'inserted' };
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

/**
 * Controlled update of invoice send status / send metadata.
 * Callers must enforce business rules (mark vs correct).
 */
export function updateInvoiceSentFields(
  vorgangId: string,
  invoiceId: string,
  fields: {
    status: VorgangInvoice['status'];
    sentAt: string;
    sentVia: NonNullable<VorgangInvoice['sentVia']>;
    sentNote?: string;
  },
): VorgangInvoice | null {
  const index = vorgaenge.findIndex((v) => v.id === vorgangId);
  if (index === -1) return null;

  const vorgang = cloneVorgang(vorgaenge[index]);
  const invoiceIndex = vorgang.invoices.findIndex((item) => item.id === invoiceId);
  if (invoiceIndex === -1) return null;

  const current = vorgang.invoices[invoiceIndex];
  const note = fields.sentNote?.trim() ?? '';
  const updatedInvoice: VorgangInvoice = {
    ...current,
    status: fields.status,
    sentAt: fields.sentAt,
    sentVia: fields.sentVia,
  };
  if (note) {
    updatedInvoice.sentNote = note;
  } else {
    delete updatedInvoice.sentNote;
  }

  vorgang.invoices = [
    ...vorgang.invoices.slice(0, invoiceIndex),
    updatedInvoice,
    ...vorgang.invoices.slice(invoiceIndex + 1),
  ];
  updateVorgangInStore(vorgang);
  return cloneVorgangInvoice(updatedInvoice);
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
    id: generateEntityId('op'),
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

/**
 * Append many order positions with a single store update / persistAll.
 * Used by confirm-first contract import to avoid N× localStorage writes.
 */
export function appendOrderPositionsBulk(
  vorgangId: string,
  inputs: OrderPositionInput[],
): {
  success: boolean;
  added: number;
  skipped: number;
  errorKey?: string;
  vorgang?: Vorgang;
} {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) {
    return { success: false, added: 0, skipped: 0, errorKey: 'position.vorgangNotFound' };
  }
  if (!canAddOrderPosition(vorgang)) {
    return {
      success: false,
      added: 0,
      skipped: inputs.length,
      errorKey: 'position.schlussLocked',
    };
  }

  const nextPositions = [...vorgang.orderPositions];
  let added = 0;
  let skipped = 0;

  for (const input of inputs) {
    const validationError = validateOrderPositionInput(input);
    if (validationError) {
      skipped += 1;
      continue;
    }

    nextPositions.push({
      id: generateEntityId('op'),
      description: normalizeDescription(input.description),
      plannedQuantity: input.plannedQuantity,
      unit: input.unit,
      unitLabel: input.unitLabel,
      unitPrice: input.unitPrice,
      category: input.category ?? 'arbeit',
      billable: input.billable ?? true,
    });
    added += 1;
  }

  if (added === 0) {
    return { success: false, added: 0, skipped };
  }

  const updated = cloneVorgang(vorgang);
  updated.orderPositions = nextPositions;
  return {
    success: true,
    added,
    skipped,
    vorgang: updateVorgangInStore(updated),
  };
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
  vorgaenge = [];
}

export { buildOrderPositionsFromInbox, parseOfferAmount } from './orderPositionFactory';
