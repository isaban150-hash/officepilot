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

/*
 * E-MAIL 07F-01C — Profil `reply` (Antwortentwurf auf eine eingegangene Mail).
 *
 * Baut auf `enhance` auf (Beträge, absolute Daten) und prüft zusätzlich
 * Uhrzeiten, Tagesdaten ohne Jahr, relative Zeitangaben, Prozentwerte,
 * Telefonnummern, Links und E-Mail-Adressen: Was nicht wörtlich im erlaubten
 * Quelltext (Mail, Verlauf, Geschäftsfakten) steht, lässt den Entwurf
 * verwerfen. Vorher wird die Ausgabe strukturell bereinigt — Betreff-/
 * Empfängerzeilen, Zitate und alles ab der Grußformel entfallen, weil
 * Signatur und Zitat bereits deterministisch im Antwort-Editor stehen.
 */
const REPLY_MAX_CHARS = 4000;
const REPLY_CLOSING_LINE = /^\s*(mit\s+freundlichen\s+grü(ß|ss)en|freundliche\s+grü(ß|ss)e|viele\s+grü(ß|ss)e|beste\s+grü(ß|ss)e|herzliche\s+grü(ß|ss)e|liebe\s+grü(ß|ss)e|mfg|best\s+regards|kind\s+regards|regards|saygılarımla|saygılarımızla|с\s+уважение|поздрави)\s*[,.!]?\s*$/iu;
const REPLY_HEADER_LINE = /^\s*(betreff|subject|an|to|cc|bcc|von|from|konu|тема)\s*:/iu;
const TIME_REGEXES = [/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, /\b([01]?\d|2[0-3])(?:[.:]([0-5]\d))?\s*uhr\b/giu];
const DAY_MONTH_REGEX = /\b(\d{1,2})\.(\d{1,2})\.(?!\d)/g;
const PERCENT_REGEX = /\b(\d+(?:[.,]\d+)?)\s*(?:%|prozent\b)/giu;
const PHONE_REGEX = /(?:\+|\b0)\d[\d\s/()-]{5,}\d/g;
const URL_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>()"']+/giu;
const EMAIL_REGEX = /[^\s<>"'(),;:[\]]+@[^\s<>"'(),;:[\]]+\.[a-z]{2,}/giu;
const WEEKDAYS = '(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
const RELATIVE_TIME_REGEXES = [
  /\bübermorgen\b/giu,
  /(?<!guten\s|am\s|jeden\s)\bmorgen\b/giu,
  new RegExp(`\\b(?:nächste[nmrs]?|kommende[nmrs]?|diese[nmrs]?|übernächste[nmrs]?)\\s+(?:woche|wochenende|monat|${WEEKDAYS})\\b`, 'giu'),
  new RegExp(`\\b(?:am|ab|bis|seit)\\s+${WEEKDAYS}\\b`, 'giu'),
  /\bheute\s+(?:noch|nachmittag|vormittag|abend|mittag)\b/giu,
  /\bin\s+(?:\d+|einem|einer|einigen|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn)\s+(?:tag(?:en)?|woche(?:n)?|monat(?:en)?|stunde(?:n)?)\b/giu,
  /\binnerhalb\s+(?:von\s+)?(?:\d+|einem|einer|zwei|drei|vier|fünf)\s+(?:tag(?:en)?|woche(?:n)?|monat(?:en)?|stunde(?:n)?)\b/giu,
  /\b(?:ende|anfang|mitte)\s+(?:der|dieser|nächster|kommender)\s+woche\b/giu,
  /\bbis\s+(?:morgen|übermorgen|heute\s+abend|ende\s+der\s+woche)\b/giu,
  new RegExp(`\\b(?:tomorrow|next\\s+(?:week|month|${WEEKDAYS})|this\\s+(?:week|${WEEKDAYS})|in\\s+\\d+\\s+(?:days?|weeks?))\\b`, 'giu'),
];

/** Strukturelle Bereinigung: nur der Antworttext bleibt (Signatur/Zitat stehen bereits im Editor). */
export function cleanReplyStructure(text: string): string {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').replace(/^```[a-z]*\n?|```\s*$/gim, '').split('\n');
  const out: string[] = [];
  let atStart = true;
  for (const line of lines) {
    if (atStart && (REPLY_HEADER_LINE.test(line) || !line.trim())) continue;
    atStart = false;
    if (REPLY_CLOSING_LINE.test(line)) break;
    if (/^\s*(am|on)\s.{3,120}(schrieb|wrote)\s?.{0,80}:\s*$/iu.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function collect(regexes: RegExp[], text: string, normalize: (match: RegExpMatchArray) => string | null): Set<string> {
  const found = new Set<string>();
  for (const regex of regexes) {
    for (const match of text.matchAll(new RegExp(regex.source, regex.flags))) {
      const value = normalize(match);
      if (value) found.add(value);
    }
  }
  return found;
}

function validateReplyFacts(text: string, guardContext: AiGuardContext): AiOutputGuardResult {
  const base = validateEnhanceFacts(text, guardContext);
  const warnings = [...base.warnings];
  // Platzhalter („[Termin ergänzen]") sind gewollt und werden nicht geprüft.
  const scanned = text.replace(/\[[^[\]\n]{2,80}\]/g, ' ');
  const source = `${guardContext.originalText ?? ''}\n${guardContext.allowedSourceText ?? ''}`;
  const sourceLower = source.toLowerCase();
  const time = (m: RegExpMatchArray) => `${Number(m[1])}:${m[2] ?? '00'}`;
  const checks: Array<[string, RegExp[], (m: RegExpMatchArray) => string | null]> = [
    ['Uhrzeit', TIME_REGEXES, time],
    ['Datumsangabe', [DAY_MONTH_REGEX], (m) => `${Number(m[1])}.${Number(m[2])}`],
    ['Prozentwert', [PERCENT_REGEX], (m) => String(Number(m[1].replace(',', '.')))],
    ['Telefonnummer', [PHONE_REGEX], (m) => { const digits = m[0].replace(/\D/g, ''); return digits.length >= 7 ? digits : null; }],
    ['Link', [URL_REGEX], (m) => m[0].toLowerCase().replace(/[.,;:!?)]+$/, '').replace(/^https?:\/\//, '').replace(/^www\./, '')],
    ['E-Mail-Adresse', [EMAIL_REGEX], (m) => m[0].toLowerCase()],
  ];
  for (const [label, regexes, normalize] of checks) {
    const allowed = collect(regexes, source, normalize);
    const allowedText = label === 'Link' || label === 'Telefonnummer' ? sourceLower.replace(/\s/g, '') : '';
    for (const value of collect(regexes, scanned, normalize)) {
      if (allowed.has(value) || (allowedText && allowedText.includes(value))) continue;
      warnings.push(`Neue ${label} nicht erlaubt: ${value}`);
    }
  }
  for (const phrase of collect(RELATIVE_TIME_REGEXES, scanned, (m) => m[0].toLowerCase().replace(/\s+/g, ' '))) {
    if (!sourceLower.replace(/\s+/g, ' ').includes(phrase)) warnings.push(`Neue relative Zeitangabe nicht erlaubt: ${phrase}`);
  }
  if (text.length > REPLY_MAX_CHARS) warnings.push('Antwortentwurf zu lang');
  return warnings.length > 0 ? { valid: false, warnings } : { valid: true, warnings: [] };
}

export function validateAiOutput(
  text: string,
  profile: AiGuardProfile,
  guardContext: AiGuardContext = {},
): AiOutputGuardResult {
  if (profile === 'reply') {
    // Erst Struktur (Grußformel/Signatur/Zitat/Kopfzeilen weg), dann dieselben Prüfungen wie sonst.
    const cleaned = cleanReplyStructure(text);
    const commonReply = validateCommon(cleaned);
    if (!commonReply.valid) return commonReply;
    const checked = commonReply.safeText ?? cleaned;
    const facts = validateReplyFacts(checked, guardContext);
    if (!facts.valid) return { valid: false, warnings: [...commonReply.warnings, ...facts.warnings] };
    return { valid: true, warnings: commonReply.warnings, safeText: checked };
  }
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
