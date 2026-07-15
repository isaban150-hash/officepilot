import type { StorageRecommendationLevel } from '../types/storageRecommendation';
import type { TranslationKey } from '../i18n';

export function getStorageRecommendationLevelKey(
  level: StorageRecommendationLevel,
): TranslationKey {
  return `storageRecommendation.level.${level}` as TranslationKey;
}

export function getStorageRecommendationPrimaryActionKey(
  level: StorageRecommendationLevel,
): TranslationKey {
  switch (level) {
    case 'temporary_only':
      return 'storageRecommendation.action.temporaryOnly';
    case 'review_required':
      return 'storageRecommendation.action.reviewAssignment';
    case 'duplicate_detected':
      return 'storageRecommendation.action.saveAnyway';
    case 'discard_recommended':
      return 'storageRecommendation.action.savePermanently';
    default:
      return 'storageRecommendation.action.savePermanently';
  }
}

export function translateStorageReasonKey(
  key: string,
  translate: (key: TranslationKey) => string,
): string {
  const translated = translate(key as TranslationKey);
  if (translated === key) {
    return translate('storageRecommendation.reason.archiveRecommended');
  }
  return translated;
}

export function getRecognitionStatusKey(
  status: 'confident' | 'assign_customer' | 'review',
): TranslationKey {
  return `storageRecommendation.recognition.${status}` as TranslationKey;
}

export function getSteuerberaterHintKey(
  hint: 'mark' | 'check' | 'not_relevant',
): TranslationKey {
  return `storageRecommendation.steuerberater.${hint}` as TranslationKey;
}
