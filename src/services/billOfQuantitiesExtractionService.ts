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

const LV_FLAT_SEQUENCE_ROW = new RegExp(
  String.raw`([A-Za-zÄÖÜäöüß0-9/()\-.,]+?)\s+([\d.,]+)\s*(${UNIT_TOKEN})\s+([\d.,]+)\s+([\d.,]+)\s*(?:€|eur)?`,
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

export function extractBillOfQuantitiesPositions(
  text: string,
  sourcePage?: number,
): EnhancedDetectedOrderPosition[] {
  const positions: EnhancedDetectedOrderPosition[] = [];
  let match: RegExpExecArray | null;

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
