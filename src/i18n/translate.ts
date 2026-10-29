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
const loggedMissingDeKeys = new Set<string>();

export function resetMissingTranslationLog(): void {
  loggedMissingKeys.clear();
  loggedMissingDeKeys.clear();
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

/** Vitest-Lauf (nicht der Entwicklungsserver, auf dem auch die Prüf-App läuft). */
function isTestRun(): boolean {
  return typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'test';
}

/** EINRICHTUNG-01 (AP9; Vertrag 1.30, Q-01.4) — Schlüssel des allgemeinen Texts für fehlende Übersetzungen. */
export const GENERIC_TEXT_KEY = 'errors.generic';

export interface TranslateOptions {
  /**
   * Was ein in de fehlender Schlüssel ergibt: `generic` (Produkt und Entwicklungsserver samt Prüf-App — nie ein
   * Schlüssel auf dem Bildschirm; der Entwicklungsserver meldet ihn in der Konsole) oder `key` (Vitest-Läufe, damit
   * fehlende Texte in Tests auffallen).
   */
  missingKey?: 'generic' | 'key';
}

export function translateKey(
  key: string,
  lang: AppLanguage,
  catalog: TranslateCatalog,
  params?: Record<string, string | number>,
  options: TranslateOptions = {},
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

  /*
   * Rückfall: tr/bg → de; fehlt der Schlüssel auch in de, der allgemeine Text in der gewünschten Sprache (nur
   * Laufzeitschutz — der Paritätstest zählt einen fehlenden tr- bzw. bg-Schlüssel trotzdem als Lücke).
   */
  const missingKey = options.missingKey ?? (isTestRun() ? 'key' : 'generic');
  if (deValue === undefined && !override && isDevOrTest() && !isTestRun() && !loggedMissingDeKeys.has(key)) {
    loggedMissingDeKeys.add(key);
    console.warn(`[i18n] Missing key: ${key}`);
  }
  const generic =
    (lang === 'de' ? undefined : (catalog[lang] as Partial<Record<string, string>> | undefined)?.[GENERIC_TEXT_KEY]) ??
    catalog.de[GENERIC_TEXT_KEY] ??
    '';
  const resolved = override ?? deValue ?? (missingKey === 'generic' ? generic : key);
  return interpolateParams(resolved, params);
}

/**
 * EINRICHTUNG-01 (AP9; Vertrag 1.30, Q-01.2) — Kurzreferenz für einen unbekannten Code oder eine Ausnahme: 4 Zeichen
 * aus einem Hash (FNV-1a) des Rohtexts. Der Rohtext selbst erscheint nie.
 */
export function errorReference(raw: unknown): string {
  const text = raw instanceof Error ? `${raw.name}:${raw.message}` : typeof raw === 'string' ? raw : JSON.stringify(raw ?? null) ?? '';
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(4, '0').slice(-4);
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
