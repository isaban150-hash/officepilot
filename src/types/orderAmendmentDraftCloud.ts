/**
 * CLOUD-SYNC S6 — der Nachtragsentwurf als Cloud-Wahrheit.
 *
 * Der Entwurf bleibt lokal dort, wo er immer lag: in `Vorgang.orderAmendments`.
 * In die Cloud reist ausschliesslich sein fachlicher Inhalt. Nicht darin:
 *  - die Sequenz — sie entsteht erst bei der Bestätigung, serverseitig;
 *  - Bestätigungsabsicht, Kennung `oam-…`, Fingerprint, `rpcInput` und
 *    Wiederanlaufzustand — sie bleiben gerätelokal
 *    (`orderAmendmentConfirmIntentService`);
 *  - Sync-Metadaten und Konflikt — sie gehören dem Gerät.
 */
import type { OrderAmendmentDraftPosition } from './models';
import type { SyncMeta } from './sync';

/** Der fachliche Inhalt eines Nachtragsentwurfs in der Cloud. */
export interface OrderAmendmentDraftCloudPayload {
  id: string;
  vorgangId: string;
  title: string;
  reason?: string;
  positions: OrderAmendmentDraftPosition[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Der lokale Grabstein eines verworfenen Nachtragsentwurfs, solange die
 * Cloud das Verwerfen noch nicht bestätigt hat.
 *
 * Er liegt bewusst **neben** dem Vorgang (`AppPersistedState`), nicht in
 * `Vorgang.orderAmendments`: Dort stehen ausschliesslich lebende Entwürfe, und
 * kein Leser muss Grabsteine herausfiltern.
 */
export interface OrderAmendmentDraftTombstone {
  id: string;
  vorgangId: string;
  sync: SyncMeta;
}

/** Zeile aus `public.workspace_order_amendment_drafts` — exakt die Spalten der Migration. Endzustände ohne `payload`. */
export interface WorkspaceOrderAmendmentDraftRow {
  id?: string;
  workspace_id: string;
  client_draft_id: string;
  vorgang_id: string;
  status: string;
  payload?: Record<string, unknown>;
  consumed_client_amendment_id: string | null;
  row_version: number;
  deleted: boolean;
  deleted_at: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at: string;
}

/** Die Bindung der Nachtragsbestätigung an den Cloud-Entwurf (Server: atomarer Verbrauch). */
export interface OrderAmendmentDraftCloudBinding {
  sourceDraftId: string;
  expectedDraftRowVersion: number;
}
