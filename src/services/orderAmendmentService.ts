import { generateEntityId } from './sync/syncMetaService';
import {
  getVorgangById,
  saveVorgangOrderAmendments,
} from './vorgangService';
import { isOrderAmendmentDraftLockedByIntent } from './orderAmendment/orderAmendmentConfirmIntentService';
import { buildPersistedStateSnapshot } from './persistenceService';
import { isSupabaseSyncAllowed } from './sync/cloudSyncAllowlist';
import {
  enqueueSyncOutbox,
  getSyncOutboxSnapshot,
  hydrateSyncOutbox,
  markOutboxEntriesCompleted,
  releaseBlockedOutboxEntry,
} from './sync/syncOutboxService';
import {
  acknowledgeTrackedEntityFromState,
  captureSyncChangeTrackerState,
  restoreSyncChangeTrackerState,
} from './sync/syncChangeTrackerService';
import {
  getOrderAmendmentDraftTombstoneSnapshot,
  hydrateOrderAmendmentDraftTombstones,
  putOrderAmendmentDraftTombstone,
} from './orderAmendment/orderAmendmentDraftTombstoneStore';
import type {
  OrderAmendment,
  OrderAmendmentChangeType,
  OrderAmendmentDraftPosition,
  OrderPosition,
  OrderPositionCategory,
  OrderUnit,
  Vorgang,
} from '../types/models';
import type { SyncMeta } from '../types/sync';
import type { OrderAmendmentDraftCloudBinding } from '../types/orderAmendmentDraftCloud';

export type OrderAmendmentErrorKey =
  | 'vorgang.notFound'
  | 'order_amendment_requires_confirmation'
  | 'order_amendment_not_found'
  | 'order_amendment_position_not_found'
  | 'order_amendment_invalid_position'
  | 'order_amendment_parent_position_not_found'
  | 'order_amendment_confirmation_outcome_unknown'
  /** CLOUD-SYNC S6 — ein offener Konflikt sperrt den Entwurf bis zur Entscheidung. */
  | 'order_amendment_conflict_open'
  /** CLOUD-SYNC S6 — die lokale Speicherung ist gescheitert; nichts wurde übernommen. */
  | 'order_amendment_persist_failed';

function assertDraftUnlocked(
  vorgangId: string,
  amendmentId: string,
): OrderAmendmentErrorKey | null {
  if (isOrderAmendmentDraftLockedByIntent(vorgangId, amendmentId)) {
    return 'order_amendment_confirmation_outcome_unknown';
  }
  // CLOUD-SYNC S6 — bis zur Entscheidung über einen Konflikt nimmt der Entwurf keine Änderung an.
  const draft = getVorgangById(vorgangId)?.orderAmendments?.find((item) => item.id === amendmentId);
  if (draft?.conflict) return 'order_amendment_conflict_open';
  return null;
}

/** CLOUD-SYNC S6 — ob die Cloud-Seite freigegeben ist (Migration remote angewendet). */
export function isOrderAmendmentDraftCloudSyncAllowed(): boolean {
  return isSupabaseSyncAllowed('order_amendment_draft');
}

/** Aktive Sendeaufträge eines Nachtragsentwurfs (ausstehend, blockiert, fehlerhaft). */
function activeAmendmentDraftOutbox(draftId: string) {
  return getSyncOutboxSnapshot().filter(
    (entry) =>
      entry.entityType === 'order_amendment_draft' &&
      entry.entityId === draftId &&
      (entry.status === 'pending' || entry.status === 'blocked' || entry.status === 'error'),
  );
}

/** Ob dieser Nachtragsentwurf noch eine nicht übertragene Änderung trägt. */
export function hasPendingOrderAmendmentDraftCloudChange(draftId: string): boolean {
  return activeAmendmentDraftOutbox(draftId).length > 0;
}

function completeAmendmentDraftOutbox(draftId: string): void {
  const ids = activeAmendmentDraftOutbox(draftId).map((entry) => entry.id);
  if (ids.length > 0) markOutboxEntriesCompleted(ids);
}

/**
 * Gemeinsamer Speicherweg für Entscheidungen und Verwerfen: Grabsteine,
 * Warteschlange und Änderungsverfolger werden zusammen mit dem Vorgang
 * gespeichert — oder gemeinsam zurückgebaut. Ein Speicherfehler meldet nie
 * Erfolg.
 */
