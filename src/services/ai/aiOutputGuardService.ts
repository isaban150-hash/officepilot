import { reviewAiAnswerText } from './legalClaimGuard';
import type { AiGuardContext, AiGuardProfile } from '../../types/ai';

const AMOUNT_REGEX = /(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)\s*€/gi;
const INLINE_AMOUNT_REGEX = /(?:preis|betrag|summe|offen|kosten)\s*:?\s*(\d+(?:[.,]\d{1,2})?)/gi;
const ISO_DATE_REGEX = /\b\d{4}-\d{2}-\d{2}\b/g;
const GERMAN_DATE_REGEX = /\b\d{1,2}\.\d{1,2}\.\d{4}\b/g;

export interface AiOutputGuardResult {
  valid: boolean;
  warnings: string[];
  /**
   * DOKUMENT-ASSISTENT-01H2 — die Antwort ohne die beanstandeten Sätze.
   *
   * Gesetzt, sobald etwas entfernt wurde und ein brauchbarer Rest bleibt. Wer
   * den Text weitergibt, nimmt diesen statt des Originals. Fehlt er, war
   * nichts zu beanstanden — oder es blieb nichts übrig, und dann ist `valid`
   * falsch.
   */
  safeText?: string;
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

/**
 * DOKUMENT-ASSISTENT-01H2 — geprüft wird die Art der Behauptung.
 *
 * Vorher entschied hier eine Wortliste: Kam `rechtsberatung` irgendwo vor,
 * war die ganze Antwort verloren — auch dann, wenn der Satz „Das ist keine
 * Rechtsberatung" lautete. Genau das war im Betrieb zu beobachten: Auf die
 * Frage, was bei Nichtreaktion auf eine Mängelanzeige geschieht, bekam der
 * Benutzer gar nichts.
 *
 * Jetzt entscheidet, **was** behauptet wird; die Einordnung steht in
 * `legalClaimGuard` und nirgends sonst. Die Folge ist mild geworden: Der
 * beanstandete Satz entfällt, der Rest bleibt. Erst wenn nichts Brauchbares
 * übrig bleibt, fällt die Antwort ganz — fail-closed bleibt fail-closed, ist
 * aber der Ausnahmefall und nicht mehr die Regel.
 */
function validateCommon(text: string): AiOutputGuardResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { valid: false, warnings: ['Leere KI-Antwort'] };
  }

  const review = reviewAiAnswerText(trimmed);
  if (review.findings.length === 0) {
    return { valid: true, warnings: [] };
  }

  const warnings = review.findings.map(
    (finding) => `Einzelfallentscheidung entfernt: ${finding.reason}`,
  );

  if (review.safeText === null) {
    return { valid: false, warnings };
  }

  return { valid: true, warnings, safeText: review.safeText };
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

  /*
   * Ab hier zählt der geprüfte Text, nicht das Original: Ein entfernter Satz
   * darf in der Betrags- und Datumsprüfung nicht mehr auftauchen — sonst
   * würde ein Betrag beanstandet, den niemand mehr zu lesen bekommt.
   */
  const geprueft = common.safeText ?? text;
  const weitergabe = (result: AiOutputGuardResult): AiOutputGuardResult => ({
    ...result,
    warnings: [...common.warnings, ...result.warnings],
    ...(common.safeText !== undefined && result.valid ? { safeText: common.safeText } : {}),
  });

  if (profile === 'enhance') {
    return weitergabe(validateEnhanceFacts(geprueft, guardContext));
  }

  if (profile === 'qa' && guardContext.allowedSourceText) {
    return weitergabe(validateEnhanceFacts(geprueft, guardContext));
  }

  return weitergabe({ valid: true, warnings: [] });
}
