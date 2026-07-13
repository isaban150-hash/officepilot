import type { AppLanguage } from '../types/models';
import type { TranslationKey } from '../i18n';
import { t } from '../i18n';
import { getCachedSetup } from './persistenceService';
import type { PaperFilingRule } from '../types/models';
import { getPaperFolderById } from './paperFolderService';

export const PAPER_FOLDER_NAME_KEY_PREFIX = 'paperFolder.' as const;

export function getPaperFolderNameKey(folderId: string): TranslationKey | undefined {
  const key = `${PAPER_FOLDER_NAME_KEY_PREFIX}${folderId}` as TranslationKey;
  const lang = getCachedSetup()?.language ?? 'de';
  const translated = t(key, lang);
  return translated !== key ? key : undefined;
}

export function getLocalizedPaperFolderName(
  folderId: string,
  fallbackLabel: string,
  lang: AppLanguage = getCachedSetup()?.language ?? 'de',
): string {
  const key = getPaperFolderNameKey(folderId);
  if (key) return t(key, lang);
  return fallbackLabel;
}

export function formatPaperFilingInstruction(
  rule: PaperFilingRule,
  lang: AppLanguage = getCachedSetup()?.language ?? 'de',
): string {
  const folder = getPaperFolderById(rule.folderId);
  const folderName = getLocalizedPaperFolderName(rule.folderId, folder?.name ?? rule.label, lang);
  return t('paperFiling.instruction', lang, { folder: folderName, register: rule.register });
}

export function formatPaperLocationSummary(
  rule: PaperFilingRule,
  lang: AppLanguage = getCachedSetup()?.language ?? 'de',
): string {
  const folder = getPaperFolderById(rule.folderId);
  const folderName = getLocalizedPaperFolderName(rule.folderId, folder?.name ?? rule.label, lang);
  return t('paperFiling.summary', lang, { folder: folderName, register: rule.register });
}
