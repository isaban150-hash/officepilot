import type {
  EnhancedDetectedOrderPosition,
  PositionReviewReason,
} from '../types/documentIntelligence';
import { isResolvedUnit, resolveOrderUnit } from './orderUnitMapper';
import { parseGermanMoney } from './documentAmountExtractionService';
import { lineTotalCents, roundMoney, toCents } from './invoiceMoney';

/**
 * Unit token shared by every row format. Deliberately open: a structurally
 * valid LV row must be parsed even when the unit is not (yet) supported —
 * otherwise the whole position, including quantity and price, disappears.
 * Bounded so it cannot swallow ordinary description words.
 */
const UNIT_TOKEN = String.raw`[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß0-9²³./]{0,11}`;

/** Horizontal whitespace only — a row never continues on the next line. */
const H = String.raw`[^\S\r\n]`;

/**
 * General currency detection. A currency token states the money, never the
 * measured unit, so it must not be accepted as one. No document-specific rule.
 */
const CURRENCY_TOKEN_PATTERN = /^(?:€|eur|euro|chf|usd|\$)$/i;

function isCurrencyToken(value: string): boolean {
  return CURRENCY_TOKEN_PATTERN.test(value.trim().replace(/[.,;:]+$/, ''));
}

const LV_PIPE_ROW =
  /^(\d{1,3})\s*[|]\s*(.+?)\s*[|]\s*(\S+)\s*[|]\s*([\d.,]+)\s*[|]\s*([\d.,]+)\s*[|]\s*([\d.,]+)\s*$/gm;

const LV_SPACE_ROW = new RegExp(
  String.raw`^(\d{1,3})\s+([\d.,]+)\s+(${UNIT_TOKEN})\s+(.+?)\s+(?:ep|einzelpreis)\s*[:]?\s*([\d.,]+)\s*(?:€|eur)?(?:\s+(?:gp|gesamt(?:preis)?)\s*[:]?\s*([\d.,]+)\s*(?:€|eur)?)?\s*$`,
  'gim',
);

const LV_ALT_ROW = new RegExp(
  String.raw`^(\d{1,3})\s+(.+?)\s+(${UNIT_TOKEN})\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s*$`,
  'gim',
);

/**
 * Flat sequence inside a single visual line. Horizontal whitespace only:
 * with `\s` the match could span a line break and turn the transition between
 * two positions into a phantom row.
 */
const LV_FLAT_SEQUENCE_ROW = new RegExp(
  String.raw`([A-Za-zÄÖÜäöüß0-9/()\-.,]+?)${H}+([\d.,]+)${H}*(${UNIT_TOKEN})${H}+([\d.,]+)${H}+([\d.,]+)${H}*(?:€|eur)?`,
  'gi',
);

/**
 * Exact cent comparison — the same rounding the invoice uses. No relative
 * tolerance: a 2 % rule silently accepted ~270 € of error on a large line.
 */
function hasLineMathMismatch(
  quantity: number,
  unitPrice: number,
  lineTotal: number | undefined,
  lineTotalStated: boolean,
): boolean {
  if (quantity <= 0 || unitPrice <= 0) return true;
  // Without a stated GP there is nothing to contradict — no invented conflict.
  if (!lineTotalStated || lineTotal === undefined) return false;
  return lineTotalCents(quantity, unitPrice) !== toCents(lineTotal);
}

function pushPosition(
  positions: EnhancedDetectedOrderPosition[],
  candidate: EnhancedDetectedOrderPosition,
): void {
  const key = `${candidate.positionNumber ?? ''}:${candidate.description.toLowerCase()}`;
  if (positions.some((existing) => `${existing.positionNumber ?? ''}:${existing.description.toLowerCase()}` === key)) {
    return;
  }
  positions.push(candidate);
}

