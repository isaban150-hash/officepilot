import type { TranslationKey } from '../i18n';
import type { UserStorageDecision } from '../types/userStorageDecision';

export interface StorageDecisionActionSpec {
  decision: UserStorageDecision;
  labelKey: TranslationKey;
  variant: 'primary' | 'outline';
  testId: string;
}

const DECISION_LABEL_KEYS: Record<UserStorageDecision, TranslationKey> = {
  save_permanently: 'userStorageDecision.action.savePermanently',
  keep_temporarily: 'userStorageDecision.action.keepTemporarily',
  discard: 'userStorageDecision.action.discard',
  use_existing: 'userStorageDecision.action.useExisting',
  save_duplicate_anyway: 'userStorageDecision.action.saveDuplicateAnyway',
};

const DECISION_TEST_IDS: Record<UserStorageDecision, string> = {
  save_permanently: 'storage-decision-save-permanently',
  keep_temporarily: 'storage-decision-keep-temporarily',
  discard: 'storage-decision-discard',
  use_existing: 'storage-decision-use-existing',
  save_duplicate_anyway: 'storage-decision-save-duplicate-anyway',
};

export function getUserStorageDecisionLabelKey(
  decision: UserStorageDecision,
): TranslationKey {
  return DECISION_LABEL_KEYS[decision];
}

export function buildStorageDecisionActionSpecs(
  availableDecisions: UserStorageDecision[],
  primaryDecision: UserStorageDecision,
): StorageDecisionActionSpec[] {
  return availableDecisions.map((decision) => ({
    decision,
    labelKey: getUserStorageDecisionLabelKey(decision),
    variant: decision === primaryDecision ? 'primary' : 'outline',
    testId: DECISION_TEST_IDS[decision],
  }));
}