function commitAmendmentDrafts(
  vorgangId: string,
  nextDrafts: OrderAmendment[],
  options: { before?: () => void; acknowledge?: string[] } = {},
): { success: true; vorgang: Vorgang } | { success: false; errorKey: OrderAmendmentErrorKey } {
  const tombstonesBefore = getOrderAmendmentDraftTombstoneSnapshot();
  const outboxBefore = getSyncOutboxSnapshot();
  const trackerBefore = captureSyncChangeTrackerState();
  options.before?.();
  if (options.acknowledge && options.acknowledge.length > 0) {
    // Der Zielzustand wird vorab als „mit dem Server abgeglichen" quittiert: Er übernimmt einen bekannten Serverstand.
    const snapshot = buildPersistedStateSnapshot();
    const target = {
      ...snapshot,
      vorgaenge: snapshot.vorgaenge.map((vorgang) =>
        vorgang.id === vorgangId ? { ...vorgang, orderAmendments: nextDrafts.map(normalizeForStore) } : vorgang,
      ),
    };
    for (const id of options.acknowledge) acknowledgeTrackedEntityFromState(target, 'order_amendment_draft', id);
  }
  const saved = saveVorgangOrderAmendments(vorgangId, nextDrafts);
  if (!saved.success) {
    hydrateOrderAmendmentDraftTombstones(tombstonesBefore);
    hydrateSyncOutbox(outboxBefore);
    restoreSyncChangeTrackerState(trackerBefore);
    return { success: false, errorKey: saved.errorKey };
  }
  return { success: true, vorgang: saved.vorgang };
}

/** Dieselbe Normalisierung wie beim Speichern im Vorgang — für die Vorab-Quittung. */
function normalizeForStore(amendment: OrderAmendment): OrderAmendment {
  return {
    ...amendment,
    status: 'entwurf',
    title: typeof amendment.title === 'string' ? amendment.title : 'Nachtrag',
    reason: amendment.reason?.trim() || undefined,
    positions: (amendment.positions ?? []).map((position) => ({ ...position })),
  };
}

export type OrderAmendmentResult =
  | { success: true; vorgang: Vorgang; amendment: OrderAmendment }
  | { success: false; errorKey: OrderAmendmentErrorKey };

export type OrderAmendmentDraftPositionInput = {
  changeType: OrderAmendmentChangeType;
  description: string;
  quantity: number;
  unit: OrderUnit;
  unitLabel?: string;
  unitPrice: number;
  category?: OrderPositionCategory;
  billable?: boolean;
  parentPositionId?: string;
};

const ORDER_UNITS: ReadonlySet<OrderUnit> = new Set([
  'm²',
  'Stück',
  'Meter',
  'Stunden',
  'Pauschal',
]);

function nowIso(): string {
  return new Date().toISOString();
}

function cloneAmendment(amendment: OrderAmendment): OrderAmendment {
  return {
    ...amendment,
    positions: amendment.positions.map((position) => ({ ...position })),
  };
}

function cloneAmendments(list: OrderAmendment[] | undefined): OrderAmendment[] {
  return (list ?? []).map(cloneAmendment);
}

function listConfirmedParentIds(vorgang: Vorgang): Set<string> {
  const fromSnapshot = vorgang.contractConfirmation?.positions.map((p) => p.id) ?? [];
  return new Set(fromSnapshot);
}

function findParentPosition(vorgang: Vorgang, parentPositionId: string): OrderPosition | undefined {
  return vorgang.orderPositions.find((position) => position.id === parentPositionId);
}

function validateDraftPosition(
  vorgang: Vorgang,
  input: OrderAmendmentDraftPositionInput,
): OrderAmendmentErrorKey | null {
  if (!input.description.trim()) {
    return 'order_amendment_invalid_position';
  }
  if (!ORDER_UNITS.has(input.unit)) {
    return 'order_amendment_invalid_position';
  }
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    return 'order_amendment_invalid_position';
  }
  if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0) {
    return 'order_amendment_invalid_position';
  }

  if (input.changeType === 'add') {
    if (input.parentPositionId) {
      return 'order_amendment_invalid_position';
    }
    return null;
  }

  if (input.changeType === 'quantity_increase') {
    if (!input.parentPositionId) {
      return 'order_amendment_parent_position_not_found';
    }
    if (!listConfirmedParentIds(vorgang).has(input.parentPositionId)) {
      return 'order_amendment_parent_position_not_found';
    }
    if (!findParentPosition(vorgang, input.parentPositionId)) {
      return 'order_amendment_parent_position_not_found';
    }
    return null;
  }

  return 'order_amendment_invalid_position';
}

