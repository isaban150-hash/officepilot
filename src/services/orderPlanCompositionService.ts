import { buildOrderPositionsFromSnapshot } from './contractPositionAlignService';
import type {
  ConfirmedOrderAmendment,
  OrderPosition,
  Vorgang,
} from '../types/models';

export const ORDER_AMENDMENT_POSITION_ID_CONFLICT =
  'order_amendment_position_id_conflict' as const;

export type ComposeOrderPositionsResult =
  | { ok: true; positions: OrderPosition[] }
  | { ok: false; errorKey: typeof ORDER_AMENDMENT_POSITION_ID_CONFLICT };

function clonePosition(position: OrderPosition): OrderPosition {
  return { ...position };
}

function commercialEqual(a: OrderPosition, b: OrderPosition): boolean {
  return (
    a.id === b.id &&
    a.description === b.description &&
    a.plannedQuantity === b.plannedQuantity &&
    a.unit === b.unit &&
    a.unitLabel === b.unitLabel &&
    a.unitPrice === b.unitPrice &&
    a.category === b.category &&
    a.billable === b.billable &&
    a.sourceAmendmentId === b.sourceAmendmentId &&
    a.sourceAmendmentSequence === b.sourceAmendmentSequence &&
    a.parentPositionId === b.parentPositionId &&
    a.amendmentChangeType === b.amendmentChangeType
  );
}

export function sortConfirmedOrderAmendments(
  amendments: ConfirmedOrderAmendment[] | undefined,
): ConfirmedOrderAmendment[] {
  return [...(amendments ?? [])].sort((left, right) => {
    if (left.sequenceNo !== right.sequenceNo) {
      return left.sequenceNo - right.sequenceNo;
    }
    return left.clientAmendmentId.localeCompare(right.clientAmendmentId);
  });
}

export function getMaxConfirmedAmendmentSequence(
  amendments: ConfirmedOrderAmendment[] | undefined,
): number {
  if (!amendments || amendments.length === 0) return 0;
  return amendments.reduce((max, item) => Math.max(max, item.sequenceNo), 0);
}

/**
 * Compose operative orderPositions from Hauptsnapshot + confirmed amendments.
 * Drafts are never included. Preserves executedQuantity by position id.
 * Duplicate position ids (main vs amendment, across amendments, or within one
 * amendment) fail hard — never skip or overwrite.
 */
export function composeOrderPositionsFromAuthoritativePlan(
  vorgang: Pick<Vorgang, 'contractConfirmation' | 'confirmedOrderAmendments' | 'orderPositions'>,
): ComposeOrderPositionsResult {
  const previous = vorgang.orderPositions ?? [];
  const previousById = new Map(previous.map((position) => [position.id, position]));

  if (!vorgang.contractConfirmation) {
    return { ok: true, positions: previous.map(clonePosition) };
  }

  const base = buildOrderPositionsFromSnapshot(vorgang.contractConfirmation, previous);
  const composed: OrderPosition[] = base.map(clonePosition);
  const seenIds = new Set(composed.map((position) => position.id));

  for (const amendment of sortConfirmedOrderAmendments(vorgang.confirmedOrderAmendments)) {
    for (const position of amendment.positions) {
      if (seenIds.has(position.id)) {
        return { ok: false, errorKey: ORDER_AMENDMENT_POSITION_ID_CONFLICT };
      }
      seenIds.add(position.id);
      const prior = previousById.get(position.id);
      composed.push({
        id: position.id,
        description: position.description,
        plannedQuantity: position.plannedQuantity,
        unit: position.unit,
        unitLabel: position.unitLabel,
        unitPrice: position.unitPrice,
        category: position.category,
        billable: position.billable,
        executedQuantity: prior?.executedQuantity,
        sourceAmendmentId: amendment.clientAmendmentId,
        sourceAmendmentSequence: amendment.sequenceNo,
        parentPositionId: position.parentPositionId,
        amendmentChangeType: position.changeType,
      });
    }
  }

  return { ok: true, positions: composed };
}

export function orderPositionsMatchComposedPlan(
  positions: OrderPosition[],
  composed: OrderPosition[],
): boolean {
  if (positions.length !== composed.length) return false;
  return composed.every((expected, index) => {
    const actual = positions[index];
    if (!actual) return false;
    return commercialEqual(actual, expected);
  });
}
