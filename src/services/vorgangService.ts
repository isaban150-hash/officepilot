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
import {
  clearInboxVorgangLink,
  resolveInboxItemForLinking,
  setInboxVorgangLink,
} from './inboxVorgangLinkService';
import {
  getDocumentById,
  getDocumentStoreSnapshot,
  hydrateDocumentStore,
  stageDocumentUpdate,
  updateDocument,
} from './documentService';
import {
  isOwnCompanyName,
  normalizeCompanyNameForComparison,
  pickExternalCustomerName,
} from './customerOwnCompanyGuard';
import {
  billingFromCustomer,
  buildValidatedCustomer,
  validateCustomerDecisionForCreate,
  type CustomerDecision,
} from './customerService';
import {
  getCustomerById,
  getCustomerStoreSnapshot,
  restoreCustomerStore,
  upsertCustomerInStore,
} from './customerStoreService';
import {
  getInboxStoreSnapshot,
  hydrateInboxStore,
  stageInboxItemPatch,
} from './inboxService';
import {
  canTransitionVorgangStatus,
  migrateVorgangStatus,
} from './vorgangLifecycleService';
import { persistAll } from './persistenceService';
import { generateEntityId, withNewEntitySync, withUpdatedEntitySync, withTombstonedEntity, filterSyncActive, isEntitySyncActive } from './sync/syncMetaService';
import type {
  ContractExtractedFields,
  CompanyDocument,
  Customer,
  CustomerBilling,
  InboxItem,
  InvoicePayment,
  InvoicePaymentStatus,
  MaterialStandard,
  ContractConfirmationSnapshot,
  ContractNegotiationState,
  OrderAmendment,
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
  cloneConfirmedOrderAmendments,
  normalizeConfirmedOrderAmendments,
} from './orderAmendment/orderAmendmentConfirmedNormalize';
import {
  buildOrderPositionsFromSnapshot,
  isSnapshotAlignable,
  orderPositionsMatchSnapshot,
} from './contractPositionAlignService';
import {
  assertContractPlanMutable,
  repairContractPlanFromSnapshot,
} from './orderPlanIntegrityService';
import { resolvePrimaryTargetObjectForDocumentType } from './documentPrimaryTargetService';

export type OrderPositionMutationResult =
  | { success: true; vorgang: Vorgang }
  | { success: false; errorKey: string };

export type VorgangStatusUpdateResult =
  | { success: true; vorgang: Vorgang }
  | { success: false; errorKey: 'vorgang.notFound' | 'vorgang.status.invalidTransition' };

export type VorgangNegotiationUpdateResult =
  | { success: true; vorgang: Vorgang }
  | { success: false; errorKey: 'vorgang.notFound' };

export type VorgangOrderAmendmentsUpdateResult =
  | { success: true; vorgang: Vorgang }
  | {
      success: false;
      errorKey: 'vorgang.notFound' | 'order_amendment_requires_confirmation';
    };

