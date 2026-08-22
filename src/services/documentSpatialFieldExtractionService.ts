/**
 * SCAN-OCR-EVIDENCE-01B — visible label/value facts from OCR layout.
 *
 * Deliberately domain agnostic: this module knows nothing about contracts,
 * invoices, companies or people. It only answers "which visible text belongs to
 * which visible label", using coordinates — never the order of the flat OCR text.
 *
 * Every fact carries its evidence (token ids and boxes) and a status. A value
 * without evidence must never reach the user.
 */
import {
  tokenCenterY,
  tokenHeight,
  type DocumentLayoutPage,
  type DocumentLayoutToken,
} from '../types/documentLayout';

export type DocumentVisibleFactStatus =
  | 'recognized'
  | 'ambiguous'
  | 'missing_value'
  | 'unreadable'
  | 'partial';

export type DocumentVisibleFactRelation = 'right' | 'below' | 'same_line' | 'none';

export interface DocumentVisibleFactBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface DocumentVisibleFact {
  id: string;
  labelText: string;
  valueText: string | null;
  pageNumber: number;
  labelTokenIds: string[];
  valueTokenIds: string[];
  labelBox: DocumentVisibleFactBox;
  valueBox: DocumentVisibleFactBox | null;
  relation: DocumentVisibleFactRelation;
  confidence: number;
  status: DocumentVisibleFactStatus;
}

/** Below this OCR confidence a value is present but not trustworthy. */
const UNREADABLE_CONFIDENCE = 55;
/** Two candidates within this relative distance are equally plausible. */
const AMBIGUITY_MARGIN = 0.25;

interface VisualLine {
  tokens: DocumentLayoutToken[];
  centerY: number;
}

/** Rebuilds visual lines from coordinates — OCR block order is irrelevant. */
export function buildVisualLines(page: DocumentLayoutPage): VisualLine[] {
  const sorted = [...page.tokens].sort((a, b) => tokenCenterY(a) - tokenCenterY(b));
  const lines: VisualLine[] = [];

  for (const token of sorted) {
    const center = tokenCenterY(token);
    const tolerance = Math.max(tokenHeight(token) * 0.6, 0.004);
    const line = lines.find((entry) => Math.abs(entry.centerY - center) <= tolerance);
    if (line) {
      line.tokens.push(token);
      line.centerY = (line.centerY * (line.tokens.length - 1) + center) / line.tokens.length;
    } else {
      lines.push({ tokens: [token], centerY: center });
    }
  }

  for (const line of lines) {
    line.tokens.sort((a, b) => a.x0 - b.x0);
  }
  return lines.sort((a, b) => a.centerY - b.centerY);
}

/**
 * A label is a leading text group that ends with a separator, or a short group
 * that is followed by a clear horizontal gap. No vocabulary is involved.
 */
function isLabelText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > 60) return false;
  // Sentences are not labels.
  if (trimmed.split(/\s+/).length > 5) return false;
  // A field label starts with a letter — navigation chrome like "<" or "‹" does not.
  if (!/^[A-Za-zÄÖÜäöüß]/.test(trimmed)) return false;
  return true;
}

function endsWithSeparator(text: string): boolean {
  return /[:：]\s*$/.test(text.trim());
}

function stripSeparator(text: string): string {
  return text.replace(/[\s:：|·•\-–—]+$/u, '').trim();
}

function boxOf(tokens: DocumentLayoutToken[]): DocumentVisibleFactBox {
  return {
    x0: Math.min(...tokens.map((token) => token.x0)),
    y0: Math.min(...tokens.map((token) => token.y0)),
    x1: Math.max(...tokens.map((token) => token.x1)),
    y1: Math.max(...tokens.map((token) => token.y1)),
  };
}

