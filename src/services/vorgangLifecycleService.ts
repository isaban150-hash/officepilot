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

/**
 * BUSINESS-STATE-DIRECT-CONFIRMATION-01B — statuses from which a documented,
 * already placed order may be confirmed without opening a negotiation first.
 *
 * Deliberately kept out of ALLOWED_TRANSITIONS: the general lifecycle stays
 * strictly linear, and this shortcut is only ever reachable together with the
 * business-state guard in confirmContractOrder.
 */
const DIRECT_CONFIRMATION_SOURCE_STATUSES: ReadonlySet<VorgangStatus> = new Set([
  'eingegangen',
  'in_pruefung',
]);

/** Whether `status` may go straight to `beauftragt` on an explicit direct confirmation. */
export function canConfirmOrderDirectlyFromStatus(status: VorgangStatus): boolean {
  return DIRECT_CONFIRMATION_SOURCE_STATUSES.has(status);
}

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
