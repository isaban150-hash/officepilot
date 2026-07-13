import type { AppLanguage } from '../types/models';
import { CORE_I18N_PATHS, type CoreI18nPath } from './corePaths';
import { interpolateParams } from './formatMessage';

export interface TranslateCatalog {
  de: Record<string, string>;
  tr: Partial<Record<string, string>>;
  bg: Partial<Record<string, string>>;
  ro: Partial<Record<string, string>>;
  ru: Partial<Record<string, string>>;
}

const loggedMissingKeys = new Set<string>();

export function resetMissingTranslationLog(): void {
  loggedMissingKeys.clear();
}

export function getLoggedMissingKeys(): string[] {
  return [...loggedMissingKeys];
}

function shouldLogMissing(lang: AppLanguage, key: string): boolean {
  if (lang === 'de') return false;
  const id = `${lang}:${key}`;
  if (loggedMissingKeys.has(id)) return false;
  loggedMissingKeys.add(id);
  return true;
}

function isDevOrTest(): boolean {
  return (
    (typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV)) ||
    (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'test')
  );
}

export function translateKey(
  key: string,
  lang: AppLanguage,
  catalog: TranslateCatalog,
  params?: Record<string, string | number>,
): string {
  const deValue = catalog.de[key];
  const override =
    lang === 'de'
      ? undefined
      : (catalog[lang] as Partial<Record<string, string>> | undefined)?.[key];

  if (lang !== 'de' && !override) {
    if (isDevOrTest() && shouldLogMissing(lang, key)) {
      console.warn(`[i18n] Missing translation: ${lang}.${key}`);
    }
  }

  const resolved = override ?? deValue ?? key;
  return interpolateParams(resolved, params);
}

export function assertCoreTranslations(catalog: TranslateCatalog): string[] {
  const missing: string[] = [];
  for (const key of CORE_I18N_PATHS) {
    for (const lang of ['de', 'tr', 'bg'] as const) {
      const value =
        lang === 'de'
          ? catalog.de[key]
          : (catalog[lang] as Partial<Record<CoreI18nPath, string>>)[key];
      if (!value || value.trim().length === 0) {
        missing.push(`${lang}.${key}`);
      }
    }
  }
  return missing;
}