function requireConfirmedVorgang(
  vorgangId: string,
): { ok: true; vorgang: Vorgang } | { ok: false; errorKey: OrderAmendmentErrorKey } {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) {
    return { ok: false, errorKey: 'vorgang.notFound' };
  }
  if (!vorgang.contractConfirmation) {
    return { ok: false, errorKey: 'order_amendment_requires_confirmation' };
  }
  return { ok: true, vorgang };
}

function persistAmendments(
  vorgangId: string,
  amendments: OrderAmendment[],
  amendmentId: string,
): OrderAmendmentResult {
  const saved = saveVorgangOrderAmendments(vorgangId, amendments);
  if (!saved.success) {
    return { success: false, errorKey: saved.errorKey };
  }
  const amendment = saved.vorgang.orderAmendments?.find((item) => item.id === amendmentId);
  if (!amendment) {
    return { success: false, errorKey: 'order_amendment_not_found' };
  }
  return { success: true, vorgang: saved.vorgang, amendment: cloneAmendment(amendment) };
}

export function listOrderAmendments(vorgangId: string): OrderAmendment[] {
  const vorgang = getVorgangById(vorgangId);
  return cloneAmendments(vorgang?.orderAmendments);
}

export function getOrderAmendment(
  vorgangId: string,
  amendmentId: string,
): OrderAmendment | undefined {
  return listOrderAmendments(vorgangId).find((item) => item.id === amendmentId);
}

