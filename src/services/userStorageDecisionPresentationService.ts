import type { TranslationKey } from '../i18n';
import type { StorageRecommendationLevel } from '../types/storageRecommendation';
import type { UserStorageDecision } from '../types/userStorageDecision';

export interface StorageDecisionActionSpec {
  decision: UserStorageDecision;
  labelKey: TranslationKey;
  variant: 'primary' | 'outline';
  testId: string;
  /** Set when OCR Fast Path presentation was applied to this primary action. */
  ocrFastPathPrimary?: boolean;
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

/** Levels where the storage engine already picked a clear primary UserStorageDecision. */
const OCR_FAST_PATH_LEVELS = new Set<StorageRecommendationLevel>([
  'archive_required',
  'archive_recommended',
  'duplicate_detected',
  'discard_recommended',
]);

export function isOcrStorageFastPathLevel(level: StorageRecommendationLevel): boolean {
  return OCR_FAST_PATH_LEVELS.has(level);
}

export function getUserStorageDecisionLabelKey(
  decision: UserStorageDecision,
): TranslationKey {
  return DECISION_LABEL_KEYS[decision];
}

/**
 * Presentation-only Fast Path labels for the existing primary UserStorageDecision.
 * Does not choose or validate decisions — only renames the already-primary action.
 */
export function resolveOcrFastPathPrimaryLabelKey(
  level: StorageRecommendationLevel,
  primaryDecision: UserStorageDecision,
): TranslationKey | null {
  if (!isOcrStorageFastPathLevel(level)) {
    return null;
  }

  if (
    (level === 'archive_required' || level === 'archive_recommended') &&
    primaryDecision === 'save_permanently'
  ) {
    return 'userStorageDecision.action.acceptRecommendation';
  }

  if (level === 'duplicate_detected' && primaryDecision === 'use_existing') {
    return 'userStorageDecision.action.useExistingDocument';
  }

  if (level === 'discard_recommended' && primaryDecision === 'discard') {
    return 'userStorageDecision.action.discard';
  }

  return null;
}

export function applyOcrFastPathPrimaryLabels(
  actions: StorageDecisionActionSpec[],
  level: StorageRecommendationLevel,
): StorageDecisionActionSpec[] {
  if (!isOcrStorageFastPathLevel(level)) {
    return actions;
  }

  return actions.map((action) => {
    if (action.variant !== 'primary') {
      return action;
    }
    const fastPathLabel = resolveOcrFastPathPrimaryLabelKey(level, action.decision);
    if (!fastPathLabel) {
      return action;
    }
    return { ...action, labelKey: fastPathLabel, ocrFastPathPrimary: true };
  });
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