function buildPosition(
  positionNumber: string,
  description: string,
  rawUnit: string,
  quantityRaw: string,
  unitPriceRaw: string,
  lineTotalRaw: string | undefined,
  sourcePage?: number,
): EnhancedDetectedOrderPosition {
  const quantity = parseGermanMoney(quantityRaw);
  const unitPrice = parseGermanMoney(unitPriceRaw);
  const lineTotalStated = Boolean(lineTotalRaw);
  const lineTotal = lineTotalRaw ? parseGermanMoney(lineTotalRaw) : roundMoney(quantity * unitPrice);
  const resolved = resolveOrderUnit(rawUnit);

  const reviewReasons: PositionReviewReason[] = [];
  if (resolved.state === 'unknown') reviewReasons.push('unit_unknown');
  if (resolved.state === 'ambiguous') reviewReasons.push('unit_ambiguous');
  if (hasLineMathMismatch(quantity, unitPrice, lineTotal, lineTotalStated)) {
    reviewReasons.push('line_math_mismatch');
  }

  const reviewStatus = reviewReasons.length > 0 ? 'review_required' : 'confirmed';

  return {
    positionNumber,
    description: description.trim(),
    // Unresolved units keep their document text — never a substituted default.
    unit: isResolvedUnit(resolved) ? resolved.unitLabel ?? resolved.unit : resolved.rawUnit,
    rawUnit: resolved.rawUnit,
    quantity,
    unitPrice,
    lineTotal,
    sourcePage,
    confidence: reviewStatus === 'confirmed' ? 'high' : 'medium',
    reviewStatus,
    reviewReasons: reviewReasons.length > 0 ? reviewReasons : undefined,
  };
}

/**
 * CONTRACT-LV-POSITION-COMPLETENESS-01C — multi-line table blocks.
 *
 *   <number> <quantity> <unit> <first description part>
 *   …any number of further description lines…
 *   <unit price> <currency> <line total> <currency>
 *
 * A line-based state machine: every line belongs to exactly one block, so no
 * match can ever span a position boundary. Page breaks are not bridged.
 */
const BLOCK_START_ROW = new RegExp(
  String.raw`^${H}*(\d{1,3}(?:[.\-]\d{1,3})*)${H}+([\d.][\d.,]*)${H}+(${UNIT_TOKEN})${H}+(\S.*)$`,
);

/** Two money values in one line, currency markers optional but typical. */
const BLOCK_PRICE_ROW = new RegExp(
  String.raw`^${H}*([\d.][\d.,]*)${H}*(?:€|eur|euro)?${H}+([\d.][\d.,]*)${H}*(?:€|eur|euro)?${H}*$`,
  'i',
);

/**
 * Structural non-service rows never start a block. Anchored at the line start,
 * mirroring the import gate — no loosening of the non-billable rules.
 */
const BLOCK_NON_BILLABLE_LINE =
  /^\s*(?:agb(?![\w-])|(?:allgemeine|besondere)\s+(?:vertrags|geschäfts|geschaefts)bedingungen\b|zwischensumme\b|(?:gesamt|netto|brutto|end)?summe\b|(?:seiten)?übertrag\b|(?:seiten)?uebertrag\b|(?:titel|los|abschnitt|kapitel|gewerk)\s+\d)/i;

interface MultilineBlock {
  positionNumber: string;
  quantityRaw: string;
  unitRaw: string;
  descriptionLines: string[];
  unitPriceRaw?: string;
  lineTotalRaw?: string;
}

function startBlock(line: string): MultilineBlock | null {
  const match = BLOCK_START_ROW.exec(line);
  if (!match) return null;
  const unitRaw = match[3] ?? '';
  // A currency states the money, never the measured unit.
  if (isCurrencyToken(unitRaw)) return null;
  if (parseGermanMoney(match[2] ?? '') <= 0) return null;
  const description = (match[4] ?? '').trim();
  if (!description) return null;
  return {
    positionNumber: match[1] ?? '',
    quantityRaw: match[2] ?? '',
    unitRaw,
    descriptionLines: [description],
  };
}

/**
 * Extracts only blocks that are genuinely multi-line: a separate price line
 * closes them. Single-line formats stay with the existing row patterns.
 */
