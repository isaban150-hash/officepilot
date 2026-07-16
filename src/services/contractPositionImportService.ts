import type { EnhancedDetectedOrderPosition } from '../types/documentIntelligence';
import type { DetectedOrderPosition } from '../types/models';
import { importSuggestedPositionsToVorgang } from './intakeWorkflowService';

export type ContractPositionSelectionState =
  | 'selected'
  | 'deselected'
  | 'needs_review'
  | 'rejected';

export type ContractPositionSelectionMap = Record<string, ContractPositionSelectionState>;

const ROUNDING_TOLERANCE = 0.06;

const NON_BILLABLE_DESCRIPTION_PATTERN =
  /windlast|befestigungsplan|montagezeichnung|detailzeichnung|technische\s+berechnung|maßstab|grundriss|statik|tragwerk|\bcad\b|\bdwg\b|nachweispflicht|gewährleistung|vertragsstrafe|agb\b|allgemeine\s+vertragsbedingungen|besondere\s+vertragsbedingungen|lieferumfang|materialliste|stückliste|seitenzahl|seite\s+\d+/i;

export function buildContractPositionKey(position: DetectedOrderPosition): string {
  return `${position.positionNumber ?? ''}::${position.description.trim().toLowerCase()}`;
}

function hasReviewStatus(
  position: DetectedOrderPosition | EnhancedDetectedOrderPosition,
): position is EnhancedDetectedOrderPosition {
  return 'reviewStatus' in position && typeof position.reviewStatus === 'string';
}

/**
 * A billable LV row needs structure + price/quantity evidence.
 * Technical attachments, clauses and empty rows are rejected.
 */
export function isImportableLvPosition(
  position: DetectedOrderPosition | EnhancedDetectedOrderPosition,
): boolean {
  const description = position.description?.trim() ?? '';
  if (!description) return false;
  if (NON_BILLABLE_DESCRIPTION_PATTERN.test(description)) return false;
  if (!position.unit?.trim()) return false;

  const hasQuantity = Number.isFinite(position.quantity) && position.quantity > 0;
  const hasUnitPrice = Number.isFinite(position.unitPrice) && position.unitPrice > 0;
  const hasLineTotal = Number.isFinite(position.lineTotal) && position.lineTotal > 0;
  if (!hasQuantity && !hasUnitPrice && !hasLineTotal) return false;

  return true;
}

/** True when Menge × EP disagrees with Gesamtpreis (no auto-correction). */
export function hasPositionMathConflict(position: DetectedOrderPosition): boolean {
  const quantity = position.quantity;
  const unitPrice = position.unitPrice;
  const lineTotal = position.lineTotal;
  if (!(quantity > 0 && unitPrice > 0 && lineTotal > 0)) return false;
  const expected = Math.round(quantity * unitPrice * 100) / 100;
  const roundedTotal = Math.round(lineTotal * 100) / 100;
  const diff = Math.abs(expected - roundedTotal);
  if (diff <= ROUNDING_TOLERANCE) return false;
  if (diff / roundedTotal <= 0.02) return false;
  return true;
}

export function buildDefaultContractPositionSelections(
  positions: Array<DetectedOrderPosition | EnhancedDetectedOrderPosition>,
): ContractPositionSelectionMap {
  const selections: ContractPositionSelectionMap = {};

  for (const position of positions) {
    const key = buildContractPositionKey(position);
    if (!isImportableLvPosition(position)) {
      selections[key] = 'rejected';
      continue;
    }
    if (hasReviewStatus(position) && position.reviewStatus === 'review_required') {
      selections[key] = 'needs_review';
      continue;
    }
    selections[key] = 'selected';
  }

  return selections;
}

export function isPositionSelectedForImport(state: ContractPositionSelectionState | undefined): boolean {
  return state === 'selected';
}

export function filterConfirmedPositionsForImport<T extends DetectedOrderPosition>(
  positions: T[],
  selections: ContractPositionSelectionMap,
): T[] {
  return positions.filter((position) => {
    if (!isImportableLvPosition(position)) return false;
    const state = selections[buildContractPositionKey(position)];
    return isPositionSelectedForImport(state);
  });
}

export function countSelectedContractPositions(
  positions: Array<DetectedOrderPosition | EnhancedDetectedOrderPosition>,
  selections: ContractPositionSelectionMap,
): number {
  return filterConfirmedPositionsForImport(positions, selections).length;
}

/**
 * Shared confirm-first import. Only explicitly selected, importable positions are persisted.
 */
export function confirmImportContractPositions(
  vorgangId: string,
  positions: DetectedOrderPosition[],
  selections: ContractPositionSelectionMap,
): { success: boolean; added: number; skipped: number; selectedCount: number } {
  const confirmed = filterConfirmedPositionsForImport(positions, selections);
  const result = importSuggestedPositionsToVorgang(vorgangId, confirmed);
  return {
    ...result,
    selectedCount: confirmed.length,
  };
}

export function selectAllSafeContractPositions(
  positions: Array<DetectedOrderPosition | EnhancedDetectedOrderPosition>,
  selections: ContractPositionSelectionMap,
): ContractPositionSelectionMap {
  const next = { ...selections };
  for (const position of positions) {
    const key = buildContractPositionKey(position);
    if (!isImportableLvPosition(position)) {
      next[key] = 'rejected';
      continue;
    }
    if (hasReviewStatus(position) && position.reviewStatus === 'review_required') {
      next[key] = 'needs_review';
      continue;
    }
    if (next[key] !== 'rejected') {
      next[key] = 'selected';
    }
  }
  return next;
}

/** Test/helper: import only positions that default to selected (safe LV rows). */
export function confirmImportSafeContractPositions(
  vorgangId: string,
  positions: Array<DetectedOrderPosition | EnhancedDetectedOrderPosition>,
): { success: boolean; added: number; skipped: number; selectedCount: number } {
  const selections = buildDefaultContractPositionSelections(positions);
  return confirmImportContractPositions(vorgangId, positions, selections);
}
