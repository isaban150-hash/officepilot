/**
 * AUFTRAG-02C — die serverautoritative Anlage eines manuellen Auftrags.
 *
 * Ablauf:
 *   Entwurf → Nutzer bestätigt → `create_workspace_order` erzeugt in
 *   **einer** Transaktion den Auftrag (Vorgang, Status `beauftragt`, Nummer
 *   AU-JJJJ-NNNN aus derselben Jahressequenz wie Aufträge aus Angeboten,
 *   eingefrorener Snapshot, serverseitig gerechnete Summen) → der Client
 *   übernimmt die Serverzeile und erst **danach** verschwindet der Entwurf.
 *
 * Idempotenz: Die Entwurfskennung ist die Vorgangskennung. Ein zweiter Aufruf
 * — Retry nach verlorener Antwort, Doppelklick — liefert denselben Auftrag
 * zurück, ohne zweite Nummer und ohne den bestätigten Stand zu überschreiben.
 *
 * CLOUD-SYNC S6 — mit freigegebenem Entwurfs-Sync ist die Anlage an den
 * Cloud-Entwurf gebunden (Kennung und erwartete Version); der Server
 * verbraucht ihn in derselben Transaktion. Ein Replay meldet nur dann Erfolg,
 * wenn genau dieser Entwurf in genau dieser Version den Auftrag erzeugt hat —
 * sonst heisst es ehrlich „bereits als Auftrag angelegt", und abweichende
 * Eingaben erscheinen nie still als übernommen. Ohne Freigabe bleibt alles
 * wie bisher; die Datenbank ohne S6-Migration kennt die Bindung nicht.
 *
 * Ohne Cloud gibt es keine Anlage (die Nummer wird zentral vergeben).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../lib/supabase';
import { buildPersistedStateSnapshot, persistAll, seedSyncChangeTrackerFromCurrentStores } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { getSyncClient } from '../sync/syncClientService';
import { runSyncFromUi } from '../sync/syncUiService';
import { adoptServerVorgang, getVorgangById } from '../vorgangService';
import { createVorgangFromCloudRow, mapWorkspaceVorgangRow, type WorkspaceVorgangRow } from '../vorgang/vorgangCloudService';
import {
  getOrderDraftBlockers,
  getOrderDraftById,
  isOrderDraftCloudSyncAllowed,
  removeConsumedOrderDraft,
  resolveOrderDraftCloudBinding,
  type OrderDraftCloudBindingResult,
} from './orderDraftService';
import type { Vorgang } from '../../types/models';

export type CreateOrderFailure =
  | { ok: false; reason: 'draft_not_found' }
  | { ok: false; reason: 'blocked'; blockers: string[] }
  | { ok: false; reason: 'cloud_required' }
  | { ok: false; reason: 'server_rejected'; message: string }
  | { ok: false; reason: 'network'; message: string }
  /** CLOUD-SYNC S6 — der Entwurf ist noch nicht vollständig in der Cloud. */
  | { ok: false; reason: 'draft_not_synced' }
  /** CLOUD-SYNC S6 — offener Konflikt oder eine andere Entwurfsversion in der Cloud. */
  | { ok: false; reason: 'draft_conflict' }
  /** CLOUD-SYNC S6 — der Entwurf wurde auf einem anderen Gerät verworfen. */
  | { ok: false; reason: 'draft_ended' }
  /**
   * CLOUD-SYNC S6 — aus dieser Entwurfskennung ist bereits ein Auftrag
   * entstanden, aber nicht nachweislich aus genau diesem Stand. Der Auftrag
   * bleibt kanonisch; kein Erfolg, kein zweiter Auftrag.
   */
  | { ok: false; reason: 'already_created'; vorgangId: string; orderNumber?: string };

export type CreateOrderResult = { ok: true; vorgang: Vorgang; replayed: boolean } | CreateOrderFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * CLOUD-SYNC S6 — „Erst den Entwurf zur Ruhe bringen" (Muster aus S5): Trägt er
 * noch eine nicht übertragene Änderung, läuft genau ein Sync-Lauf, danach
 * entscheidet die Prüfung.
 */
async function prepareOrderDraftBinding(draftId: string): Promise<OrderDraftCloudBindingResult> {
  const first = resolveOrderDraftCloudBinding(draftId);
  if (first.ok || first.reason !== 'draft_not_synced') return first;
  try {
    await runSyncFromUi();
  } catch {
    /* die Prüfung unten entscheidet */
  }
  return resolveOrderDraftCloudBinding(draftId);
}

