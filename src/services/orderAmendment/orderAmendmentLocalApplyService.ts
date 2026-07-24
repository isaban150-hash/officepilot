import type { ConfirmedOrderAmendment, Vorgang } from '../../types/models';
import { composeOrderPositionsFromAuthoritativePlan } from '../orderPlanCompositionService';
import { commitVorgangMutation } from '../vorgangService';

export type OrderAmendmentLocalApplyErrorKey =
  | 'vorgang.notFound'
  | 'order_amendment_local_confirmation_conflict'
  | 'order_amendment_local_persist_failed'
  | 'order_amendment_position_id_conflict';

function mapCommitError(errorKey: string): OrderAmendmentLocalApplyErrorKey {
  if (errorKey === 'vorgang.notFound') return 'vorgang.notFound';
  if (errorKey === 'order_amendment_local_confirmation_conflict') {
    return 'order_amendment_local_confirmation_conflict';
  }
  if (errorKey === 'order_amendment_position_id_conflict') {
    return 'order_amendment_position_id_conflict';
  }
  return 'order_amendment_local_persist_failed';
}

export type OrderAmendmentLocalApplyResult =
  | { ok: true; vorgang: Vorgang; action: 'inserted' | 'noop' }
  | { ok: false; errorKey: OrderAmendmentLocalApplyErrorKey };

function sameFingerprint(
  existing: ConfirmedOrderAmendment,
  incoming: ConfirmedOrderAmendment,
): boolean {
  return existing.contentFingerprint === incoming.contentFingerprint;
}

/**
 * Atomically: write-once merge confirmed amendment, remove draft, recompose plan, persist once.
 * Position-id conflicts abort before any in-memory mutation is committed.
 */
export function applyConfirmedOrderAmendmentLocally(input: {
  vorgangId: string;
  draftId: string;
  confirmed: ConfirmedOrderAmendment;
}): OrderAmendmentLocalApplyResult {
  let action: 'inserted' | 'noop' = 'inserted';

  const committed = commitVorgangMutation(input.vorgangId, (current) => {
    const existing = (current.confirmedOrderAmendments ?? []).find(
      (item) => item.clientAmendmentId === input.confirmed.clientAmendmentId,
    );

    if (existing) {
      if (!sameFingerprint(existing, input.confirmed)) {
        return { errorKey: 'order_amendment_local_confirmation_conflict' };
      }
      action = 'noop';
      const drafts = (current.orderAmendments ?? []).filter((draft) => draft.id !== input.draftId);
      const withConfirmed: Vorgang = {
        ...current,
        orderAmendments: drafts.length > 0 ? drafts : undefined,
        confirmedOrderAmendments: current.confirmedOrderAmendments,
      };
      const composed = composeOrderPositionsFromAuthoritativePlan(withConfirmed);
      if (!composed.ok) {
        return { errorKey: composed.errorKey };
      }
      return {
        ...withConfirmed,
        orderPositions: composed.positions,
      };
    }

    const drafts = (current.orderAmendments ?? []).filter((draft) => draft.id !== input.draftId);
    const confirmed: ConfirmedOrderAmendment = {
      ...input.confirmed,
      localSourceDraftId: input.draftId,
    };
    const nextList = [...(current.confirmedOrderAmendments ?? []), confirmed].sort(
      (left, right) => {
        if (left.sequenceNo !== right.sequenceNo) return left.sequenceNo - right.sequenceNo;
        return left.clientAmendmentId.localeCompare(right.clientAmendmentId);
      },
    );

    const next: Vorgang = {
      ...current,
      orderAmendments: drafts.length > 0 ? drafts : undefined,
      confirmedOrderAmendments: nextList,
    };

    const composed = composeOrderPositionsFromAuthoritativePlan(next);
    if (!composed.ok) {
      return { errorKey: composed.errorKey };
    }

    return {
      ...next,
      orderPositions: composed.positions,
    };
  });

  if (!committed.ok) {
    return { ok: false, errorKey: mapCommitError(committed.errorKey) };
  }

  return { ok: true, vorgang: committed.vorgang, action };
}
