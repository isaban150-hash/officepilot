/**
 * ANGEBOT-01B — die serverautoritative Freigabe eines Angebots.
 *
 * Ablauf:
 *   Entwurf → Nutzer gibt frei → `finalize_workspace_offer` vergibt atomar die
 *   Angebotsnummer aus dem eigenen Nummernkreis (`workspace_offer_sequences`)
 *   und friert den Payload ein → der Client übernimmt **die Serverantwort**,
 *   nicht seinen eigenen Kandidaten.
 *
 * Idempotenz: Der Fingerabdruck des eingefrorenen Inhalts reist mit. Ein
 * Wiederholungsaufruf für ein bereits freigegebenes Angebot mit demselben
 * Fingerabdruck liefert dieselbe Zeile zurück — keine zweite Nummer, auch
 * nicht nach Reload oder von einem zweiten Gerät.
 *
 * Keine lokale Nummer, kein Raten, kein Nachkorrigieren: Ohne Cloud gibt es
 * keine Freigabe, und das sagt die Oberfläche auch so.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../lib/supabase';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { getSyncOutboxSnapshot } from '../sync/syncOutboxService';
import { runSyncFromUi } from '../sync/syncUiService';
import { getSyncClient } from '../sync/syncClientService';
import {
  applyConfirmedOfferFinalization,
  buildOfferFinalizationCandidate,
  getOfferById,
  type OfferFinalizeBlocker,
} from './offerService';
import { mapWorkspaceOfferRow, type WorkspaceOfferRow } from './offerCloudService';
import type { Offer } from '../../types/offer';

export type FinalizeOfferFailure =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'blocked'; blockers: OfferFinalizeBlocker[] }
  | { ok: false; reason: 'cloud_required' }
  | { ok: false; reason: 'sync_pending' }
  | { ok: false; reason: 'already_finalized_elsewhere' }
  | { ok: false; reason: 'server_rejected'; message: string }
  | { ok: false; reason: 'network'; message: string };

export type FinalizeOfferResult = { ok: true; offer: Offer; replayed: boolean } | FinalizeOfferFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Offene Sendeaufträge zu diesem Angebot — die Freigabe darf keinen alten Entwurf überholen. */
function hasActiveOutboxEntry(offerId: string): boolean {
  return getSyncOutboxSnapshot().some(
    (entry) =>
      entry.entityType === 'offer' &&
      entry.entityId === offerId &&
      (entry.status === 'pending' || entry.status === 'blocked' || entry.status === 'error'),
  );
}

export async function finalizeOfferWithCloud(
  offerId: string,
  client?: SupabaseClient | null,
): Promise<FinalizeOfferResult> {
  const existing = getOfferById(offerId);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status !== 'entwurf') return { ok: true, offer: existing, replayed: true };

  const candidate = buildOfferFinalizationCandidate(offerId);
  if (!candidate.ok) return { ok: false, reason: 'blocked', blockers: candidate.blockers };

  const supabase = client ?? getSupabaseClient();
  const state = buildPersistedStateSnapshot();
  const workspaceId = resolveCloudWorkspaceId(state).trim();
  if (!supabase || !workspaceId || state.syncClient?.syncPolicy !== 'cloud_ready') {
    return { ok: false, reason: 'cloud_required' };
  }

  /*
   * Erst den Entwurf zur Ruhe bringen: Ein noch nicht bestätigter Sendeauftrag
   * würde nach der Freigabe mit altem Inhalt beim Server ankommen und dort
   * (zu Recht) abgewiesen. Ein Lauf, dann Prüfung — kein Endlosversuch.
   */
  if (hasActiveOutboxEntry(offerId)) {
    try {
      await runSyncFromUi();
    } catch {
      /* Der erneute Blick unten entscheidet. */
    }
    if (hasActiveOutboxEntry(offerId)) return { ok: false, reason: 'sync_pending' };
  }

  const current = getOfferById(offerId) ?? existing;
  const rowVersion = current.sync?.version ?? 0;

  let data: unknown;
  try {
    const response = await supabase.rpc('finalize_workspace_offer', {
      p_workspace_id: workspaceId,
      p_offer_id: offerId,
      p_payload: {
        ...candidate.content,
        id: offerId,
        workspaceId: current.workspaceId,
        createdAt: current.createdAt,
      },
      p_fingerprint: candidate.fingerprint,
      p_row_version: rowVersion,
    });
    if (response.error) {
      const message = response.error.message ?? 'Unbekannter Fehler';
      if (message.includes('bereits freigegeben')) return { ok: false, reason: 'already_finalized_elsewhere' };
      if (message.includes('Failed to fetch') || message.includes('Network')) {
        return { ok: false, reason: 'network', message };
      }
      return { ok: false, reason: 'server_rejected', message };
    }
    data = response.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    return { ok: false, reason: 'network', message };
  }

  if (!isRecord(data) || !isRecord(data.row)) {
    return { ok: false, reason: 'server_rejected', message: 'Ungültige Server-Antwort' };
  }
  const mapped = mapWorkspaceOfferRow(data.row as unknown as WorkspaceOfferRow);
  if (!mapped || !mapped.payload || !mapped.payload.offerNumber || typeof mapped.payload.offerSequenceNumber !== 'number') {
    return { ok: false, reason: 'server_rejected', message: 'Server-Antwort ohne Angebotsnummer' };
  }

  const syncClient = getSyncClient();
  const applied = applyConfirmedOfferFinalization(offerId, {
    serverOffer: { ...mapped.payload, id: offerId },
    rowVersion: mapped.rowVersion,
    updatedAt: mapped.updatedAt,
    deviceId: syncClient.deviceId,
    workspaceId,
  });
  if (!applied.success) return { ok: false, reason: 'server_rejected', message: applied.errorKey };

  return { ok: true, offer: applied.offer, replayed: Boolean(data.replayed) };
}
