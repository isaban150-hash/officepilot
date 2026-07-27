import type { DocumentZone, EvidenceRef } from '../types/documentAnalysis';
import { isValidEvidenceRef } from '../types/documentAnalysis';
import type { DocumentZonedText, ZonedLine } from '../types/documentZoning';
import { buildPageMarker } from './documentSegmentationService';

const HEADER_MIN_LINES = 2;
const HEADER_MAX_LINES = 12;
const HEADER_RATIO = 0.2;
const FOOTER_MIN_LINES = 2;
const FOOTER_MAX_LINES = 12;
const FOOTER_RATIO = 0.2;

type ParsedLine = {
  text: string;
  lineIndex: number;
  startOffset: number;
  endOffset: number;
  pageNumber: number;
};

type PageSpan = {
  pageNumber: number;
  startOffset: number;
  endOffset: number;
};

export function buildCanonicalDocumentText(
  recognizedText?: string,
  pageTexts?: Array<{ pageNumber: number; text: string }>,
): string {
  if (pageTexts?.length) {
    const sorted = [...pageTexts].sort((left, right) => left.pageNumber - right.pageNumber);
    return sorted
      .map((page, index) => {
        const prefix = index === 0 && page.pageNumber <= 1 ? '' : buildPageMarker(page.pageNumber);
        return `${prefix}${page.text}`;
      })
      .join('\n')
      .trim();
  }

  return recognizedText?.trim() ?? '';
}

function buildPageSpans(text: string): PageSpan[] {
  const markerPattern = /---SEITE\s+(\d+)---/gi;
  const spans: PageSpan[] = [];

  if (!markerPattern.test(text)) {
    return text ? [{ pageNumber: 1, startOffset: 0, endOffset: text.length }] : [];
  }

  markerPattern.lastIndex = 0;
  let match = markerPattern.exec(text);
  if (!match && text.trim()) {
    return [{ pageNumber: 1, startOffset: 0, endOffset: text.length }];
  }

  while (match) {
    const contentStart = match.index + match[0].length;
    // lastIndex already sits after `match` from the previous exec.
    const nextMatch = markerPattern.exec(text);
    const contentEnd = nextMatch?.index ?? text.length;
    const pageNumber = Number(match[1]);

    if (Number.isFinite(pageNumber) && contentEnd > contentStart) {
      spans.push({
        pageNumber,
        startOffset: contentStart,
        endOffset: contentEnd,
      });
    }

    // Advance to nextMatch only. Rewinding lastIndex to nextMatch.index
    // re-finds the same marker forever (DOCUMENT-INTAKE-RECEIPT-GUARD-01).
    match = nextMatch;
  }

  if (spans.length === 0 && text.trim()) {
    return [{ pageNumber: 1, startOffset: 0, endOffset: text.length }];
  }

  // Real cover text before the first marker becomes page 1. Marker-only
  // prefixes must not invent a second empty/phantom page-1 span.
  const rawPreamble = text.slice(0, spans[0]?.startOffset ?? text.length);
  const preamble = rawPreamble.replace(/---SEITE\s+\d+---/gi, '').trim();
  if (preamble) {
    spans.unshift({ pageNumber: 1, startOffset: 0, endOffset: spans[0]?.startOffset ?? text.length });
  }

  return spans;
}

/** Exported for hang-regression / marker edge-case tests only. */
export function buildPageSpansForTests(text: string): Array<{
  pageNumber: number;
  startOffset: number;
  endOffset: number;
}> {
  return buildPageSpans(text);
}

function resolvePageNumber(offset: number, spans: PageSpan[]): number {
  const match = spans.find((span) => offset >= span.startOffset && offset < span.endOffset);
  return match?.pageNumber ?? spans[spans.length - 1]?.pageNumber ?? 1;
}

function parseLines(text: string): ParsedLine[] {
  if (!text) {
    return [];
  }

  const spans = buildPageSpans(text);
  const lines: ParsedLine[] = [];
  const parts = text.split(/\r?\n/);
  let offset = 0;

  for (let lineIndex = 0; lineIndex < parts.length; lineIndex += 1) {
    const rawLine = parts[lineIndex] ?? '';
    const startOffset = offset;
    const endOffset = startOffset + rawLine.length;
    const trimmed = rawLine.trim();

    if (trimmed && !/^---SEITE\s+\d+---$/i.test(trimmed)) {
      lines.push({
        text: rawLine,
        lineIndex,
        startOffset,
        endOffset,
        pageNumber: resolvePageNumber(startOffset, spans),
      });
    }

    offset = endOffset + 1;
  }

  return lines;
}

function isUnknownLine(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || /^[-_–—.=]{2,}$/.test(trimmed);
}

