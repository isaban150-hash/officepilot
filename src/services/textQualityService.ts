export interface TextQualityReport {
  score: number;
  readable: boolean;
  crypticRatio: number;
  wordCount: number;
  sanitizedText: string;
}

const PDF_GARBAGE_LINE =
  /^(?:BT|ET|Tj|TJ|Tm|Td|Tf|re|f|q|Q|cm|gs|endobj|endstream|xref|trailer|stream)$/i;

const PDF_OPERATOR_CHUNK =
  /^\/[A-Za-z][\w]*$|^[\d.]+\s+[\d.]+\s+[a-z]{1,3}$|^\d+\s+\d+\s+obj$/i;

const CRYPTIC_CHAR_PATTERN = /[^\p{L}\p{N}\s.,;:!?€%\-+()/&@#'"„"–—]/u;

export function containsCrypticCharacters(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const chars = trimmed.replace(/\s/g, '');
  if (chars.length === 0) return false;

  const cryptic = (chars.match(CRYPTIC_CHAR_PATTERN) ?? []).length;
  return cryptic / chars.length > 0.25;
}

const PDF_OPERATOR_INLINE = /\/(?:Type|Font|Page|XObject|Annots)\b|endobj|endstream|\bxref\b|\bstream\b/i;

/** Zahl mit Dezimal- oder Tausendertrennung: `1.200,00`, `12,50`, `1,000.00`. */
const FORMATTED_NUMBER = /\d{1,3}(?:[.,]\d{3})*[.,]\d{1,2}\b|\b\d+[.,]\d{1,2}\b/;

/** Alles, was ein Betrag sein kann — mit oder ohne Trennzeichen. */
const NUMERIC_TOKEN = /(?:[€$£]|\b(?:eur|chf|usd)\b)|\d[\d.,]*/gi;

/**
 * TEXT-QUALITY-STRUCTURED-NUMERIC-LINES-01B — eine Zahlenzeile ist Inhalt.
 *
 * In tabellarischen Belegen steht die tragende Information oft in einer Zeile
 * ganz ohne Wörter: Einzelpreis und Gesamtpreis einer Position, eine
 * Summenzeile, eine Mengenspalte. Bis hierher fielen genau diese Zeilen aus
 * dem Text, weil „lesbar" an mindestens einem Wort hing — und mit ihnen die
 * Beträge, auf die jede Positionserkennung angewiesen ist.
 *
 * Die Schwelle bleibt bewusst hoch: Verlangt werden **zwei** numerische Marken
 * und **eine erkennbare Betragsform** — ein Dezimal- oder Tausendertrennzeichen
 * oder ein Währungszeichen. Eine nackte Seitenzahl, eine Jahreszahl oder eine
 * einzelne Ziffernfolge erfüllt das nicht und gilt weiterhin nicht als Inhalt.
 */
export function isStructuredNumericLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const hasCurrency = /[€$£]|\b(?:eur|euro|chf|usd)\b/i.test(trimmed);
  if (!hasCurrency && !FORMATTED_NUMBER.test(trimmed)) return false;

  NUMERIC_TOKEN.lastIndex = 0;
  const tokens = trimmed.match(NUMERIC_TOKEN) ?? [];
  return tokens.length >= 2;
}

export function isLikelyPdfGarbageChunk(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 2) return true;
  if (PDF_GARBAGE_LINE.test(trimmed)) return true;
  if (PDF_OPERATOR_CHUNK.test(trimmed)) return true;
  if (PDF_OPERATOR_INLINE.test(trimmed)) return true;
  if (/^endobj|endstream|xref|trailer|stream$/i.test(trimmed)) return true;
  if (/^\/[A-Za-z]/.test(trimmed) && !/\s/.test(trimmed)) return true;
  if (/^[0-9a-f]{10,}$/i.test(trimmed.replace(/\s/g, ''))) return true;

  const letters = (trimmed.match(/\p{L}/gu) ?? []).length;
  const digits = (trimmed.match(/\d/g) ?? []).length;
  const meaningful = letters + digits;

  if (meaningful === 0) return true;
  /*
   * Eine lange Ziffernfolge ohne Buchstaben ist meistens Rauschen — aber nicht,
   * wenn sie die Form eines Betrags hat. Genau daran scheiterten bisher die
   * Preiszeilen tabellarischer Belege.
   */
  if (letters === 0 && digits > 0 && trimmed.length > 12 && !isStructuredNumericLine(trimmed)) {
    return true;
  }

  const ratio = meaningful / trimmed.length;
  if (ratio < 0.35 && trimmed.length > 6) return true;

  return false;
}

export function isReadableLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 2) return false;
  if (isLikelyPdfGarbageChunk(trimmed)) return false;

  const words = trimmed.match(/[\p{L}]{2,}/gu) ?? [];
  /* Ohne Wort nur, wenn die Zeile erkennbar Beträge trägt — siehe oben. */
  if (words.length === 0 && !isStructuredNumericLine(trimmed)) return false;

  return !containsCrypticCharacters(trimmed);
}

export function sanitizeExtractedText(text: string): string {
  if (!text.trim()) return '';

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => isReadableLine(line));

  const uniqueLines: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueLines.push(line);
  }

  return uniqueLines.join('\n').trim();
}

export function assessTextQuality(text: string): TextQualityReport {
  const sanitizedText = sanitizeExtractedText(text);
  const words = sanitizedText.match(/[\p{L}]{3,}/gu) ?? [];
  const wordCount = words.length;
  const chars = sanitizedText.replace(/\s/g, '');
  const charCount = chars.length;

  let readableRatio = 0;
  if (charCount > 0) {
    const readableChars = (chars.match(/[\p{L}\p{N}.,;:!?€%\-+()/]/gu) ?? []).length;
    readableRatio = readableChars / charCount;
  }

  const crypticRatio = Math.max(0, 1 - readableRatio);
  const score = Math.round(readableRatio * 55 + Math.min(wordCount, 25) * 1.8);
  const readable = wordCount >= 3 && readableRatio >= 0.72 && score >= 38 && !containsCrypticCharacters(sanitizedText) && !PDF_OPERATOR_INLINE.test(sanitizedText);

  return {
    score,
    readable,
    crypticRatio,
    wordCount,
    sanitizedText,
  };
}

export function isReadableText(text: string): boolean {
  return assessTextQuality(text).readable;
}

export function buildDisplayPreviewLines(
  text: string,
  maxLines = 3,
): { lines: string[]; usesPartialHint: boolean } {
  const quality = assessTextQuality(text);

  if (!quality.sanitizedText || quality.wordCount < 2 || containsCrypticCharacters(quality.sanitizedText) || PDF_OPERATOR_INLINE.test(quality.sanitizedText)) {
    return {
      lines: [],
      usesPartialHint: quality.wordCount > 0 && quality.score >= 25,
    };
  }

  if (!quality.readable) {
    return { lines: [], usesPartialHint: true };
  }

  return {
    lines: quality.sanitizedText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, maxLines),
    usesPartialHint: false,
  };
}
