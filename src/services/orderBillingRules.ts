import type {
  MaterialStandard,
  OrderPosition,
  OrderPositionEditableField,
  PositionBillingStatus,
  Vorgang,
  VorgangInvoice,
} from '../types/models';

const COUNTED_STATUSES: VorgangInvoice['status'][] = ['vorbereitet', 'versendet'];

export function getBilledQuantity(vorgang: Vorgang, orderPositionId: string): number {
  return vorgang.invoices
    .filter((inv) => COUNTED_STATUSES.includes(inv.status))
    .flatMap((inv) => inv.positions ?? [])
    .filter((p) => p.orderPositionId === orderPositionId)
    .reduce((sum, p) => sum + p.quantity, 0);
}

/**
 * Still-billable quantity for draft suggestions / openQuantity.
 * Caps at planned; uses executedQuantity when set, otherwise planned (legacy fallback).
 */
export function getBillableOpenQuantity(vorgang: Vorgang, orderPositionId: string): number {
  const orderPosition = vorgang.orderPositions.find((p) => p.id === orderPositionId);
  if (!orderPosition) return 0;

  const plannedQuantity = orderPosition.plannedQuantity;
  const executedOrPlanned = orderPosition.executedQuantity ?? plannedQuantity;
  const eligible = Math.min(plannedQuantity, executedOrPlanned);
  return Math.max(0, eligible - getBilledQuantity(vorgang, orderPositionId));
}

export function getOpenQuantity(vorgang: Vorgang, orderPositionId: string): number {
  return getBillableOpenQuantity(vorgang, orderPositionId);
}

export function hasSchlussrechnung(vorgang: Vorgang): boolean {
  return vorgang.invoices.some(
    (inv) => inv.type === 'schluss' && COUNTED_STATUSES.includes(inv.status),
  );
}

export function hasAbschlagsrechnung(vorgang: Vorgang): boolean {
  return vorgang.invoices.some(
    (inv) => inv.type === 'abschlag' && COUNTED_STATUSES.includes(inv.status),
  );
}

export function hasFinalSchlussrechnung(vorgang: Vorgang): boolean {
  return hasSchlussrechnung(vorgang);
}

export function getPositionBillingStatus(
  vorgang: Vorgang,
  orderPositionId: string,
): PositionBillingStatus | null {
  const orderPosition = vorgang.orderPositions.find((p) => p.id === orderPositionId);
  if (!orderPosition) return null;

  const billedQuantity = getBilledQuantity(vorgang, orderPositionId);
  const openQuantity = getBillableOpenQuantity(vorgang, orderPositionId);

  return {
    orderPositionId,
    billedQuantity,
    openQuantity,
    plannedQuantity: orderPosition.plannedQuantity,
    hasBilling: billedQuantity > 0,
    isFullyBilled: billedQuantity >= orderPosition.plannedQuantity,
  };
}

export function canAddOrderPosition(vorgang: Vorgang): boolean {
  return !hasFinalSchlussrechnung(vorgang);
}

export function canDeleteOrderPosition(vorgang: Vorgang, orderPositionId: string): boolean {
  if (hasFinalSchlussrechnung(vorgang)) return false;
  return getBilledQuantity(vorgang, orderPositionId) === 0;
}

export function canEditOrderPositionField(
  vorgang: Vorgang,
  orderPositionId: string,
  field: OrderPositionEditableField,
): boolean {
  if (hasFinalSchlussrechnung(vorgang)) return false;

  const billedQuantity = getBilledQuantity(vorgang, orderPositionId);

  if (billedQuantity === 0) {
    return true;
  }

  if (field === 'description' || field === 'plannedQuantity') {
    return true;
  }

  return false;
}

export function getNextAbschlagNumber(vorgang: Vorgang): number {
  const numbers = vorgang.invoices
    .filter(
      (inv) =>
        inv.type === 'abschlag' &&
        COUNTED_STATUSES.includes(inv.status) &&
        typeof inv.abschlagNumber === 'number',
    )
    .map((inv) => inv.abschlagNumber as number);

  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

export function isPositionBillable(
  position: OrderPosition,
  materialSource: MaterialStandard,
): boolean {
  if (position.category !== 'material') return true;

  switch (materialSource) {
    case 'auftraggeber':
      return false;
    case 'betrieb':
      return true;
    case 'gemischt':
      return position.billable ?? true;
    case 'unclear':
    default:
      return true;
  }
}