function computeZoneBoundaries(lineCount: number): { headerCount: number; footerCount: number } {
  if (lineCount <= 1) {
    return { headerCount: 0, footerCount: 0 };
  }
  if (lineCount === 2) {
    return { headerCount: 1, footerCount: 0 };
  }
  if (lineCount === 3) {
    return { headerCount: 1, footerCount: 1 };
  }

  let headerCount = Math.max(
    HEADER_MIN_LINES,
    Math.min(HEADER_MAX_LINES, Math.floor(lineCount * HEADER_RATIO)),
  );
  let footerCount = Math.max(
    FOOTER_MIN_LINES,
    Math.min(FOOTER_MAX_LINES, Math.floor(lineCount * FOOTER_RATIO)),
  );

  while (headerCount + footerCount >= lineCount) {
    if (footerCount > headerCount && footerCount > 1) {
      footerCount -= 1;
      continue;
    }
    if (headerCount > 1) {
      headerCount -= 1;
      continue;
    }
    if (footerCount > 1) {
      footerCount -= 1;
      continue;
    }
    break;
  }

  return { headerCount, footerCount };
}

function assignZones(parsedLines: ParsedLine[]): ZonedLine[] {
  const meaningfulLines = parsedLines.filter((line) => !isUnknownLine(line.text));
  const { headerCount, footerCount } = computeZoneBoundaries(meaningfulLines.length);
  const footerStart = meaningfulLines.length - footerCount;

  return parsedLines.map((line) => {
    if (isUnknownLine(line.text)) {
      return { ...line, zone: 'unknown' as DocumentZone };
    }

    const meaningfulIndex = meaningfulLines.findIndex(
      (candidate) => candidate.lineIndex === line.lineIndex,
    );
    if (meaningfulIndex < 0) {
      return { ...line, zone: 'unknown' as DocumentZone };
    }

    if (meaningfulIndex < headerCount) {
      return { ...line, zone: 'header' as DocumentZone };
    }
    if (footerCount > 0 && meaningfulIndex >= footerStart) {
      return { ...line, zone: 'footer' as DocumentZone };
    }
    return { ...line, zone: 'body' as DocumentZone };
  });
}

function groupLines(lines: ZonedLine[]): DocumentZonedText {
  return {
    originalText: lines.map((line) => line.text).join('\n'),
    lines,
    headerLines: lines.filter((line) => line.zone === 'header'),
    bodyLines: lines.filter((line) => line.zone === 'body'),
    footerLines: lines.filter((line) => line.zone === 'footer'),
    tableLines: [],
    unknownLines: lines.filter((line) => line.zone === 'unknown'),
  };
}

export function zoneText(
  originalText: string,
  pageTexts?: Array<{ pageNumber: number; text: string }>,
): DocumentZonedText {
  const canonicalText = originalText.trim()
    ? originalText
    : buildCanonicalDocumentText(undefined, pageTexts);

  const parsedLines = parseLines(canonicalText);
  const zonedLines = assignZones(parsedLines);

  return {
    ...groupLines(zonedLines),
    originalText: canonicalText,
  };
}

export function zoneDocumentText(
  recognizedText?: string,
  pageTexts?: Array<{ pageNumber: number; text: string }>,
): DocumentZonedText {
  const canonicalText = buildCanonicalDocumentText(recognizedText, pageTexts);
  return zoneText(canonicalText, pageTexts);
}

export function buildEvidenceIndex(zonedText: DocumentZonedText): Record<string, EvidenceRef> {
  const evidenceIndex: Record<string, EvidenceRef> = {};

  for (const line of zonedText.lines) {
    if (line.zone === 'unknown' || !line.text.trim()) {
      continue;
    }

    const evidenceId = `zone:${line.zone}:${line.lineIndex}`;
    evidenceIndex[evidenceId] = {
      id: evidenceId,
      zone: line.zone,
      snippet: line.text.trim(),
      startOffset: line.startOffset,
      endOffset: line.endOffset,
      startLine: line.lineIndex + 1,
      endLine: line.lineIndex + 1,
      pageNumber: line.pageNumber,
    };
  }

  return evidenceIndex;
}

export function validateZoneEvidenceIndex(
  evidenceIndex: Record<string, EvidenceRef>,
): boolean {
  return Object.entries(evidenceIndex).every(
    ([evidenceId, evidenceRef]) => isValidEvidenceRef(evidenceRef) && evidenceRef.id === evidenceId,
  );
}

export function findZonedLineAtOffset(
  zonedText: DocumentZonedText,
  offset: number,
): ZonedLine | undefined {
  return zonedText.lines.find(
    (line) => offset >= line.startOffset && offset < line.endOffset,
  );
}
