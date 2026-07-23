import type {
  ConfirmedContractPositionSnapshot,
  ContractConfirmationSnapshot,
  OrderPosition,
} from '../types/models';

/** Build operative orderPositions that exactly mirror a confirmation snapshot (order preserved). */
export function buildOrderPositionsFromSnapshot(
  snapshot: ContractConfirmationSnapshot,
  previousPositions: OrderPosition[] = [],
): OrderPosition[] {
  const previousById = new Map(previousPositions.map((position) => [position.id, position]));

  return snapshot.positions.map((snapPos) => {
    const previous = previousById.get(snapPos.id);
    return {
      id: snapPos.id,
      description: snapPos.description,
      plannedQuantity: snapPos.plannedQuantity,
      unit: snapPos.unit,
      unitLabel: snapPos.unitLabel,
      unitPrice: snapPos.unitPrice,
      category: snapPos.category,
      billable: snapPos.billable !== undefined ? snapPos.billable : previous?.billable,
      // Execution quantity is operative — never taken from snapshot.
      executedQuantity: previous?.executedQuantity,
    };
  });
}

function sameOptional<T>(a: T | undefined, b: T | undefined): boolean {
  return a === b;
}

export function orderPositionMatchesSnapshotPosition(
  position: OrderPosition,
  snapPos: ConfirmedContractPositionSnapshot,
): boolean {
  const billableMatches =
    snapPos.billable === undefined
      ? true
      : position.billable === snapPos.billable;

  return (
    position.id === snapPos.id &&
    position.description === snapPos.description &&
    position.plannedQuantity === snapPos.plannedQuantity &&
    position.unit === snapPos.unit &&
    sameOptional(position.unitLabel, snapPos.unitLabel) &&
    position.unitPrice === snapPos.unitPrice &&
    sameOptional(position.category, snapPos.category) &&
    billableMatches
  );
}

/** True when orderPositions fully match snapshot positions (including order). */
export function orderPositionsMatchSnapshot(
  positions: OrderPosition[],
  snapshot: ContractConfirmationSnapshot,
): boolean {
  if (positions.length !== snapshot.positions.length) return false;
  return snapshot.positions.every((snapPos, index) => {
    const position = positions[index];
    return position ? orderPositionMatchesSnapshotPosition(position, snapPos) : false;
  });
}

/** Snapshot must be alignable before atomic confirmation writes. */
export function isSnapshotAlignable(snapshot: ContractConfirmationSnapshot): boolean {
  if (!snapshot.immutable) return false;
  if (!Array.isArray(snapshot.positions)) return false;
  return snapshot.positions.every(
    (position) =>
      Boolean(position.id) &&
      typeof position.description === 'string' &&
      Number.isFinite(position.plannedQuantity) &&
      position.plannedQuantity >= 0 &&
      Number.isFinite(position.unitPrice) &&
      position.unitPrice >= 0 &&
      Boolean(position.unit),
  );
}

/**
 * If a confirmation snapshot exists and operative positions diverge, realign from snapshot.
 * Snapshot is never modified.
 */
export function alignOrderPositionsToConfirmation(
  orderPositions: OrderPosition[],
  snapshot: ContractConfirmationSnapshot | undefined,
): { positions: OrderPosition[]; changed: boolean } {
  if (!snapshot) {
    return { positions: orderPositions, changed: false };
  }
  if (orderPositionsMatchSnapshot(orderPositions, snapshot)) {
    return { positions: orderPositions, changed: false };
  }
  return {
    positions: buildOrderPositionsFromSnapshot(snapshot, orderPositions),
    changed: true,
  };
}
