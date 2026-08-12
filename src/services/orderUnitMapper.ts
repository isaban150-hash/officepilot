import type { DetectedOrderPosition, OrderUnit } from '../types/models';

/** How confidently the document unit maps onto a billable OrderUnit. */
export type UnitResolutionState = 'known' | 'unknown' | 'ambiguous';

export interface ResolvedOrderUnit {
  /** Verbatim unit text from the document — never overwritten. */
  rawUnit: string;
  state: UnitResolutionState;
  /** Only set when state === 'known'. */
  unit?: OrderUnit;
  unitLabel?: string;
}

/**
 * Single source of truth for unit spellings. Every LV row format resolves its
 * unit here, so the three row regexes can no longer disagree.
 */
const UNIT_VOCABULARY: Array<{ unit: OrderUnit; unitLabel?: string; spellings: string[] }> = [
  { unit: 'm²', spellings: ['m²', 'm2', 'qm', 'quadratmeter'] },
  { unit: 'Meter', unitLabel: 'lfm', spellings: ['lfm', 'lfdm', 'lfd.m', 'lfd m', 'laufende meter', 'laufmeter'] },
  { unit: 'Meter', spellings: ['m', 'meter', 'le'] },
  { unit: 'Stück', spellings: ['stück', 'stueck', 'stk', 'stck', 'st'] },
  { unit: 'Stunden', spellings: ['std', 'h', 'stunde', 'stunden'] },
  { unit: 'Pauschal', spellings: ['pauschal', 'psch', 'pausch', 'pau'] },
];

/**
 * Spellings that could mean more than one billable unit. Kept explicit so an
 * ambiguous token is never silently resolved to one of the candidates.
 */
const AMBIGUOUS_SPELLINGS = new Set(['stk/m', 'm/stk', 'stk.m']);

function normalizeUnitToken(rawUnit: string): string {
  return rawUnit
    .trim()
    .toLowerCase()
    .replace(/[.]+$/, '')
    .replace(/\s+/g, ' ');
}

/**
 * Resolves a document unit without ever guessing.
 *
 * An unsupported unit (kg, t, Sack, …) stays `unknown` — it must not become
 * Stück, because that would silently change what is billed.
 */
export function resolveOrderUnit(rawUnit: string): ResolvedOrderUnit {
  const raw = rawUnit.trim();
  const normalized = normalizeUnitToken(raw);
  if (!normalized) return { rawUnit: raw, state: 'unknown' };
  if (AMBIGUOUS_SPELLINGS.has(normalized)) return { rawUnit: raw, state: 'ambiguous' };

  for (const entry of UNIT_VOCABULARY) {
    if (entry.spellings.includes(normalized)) {
      return {
        rawUnit: raw,
        state: 'known',
        unit: entry.unit,
        unitLabel: entry.unitLabel,
      };
    }
  }

  return { rawUnit: raw, state: 'unknown' };
}

export function isResolvedUnit(
  resolved: ResolvedOrderUnit,
): resolved is ResolvedOrderUnit & { unit: OrderUnit } {
  return resolved.state === 'known' && resolved.unit !== undefined;
}

export function formatDetectedPositionDescription(position: DetectedOrderPosition): string {
  const description = position.description.trim();
  const positionNumber = position.positionNumber?.trim();
  if (positionNumber) {
    return `${positionNumber} – ${description}`;
  }
  return description;
}

export function buildPositionImportKey(position: DetectedOrderPosition): string {
  const positionNumber = position.positionNumber?.trim().toLowerCase();
  if (positionNumber) {
    return `pos:${positionNumber}`;
  }
  return `desc:${formatDetectedPositionDescription(position).trim().toLowerCase()}`;
}

export function formatOrderUnitDisplay(unit: OrderUnit, unitLabel?: string): string {
  return unitLabel ?? unit;
}

export function computeContractPositionsTotal(positions: DetectedOrderPosition[]): number {
  return positions.reduce(
    (sum, position) => sum + (position.lineTotal || position.quantity * position.unitPrice),
    0,
  );
}
