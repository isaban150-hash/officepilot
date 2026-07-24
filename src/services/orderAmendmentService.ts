import { generateEntityId } from './sync/syncMetaService';
import {
  getVorgangById,
  saveVorgangOrderAmendments,
} from './vorgangService';
import { isOrderAmendmentDraftLockedByIntent } from './orderAmendment/orderAmendmentConfirmIntentService';
import type {
  OrderAmendment,
  OrderAmendmentChangeType,
  OrderAmendmentDraftPosition,
  OrderPosition,
  OrderPositionCategory,
  OrderUnit,
  Vorgang,
} from '../types/models';

export type OrderAmendmentErrorKey =
  | 'vorgang.notFound'
  | 'order_amendment_requires_confirmation'
  | 'order_amendment_not_found'
  | 'order_amendment_position_not_found'
  | 'order_amendment_invalid_position'
  | 'order_amendment_parent_position_not_found'
  | 'order_amendment_confirmation_outcome_unknown';

function assertDraftUnlocked(
  vorgangId: string,
  amendmentId: string,
): OrderAmendmentErrorKey | null {
  if (isOrderAmendmentDraftLockedByIntent(vorgangId, amendmentId)) {
    return 'order_amendment_confirmation_outcome_unknown';
  }
  return null;
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

  amendments.splice(index, 1);
  const saved = saveVorgangOrderAmendments(vorgangId, amendments);
  if (!saved.success) {
    return { success: false, errorKey: saved.errorKey };
  }
  return { success: true, vorgang: saved.vorgang };
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