/** Der nächste Abzug bringt den Endzustand des Entwurfs und den Auftrag — ohne auf ihn zu warten. */
function refreshInBackground(): void {
  void runSyncFromUi().catch(() => undefined);
}

export async function createOrderFromDraftWithCloud(
  draftId: string,
  client?: SupabaseClient | null,
): Promise<CreateOrderResult> {
  const cloudDrafts = isOrderDraftCloudSyncAllowed();

  // Der Auftrag existiert bereits (eigene Antwort verloren oder über Pull adoptiert).
  const existing = getVorgangById(draftId);
  if (existing?.orderNumber) {
    if (!cloudDrafts) {
      removeConsumedOrderDraft(draftId);
      return { ok: true, vorgang: existing, replayed: true };
    }
    /*
     * CLOUD-SYNC S6 — ob genau dieser Entwurfsstand den Auftrag erzeugt hat,
     * weiss hier niemand; der Abgleich mit dem verbrauchten Cloud-Entwurf
     * klärt das. Kein „Erfolg" mit womöglich abweichendem Inhalt.
     */
    return { ok: false, reason: 'already_created', vorgangId: existing.id, orderNumber: existing.orderNumber };
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

  let binding: { clientDraftId: string; expectedDraftRowVersion: number } | null = null;
  if (cloudDrafts) {
    const prepared = await prepareOrderDraftBinding(draftId);
    if (!prepared.ok) {
      /*
       * Der Sync-Lauf kann gerade erst gezeigt haben, dass aus diesem Entwurf
       * anderswo schon der Auftrag wurde (der Entwurf ist dann verbraucht oder
       * steht mit dieser Abweichung da). Das ist kein „verworfen" und kein
       * offener Abgleich: Es gibt den Auftrag — und keinen zweiten.
       */
      const created = getVorgangById(draftId);
      if (created?.orderNumber) {
        return { ok: false, reason: 'already_created', vorgangId: created.id, orderNumber: created.orderNumber };
      }
      return { ok: false, reason: prepared.reason };
    }
    binding = prepared.binding;
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
      // CLOUD-SYNC S6 — nur mit Bindung; ohne bleibt der Aufruf exakt der bisherige.
      ...(binding
        ? { p_client_draft_id: binding.clientDraftId, p_expected_draft_row_version: binding.expectedDraftRowVersion }
        : {}),
    });
    if (response.error) {
      const message = response.error.message ?? 'Unbekannter Fehler';
      if (message.includes('Failed to fetch') || message.includes('Network')) {
        return { ok: false, reason: 'network', message };
      }
      /* CLOUD-SYNC S6 — Befunde der Entwurfsbindung: nichts wurde angelegt, keine Nummer verbraucht. */
      if (message.includes('order_draft_already_consumed')) {
        /*
         * Den Auftrag gleich holen: Der Weg „Zum Auftrag" soll ihn schon
         * finden — mit seiner Nummer. Scheitert der Abgleich, bleibt es beim
         * Befund; die Auftragsseite lädt ihn dann nach.
         */
        await runSyncFromUi().catch(() => undefined);
        const created = getVorgangById(draft.id);
        return {
          ok: false,
          reason: 'already_created',
          vorgangId: draft.id,
          ...(created?.orderNumber ? { orderNumber: created.orderNumber } : {}),
        };
      }
      if (message.includes('order_draft_discarded')) {
        refreshInBackground();
        return { ok: false, reason: 'draft_ended' };
      }
      if (message.includes('order_draft_version_conflict')) {
        refreshInBackground();
        return { ok: false, reason: 'draft_conflict' };
      }
      if (
        message.includes('order_draft_not_found') ||
        message.includes('order_draft_binding_invalid') ||
        message.includes('order_draft_consume_failed')
      ) {
        return { ok: false, reason: 'draft_not_synced' };
      }
      return { ok: false, reason: 'server_rejected', message };
    }
    data = response.data;
  } catch (error) {
    // Der Entwurf bleibt — ein Retry mit derselben Kennung (und derselben Bindung) ist gefahrlos.
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
  /*
   * Erst wenn der Auftrag übernommen ist, darf der Entwurf verschwinden — als
   * verbrauchter Entwurf, ohne Grabstein und ohne Löschauftrag: Mit Bindung
   * hat der Server ihn bereits in derselben Transaktion verbraucht.
   */
  removeConsumedOrderDraft(draftId);
  persistAll();

  return { ok: true, vorgang: adopted, replayed: Boolean(data.replayed) };
}
