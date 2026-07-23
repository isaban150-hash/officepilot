import { getContractConfirmation } from './contractConfirmationService';
import { getVorgangById, startVorgangExecutionAt } from './vorgangService';
import type { Vorgang } from '../types/models';

export type OrderExecutionStartResult =
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

/**
 * User-triggered start of order execution.
 * Requires status beauftragt and an existing contract confirmation snapshot.
 */
export function startOrderExecution(vorgangId: string): OrderExecutionStartResult {
  const current = getVorgangById(vorgangId);
  if (!current) {
    return { success: false, errorKey: 'vorgang.notFound' };
  }

  if (current.status !== 'beauftragt') {
    return { success: false, errorKey: 'execution.notBeauftragt' };
  }

  if (!getContractConfirmation(vorgangId) && !current.contractConfirmation) {
    return { success: false, errorKey: 'execution.snapshotRequired' };
  }

  return startVorgangExecutionAt(vorgangId, new Date().toISOString());
}
