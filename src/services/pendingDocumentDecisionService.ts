import type { CreateInboxFromUploadOptions } from './inboxUploadFactory';
import type { DocumentIntakeResult } from './documentIntakeService';
import type { StorageRecommendation } from '../types/storageRecommendation';
import type { UserStorageDecision } from '../types/userStorageDecision';
import { isPersistingUserStorageDecision } from '../types/userStorageDecision';
import {
  confirmPendingDocumentIntake,
  discardPendingDocumentIntake,
  type PendingDocumentIntake,
} from './pendingDocumentIntakeService';
import {
  resolveAvailableUserStorageDecisions,
  resolvePrimarySuggestedUserStorageDecision,
  validateUserStorageDecision,
} from './userStorageDecisionService';
import { buildStorageDecisionActionSpecs } from './userStorageDecisionPresentationService';
import type { StorageDecisionActionSpec } from './userStorageDecisionPresentationService';

export type ExecutePendingDocumentDecisionResult =
  | { outcome: 'discarded' }
  | {
      outcome: 'navigate_existing';
      match: NonNullable<StorageRecommendation['duplicateMatch']>;
    }
  | DocumentIntakeResult;

export async function executePendingDocumentDecision(
  pending: PendingDocumentIntake,
  decision: UserStorageDecision,
  intakeOptions: CreateInboxFromUploadOptions = {},
): Promise<ExecutePendingDocumentDecisionResult> {
  const validation = validateUserStorageDecision({
    decision,
    recommendation: pending.storageRecommendation,
    storagePolicy: pending.storagePolicy,
  });

  if (!validation.valid) {
    return { success: false, error: 'navigation_failed' };
  }

  if (decision === 'discard') {
    discardPendingDocumentIntake(pending);
    return { outcome: 'discarded' };
  }

  if (decision === 'use_existing') {
    const match = pending.storageRecommendation.duplicateMatch;
    if (!match) {
      return { success: false, error: 'navigation_failed' };
    }
    discardPendingDocumentIntake(pending);
    return { outcome: 'navigate_existing', match };
  }

  if (!isPersistingUserStorageDecision(decision)) {
    return { success: false, error: 'navigation_failed' };
  }

  return confirmPendingDocumentIntake(pending, {
    ...intakeOptions,
    userDecision: decision,
  });
}

export function isPendingDocumentDecisionResultIntake(
  result: ExecutePendingDocumentDecisionResult,
): result is DocumentIntakeResult {
  return !('outcome' in result);
}

export function isDiscardedPendingDocumentDecision(
  result: ExecutePendingDocumentDecisionResult,
): result is { outcome: 'discarded' } {
  return 'outcome' in result && result.outcome === 'discarded';
}

export function isNavigateExistingPendingDocumentDecision(
  result: ExecutePendingDocumentDecisionResult,
): result is {
  outcome: 'navigate_existing';
  match: NonNullable<StorageRecommendation['duplicateMatch']>;
} {
  return 'outcome' in result && result.outcome === 'navigate_existing';
}

export function buildPendingDocumentDecisionActions(
  pending: PendingDocumentIntake,
): StorageDecisionActionSpec[] {
  const available = resolveAvailableUserStorageDecisions(
    pending.storageRecommendation,
    pending.storagePolicy,
  );
  const primary = resolvePrimarySuggestedUserStorageDecision(pending.storageRecommendation);
  return buildStorageDecisionActionSpecs(available, primary);
}
