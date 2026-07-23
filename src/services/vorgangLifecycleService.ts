import type { VorgangStatus } from '../types/models';

/** Canonical lifecycle statuses after migration. */
export const VORGANG_LIFECYCLE_STATUSES: readonly Exclude<VorgangStatus, 'neu'>[] = [
  'eingegangen',
  'in_pruefung',
  'in_verhandlung',
  'beauftragt',
  'in_bearbeitung',
  'wartet',
  'abgeschlossen',
] as const;

const ALLOWED_TRANSITIONS: Record<Exclude<VorgangStatus, 'neu'>, readonly VorgangStatus[]> = {
  eingegangen: ['in_pruefung'],
  in_pruefung: ['in_verhandlung'],
  in_verhandlung: ['beauftragt'],
  beauftragt: ['in_bearbeitung'],
  in_bearbeitung: ['wartet', 'abgeschlossen'],
  wartet: ['in_bearbeitung', 'abgeschlossen'],
  abgeschlossen: [],
};

/** Maps persisted legacy status values onto the current lifecycle. */
export function migrateVorgangStatus(status: VorgangStatus | string | undefined): VorgangStatus {
  if (status === 'neu' || status === undefined || status === '') {
    return 'eingegangen';
  }
  if ((VORGANG_LIFECYCLE_STATUSES as readonly string[]).includes(status)) {
    return status as VorgangStatus;
  }
  return 'eingegangen';
}

export function getAllowedVorgangStatusTransitions(
  from: VorgangStatus,
): readonly VorgangStatus[] {
  const normalized = migrateVorgangStatus(from) as Exclude<VorgangStatus, 'neu'>;
  return ALLOWED_TRANSITIONS[normalized] ?? [];
}

export function canTransitionVorgangStatus(
  from: VorgangStatus,
  to: VorgangStatus,
): boolean {
  const normalizedFrom = migrateVorgangStatus(from);
  const normalizedTo = migrateVorgangStatus(to);
  if (normalizedFrom === normalizedTo) return false;
  return getAllowedVorgangStatusTransitions(normalizedFrom).includes(normalizedTo);
}