export type VorgangConfirmationUpdateResult =
  | { success: true; vorgang: Vorgang }
  | {
      success: false;
      errorKey:
        | 'vorgang.notFound'
        | 'vorgang.status.invalidTransition'
        | 'confirmation.snapshotImmutable'
        | 'confirmation.alreadyExists'
        | 'confirmation.alignFailed'
        | 'confirmation.persistFailed';
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

function cloneOrderAmendment(amendment: OrderAmendment): OrderAmendment {
  return {
    ...amendment,
    positions: amendment.positions.map((position) => ({ ...position })),
  };
}

function cloneOrderAmendments(
  amendments: OrderAmendment[] | undefined,
): OrderAmendment[] | undefined {
  if (!amendments) return undefined;
  return amendments.map(cloneOrderAmendment);
}

function normalizeOrderAmendments(
  amendments: OrderAmendment[] | undefined,
): OrderAmendment[] | undefined {
  if (!amendments) return undefined;
  return amendments.map((amendment) => ({
    ...amendment,
    status: 'entwurf' as const,
    title: typeof amendment.title === 'string' ? amendment.title : 'Nachtrag',
    reason: amendment.reason?.trim() || undefined,
    positions: (amendment.positions ?? []).map((position) => ({ ...position })),
    createdAt: amendment.createdAt,
    updatedAt: amendment.updatedAt,
  }));
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
    orderAmendments: cloneOrderAmendments(v.orderAmendments),
    confirmedOrderAmendments: cloneConfirmedOrderAmendments(v.confirmedOrderAmendments),
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
    orderAmendments: normalizeOrderAmendments(v.orderAmendments),
    confirmedOrderAmendments: normalizeConfirmedOrderAmendments(v.confirmedOrderAmendments),
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
      expectedAmendmentSequence:
        typeof inv.expectedAmendmentSequence === 'number' &&
        Number.isInteger(inv.expectedAmendmentSequence) &&
        inv.expectedAmendmentSequence >= 0
          ? inv.expectedAmendmentSequence
          : undefined,
    })),
  });

  if (!normalized.customerBilling) {
    normalized.customerBilling = defaultCustomerBilling(normalized);
  }

  // Legacy / drift: confirmed Vorgänge keep operative contract fields aligned to snapshot.
  const repaired = repairContractPlanFromSnapshot(normalized);
  return repaired.vorgang;
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
  truthOverrides?: Parameters<typeof buildDraftFromInbox>[2],
): VorgangDraft {
  return buildDraftFromInbox(item, defaultMaterial, truthOverrides);
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

  updateVorgangInStore(
    applyCompanyDocumentToVorgang(cloneVorgang(vorgaenge[index]), companyDocument, inboxItem),
  );
}

