import type { EnhancedDetectedOrderPosition } from '../types/documentIntelligence';
import { mapDetectedUnit } from './orderUnitMapper';
import { parseGermanMoney } from './documentAmountExtractionService';

const LV_PIPE_ROW =
  /^(\d{1,3})\s*[|]\s*(.+?)\s*[|]\s*(\S+)\s*[|]\s*([\d.,]+)\s*[|]\s*([\d.,]+)\s*[|]\s*([\d.,]+)\s*$/gm;

const LV_SPACE_ROW =
  /^(\d{1,3})\s+([\d.,]+)\s+(qm|m²|m2|lfdm\.?|lfm|m|st\.?|stk|stück|std\.?|kg|pauschal)\s+(.+?)\s+(?:ep|einzelpreis)\s*[:]?\s*([\d.,]+)\s*(?:€|eur)?(?:\s+(?:gp|gesamt(?:preis)?)\s*[:]?\s*([\d.,]+)\s*(?:€|eur)?)?\s*$/gim;

const LV_ALT_ROW =
  /^(\d{1,3})\s+(.+?)\s+(Stk|m²|m2|m|psch|Std|h|LE|qm|lfdm\.?|lfm|kg|pauschal)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s*$/gim;
const LV_FLAT_SEQUENCE_ROW =
  /([A-Za-zÄÖÜäöüß0-9/()\-.,]+?)\s+([\d.,]+)\s*(m²|m2|qm|lfdm\.?|lfm|m|st\.?|stk|stück|std\.?|kg|pauschal)\s+([\d.,]+)\s+([\d.,]+)\s*(?:€|eur)?/gi;
const ROUNDING_TOLERANCE = 0.06;

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function validatePositionMath(
  quantity: number,
  unitPrice: number,
  lineTotal: number,
): 'confirmed' | 'review_required' {
  if (quantity <= 0 || unitPrice <= 0) return 'review_required';
  const expected = roundMoney(quantity * unitPrice);
  const diff = Math.abs(expected - roundMoney(lineTotal));
  if (diff <= ROUNDING_TOLERANCE) return 'confirmed';
  if (lineTotal > 0 && diff / lineTotal <= 0.02) return 'confirmed';
  return 'review_required';
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
  const lineTotal = lineTotalRaw ? parseGermanMoney(lineTotalRaw) : roundMoney(quantity * unitPrice);
  const mapped = mapDetectedUnit(rawUnit);
  const reviewStatus = validatePositionMath(quantity, unitPrice, lineTotal);

  return {
    positionNumber,
    description: description.trim(),
    unit: mapped.unitLabel ?? mapped.unit,
    quantity,
    unitPrice,
    lineTotal,
    sourcePage,
    confidence: reviewStatus === 'confirmed' ? 'high' : 'medium',
    reviewStatus,
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
