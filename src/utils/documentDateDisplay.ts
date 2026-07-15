import type { AppLanguage, CompanyDocument } from '../types/models';

const LOCALE_BY_LANGUAGE: Record<AppLanguage, string> = {
  de: 'de-DE',
  tr: 'tr-TR',
  bg: 'bg-BG',
  ro: 'ro-RO',
  ru: 'ru-RU',
};

const DATE_DISPLAY_OPTIONS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
};

const GERMAN_DATE_PATTERN = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

export function localeForAppLanguage(language: AppLanguage = 'de'): string {
  return LOCALE_BY_LANGUAGE[language] ?? 'de-DE';
}

/**
 * Parses ISO / native Date-parseable values and unambiguous TT.MM.JJJJ.
 * Returns null for empty, Invalid Date, or ambiguous values (never invents).
 */
export function parseSafeDocumentDate(value: string | null | undefined): Date | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  const german = trimmed.match(GERMAN_DATE_PATTERN);
  if (german) {
    const day = Number(german[1]);
    const month = Number(german[2]);
    const year = Number(german[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(year, month - 1, day);
    if (
      Number.isNaN(date.getTime()) ||
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }
    return date;
  }

  // Only unambiguous ISO-like values — never guess slash or free-text dates.
  if (!/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(trimmed)) {
    return null;
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function formatSafeDocumentDate(
  value: string | null | undefined,
  language: AppLanguage = 'de',
  unrecognizedLabel = 'Datum nicht erkannt',
): string {
  const date = parseSafeDocumentDate(value);
  if (!date) return unrecognizedLabel;
  return date.toLocaleDateString(localeForAppLanguage(language), DATE_DISPLAY_OPTIONS);
}

export type DocumentCardDateSource =
  | 'documentDate'
  | 'issueDate'
  | 'createdAt'
  | 'uploadedAt'
  | 'none';

export interface DocumentCardDateResolution {
  source: DocumentCardDateSource;
  rawValue: string | null;
  formatted: string;
  isRecognized: boolean;
}

/**
 * Primary archive-card date: documentDate → issueDate → createdAt → uploadedAt.
 * Never uses validUntil/deadline as the primary card date.
 */
export function resolveDocumentCardDate(
  document: Pick<CompanyDocument, 'documentDate' | 'issueDate' | 'createdAt' | 'uploadedAt'>,
  language: AppLanguage = 'de',
  unrecognizedLabel = 'Datum nicht erkannt',
): DocumentCardDateResolution {
  const candidates: Array<{ source: DocumentCardDateSource; value: string | null | undefined }> = [
    { source: 'documentDate', value: document.documentDate },
    { source: 'issueDate', value: document.issueDate },
    { source: 'createdAt', value: document.createdAt },
    { source: 'uploadedAt', value: document.uploadedAt },
  ];

  for (const candidate of candidates) {
    const date = parseSafeDocumentDate(candidate.value);
    if (!date || !candidate.value) continue;
    return {
      source: candidate.source,
      rawValue: candidate.value,
      formatted: date.toLocaleDateString(localeForAppLanguage(language), DATE_DISPLAY_OPTIONS),
      isRecognized: true,
    };
  }

  return {
    source: 'none',
    rawValue: null,
    formatted: unrecognizedLabel,
    isRecognized: false,
  };
}

/** Separate display for validity / deadline – empty if unusable (never "Invalid Date"). */
export function formatDocumentValidUntil(
  value: string | null | undefined,
  language: AppLanguage = 'de',
): string | null {
  const date = parseSafeDocumentDate(value);
  if (!date) return null;
  return date.toLocaleDateString(localeForAppLanguage(language), DATE_DISPLAY_OPTIONS);
}
