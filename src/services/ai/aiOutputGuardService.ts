import { FORBIDDEN_LEGAL_TAX_PHRASES } from './aiGuardrails';
import type { AiGuardContext, AiGuardProfile } from '../../types/ai';

const AMOUNT_REGEX = /(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)\s*€/gi;
const INLINE_AMOUNT_REGEX = /(?:preis|betrag|summe|offen|kosten)\s*:?\s*(\d+(?:[.,]\d{1,2})?)/gi;
const ISO_DATE_REGEX = /\b\d{4}-\d{2}-\d{2}\b/g;
const GERMAN_DATE_REGEX = /\b\d{1,2}\.\d{1,2}\.\d{4}\b/g;

export interface AiOutputGuardResult {
  valid: boolean;
  warnings: string[];
}

function normalizeAmountToken(token: string): string | null {
  const cleaned = token
    .trim()
    .replace(/\s/g, '')
    .replace(/€/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const value = Number.parseFloat(cleaned);
  if (Number.isNaN(value)) return null;
  return value.toFixed(2);
}

function extractAmounts(text: string): Set<string> {
  const amounts = new Set<string>();

  for (const match of text.matchAll(AMOUNT_REGEX)) {
    const normalized = normalizeAmountToken(match[1] ?? '');
    if (normalized) amounts.add(normalized);
  }

  for (const match of text.matchAll(INLINE_AMOUNT_REGEX)) {
    const normalized = normalizeAmountToken(match[1] ?? '');
    if (normalized) amounts.add(normalized);
  }

  return amounts;
}

function extractDates(text: string): Set<string> {
  const dates = new Set<string>();
  for (const match of text.matchAll(ISO_DATE_REGEX)) {
    dates.add(match[0]);
  }
  for (const match of text.matchAll(GERMAN_DATE_REGEX)) {
    dates.add(match[0]);
  }
  return dates;
}

function containsForbiddenLegalTaxPhrase(text: string): string | null {
  const normalized = text.toLowerCase();
  for (const phrase of FORBIDDEN_LEGAL_TAX_PHRASES) {
    if (normalized.includes(phrase)) {
      return phrase;
    }
  }
  return null;
}

function validateCommon(text: string): AiOutputGuardResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { valid: false, warnings: ['Leere KI-Antwort'] };
  }

  const forbiddenPhrase = containsForbiddenLegalTaxPhrase(trimmed);
  if (forbiddenPhrase) {
    return {
      valid: false,
      warnings: [`Verbotene Rechts-/Steuerformulierung: ${forbiddenPhrase}`],
    };
  }

  return { valid: true, warnings: [] };
}

function validateEnhanceFacts(
  text: string,
  guardContext: AiGuardContext,
): AiOutputGuardResult {
  const warnings: string[] = [];
  const allowedSourceText = guardContext.allowedSourceText ?? '';
  const originalText = guardContext.originalText ?? '';

  const allowedAmounts = extractAmounts(allowedSourceText);
  const enhancedAmounts = extractAmounts(text);
  for (const amount of enhancedAmounts) {
    if (!allowedAmounts.has(amount)) {
      warnings.push(`Neuer Geldbetrag nicht erlaubt: ${amount} €`);
    }
  }

  const allowedDates = extractDates(`${originalText}\n${allowedSourceText}`);
  const enhancedDates = extractDates(text);
  for (const date of enhancedDates) {
    if (!allowedDates.has(date)) {
      warnings.push(`Neue Datumsangabe nicht erlaubt: ${date}`);
    }
  }

  if (warnings.length > 0) {
    return { valid: false, warnings };
  }

  return { valid: true, warnings: [] };
}

export function validateAiOutput(
  text: string,
  profile: AiGuardProfile,
  guardContext: AiGuardContext = {},
): AiOutputGuardResult {
  const common = validateCommon(text);
  if (!common.valid) {
    return common;
  }

  if (profile === 'enhance') {
    return validateEnhanceFacts(text, guardContext);
  }

  if (profile === 'qa' && guardContext.allowedSourceText) {
    return validateEnhanceFacts(text, guardContext);
  }

  return { valid: true, warnings: [] };
}
