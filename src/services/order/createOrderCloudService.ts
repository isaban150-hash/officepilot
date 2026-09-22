/**
 * AUFTRAG-02C — die serverautoritative Anlage eines manuellen Auftrags.
 *
 * Ablauf:
 *   lokaler Entwurf → Nutzer bestätigt → `create_workspace_order` erzeugt in
 *   **einer** Transaktion den Auftrag (Vorgang, Status `beauftragt`, Nummer
 *   AU-JJJJ-NNNN aus derselben Jahressequenz wie Aufträge aus Angeboten,
 *   eingefrorener Snapshot, serverseitig gerechnete Summen) → der Client
 *   übernimmt die Serverzeile und erst **danach** verschwindet der Entwurf.
 *
 * Idempotenz: Die Entwurfskennung ist die Vorgangskennung. Ein zweiter Aufruf
 * — Retry nach verlorener Antwort, Doppelklick, zweites Gerät mit demselben
 * Entwurf — liefert denselben Auftrag zurück, ohne zweite Nummer und ohne den
 * bestätigten Stand zu überschreiben. Ein inzwischen veränderter Entwurf
 * ändert daran nichts: Serverwahrheit gewinnt.
 *
 * Ohne Cloud gibt es keine Anlage (die Nummer wird zentral vergeben).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../lib/supabase';
import { buildPersistedStateSnapshot, persistAll, seedSyncChangeTrackerFromCurrentStores } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { getSyncClient } from '../sync/syncClientService';
import { adoptServerVorgang, getVorgangById } from '../vorgangService';
import { createVorgangFromCloudRow, mapWorkspaceVorgangRow, type WorkspaceVorgangRow } from '../vorgang/vorgangCloudService';
import { deleteOrderDraft, getOrderDraftBlockers, getOrderDraftById } from './orderDraftService';
import type { Vorgang } from '../../types/models';

export type CreateOrderFailure =
  | { ok: false; reason: 'draft_not_found' }
  | { ok: false; reason: 'blocked'; blockers: string[] }
  | { ok: false; reason: 'cloud_required' }
  | { ok: false; reason: 'server_rejected'; message: string }
  | { ok: false; reason: 'network'; message: string };

export type CreateOrderResult = { ok: true; vorgang: Vorgang; replayed: boolean } | CreateOrderFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function createOrderFromDraftWithCloud(
  draftId: string,
  client?: SupabaseClient | null,
): Promise<CreateOrderResult> {
  // Der Auftrag existiert bereits (eigene Antwort verloren oder über Pull adoptiert).
  const existing = getVorgangById(draftId);
  if (existing?.orderNumber) {
    deleteOrderDraft(draftId);
    return { ok: true, vorgang: existing, replayed: true };
  }

  const draft = getOrderDraftById(draftId);
  if (!draft) return { ok: false, reason: 'draft_not_found' };
  const blockers = getOrderDraftBlockers(draft);
  if (blockers.length > 0) return { ok: false, reason: 'blocked', blockers };

  const supabase = client ?? getSupabaseClient();
  const state = buildPersistedStateSnapshot();
  const workspaceId = resolveCloudWorkspaceId(state).trim();
  if (!supabase || !workspaceId || state.syncClient?.syncPolicy !== 'cloud_ready') {
    return { ok: false, reason: 'cloud_required' };
  }

  let data: unknown;
  try {
    const response = await supabase.rpc('create_workspace_order', {
      p_workspace_id: workspaceId,
      p_vorgang_id: draft.id,
      p_order: {
        customerId: draft.customerId ?? null,
        customerBilling: draft.customerBilling,
        title: draft.title,
        baustelle: draft.baustelle,
        taxStatus: draft.taxStatus,
        paymentTermsText: draft.paymentTermsText,
        introText: draft.introText,
        closingText: draft.closingText,
        positions: draft.positions.map((position) => ({
          id: position.id,
          description: position.description,
          plannedQuantity: position.plannedQuantity,
          unit: position.unit,
          unitPrice: position.unitPrice,
        })),
      },
    });
    if (response.error) {
      const message = response.error.message ?? 'Unbekannter Fehler';
      if (message.includes('Failed to fetch') || message.includes('Network')) {
        return { ok: false, reason: 'network', message };
      }
      return { ok: false, reason: 'server_rejected', message };
    }
    data = response.data;
  } catch (error) {
    // Der Entwurf bleibt — ein Retry mit derselben Kennung ist gefahrlos.
    return { ok: false, reason: 'network', message: error instanceof Error ? error.message : 'Unbekannter Fehler' };
  }

  if (!isRecord(data) || !isRecord(data.vorgang)) {
    return { ok: false, reason: 'server_rejected', message: 'Ungültige Server-Antwort' };
  }
  const row = mapWorkspaceVorgangRow(data.vorgang as unknown as WorkspaceVorgangRow);
  if (!row?.payload || !row.payload.orderNumber) {
    return { ok: false, reason: 'server_rejected', message: 'Server-Antwort ohne Auftragsnummer' };
  }

  const syncClient = getSyncClient();
  const vorgang = createVorgangFromCloudRow(
    row.payload,
    row.rowVersion,
    row.updatedAt,
    false,
    syncClient.deviceId,
    workspaceId,
  );
  const adopted = adoptServerVorgang(vorgang);
  // Die Serverzeile ist Wahrheit — sie darf nicht als eigene Änderung eingereiht
  // werden. Das muss vor dem ersten Speichern geschehen, sonst sieht der
  // Änderungszähler einen neuen Vorgang und reiht ihn ein.
  seedSyncChangeTrackerFromCurrentStores();
  // Erst wenn der Auftrag übernommen ist, darf der Entwurf verschwinden.
  deleteOrderDraft(draftId);
  persistAll();

  return { ok: true, vorgang: adopted, replayed: Boolean(data.replayed) };
}
