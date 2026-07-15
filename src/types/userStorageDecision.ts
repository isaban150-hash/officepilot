import type { StorageRecommendationLevel } from './storageRecommendation';
import type { StoragePolicyId } from './storagePolicy';

export const USER_STORAGE_DECISIONS = [
  'save_permanently',
  'keep_temporarily',
  'discard',
  'use_existing',
  'save_duplicate_anyway',
] as const;

export type UserStorageDecision = (typeof USER_STORAGE_DECISIONS)[number];

export type DocumentFileLifecycleIntent = 'committed' | 'temp';

export const PERSISTING_USER_STORAGE_DECISIONS = [
  'save_permanently',
  'keep_temporarily',
  'save_duplicate_anyway',
] as const;

export type PersistingUserStorageDecision = (typeof PERSISTING_USER_STORAGE_DECISIONS)[number];

export function isPersistingUserStorageDecision(
  decision: UserStorageDecision,
): decision is PersistingUserStorageDecision {
  return (PERSISTING_USER_STORAGE_DECISIONS as readonly string[]).includes(decision);
}

export interface UserStorageDecisionContext {
  recommendationLevel: StorageRecommendationLevel;
  storagePolicyId: StoragePolicyId;
  hasDuplicateMatch: boolean;
}
