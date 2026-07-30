import type { StorageRecommendation } from '../types/storageRecommendation';
import type { ResolvedStoragePolicy } from '../types/storagePolicy';
import type {
  DocumentFileLifecycleIntent,
  UserStorageDecision,
  UserStorageDecisionContext,
} from '../types/userStorageDecision';
import { isPersistingUserStorageDecision } from '../types/userStorageDecision';

export interface ValidateUserStorageDecisionInput {
  decision: UserStorageDecision;
  recommendation: StorageRecommendation;
  storagePolicy: ResolvedStoragePolicy;
}

export function buildUserStorageDecisionContext(
  recommendation: StorageRecommendation,
  storagePolicy: ResolvedStoragePolicy,
): UserStorageDecisionContext {
  return {
    recommendationLevel: recommendation.level,
    storagePolicyId: storagePolicy.policyId,
    hasDuplicateMatch: Boolean(recommendation.duplicateMatch),
  };
}

function canOfferKeepTemporarily(context: UserStorageDecisionContext): boolean {
  if (context.recommendationLevel === 'temporary_only') {
    return true;
  }
  if (context.storagePolicyId === 'construction_photo') {
    return true;
  }
  if (context.storagePolicyId === 'temporary_unknown') {
    return true;
  }
  return false;
}

export function resolveAvailableUserStorageDecisions(
  recommendation: StorageRecommendation,
  storagePolicy: ResolvedStoragePolicy,
): UserStorageDecision[] {
  const context = buildUserStorageDecisionContext(recommendation, storagePolicy);

  if (context.recommendationLevel === 'duplicate_detected') {
    // Inbox matches are not archive documents — never offer use_existing.
    if (recommendation.duplicateMatch?.type === 'inbox') {
      return ['save_duplicate_anyway', 'discard'];
    }
    return ['use_existing', 'save_duplicate_anyway', 'discard'];
  }

  if (context.recommendationLevel === 'discard_recommended') {
    return ['discard', 'save_permanently'];
  }

  if (context.recommendationLevel === 'temporary_only') {
    return ['keep_temporarily', 'save_permanently', 'discard'];
  }

  const decisions: UserStorageDecision[] = ['save_permanently', 'discard'];
  if (canOfferKeepTemporarily(context)) {
    decisions.splice(1, 0, 'keep_temporarily');
  }
  return decisions;
}

export function resolvePrimarySuggestedUserStorageDecision(
  recommendation: StorageRecommendation,
): UserStorageDecision {
  switch (recommendation.level) {
    case 'duplicate_detected':
      return recommendation.duplicateMatch?.type === 'inbox'
        ? 'save_duplicate_anyway'
        : 'use_existing';
    case 'discard_recommended':
      return 'discard';
    case 'temporary_only':
      return 'keep_temporarily';
    default:
      return 'save_permanently';
  }
}

export function mapDecisionToLifecycleIntent(
  decision: UserStorageDecision,
): DocumentFileLifecycleIntent | null {
  if (decision === 'save_permanently' || decision === 'save_duplicate_anyway') {
    return 'committed';
  }
  if (decision === 'keep_temporarily') {
    return 'temp';
  }
  return null;
}

export function validateUserStorageDecision(
  input: ValidateUserStorageDecisionInput,
): { valid: true } | { valid: false; reason: string } {
  const available = resolveAvailableUserStorageDecisions(
    input.recommendation,
    input.storagePolicy,
  );

  if (!available.includes(input.decision)) {
    return { valid: false, reason: 'decision_not_allowed' };
  }

  if (input.decision === 'use_existing') {
    const match = input.recommendation.duplicateMatch;
    if (!match) {
      return { valid: false, reason: 'duplicate_match_required' };
    }
    if (match.type !== 'document') {
      return { valid: false, reason: 'archive_document_match_required' };
    }
  }

  if (input.decision === 'save_duplicate_anyway' && !input.recommendation.duplicateMatch) {
    return { valid: false, reason: 'duplicate_match_required' };
  }

  if (isPersistingUserStorageDecision(input.decision)) {
    return { valid: true };
  }

  if (input.decision === 'discard' || input.decision === 'use_existing') {
    return { valid: true };
  }

  return { valid: false, reason: 'unknown_decision' };
}
