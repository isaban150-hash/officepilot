import type {
  ConfirmedOrderAmendment,
  ConfirmedOrderAmendmentPosition,
  OrderAmendmentChangeType,
  OrderUnit,
} from '../../types/models';

const ORDER_UNITS = new Set<OrderUnit>(['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal']);
const CHANGE_TYPES = new Set<OrderAmendmentChangeType>(['add', 'quantity_increase']);

function clonePosition(position: ConfirmedOrderAmendmentPosition): ConfirmedOrderAmendmentPosition {
  return { ...position };
}

function isValidPosition(position: ConfirmedOrderAmendmentPosition): boolean {
  if (!position.id?.trim()) return false;
  if (!CHANGE_TYPES.has(position.changeType)) return false;
  if (!position.description?.trim()) return false;
  if (!ORDER_UNITS.has(position.unit)) return false;
  if (!Number.isFinite(position.plannedQuantity) || position.plannedQuantity <= 0) return false;
  if (!Number.isFinite(position.unitPrice) || position.unitPrice < 0) return false;
  if (position.changeType === 'add' && position.parentPositionId) return false;
  if (position.changeType === 'quantity_increase' && !position.parentPositionId?.trim()) {
    return false;
  }
  return true;
}

function isValidConfirmed(amendment: ConfirmedOrderAmendment): boolean {
  if (!amendment.cloudId?.trim()) return false;
  if (!amendment.clientAmendmentId?.trim()) return false;
  if (!amendment.vorgangId?.trim()) return false;
  if (!Number.isInteger(amendment.sequenceNo) || amendment.sequenceNo <= 0) return false;
  if (amendment.status !== 'bestaetigt') return false;
  if (!amendment.title?.trim()) return false;
  if (!amendment.contentFingerprint?.trim()) return false;
  if (!amendment.confirmedAt?.trim()) return false;
  if (!amendment.confirmedBy?.trim()) return false;
  if (!Number.isInteger(amendment.rowVersion) || amendment.rowVersion <= 0) return false;
  if (!Array.isArray(amendment.positions) || amendment.positions.length < 1) return false;
  return amendment.positions.every(isValidPosition);
}

/** Strict normalize — drops invalid entries, never coerces to drafts. */
export function normalizeConfirmedOrderAmendments(
  amendments: ConfirmedOrderAmendment[] | undefined,
): ConfirmedOrderAmendment[] | undefined {
  if (!amendments || amendments.length === 0) return undefined;
  const next = amendments
    .filter(isValidConfirmed)
    .map((amendment) => ({
      ...amendment,
      status: 'bestaetigt' as const,
      title: amendment.title.trim(),
      reason: amendment.reason?.trim() || undefined,
      positions: amendment.positions.map(clonePosition),
      localSourceDraftId: amendment.localSourceDraftId?.trim() || undefined,
    }));
  return next.length > 0 ? next : undefined;
}

export function cloneConfirmedOrderAmendments(
  amendments: ConfirmedOrderAmendment[] | undefined,
): ConfirmedOrderAmendment[] | undefined {
  if (!amendments) return undefined;
  return amendments.map((amendment) => ({
    ...amendment,
    positions: amendment.positions.map(clonePosition),
  }));
}
