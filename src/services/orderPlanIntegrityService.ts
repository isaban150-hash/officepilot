import type { Vorgang } from '../types/models';
import {
  composeOrderPositionsFromAuthoritativePlan,
  orderPositionsMatchComposedPlan,
} from './orderPlanCompositionService';
import { orderPositionsMatchSnapshot } from './contractPositionAlignService';

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

/**
 * True when no snapshot, or operative commercial plan matches authoritative composition
 * (Hauptsnapshot + confirmed amendments). Without confirmed amendments this equals
 * snapshot-only matching.
 * Duplicate position ids make the plan unhealthy (not a silent match).
 */
export function contractPlanMatchesSnapshot(vorgang: Vorgang): boolean {
  if (!vorgang.contractConfirmation) return true;
  if (!(vorgang.confirmedOrderAmendments?.length)) {
    return orderPositionsMatchSnapshot(vorgang.orderPositions, vorgang.contractConfirmation);
  }
  const composed = composeOrderPositionsFromAuthoritativePlan(vorgang);
  if (!composed.ok) return false;
  return orderPositionsMatchComposedPlan(vorgang.orderPositions, composed.positions);
}

/**
 * Repair operative plan from Hauptsnapshot + confirmed amendments (idempotent).
 * Preserves executedQuantity by position id. Never mutates the Hauptsnapshot.
 * Without confirmed amendments, behavior matches snapshot-only align.
 * On position-id conflict: report error and leave the existing plan unchanged
 * (never replace with a partial plan).
 */
export function repairContractPlanFromSnapshot(vorgang: Vorgang): {
  vorgang: Vorgang;
  repaired: boolean;
  errorKey?: string;
} {
  if (!vorgang.contractConfirmation) {
    return { vorgang, repaired: false };
  }

  const composed = composeOrderPositionsFromAuthoritativePlan(vorgang);
  if (!composed.ok) {
    return { vorgang, repaired: false, errorKey: composed.errorKey };
  }
  if (orderPositionsMatchComposedPlan(vorgang.orderPositions ?? [], composed.positions)) {
    return { vorgang, repaired: false };
  }

  return {
    vorgang: {
      ...vorgang,
      orderPositions: composed.positions,
    },
    repaired: true,
  };
}
