/**
 * ANGEBOT->AUFTRAG-02B — die serverautoritative Annahme eines Angebots.
 *
 * Ablauf:
 *   freigegebenes/versendetes Angebot → Nutzer bestätigt → `accept_workspace_offer`
 *   erzeugt in **einer** Transaktion den Auftrag (Vorgang, Status `beauftragt`,
 *   Nummer AU-JJJJ-NNNN aus `workspace_order_sequences`) und setzt das Angebot
 *   auf `angenommen` mit `resultingVorgangId` → der Client übernimmt **beide
 *   Serverzeilen**.
 *
 * Idempotenz: Ist das Angebot bereits angenommen, liefert der Server denselben
 * Auftrag zurück — auch bei einer anderen Client-Vorgangskennung. Weder ein
 * Retry noch ein Doppelklick noch ein zweites Gerät erzeugt einen zweiten
 * Auftrag oder eine zweite Nummer.
 *
 * Ohne Cloud gibt es keine Annahme (die Nummer wird zentral vergeben).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../lib/supabase';
import { buildPersistedStateSnapshot, persistAll, seedSyncChangeTrackerFromCurrentStores } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { getSyncOutboxSnapshot } from '../sync/syncOutboxService';
import { runSyncFromUi } from '../sync/syncUiService';
import { getSyncClient } from '../sync/syncClientService';
import { generateEntityId } from '../sync/syncMetaService';
import { adoptServerVorgang, getVorgangById } from '../vorgangService';
import { createVorgangFromCloudRow, mapWorkspaceVorgangRow, type WorkspaceVorgangRow } from '../vorgang/vorgangCloudService';
import { adoptAcceptedOfferFromServer, canAcceptOffer, getOfferById } from './offerService';
import { mapWorkspaceOfferRow, type WorkspaceOfferRow } from './offerCloudService';
import type { Offer } from '../../types/offer';
import type { Vorgang } from '../../types/models';

export type AcceptOfferFailure =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_acceptable' }
  | { ok: false; reason: 'cloud_required' }
  | { ok: false; reason: 'sync_pending' }
  | { ok: false; reason: 'server_rejected'; message: string }
  | { ok: false; reason: 'network'; message: string };

export type AcceptOfferResult = { ok: true; offer: Offer; vorgang: Vorgang; replayed: boolean } | AcceptOfferFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasActiveOutboxEntry(offerId: string): boolean {
  return getSyncOutboxSnapshot().some(
    (entry) =>
      entry.entityType === 'offer' &&
      entry.entityId === offerId &&
      (entry.status === 'pending' || entry.status === 'blocked' || entry.status === 'error'),
  );
}

export async function acceptOfferWithCloud(offerId: string, client?: SupabaseClient | null): Promise<AcceptOfferResult> {
  const existing = getOfferById(offerId);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status === 'angenommen' && existing.resultingVorgangId) {
    const vorgang = getVorgangById(existing.resultingVorgangId);
    if (vorgang) return { ok: true, offer: existing, vorgang, replayed: true };
  }
  if (existing.status !== 'angenommen' && !canAcceptOffer(existing)) return { ok: false, reason: 'not_acceptable' };

  const supabase = client ?? getSupabaseClient();
  const state = buildPersistedStateSnapshot();
  const workspaceId = resolveCloudWorkspaceId(state).trim();
  if (!supabase || !workspaceId || state.syncClient?.syncPolicy !== 'cloud_ready') {
    return { ok: false, reason: 'cloud_required' };
  }

  // Ein offener Zustandswechsel (z. B. „versendet") soll den Server vor der Annahme erreichen.
  if (hasActiveOutboxEntry(offerId)) {
    try {
      await runSyncFromUi();
    } catch {
      /* der erneute Blick unten entscheidet */
    }
    if (hasActiveOutboxEntry(offerId)) return { ok: false, reason: 'sync_pending' };
  }

  const current = getOfferById(offerId) ?? existing;
  const vorgangId = current.resultingVorgangId ?? generateEntityId('v');

  let data: unknown;
  try {
    const response = await supabase.rpc('accept_workspace_offer', {
      p_workspace_id: workspaceId,
      p_offer_id: offerId,
      p_vorgang_id: vorgangId,
      p_row_version: current.sync?.version ?? 0,
    });
    if (response.error) {
      const message = response.error.message ?? 'Unbekannter Fehler';
      if (message.includes('Failed to fetch') || message.includes('Network')) return { ok: false, reason: 'network', message };
      return { ok: false, reason: 'server_rejected', message };
    }
    data = response.data;
  } catch (error) {
    return { ok: false, reason: 'network', message: error instanceof Error ? error.message : 'Unbekannter Fehler' };
  }

  if (!isRecord(data) || !isRecord(data.offer) || !isRecord(data.vorgang)) {
    return { ok: false, reason: 'server_rejected', message: 'Ungültige Server-Antwort' };
  }
  const offerRow = mapWorkspaceOfferRow(data.offer as unknown as WorkspaceOfferRow);
  const vorgangRow = mapWorkspaceVorgangRow(data.vorgang as unknown as WorkspaceVorgangRow);
  if (!offerRow?.payload || !vorgangRow || offerRow.payload.status !== 'angenommen' || !offerRow.payload.resultingVorgangId) {
    return { ok: false, reason: 'server_rejected', message: 'Server-Antwort ohne Auftrag' };
  }

  const syncClient = getSyncClient();
  const vorgang = createVorgangFromCloudRow(
    vorgangRow.payload,
    vorgangRow.rowVersion,
    vorgangRow.updatedAt,
    false,
    syncClient.deviceId,
    workspaceId,
  );
  const adoptedVorgang = adoptServerVorgang(vorgang);
  const adoptedOffer = adoptAcceptedOfferFromServer(
    offerId,
    { ...offerRow.payload, id: offerId },
    { rowVersion: offerRow.rowVersion, updatedAt: offerRow.updatedAt, deviceId: syncClient.deviceId, workspaceId },
  );
  if (!adoptedOffer.success) return { ok: false, reason: 'server_rejected', message: adoptedOffer.errorKey };

  // Beide Zeilen sind Serverwahrheit — nichts davon soll erneut eingereiht werden.
  seedSyncChangeTrackerFromCurrentStores();
  persistAll();

  return { ok: true, offer: adoptedOffer.offer, vorgang: adoptedVorgang, replayed: Boolean(data.replayed) };
}