export function createOrderAmendmentDraft(
  vorgangId: string,
  input: { title?: string; reason?: string } = {},
): OrderAmendmentResult {
  const gate = requireConfirmedVorgang(vorgangId);
  if (!gate.ok) return { success: false, errorKey: gate.errorKey };

  const timestamp = nowIso();
  const amendment: OrderAmendment = {
    id: generateEntityId('oa'),
    vorgangId,
    status: 'entwurf',
    title: input.title?.trim() || 'Nachtrag',
    reason: input.reason?.trim() || undefined,
    positions: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const next = [...cloneAmendments(gate.vorgang.orderAmendments), amendment];
  return persistAmendments(vorgangId, next, amendment.id);
}

export function updateOrderAmendmentDraft(
  vorgangId: string,
  amendmentId: string,
  patch: { title?: string; reason?: string | null },
): OrderAmendmentResult {
  const gate = requireConfirmedVorgang(vorgangId);
  if (!gate.ok) return { success: false, errorKey: gate.errorKey };
  const locked = assertDraftUnlocked(vorgangId, amendmentId);
  if (locked) return { success: false, errorKey: locked };

  const amendments = cloneAmendments(gate.vorgang.orderAmendments);
  const index = amendments.findIndex((item) => item.id === amendmentId);
  if (index === -1) {
    return { success: false, errorKey: 'order_amendment_not_found' };
  }

  const current = amendments[index]!;
  const nextTitle = patch.title !== undefined ? patch.title.trim() : current.title;
  if (!nextTitle) {
    return { success: false, errorKey: 'order_amendment_invalid_position' };
  }

  let nextReason = current.reason;
  if (patch.reason === null) {
    nextReason = undefined;
  } else if (patch.reason !== undefined) {
    nextReason = patch.reason.trim() || undefined;
  }

  amendments[index] = {
    ...current,
    title: nextTitle,
    reason: nextReason,
    updatedAt: nowIso(),
  };

  return persistAmendments(vorgangId, amendments, amendmentId);
}

/** CLOUD-SYNC S6 — kann die Cloud diesen Entwurf kennen? Dann braucht sein Verwerfen einen Grabstein. */
function needsCloudTombstone(draft: OrderAmendment): boolean {
  if (!isOrderAmendmentDraftCloudSyncAllowed()) return false;
  if ((draft.sync?.version ?? 0) > 0) return true;
  return hasPendingOrderAmendmentDraftCloudChange(draft.id);
}

function tombstoneOf(draft: OrderAmendment, vorgangId: string) {
  const at = nowIso();
  const base: SyncMeta = draft.sync ?? { updatedAt: at, version: 0, deleted: false, deviceId: '', workspaceId: '' };
  return { id: draft.id, vorgangId, sync: { ...base, deleted: true, deletedAt: at, updatedAt: at } };
}

export function deleteOrderAmendmentDraft(
  vorgangId: string,
  amendmentId: string,
): { success: true; vorgang: Vorgang } | { success: false; errorKey: OrderAmendmentErrorKey } {
  const gate = requireConfirmedVorgang(vorgangId);
  if (!gate.ok) return { success: false, errorKey: gate.errorKey };
  const locked = assertDraftUnlocked(vorgangId, amendmentId);
  if (locked) return { success: false, errorKey: locked };

  const amendments = cloneAmendments(gate.vorgang.orderAmendments);
  const index = amendments.findIndex((item) => item.id === amendmentId);
  if (index === -1) {
    return { success: false, errorKey: 'order_amendment_not_found' };
  }

  const [removed] = amendments.splice(index, 1);
  /*
   * CLOUD-SYNC S6 — kennt die Cloud den Entwurf (oder ist er unterwegs),
   * bleibt bis zur Bestätigung des Verwerfens ein Grabstein neben dem Vorgang.
   * Scheitert das Speichern, ist alles wie vorher.
   */
  return commitAmendmentDrafts(vorgangId, amendments, {
    before: () => {
      if (removed && needsCloudTombstone(removed)) putOrderAmendmentDraftTombstone(tombstoneOf(removed, vorgangId));
    },
  });
}

export function addOrderAmendmentDraftPosition(
  vorgangId: string,
  amendmentId: string,
  input: OrderAmendmentDraftPositionInput,
): OrderAmendmentResult {
  const gate = requireConfirmedVorgang(vorgangId);
  if (!gate.ok) return { success: false, errorKey: gate.errorKey };
  const locked = assertDraftUnlocked(vorgangId, amendmentId);
  if (locked) return { success: false, errorKey: locked };

  const validationError = validateDraftPosition(gate.vorgang, input);
  if (validationError) {
    return { success: false, errorKey: validationError };
  }

  const amendments = cloneAmendments(gate.vorgang.orderAmendments);
  const index = amendments.findIndex((item) => item.id === amendmentId);
  if (index === -1) {
    return { success: false, errorKey: 'order_amendment_not_found' };
  }

  let description = input.description.trim();
  let unit = input.unit;
  let unitLabel = input.unitLabel;
  let unitPrice = input.unitPrice;
  let category = input.category;
  let billable = input.billable;

  if (input.changeType === 'quantity_increase' && input.parentPositionId) {
    const parent = findParentPosition(gate.vorgang, input.parentPositionId)!;
    description = description || parent.description;
    unit = unit || parent.unit;
    unitLabel = unitLabel ?? parent.unitLabel;
    if (!Number.isFinite(unitPrice)) {
      unitPrice = parent.unitPrice;
    }
    category = category ?? parent.category;
    billable = billable ?? parent.billable;
  }

  const position: OrderAmendmentDraftPosition = {
    id: generateEntityId('oad'),
    changeType: input.changeType,
    description,
    quantity: input.quantity,
    unit,
    unitLabel,
    unitPrice,
    category,
    billable,
    parentPositionId:
      input.changeType === 'quantity_increase' ? input.parentPositionId : undefined,
  };

  const current = amendments[index]!;
  amendments[index] = {
    ...current,
    positions: [...current.positions, position],
    updatedAt: nowIso(),
  };

  return persistAmendments(vorgangId, amendments, amendmentId);
}

/**
 * Prefill helpers for quantity_increase from a confirmed parent position.
 * Does not mutate the parent or create a draft position.
 */
export function buildQuantityIncreaseDefaults(
  vorgangId: string,
  parentPositionId: string,
):
  | { success: true; defaults: OrderAmendmentDraftPositionInput }
  | { success: false; errorKey: OrderAmendmentErrorKey } {
  const gate = requireConfirmedVorgang(vorgangId);
  if (!gate.ok) return { success: false, errorKey: gate.errorKey };

  if (!listConfirmedParentIds(gate.vorgang).has(parentPositionId)) {
    return { success: false, errorKey: 'order_amendment_parent_position_not_found' };
  }
  const parent = findParentPosition(gate.vorgang, parentPositionId);
  if (!parent) {
    return { success: false, errorKey: 'order_amendment_parent_position_not_found' };
  }

  return {
    success: true,
    defaults: {
      changeType: 'quantity_increase',
      description: parent.description,
      quantity: 1,
      unit: parent.unit,
      unitLabel: parent.unitLabel,
      unitPrice: parent.unitPrice,
      category: parent.category,
      billable: parent.billable,
      parentPositionId: parent.id,
    },
  };
}

export function updateOrderAmendmentDraftPosition(
  vorgangId: string,
  amendmentId: string,
  positionId: string,
  patch: Partial<OrderAmendmentDraftPositionInput>,
): OrderAmendmentResult {
  const gate = requireConfirmedVorgang(vorgangId);
  if (!gate.ok) return { success: false, errorKey: gate.errorKey };
  const locked = assertDraftUnlocked(vorgangId, amendmentId);
  if (locked) return { success: false, errorKey: locked };

  const amendments = cloneAmendments(gate.vorgang.orderAmendments);
  const amendmentIndex = amendments.findIndex((item) => item.id === amendmentId);
  if (amendmentIndex === -1) {
    return { success: false, errorKey: 'order_amendment_not_found' };
  }

  const amendment = amendments[amendmentIndex]!;
  const positionIndex = amendment.positions.findIndex((item) => item.id === positionId);
  if (positionIndex === -1) {
    return { success: false, errorKey: 'order_amendment_position_not_found' };
  }

  const current = amendment.positions[positionIndex]!;
  const nextInput: OrderAmendmentDraftPositionInput = {
    changeType: patch.changeType ?? current.changeType,
    description: patch.description ?? current.description,
    quantity: patch.quantity ?? current.quantity,
    unit: patch.unit ?? current.unit,
    unitLabel: patch.unitLabel !== undefined ? patch.unitLabel : current.unitLabel,
    unitPrice: patch.unitPrice ?? current.unitPrice,
    category: patch.category !== undefined ? patch.category : current.category,
    billable: patch.billable !== undefined ? patch.billable : current.billable,
    parentPositionId:
      patch.parentPositionId !== undefined ? patch.parentPositionId : current.parentPositionId,
  };

  const validationError = validateDraftPosition(gate.vorgang, nextInput);
  if (validationError) {
    return { success: false, errorKey: validationError };
  }

  const nextPosition: OrderAmendmentDraftPosition = {
    id: current.id,
    changeType: nextInput.changeType,
    description: nextInput.description.trim(),
    quantity: nextInput.quantity,
    unit: nextInput.unit,
    unitLabel: nextInput.unitLabel,
    unitPrice: nextInput.unitPrice,
    category: nextInput.category,
    billable: nextInput.billable,
    parentPositionId:
      nextInput.changeType === 'quantity_increase' ? nextInput.parentPositionId : undefined,
  };

  const nextPositions = [...amendment.positions];
  nextPositions[positionIndex] = nextPosition;
  amendments[amendmentIndex] = {
    ...amendment,
    positions: nextPositions,
    updatedAt: nowIso(),
  };

  return persistAmendments(vorgangId, amendments, amendmentId);
}

/* -------------------------------------------------------------------------- */
/* CLOUD-SYNC S6 — Entscheidungen bei einem Konflikt                           */
/* -------------------------------------------------------------------------- */

export type OrderAmendmentDraftCloudDecisionResult =
  | { ok: true; draftId?: string }
  | { ok: false; reason: 'no_conflict' | 'not_allowed' | 'storage' };

function findDraftConflict(vorgangId: string, draftId: string) {
  const vorgang = getVorgangById(vorgangId);
  const drafts = cloneAmendments(vorgang?.orderAmendments);
  const draft = drafts.find((item) => item.id === draftId);
  return vorgang && draft?.conflict ? { drafts, draft, conflict: draft.conflict } : null;
}

function decisionOutcome(
  result: { success: true; vorgang: Vorgang } | { success: false; errorKey: OrderAmendmentErrorKey },
  draftId?: string,
): OrderAmendmentDraftCloudDecisionResult {
  return result.success ? { ok: true, ...(draftId ? { draftId } : {}) } : { ok: false, reason: 'storage' };
}

/** „Cloud-Fassung übernehmen" — die eigene Fassung wird bewusst ersetzt. */
export function takeCloudOrderAmendmentDraftVersion(vorgangId: string, draftId: string): OrderAmendmentDraftCloudDecisionResult {
  const found = findDraftConflict(vorgangId, draftId);
  if (!found || found.conflict.kind !== 'version') return { ok: false, reason: 'no_conflict' };
  const remote = found.conflict.remote;
  if (!remote.payload || remote.deleted || remote.status !== 'active') return { ok: false, reason: 'not_allowed' };
  const next: OrderAmendment = {
    ...JSON.parse(JSON.stringify(remote.payload)),
    status: 'entwurf',
    sync: { ...(found.draft.sync ?? { deviceId: '', workspaceId: '' }), version: remote.rowVersion, deleted: false, updatedAt: nowIso() } as SyncMeta,
  };
  const drafts = found.drafts.map((item) => (item.id === draftId ? next : item));
  return decisionOutcome(
    commitAmendmentDrafts(vorgangId, drafts, { before: () => completeAmendmentDraftOutbox(draftId), acknowledge: [draftId] }),
  );
}

/** „Meine Fassung behalten" — ein bewusster neuer Schreibversuch gegen die zuletzt gesehene Serverversion. */
export function keepLocalOrderAmendmentDraftVersion(vorgangId: string, draftId: string): OrderAmendmentDraftCloudDecisionResult {
  const found = findDraftConflict(vorgangId, draftId);
  if (!found || found.conflict.kind !== 'version') return { ok: false, reason: 'no_conflict' };
  const remote = found.conflict.remote;
  if (remote.deleted || remote.status !== 'active') return { ok: false, reason: 'not_allowed' };
  const { conflict: _conflict, ...rest } = found.draft;
  const next: OrderAmendment = {
    ...rest,
    sync: { ...(found.draft.sync ?? { updatedAt: nowIso(), deviceId: '', workspaceId: '' }), version: remote.rowVersion, deleted: false } as SyncMeta,
  };
  const drafts = found.drafts.map((item) => (item.id === draftId ? next : item));
  return decisionOutcome(
    commitAmendmentDrafts(vorgangId, drafts, {
      before: () => {
        if (!releaseBlockedOutboxEntry('order_amendment_draft', draftId, remote.rowVersion) && !hasPendingOrderAmendmentDraftCloudChange(draftId)) {
          enqueueSyncOutbox({ entityType: 'order_amendment_draft', entityId: draftId, operation: 'update', version: remote.rowVersion });
        }
      },
    }),
  );
}

/** Verworfen oder bestätigt auf einem anderen Gerät: Der Nutzer nimmt das Ende an. */
export function acceptOrderAmendmentDraftCloudEnd(vorgangId: string, draftId: string): OrderAmendmentDraftCloudDecisionResult {
  const found = findDraftConflict(vorgangId, draftId);
  if (!found || (found.conflict.kind !== 'deleted' && found.conflict.kind !== 'consumed')) {
    return { ok: false, reason: 'no_conflict' };
  }
  const drafts = found.drafts.filter((item) => item.id !== draftId);
  return decisionOutcome(commitAmendmentDrafts(vorgangId, drafts, { before: () => completeAmendmentDraftOutbox(draftId) }));
}

/**
 * „Als neuen Nachtragsentwurf behalten" — nur nach einem Ende anderswo und nur
 * auf ausdrücklichen Wunsch: neue Entwurfskennung und neue Positionskennungen,
 * damit nichts mit einem bereits bestätigten Nachtrag kollidiert.
 */
export function continueOrderAmendmentDraftAsNew(vorgangId: string, draftId: string): OrderAmendmentDraftCloudDecisionResult {
  const found = findDraftConflict(vorgangId, draftId);
  if (!found || (found.conflict.kind !== 'deleted' && found.conflict.kind !== 'consumed')) {
    return { ok: false, reason: 'not_allowed' };
  }
  const at = nowIso();
  const { conflict: _conflict, sync: _sync, ...content } = found.draft;
  const fresh: OrderAmendment = {
    ...content,
    id: generateEntityId('oa'),
    positions: content.positions.map((position) => ({ ...position, id: generateEntityId('oad') })),
    createdAt: at,
    updatedAt: at,
  };
  const drafts = [...found.drafts.filter((item) => item.id !== draftId), fresh];
  return decisionOutcome(
    commitAmendmentDrafts(vorgangId, drafts, { before: () => completeAmendmentDraftOutbox(draftId) }),
    fresh.id,
  );
}

/** Hier verworfen, anderswo geändert: Der Nutzer behält den geänderten Entwurf. */
export function keepOrderAmendmentDraftAfterRejectedDiscard(vorgangId: string, draftId: string): OrderAmendmentDraftCloudDecisionResult {
  const found = findDraftConflict(vorgangId, draftId);
  if (!found || found.conflict.kind !== 'discard_rejected') return { ok: false, reason: 'no_conflict' };
  const { conflict: _conflict, ...rest } = found.draft;
  const drafts = found.drafts.map((item) => (item.id === draftId ? rest : item));
  return decisionOutcome(commitAmendmentDrafts(vorgangId, drafts));
}

/** Hier verworfen, anderswo geändert: Der Nutzer verwirft bewusst erneut — auf der neuen Fassung. */
export function discardOrderAmendmentDraftAgain(vorgangId: string, draftId: string): OrderAmendmentDraftCloudDecisionResult {
  const found = findDraftConflict(vorgangId, draftId);
  if (!found || found.conflict.kind !== 'discard_rejected') return { ok: false, reason: 'no_conflict' };
  const drafts = found.drafts.filter((item) => item.id !== draftId);
  return decisionOutcome(
    commitAmendmentDrafts(vorgangId, drafts, {
      before: () => putOrderAmendmentDraftTombstone(tombstoneOf(found.draft, vorgangId)),
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* CLOUD-SYNC S6 — Bindung der Nachtragsbestätigung                            */
/* -------------------------------------------------------------------------- */

export type OrderAmendmentDraftCloudBindingResult =
  | { ok: true; binding: OrderAmendmentDraftCloudBinding | null }
  | { ok: false; reason: 'draft_not_synced' | 'draft_conflict' | 'draft_ended' };

/**
 * Die Bindung der Bestätigung an den Cloud-Nachtragsentwurf. Ohne freigegebene
 * Cloud-Seite gibt es keine. Mit ihr muss der Entwurf vollständig angekommen
 * sein: keine offene Übertragung, kein Konflikt.
 */
export function resolveOrderAmendmentDraftCloudBinding(
  vorgangId: string,
  draftId: string,
): OrderAmendmentDraftCloudBindingResult {
  if (!isOrderAmendmentDraftCloudSyncAllowed()) return { ok: true, binding: null };
  const draft = getVorgangById(vorgangId)?.orderAmendments?.find((item) => item.id === draftId);
  if (!draft) return { ok: false, reason: 'draft_ended' };
  if (draft.conflict) return { ok: false, reason: 'draft_conflict' };
  const version = draft.sync?.version ?? 0;
  if (version < 1 || hasPendingOrderAmendmentDraftCloudChange(draftId)) return { ok: false, reason: 'draft_not_synced' };
  return { ok: true, binding: { sourceDraftId: draftId, expectedDraftRowVersion: version } };
}

export function removeOrderAmendmentDraftPosition(
  vorgangId: string,
  amendmentId: string,
  positionId: string,
): OrderAmendmentResult {
  const gate = requireConfirmedVorgang(vorgangId);
  if (!gate.ok) return { success: false, errorKey: gate.errorKey };
  const locked = assertDraftUnlocked(vorgangId, amendmentId);
  if (locked) return { success: false, errorKey: locked };

  const amendments = cloneAmendments(gate.vorgang.orderAmendments);
  const amendmentIndex = amendments.findIndex((item) => item.id === amendmentId);
  if (amendmentIndex === -1) {
    return { success: false, errorKey: 'order_amendment_not_found' };
  }

  const amendment = amendments[amendmentIndex]!;
  const nextPositions = amendment.positions.filter((item) => item.id !== positionId);
  if (nextPositions.length === amendment.positions.length) {
    return { success: false, errorKey: 'order_amendment_position_not_found' };
  }

  amendments[amendmentIndex] = {
    ...amendment,
    positions: nextPositions,
    updatedAt: nowIso(),
  };

  return persistAmendments(vorgangId, amendments, amendmentId);
}