function textOf(tokens: DocumentLayoutToken[]): string {
  return tokens
    .map((token) => token.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function minConfidence(tokens: DocumentLayoutToken[]): number {
  return tokens.reduce((min, token) => Math.min(min, token.confidence), 100);
}

/** Splits a visual line into groups separated by clear horizontal gaps. */
function groupByGaps(tokens: DocumentLayoutToken[]): DocumentLayoutToken[][] {
  if (tokens.length === 0) return [];
  const heights = tokens.map(tokenHeight).filter((value) => value > 0);
  const typicalHeight = heights.length
    ? heights.reduce((sum, value) => sum + value, 0) / heights.length
    : 0.02;
  const gapThreshold = Math.max(typicalHeight * 1.2, 0.02);

  const groups: DocumentLayoutToken[][] = [[tokens[0]!]];
  for (let index = 1; index < tokens.length; index += 1) {
    const previous = tokens[index - 1]!;
    const current = tokens[index]!;
    if (current.x0 - previous.x1 > gapThreshold) groups.push([current]);
    else groups[groups.length - 1]!.push(current);
  }
  return groups;
}

/** Column starts that repeat across lines — the value column of a table. */
function detectValueColumns(lines: VisualLine[]): number[] {
  const starts: number[] = [];
  for (const line of lines) {
    const groups = groupByGaps(line.tokens);
    if (groups.length < 2) continue;
    starts.push(groups[1]![0]!.x0);
  }
  return starts;
}

function isolatedNoise(group: DocumentLayoutToken[], line: VisualLine): boolean {
  // A single short token alone on its line, far from any other content: phone or
  // viewer chrome rather than a document field. Position alone is never used.
  return line.tokens.length === group.length && group.length === 1 && group[0]!.text.length <= 2;
}

export interface ExtractVisibleFactsOptions {
  /** Layout was capped — unseen areas must not be reported as missing. */
  truncated?: boolean;
}

/**
 * Builds all visible label/value pairs of a page. Unknown labels are kept as raw
 * facts; the domain layer decides later what they mean.
 */
export function extractVisibleFactsFromLayout(
  page: DocumentLayoutPage,
  options: ExtractVisibleFactsOptions = {},
): DocumentVisibleFact[] {
  const lines = buildVisualLines(page);
  const valueColumns = detectValueColumns(lines);
  const facts: DocumentVisibleFact[] = [];
  const truncated = options.truncated ?? page.truncated;

  lines.forEach((line, lineIndex) => {
    const groups = groupByGaps(line.tokens);
    if (groups.length === 0) return;

    const labelGroup = groups[0]!;
    const labelRaw = textOf(labelGroup);
    const labelText = stripSeparator(labelRaw);
    if (!isLabelText(labelText)) return;
    if (isolatedNoise(labelGroup, line)) return;

    const hasSeparator = endsWithSeparator(labelRaw);
    const rightGroups = groups.slice(1);

    const baseFact = {
      id: `f${page.pageNumber}-${lineIndex}`,
      labelText,
      pageNumber: page.pageNumber,
      labelTokenIds: labelGroup.map((token) => token.id),
      labelBox: boxOf(labelGroup),
    };

    // 1) Value to the right, same visual line.
    if (rightGroups.length > 0) {
      if (rightGroups.length > 1) {
        // Two comparable candidates → never guess.
        const first = rightGroups[0]!;
        const second = rightGroups[1]!;
        const firstGap = first[0]!.x0 - labelGroup[labelGroup.length - 1]!.x1;
        const secondGap = second[0]!.x0 - first[first.length - 1]!.x1;
        const similar = Math.abs(secondGap - firstGap) / Math.max(firstGap, 1e-6) < AMBIGUITY_MARGIN;
        /**
         * With a separator the first group is normally the value and the rest
         * belongs to it ("12.345,67 EUR"). Only a wide second gap means two
         * competing candidates — then the value stays empty.
         */
        const wideSecondGap = secondGap > Math.max(tokenHeight(first[0]!) * 4, 0.08);
        if (wideSecondGap || (similar && !hasSeparator)) {
          facts.push({
            ...baseFact,
            valueText: null,
            valueTokenIds: [],
            valueBox: null,
            relation: 'right',
            confidence: minConfidence(labelGroup),
            status: 'ambiguous',
          });
          return;
        }
      }

      const valueTokens = rightGroups.flat();
      const confidence = minConfidence(valueTokens);
      facts.push({
        ...baseFact,
        valueText: confidence >= UNREADABLE_CONFIDENCE ? textOf(valueTokens) : null,
        valueTokenIds: valueTokens.map((token) => token.id),
        valueBox: boxOf(valueTokens),
        relation: hasSeparator ? 'same_line' : 'right',
        confidence,
        status: confidence >= UNREADABLE_CONFIDENCE ? 'recognized' : 'unreadable',
      });
      return;
    }

    // 2) Value directly below, aligned to the label or to the value column.
    const below = lines[lineIndex + 1];
    if (below) {
      const belowGroups = groupByGaps(below.tokens);
      const candidate = belowGroups.find(
        (group) =>
          Math.abs(group[0]!.x0 - labelGroup[0]!.x0) < 0.03 ||
          valueColumns.some((column) => Math.abs(group[0]!.x0 - column) < 0.03),
      );
      const candidateText = candidate ? textOf(candidate) : '';
      /**
       * The next label is not a value. A line is a label line when it carries a
       * separator or when it has its own value group to the right — not merely
       * because it is short.
       */
      const belowIsLabelLine =
        endsWithSeparator(candidateText) || (candidate ? belowGroups.length > 1 : false);
      if (candidate && candidateText && !belowIsLabelLine) {
        /**
         * Multi-line values: further lines belong to the same value while they
         * stay in the same column, keep normal line spacing and start no new
         * label or table field.
         */
        const valueTokens = [...candidate];
        let previousLine = below;
        const lineGap = Math.max(tokenHeight(candidate[0]!) * 2.5, 0.045);
        for (let next = lineIndex + 2; next < lines.length; next += 1) {
          const followUp = lines[next]!;
          if (followUp.centerY - previousLine.centerY > lineGap) break;
          const followGroups = groupByGaps(followUp.tokens);
          // A new table row or a new label ends the value.
          if (followGroups.length > 1) break;
          const followText = textOf(followUp.tokens);
          if (endsWithSeparator(followText)) break;
          // Column change ends the value.
          if (Math.abs(followUp.tokens[0]!.x0 - candidate[0]!.x0) > 0.03) break;
          valueTokens.push(...followUp.tokens);
          previousLine = followUp;
        }

        const confidence = minConfidence(valueTokens);
        facts.push({
          ...baseFact,
          valueText: confidence >= UNREADABLE_CONFIDENCE ? textOf(valueTokens) : null,
          valueTokenIds: valueTokens.map((token) => token.id),
          valueBox: boxOf(valueTokens),
          relation: 'below',
          confidence,
          status: confidence >= UNREADABLE_CONFIDENCE ? 'recognized' : 'unreadable',
        });
        return;
      }
    }

    // 3) Label visible, no value area found.
    if (hasSeparator || valueColumns.length > 0) {
      facts.push({
        ...baseFact,
        valueText: null,
        valueTokenIds: [],
        valueBox: null,
        relation: 'none',
        confidence: minConfidence(labelGroup),
        // A capped layout is "not fully checkable", never "missing".
        status: truncated ? 'partial' : 'missing_value',
      });
    }
  });

  return facts;
}

/** Case and separator insensitive lookup used by domain consumers. */
export function normalizeFactLabel(label: string): string {
  return stripSeparator(label)
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/gu, '');
}

export function findFactByLabelAliases(
  facts: readonly DocumentVisibleFact[],
  aliases: readonly string[],
): DocumentVisibleFact | undefined {
  const wanted = aliases.map(normalizeFactLabel);
  return facts.find((fact) => wanted.includes(normalizeFactLabel(fact.labelText)));
}