export function extractMultilinePositionBlocks(
  text: string,
  sourcePage?: number,
): EnhancedDetectedOrderPosition[] {
  const positions: EnhancedDetectedOrderPosition[] = [];
  const lines = text.split(/\r?\n/);
  let open: MultilineBlock | null = null;

  const closeComplete = (block: MultilineBlock): void => {
    if (!block.unitPriceRaw || !block.lineTotalRaw) return;
    pushPosition(
      positions,
      buildPosition(
        block.positionNumber,
        block.descriptionLines.join(' ').replace(/\s+/g, ' ').trim(),
        block.unitRaw,
        block.quantityRaw,
        block.unitPriceRaw,
        block.lineTotalRaw,
        sourcePage,
      ),
    );
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // A price line closes the open block and never starts a new one.
    if (open && !open.unitPriceRaw) {
      const price = BLOCK_PRICE_ROW.exec(line);
      if (price) {
        open.unitPriceRaw = price[1];
        open.lineTotalRaw = price[2];
        closeComplete(open);
        open = null;
        continue;
      }
    }

    const next = startBlock(line);
    if (next) {
      // An incomplete predecessor is dropped, never imported — parsing goes on.
      open = next;
      continue;
    }

    if (BLOCK_NON_BILLABLE_LINE.test(line)) {
      open = null;
      continue;
    }

    if (open) open.descriptionLines.push(line);
  }

  return positions;
}

export function extractBillOfQuantitiesPositions(
  text: string,
  sourcePage?: number,
): EnhancedDetectedOrderPosition[] {
  const positions: EnhancedDetectedOrderPosition[] = [];
  let match: RegExpExecArray | null;

  // Multi-line blocks first: their document number is authoritative and the
  // single-line patterns cannot describe them.
  for (const block of extractMultilinePositionBlocks(text, sourcePage)) {
    pushPosition(positions, block);
  }

  const pipeRegex = new RegExp(LV_PIPE_ROW.source, LV_PIPE_ROW.flags);
  while ((match = pipeRegex.exec(text)) !== null) {
    pushPosition(
      positions,
      buildPosition(match[1], match[2], match[3], match[4], match[5], match[6], sourcePage),
    );
  }

  const spaceRegex = new RegExp(LV_SPACE_ROW.source, LV_SPACE_ROW.flags);
  while ((match = spaceRegex.exec(text)) !== null) {
    pushPosition(
      positions,
      buildPosition(match[1], match[4], match[3], match[2], match[5], match[6], sourcePage),
    );
  }

  const altRegex = new RegExp(LV_ALT_ROW.source, LV_ALT_ROW.flags);
  while ((match = altRegex.exec(text)) !== null) {
    pushPosition(
      positions,
      buildPosition(match[1], match[2], match[3], match[4], match[5], match[6], sourcePage),
    );
  }

  const flatRegex = new RegExp(LV_FLAT_SEQUENCE_ROW.source, LV_FLAT_SEQUENCE_ROW.flags);
  while ((match = flatRegex.exec(text)) !== null) {
    // A currency states the money, never the measured unit — skip, keep scanning.
    if (isCurrencyToken(match[3] ?? '')) continue;
    pushPosition(
      positions,
      buildPosition(`${positions.length + 1}`, match[1], match[3], match[2], match[4], match[5], sourcePage),
    );
  }

  return positions;
}

export function extractBillOfQuantitiesFromPages(
  pages: Array<{ pageNumber: number; text: string }>,
  pageNumbers?: number[],
): EnhancedDetectedOrderPosition[] {
  const allowed = pageNumbers ? new Set(pageNumbers) : null;
  const positions: EnhancedDetectedOrderPosition[] = [];

  for (const page of pages) {
    if (allowed && !allowed.has(page.pageNumber)) continue;
    for (const position of extractBillOfQuantitiesPositions(page.text, page.pageNumber)) {
      pushPosition(positions, position);
    }
  }

  return positions.sort((a, b) => Number(a.positionNumber ?? 0) - Number(b.positionNumber ?? 0));
}

export function sumPositionsNet(positions: EnhancedDetectedOrderPosition[]): number {
  return roundMoney(positions.reduce((sum, position) => sum + (position.lineTotal || 0), 0));
}
