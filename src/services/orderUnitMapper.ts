import type { DetectedOrderPosition, OrderUnit } from '../types/models';

export interface MappedOrderUnit {
  unit: OrderUnit;
  unitLabel?: string;
}

export function mapDetectedUnit(rawUnit: string): MappedOrderUnit {
  const normalized = rawUnit.trim().toLowerCase().replace(/\.$/, '');

  if (normalized.includes('m²') || normalized === 'm2') {
    return { unit: 'm²' };
  }
  if (
    normalized.includes('stück') ||
    normalized === 'stk' ||
    normalized === 'st' ||
    normalized === 'stck'
  ) {
    return { unit: 'Stück' };
  }
  if (normalized.includes('stunde') || normalized === 'std' || normalized === 'h') {
    return { unit: 'Stunden' };
  }
  if (normalized.includes('pausch') || normalized === 'psch') {
    return { unit: 'Pauschal' };
  }
  if (
    normalized === 'lfm' ||
    normalized.includes('laufende') ||
    normalized.includes('lfd') ||
    normalized.includes('lf.')
  ) {
    return { unit: 'Meter', unitLabel: 'lfm' };
  }
  if (normalized.includes('meter') || normalized === 'm' || normalized === 'le') {
    return { unit: 'Meter' };
  }

  return { unit: 'Stück' };
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
