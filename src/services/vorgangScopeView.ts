/**
 * REFERENZVERTRAG V1 – SPRINT C — Gewerk / Hauptleistungen for Vorgang UI.
 * Prefers linked inbox recognizedData; falls back to deterministic derivation from positions.
 */
import { getInboxItemById } from './inboxService';
import {
  decodeHauptleistungen,
  deriveContractScope,
} from './contractScopeDerivationService';
import type { Vorgang } from '../types/models';

export type VorgangScopeView = {
  gewerk?: string;
  hauptleistungen: string[];
};

export function buildVorgangScopeView(vorgang: Vorgang): VorgangScopeView {
  const inbox = vorgang.createdFromInboxId
    ? getInboxItemById(vorgang.createdFromInboxId)
    : undefined;

  const fromInboxGewerk = inbox?.recognizedData.Gewerk?.trim();
  const fromInboxHaupt = decodeHauptleistungen(inbox?.recognizedData.Hauptleistungen);

  const derived = deriveContractScope({
    vertragsgegenstand:
      inbox?.recognizedData.Objekt ||
      inbox?.recognizedData.Leistung ||
      undefined,
    leistungsbeschreibung: inbox?.recognizedData.Leistungsbeschreibung,
    positions: vorgang.orderPositions,
  });

  const gewerk = fromInboxGewerk || derived.gewerk;
  // Prefer live derivation from order positions after accept (truth = imported plan).
  const hauptleistungen =
    derived.hauptleistungen.length > 0 ? derived.hauptleistungen : fromInboxHaupt;

  return {
    gewerk,
    hauptleistungen,
  };
}
