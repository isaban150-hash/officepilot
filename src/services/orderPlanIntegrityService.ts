import type { Vorgang } from '../types/models';
import {
  alignOrderPositionsToConfirmation,
  orderPositionsMatchSnapshot,
} from './contractPositionAlignService';

/** Domain error: confirmed scope must not be mutated directly (amendment required later). */
export const ORDER_PLAN_AMENDMENT_REQUIRED = 'order_plan_amendment_required' as const;

export type OrderPlanAmendmentErrorKey = typeof ORDER_PLAN_AMENDMENT_REQUIRED;

/**
 * Contract plan is locked when a confirmation snapshot exists.
 * Not derived from status alone (beauftragt / in_bearbeitung).
 */
export function isContractPlanLocked(
  vorgang: Pick<Vorgang, 'contractConfirmation'>,
): boolean {
  return Boolean(vorgang.contractConfirmation);
}

/**
 * Reject free mutations of the confirmed operative plan.
 * Confirmation's own atomic align path must not call this.
 */
export function assertContractPlanMutable(
  vorgang: Pick<Vorgang, 'contractConfirmation'>,
): { ok: true } | { ok: false; errorKey: OrderPlanAmendmentErrorKey } {
  if (isContractPlanLocked(vorgang)) {
    return { ok: false, errorKey: ORDER_PLAN_AMENDMENT_REQUIRED };
  }
  return { ok: true };
}

/** True when no snapshot, or operative commercial plan matches snapshot. */
export function contractPlanMatchesSnapshot(vorgang: Vorgang): boolean {
  if (!vorgang.contractConfirmation) return true;
  return orderPositionsMatchSnapshot(vorgang.orderPositions, vorgang.contractConfirmation);
}

/**
 * Repair operative plan from confirmation snapshot (idempotent).
 * Reuses contractPositionAlignService; preserves executedQuantity by position id.
 */
export function repairContractPlanFromSnapshot(vorgang: Vorgang): {
  vorgang: Vorgang;
  repaired: boolean;
} {
  if (!vorgang.contractConfirmation) {
    return { vorgang, repaired: false };
  }

  const aligned = alignOrderPositionsToConfirmation(
    vorgang.orderPositions,
    vorgang.contractConfirmation,
  );

  if (!aligned.changed) {
    return { vorgang, repaired: false };
  }

  return {
    vorgang: {
      ...vorgang,
      orderPositions: aligned.positions,
    },
    repaired: true,
  };
}