/** Pure document attach — no store write, no persist. Shared with the atomic handoff. */
function applyCompanyDocumentToVorgang(
  vorgang: Vorgang,
  companyDocument: CompanyDocument,
  inboxItem?: InboxItem,
): Vorgang {
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

  return vorgang;
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

/**
 * Atomically mutate one Vorgang in memory and persist once.
 * On persist failure, restores the previous in-memory row.
 */
export function commitVorgangMutation(
  vorgangId: string,
  buildNext: (
    current: Vorgang,
  ) => Vorgang | { errorKey: string },
):
  | { ok: true; vorgang: Vorgang }
  | { ok: false; errorKey: string } {
  const index = vorgaenge.findIndex((item) => item.id === vorgangId && isEntitySyncActive(item));
  if (index === -1) {
    return { ok: false, errorKey: 'vorgang.notFound' };
  }

  const previousRaw = vorgaenge[index]!;
  const built = buildNext(cloneVorgang(previousRaw));
  if ('errorKey' in built) {
    return { ok: false, errorKey: built.errorKey };
  }

  const next = isEntitySyncActive(built) ? withUpdatedEntitySync(built, 'vorgang') : built;
  vorgaenge = vorgaenge.map((item) => (item.id === vorgangId ? next : item));
  const persistResult = persistAll();
  if (!persistResult.success) {
    vorgaenge = vorgaenge.map((item) => (item.id === vorgangId ? previousRaw : item));
    return { ok: false, errorKey: 'order_amendment_local_persist_failed' };
  }
  return { ok: true, vorgang: cloneVorgang(next) };
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

/**
 * DOC-LINK-AFTER-VORGANG-01 — bind existing CompanyDocument after Vorgang create/link.
 * Uses updateDocument + attachCompanyDocumentToVorgang (no second archive document).
 */
function bindInboxArchiveDocumentToVorgang(
  inbox: InboxItem,
  vorgangId: string,
  vorgangTitle: string,
): boolean {
  const archiveId = inbox.archiveDocumentId?.trim();
  if (!archiveId) return true;

  const archived = getDocumentById(archiveId);
  if (!archived) return false;

  let document = archived;
  if (archived.linkedVorgang?.vorgangId !== vorgangId) {
    const updated = updateDocument(archiveId, {
      linkedVorgang: { vorgangId, vorgangTitle },
    });
    if (!updated.success) return false;
    document = updated.document;
  }

  attachCompanyDocumentToVorgang(vorgangId, document, inbox);
  return true;
}

interface ResolvedCustomerDecision {
  customer: string;
  billing: CustomerBilling;
  customerId?: string;
  /** Only for kind 'none' — persisted in the same atomic snapshot. */
  explicitlyUnknown?: true;
  /** Only for kind 'new' — staged into the customer store by the handoff. */
  pendingCustomer?: Customer;
}

/**
 * CUSTOMER-FACHOBJEKT-03B2 — resolves the call contract before any mutation.
 * Returns null on every validation error; the caller must abort entirely and
 * must never fall back to a different decision variant.
 */
function resolveCustomerDecision(
  decision: CustomerDecision | undefined,
  inboxId: string,
  legacyCustomer: string,
): ResolvedCustomerDecision | null {
  if (!decision) {
    return { customer: legacyCustomer, billing: emptyCustomerBilling(legacyCustomer) };
  }

  if (decision.kind === 'none') {
    return { customer: '', billing: emptyCustomerBilling(''), explicitlyUnknown: true };
  }

  if (decision.kind === 'existing') {
    const selected = getCustomerById(decision.customerId.trim());
    if (!selected) return null;
    if (!selected.name.trim()) return null;
    if (isOwnCompanyName(selected.name)) return null;
    return {
      customer: selected.name,
      billing: billingFromCustomer(selected),
      customerId: selected.id,
    };
  }

  const built = buildValidatedCustomer(decision.input, { createdFromInboxId: inboxId });
  if (!built.ok) return null;
  return {
    customer: built.customer.name,
    billing: billingFromCustomer(built.customer),
    customerId: built.customer.id,
    pendingCustomer: built.customer,
  };
}

/**
 * CUSTOMER-FACHOBJEKT-04D-U4 — single eligibility rule shared by service and UI.
 * Pure: no store access, no mutation. Any non-empty billing field counts as an
 * existing (or inconsistent) customer identity and blocks the assignment.
 */
export function isVorgangCustomerAssignmentEligible(
  vorgang: Pick<Vorgang, 'customer' | 'customerId' | 'customerBilling' | 'customerExplicitlyUnknown'>,
): boolean {
  if (vorgang.customerExplicitlyUnknown !== true) return false;
  if (vorgang.customerId?.trim()) return false;
  if (vorgang.customer.trim()) return false;

  const billing = vorgang.customerBilling;
  if (!billing) return true;
  return ![
    billing.name,
    billing.contactPerson,
    billing.street,
    billing.zip,
    billing.city,
    billing.email,
    billing.phone,
  ].some((value) => value?.trim());
}

export type AssignCustomerToVorgangResult =
  | { success: true; vorgang: Vorgang }
  | { success: false; errorKey: string };

/**
 * CUSTOMER-FACHOBJEKT-04D-U4 — later, explicit customer assignment for a Vorgang
 * that was deliberately created without one. Never automatic, never overwriting.
 *
 * Everything before the staging block is read-only: no id is generated and no
 * store is touched until every gate has passed.
 */
export function assignCustomerToVorgang(
  vorgangId: string,
  customerDecision: CustomerDecision | undefined,
): AssignCustomerToVorgangResult {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return { success: false, errorKey: 'vorgang.notFound' };

  // Only the exact unknown state may be filled — any existing identity wins.
  if (!isVorgangCustomerAssignmentEligible(vorgang)) {
    return { success: false, errorKey: 'customer.alreadyAssigned' };
  }

  // 'none' is not an assignment — the Vorgang already carries that state.
  if (!customerDecision || customerDecision.kind === 'none') {
    return { success: false, errorKey: 'customerDecision.required' };
  }

  const decisionCheck = validateCustomerDecisionForCreate(customerDecision);
  if (!decisionCheck.ok) return { success: false, errorKey: decisionCheck.errorKey };

  let target: Customer;
  let pendingCustomer: Customer | undefined;
  if (customerDecision.kind === 'existing') {
    const selected = getCustomerById(customerDecision.customerId.trim());
    if (!selected) return { success: false, errorKey: 'customerDecision.missing' };
    target = selected;
  } else {
    const built = buildValidatedCustomer(customerDecision.input);
    if (!built.ok) return { success: false, errorKey: built.errorKey };
    target = built.customer;
    pendingCustomer = built.customer;
  }

  // --- Staging: customer store first (in memory), then one persisted Vorgang mutation.
  const previousCustomers = getCustomerStoreSnapshot();
  if (pendingCustomer) upsertCustomerInStore(pendingCustomer);

  const committed = commitVorgangMutation(vorgangId, (current) => ({
    ...cloneVorgang(current),
    customer: target.name,
    customerId: target.id,
    customerBilling: billingFromCustomer(target),
    customerExplicitlyUnknown: undefined,
  }));

  if (!committed.ok) {
    if (pendingCustomer) restoreCustomerStore(previousCustomers);
    return { success: false, errorKey: committed.errorKey };
  }

  return { success: true, vorgang: committed.vorgang };
}

export function createVorgangFromInbox(
  item: InboxItem,
  optionalDraft?: Partial<VorgangDraft>,
  defaultMaterial: MaterialStandard = 'unclear',
  options?: { skipDefaultPositions?: boolean; customerDecision?: CustomerDecision },
): { vorgang: Vorgang; inbox: InboxItem } | null {
  // --- Guards and validation: no store is touched before this block completes.
  const currentItem = resolveInboxItemForLinking(item);
  if (isInboxLinkedToVorgang(currentItem)) return null;

  const archiveId = currentItem.archiveDocumentId?.trim() || undefined;
  const archiveDocument = archiveId ? getDocumentById(archiveId) : undefined;
  if (archiveId && !archiveDocument) {
    return null;
  }

  const baseDraft = buildVorgangDraftFromInbox(currentItem, defaultMaterial);
  const draft: VorgangDraft = { ...baseDraft, ...optionalDraft };
  // optionalDraft may carry an own-company name; fall back to the already guarded
  // base candidate rather than storing our own company as the customer.
  const legacyCustomer = pickExternalCustomerName([draft.customer, baseDraft.customer]);

  const resolved = resolveCustomerDecision(options?.customerDecision, item.id, legacyCustomer);
  if (!resolved) return null;

  const doc = buildDocumentFromInbox(currentItem, archiveId);

  let newVorgang: Vorgang = withNewEntitySync(
    {
      id: generateEntityId('v'),
      title: draft.title,
      customer: resolved.customer,
      baustelle: draft.baustelle,
      status: 'eingegangen' as const,
      materialSource: draft.materialSource,
      customerId: resolved.customerId,
      customerExplicitlyUnknown: resolved.explicitlyUnknown,
      customerBilling: resolved.billing,
      orderPositions: options?.skipDefaultPositions ? [] : buildOrderPositionsFromInbox(currentItem),
      documents: [doc],
      tasks: [],
      photos: [],
      invoices: [],
      createdFromInboxId: item.id,
    },
    'vorgang',
  );

  // --- Snapshots of every store the handoff may touch.
  const previousVorgaenge = vorgaenge;
  const previousCustomers = getCustomerStoreSnapshot();
  const previousInbox = getInboxStoreSnapshot();
  const previousDocuments = getDocumentStoreSnapshot();

  const rollback = (): null => {
    vorgaenge = previousVorgaenge;
    restoreCustomerStore(previousCustomers);
    hydrateInboxStore(previousInbox);
    hydrateDocumentStore(previousDocuments);
    return null;
  };

  // --- In-memory staging only. No persist inside this block.
  if (resolved.pendingCustomer) {
    upsertCustomerInStore(resolved.pendingCustomer);
  }

  vorgaenge = [newVorgang, ...vorgaenge];

  const linkedInbox = stageInboxItemPatch(currentItem.id, {
    vorgangId: newVorgang.id,
    vorgangTitle: newVorgang.title,
    vorgangLinkStatus: 'created',
    status: 'geprueft',
    isNewUpload: false,
  });
  if (!linkedInbox) return rollback();

  if (archiveId && archiveDocument) {
    let boundDocument = archiveDocument;
    if (archiveDocument.linkedVorgang?.vorgangId !== newVorgang.id) {
      const stagedDoc = stageDocumentUpdate(archiveId, {
        linkedVorgang: { vorgangId: newVorgang.id, vorgangTitle: newVorgang.title },
      });
      if (!stagedDoc.success) return rollback();
      boundDocument = stagedDoc.document;
    }
    newVorgang = applyCompanyDocumentToVorgang(newVorgang, boundDocument, linkedInbox);
    vorgaenge = vorgaenge.map((v) => (v.id === newVorgang.id ? newVorgang : v));
  }

  // --- Exactly one persist for customer, Vorgang, inbox link and document binding.
  const persisted = persistAll();
  if (!persisted.success) return rollback();

  const freshVorgang = getVorgangById(newVorgang.id);
  const freshInbox = resolveInboxItemForLinking(linkedInbox);
  if (!freshVorgang) return rollback();
  return { vorgang: freshVorgang, inbox: freshInbox };
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
 * Local-only persist for Nachtragsentwürfe.
 * Does not mutate orderPositions, confirmation, invoices, or sync version.
 * Non-empty drafts require contractConfirmation; empty clears remain allowed.
 */
export function saveVorgangOrderAmendments(
  vorgangId: string,
  orderAmendments: OrderAmendment[] | undefined,
): VorgangOrderAmendmentsUpdateResult {
  const index = vorgaenge.findIndex((v) => v.id === vorgangId && isEntitySyncActive(v));
  if (index === -1) {
    return { success: false, errorKey: 'vorgang.notFound' };
  }

  const current = normalizeVorgang(vorgaenge[index]!);
  const normalizedAmendments = normalizeOrderAmendments(orderAmendments);
  const hasDrafts = Boolean(normalizedAmendments && normalizedAmendments.length > 0);

  if (hasDrafts && !current.contractConfirmation) {
    return { success: false, errorKey: 'order_amendment_requires_confirmation' };
  }

  const updated = cloneVorgang({
    ...current,
    orderAmendments: hasDrafts ? normalizedAmendments : undefined,
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

  const previousRaw = vorgaenge[index]!;
  const updated = cloneVorgang({
    ...current,
    status: 'beauftragt',
    orderPositions: alignedPositions,
    negotiation: normalizeNegotiation(negotiation),
    contractConfirmation: frozen,
  });
  const next = isEntitySyncActive(updated)
    ? withUpdatedEntitySync(updated, 'vorgang')
    : updated;
  vorgaenge = vorgaenge.map((v) => (v.id === vorgangId ? next : v));
  const persistResult = persistAll();
  if (!persistResult.success) {
    vorgaenge = vorgaenge.map((v) => (v.id === vorgangId ? previousRaw : v));
    return { success: false, errorKey: 'confirmation.persistFailed' };
  }
  return { success: true, vorgang: cloneVorgang(next) };
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

  const index = vorgaenge.findIndex((v) => v.id === vorgangId && isEntitySyncActive(v));
  if (index === -1) return null;

  const archiveId = currentItem.archiveDocumentId?.trim() || undefined;
  if (archiveId && !getDocumentById(archiveId)) {
    return null;
  }

  const previousDocuments = cloneVorgang(vorgaenge[index]).documents.map((d) => ({ ...d }));
  const vorgang = cloneVorgang(vorgaenge[index]);
  appendDocumentIfNew(vorgang, buildDocumentFromInbox(currentItem, archiveId));
  updateVorgangInStore(vorgang);

  const linkedInbox = setInboxVorgangLink(currentItem.id, vorgang.id, vorgang.title, 'linked');
  if (!linkedInbox) {
    const restored = cloneVorgang(vorgaenge.find((v) => v.id === vorgangId)!);
    restored.documents = previousDocuments;
    updateVorgangInStore(restored);
    return null;
  }

  if (!bindInboxArchiveDocumentToVorgang(linkedInbox, vorgang.id, vorgang.title)) {
    const restored = cloneVorgang(getVorgangById(vorgangId) ?? vorgang);
    restored.documents = previousDocuments;
    updateVorgangInStore(restored);
    clearInboxVorgangLink(linkedInbox.id);
    return null;
  }

  const freshVorgang = getVorgangById(vorgangId);
  const freshInbox = resolveInboxItemForLinking(linkedInbox);
  if (!freshVorgang) return null;
  return { vorgang: freshVorgang, inbox: freshInbox };
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
  | { ok: true; invoice: VorgangInvoice; action: 'inserted' | 'noop' | 'status_raised' }
  | {
      ok: false;
      reason:
        | 'vorgang_missing'
        | 'id_content_conflict'
        | 'number_id_conflict'
        | 'local_persist_failed';
    };

const INVOICE_STATUS_RANK: Record<VorgangInvoice['status'], number> = {
  entwurf: 0,
  vorbereitet: 1,
  versendet: 2,
};

/** Monotonic status resolve — never downgrade versendet → vorbereitet. */
export function resolveMonotonicInvoiceStatus(
  local: VorgangInvoice['status'],
  cloud: VorgangInvoice['status'],
): VorgangInvoice['status'] {
  return INVOICE_STATUS_RANK[cloud] > INVOICE_STATUS_RANK[local] ? cloud : local;
}

/**
 * Immutable invoice fingerprint for append-only merge conflicts.
 * Excludes payments, archiveDocumentId, sent UI metadata, and paymentStatus.
 */
export function immutableInvoiceFingerprint(
  invoice: VorgangInvoice,
  vorgangId?: string,
): string {
  const company = invoice.companySnapshot
    ? (() => {
        const { logoDataUrl: _logo, ...rest } = invoice.companySnapshot;
        return rest;
      })()
    : null;

  return JSON.stringify({
    id: invoice.id,
    vorgangId: vorgangId ?? null,
    number: invoice.number,
    invoiceSequenceNumber: invoice.invoiceSequenceNumber ?? null,
    type: invoice.type,
    abschlagNumber: invoice.abschlagNumber ?? null,
    subtotal: invoice.subtotal,
    amount: invoice.amount,
    taxStatus: invoice.taxStatus,
    date: invoice.date,
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
    customerSnapshot: invoice.customerSnapshot ?? null,
    companySnapshot: company,
    legalNotices: invoice.legalNotices ?? [],
    previousAbschlagDeductions: invoice.previousAbschlagDeductions ?? [],
    positionCount: (invoice.positions ?? []).length,
    positions: (invoice.positions ?? []).map((p) => ({
      id: p.id,
      orderPositionId: p.orderPositionId,
      description: p.description,
      quantity: p.quantity,
      unit: p.unit,
      unitLabel: p.unitLabel ?? null,
      unitPrice: p.unitPrice,
      lineTotal: p.lineTotal,
    })),
  });
}

/**
 * Pure append-only adoption of a cloud invoice onto a Vorgang clone.
 * Preserves local payments / archiveDocumentId; never LWW-overwrites content.
 */
export function applyFinalizedInvoiceToVorgang(
  vorgang: Vorgang,
  invoice: VorgangInvoice,
): UpsertFinalizedInvoiceResult & { vorgang?: Vorgang } {
  const next = cloneVorgang(vorgang);
  const byId = next.invoices.find((item) => item.id === invoice.id);
  if (byId) {
    if (immutableInvoiceFingerprint(byId, next.id) !== immutableInvoiceFingerprint(invoice, next.id)) {
      return { ok: false, reason: 'id_content_conflict' };
    }

    const raisedStatus = resolveMonotonicInvoiceStatus(byId.status, invoice.status);
    if (raisedStatus === byId.status) {
      return { ok: true, invoice: { ...byId }, action: 'noop', vorgang: next };
    }

    const updated: VorgangInvoice = { ...byId, status: raisedStatus };
    next.invoices = next.invoices.map((item) => (item.id === updated.id ? updated : item));
    return { ok: true, invoice: { ...updated }, action: 'status_raised', vorgang: next };
  }

  const byNumber = next.invoices.find(
    (item) => item.number === invoice.number && item.id !== invoice.id,
  );
  if (byNumber) {
    return { ok: false, reason: 'number_id_conflict' };
  }

  const adopted: VorgangInvoice = {
    ...invoice,
    // Keep empty local comfort fields; never invent payments/PDF from cloud.
    payments: invoice.payments ?? [],
    paymentStatus: invoice.paymentStatus ?? 'offen',
  };
  next.invoices = [adopted, ...next.invoices];
  return { ok: true, invoice: { ...adopted }, action: 'inserted', vorgang: next };
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

  const previousRaw = vorgaenge[index]!;
  const applied = applyFinalizedInvoiceToVorgang(previousRaw, invoice);
  if (!applied.ok || !applied.vorgang) {
    return applied.ok
      ? { ok: true, invoice: applied.invoice, action: applied.action }
      : applied;
  }

  if (applied.action === 'noop') {
    return { ok: true, invoice: applied.invoice, action: 'noop' };
  }

  const next = isEntitySyncActive(applied.vorgang)
    ? withUpdatedEntitySync(applied.vorgang, 'vorgang')
    : applied.vorgang;
  vorgaenge = vorgaenge.map((v) => (v.id === vorgangId ? next : v));
  const persistResult = persistAll();
  if (!persistResult.success) {
    vorgaenge = vorgaenge.map((v) => (v.id === vorgangId ? previousRaw : v));
    return { ok: false, reason: 'local_persist_failed' };
  }
  return { ok: true, invoice: applied.invoice, action: applied.action };
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
  const planLock = assertContractPlanMutable(vorgang);
  if (!planLock.ok) {
    return { success: false, errorKey: planLock.errorKey };
  }
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
  const planLock = assertContractPlanMutable(vorgang);
  if (!planLock.ok) {
    return {
      success: false,
      added: 0,
      skipped: inputs.length,
      errorKey: planLock.errorKey,
    };
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

  const planLock = assertContractPlanMutable(vorgang);
  if (!planLock.ok) {
    return { success: false, errorKey: planLock.errorKey };
  }

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

  const planLock = assertContractPlanMutable(vorgang);
  if (!planLock.ok) {
    return { success: false, errorKey: planLock.errorKey };
  }

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
  const primaryTarget = resolvePrimaryTargetObjectForDocumentType(item.documentType);

  if (
    primaryTarget === 'vorgang' ||
    item.recommendedAction === 'auftrag_annehmen'
  ) {
    return 'create';
  }

  if (
    primaryTarget === 'expense' ||
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

/**
 * CUSTOMER-FACHOBJEKT-03B3 — single guard shared by both contract writers.
 *
 * `auftraggeber` is the name that may still be written (undefined = keep the
 * stored one). `allowContactFields` covers ansprechpartner / telefon / email,
 * which belong to the same detected party and are therefore never split off.
 */
function resolveContractCustomerFields(
  vorgang: Vorgang,
  fields: ContractExtractedFields,
): { auftraggeber?: string; allowContactFields: boolean } {
  // B — explicitly unknown: no document may fill the customer, ever.
  if (vorgang.customerExplicitlyUnknown === true) {
    return { allowContactFields: false };
  }

  // Own company is never the customer (unchanged).
  if (isOwnCompanyName(fields.auftraggeber)) {
    return { allowContactFields: false };
  }

  const auftraggeber = fields.auftraggeber?.trim() ? fields.auftraggeber : undefined;

  // A — bound identity: the chosen Customer wins over any document name.
  if (vorgang.customerId) {
    if (!auftraggeber) return { allowContactFields: true };
    const sameParty =
      normalizeCompanyNameForComparison(auftraggeber) ===
      normalizeCompanyNameForComparison(vorgang.customer);
    // Same party: contacts may enrich, but the stored spelling stays.
    // Different party: name and all three contact fields are discarded together.
    return { allowContactFields: sameParty };
  }

  // C — legacy: unchanged behaviour.
  return { auftraggeber, allowContactFields: true };
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
  const { auftraggeber, allowContactFields } = resolveContractCustomerFields(updated, fields);
  if (auftraggeber && !updated.customer.trim()) {
    updated.customer = auftraggeber;
  }

  const billing = { ...emptyCustomerBilling(updated.customer), ...(updated.customerBilling ?? {}) };
  if (allowContactFields) {
    if (fields.ansprechpartner) billing.contactPerson = fields.ansprechpartner;
    if (fields.telefon) billing.phone = fields.telefon;
    if (fields.email) billing.email = fields.email;
    if (auftraggeber) billing.name = auftraggeber;
  }
  updated.customerBilling = billing;

  return { success: true, vorgang: updateVorgangInStore(updated) };
}

/**
 * Accept-path: CI/proposal values overwrite inbox leftovers (e.g. project name stored as Baustelle).
 * Objekt has no Vorgang field — reflected on the linked contract document name when provided.
 */
export function applyContractAcceptFieldsToVorgang(
  vorgangId: string,
  fields: ContractExtractedFields,
  options?: { contractDate?: string; objekt?: string },
): { success: true; vorgang: Vorgang } | { success: false; errorKey: string } {
  const committed = commitVorgangMutation(vorgangId, (current) => {
    const updated = cloneVorgang(current);
    const title = fields.bauvorhaben ?? fields.projektname;
    if (title) updated.title = title;
    if (fields.baustellenadresse) updated.baustelle = fields.baustellenadresse;
    const { auftraggeber, allowContactFields } = resolveContractCustomerFields(updated, fields);
    if (auftraggeber) updated.customer = auftraggeber;

    const billing = {
      ...emptyCustomerBilling(updated.customer),
      ...(updated.customerBilling ?? {}),
    };
    if (allowContactFields) {
      if (fields.ansprechpartner) billing.contactPerson = fields.ansprechpartner;
      if (fields.telefon) billing.phone = fields.telefon;
      if (fields.email) billing.email = fields.email;
      if (auftraggeber) billing.name = auftraggeber;
    }
    updated.customerBilling = billing;

    const contractDate = (options?.contractDate ?? fields.vertragsdatum)?.trim();
    if (contractDate) {
      updated.documents = updated.documents.map((doc) =>
        doc.companyDocumentId || doc.type === 'kundenauftrag'
          ? { ...doc, date: contractDate, type: 'kundenauftrag' as const }
          : doc,
      );
    }

    const objekt = options?.objekt?.trim();
    if (objekt) {
      updated.documents = updated.documents.map((doc) => {
        if (!doc.companyDocumentId && doc.type !== 'kundenauftrag') return doc;
        const base = doc.name?.trim() || 'Werkvertrag';
        if (base.includes(objekt)) return doc;
        return { ...doc, name: `${base} – ${objekt}` };
      });
    }

    return updated;
  });

  if (!committed.ok) {
    return { success: false, errorKey: committed.errorKey };
  }
  return { success: true, vorgang: committed.vorgang };
}

export function resetVorgaenge(): void {
  vorgaenge = [];
}

export { buildOrderPositionsFromInbox, parseOfferAmount } from './orderPositionFactory';
