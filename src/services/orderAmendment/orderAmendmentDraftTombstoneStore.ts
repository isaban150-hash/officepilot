/**
 * CLOUD-SYNC S6 — Grabsteine verworfener Nachtragsentwürfe.
 *
 * Ein verworfener Entwurf verschwindet sofort aus `Vorgang.orderAmendments` —
 * dort stehen ausschliesslich lebende Entwürfe, und kein Leser muss filtern.
 * Kannte die Cloud ihn schon (oder ist er unterwegs), bleibt bis zur
 * Bestätigung des Verwerfens ein Grabstein hier stehen: Nur so erreicht das
 * Verwerfen die anderen Geräte, und nur so wird es nie still verloren.
 *
 * Reiner Speicher ohne Persistenzaufruf — gespeichert wird mit dem übrigen
 * Zustand (`persistAll`).
 */
import type { OrderAmendmentDraftTombstone } from '../../types/orderAmendmentDraftCloud';

let tombstones: OrderAmendmentDraftTombstone[] = [];

function clone(tombstone: OrderAmendmentDraftTombstone): OrderAmendmentDraftTombstone {
  return { ...tombstone, sync: { ...tombstone.sync } };
}

export function getOrderAmendmentDraftTombstoneSnapshot(): OrderAmendmentDraftTombstone[] {
  return tombstones.map(clone);
}

export function hydrateOrderAmendmentDraftTombstones(items: OrderAmendmentDraftTombstone[]): void {
  tombstones = (items ?? [])
    .filter((item) => item && typeof item.id === 'string' && typeof item.vorgangId === 'string' && item.sync)
    .map(clone);
}

export function resetOrderAmendmentDraftTombstones(): void {
  tombstones = [];
}

export function putOrderAmendmentDraftTombstone(tombstone: OrderAmendmentDraftTombstone): void {
  tombstones = [...tombstones.filter((item) => item.id !== tombstone.id), clone(tombstone)];
}

export function removeOrderAmendmentDraftTombstone(draftId: string): void {
  tombstones = tombstones.filter((item) => item.id !== draftId);
}
