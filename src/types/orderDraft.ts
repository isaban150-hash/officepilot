import type { CustomerBilling, OrderUnit, TaxStatus } from './models';
import type { SyncMeta } from './sync';
import type { DraftCloudConflict } from './draftCloud';

/**
 * AUFTRAG-02C — der Auftragsentwurf.
 *
 * Ein Entwurf ist **kein** Auftrag: kein Vorgang, keine Auftragsnummer. Er
 * existiert nur so lange, bis der Nutzer den Auftrag verbindlich anlegt —
 * danach ist die Serverzeile des Auftrags die Wahrheit und der Entwurf ist
 * verbraucht.
 *
 * CLOUD-SYNC S6 — lokal liegt er weiterhin in `AppPersistedState.orderDrafts`.
 * Mit freigegebenem Entwurfs-Sync reist sein fachlicher Inhalt
 * (`OrderDraftCloudPayload`) über die bestehende Kette in die Cloud.
 *
 * `id` ist zugleich die spätere Vorgangskennung und damit der
 * Idempotenzschlüssel für `create_workspace_order`: Sie entsteht einmal beim
 * Anlegen des Entwurfs und überlebt Wiederaufnahme, Retry und Absturz.
 */
export interface OrderDraftPosition {
  id: string;
  description: string;
  plannedQuantity: number;
  unit: OrderUnit;
  unitPrice: number;
}

export interface OrderDraft {
  /** Zugleich die spätere Vorgangskennung (`v-…`) und der Idempotenzschlüssel. */
  id: string;
  workspaceId: string;
  customerId?: string;
  customerBilling: CustomerBilling;
  title: string;
  baustelle: string;
  positions: OrderDraftPosition[];
  taxStatus: TaxStatus;
  paymentTermsText: string;
  introText?: string;
  closingText?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * CLOUD-SYNC S6 — Serverstand (`row_version`) und Grabstein „verworfen".
   * Fehlt, solange der Entwurf nie mit der Cloud abgeglichen wurde.
   */
  sync?: SyncMeta;
  /** CLOUD-SYNC S6 — gerätelokal: ein offener Konflikt. Nie im Inhaltsschlüssel, nie im Push. */
  conflict?: DraftCloudConflict<OrderDraftCloudPayload>;
}

/**
 * CLOUD-SYNC S6 — der fachliche Inhalt eines Auftragsentwurfs in der Cloud.
 *
 * Ohne `workspaceId` (der Workspace ist der Scope der Zeile, keine
 * Inhaltsangabe), ohne Sync-Metadaten und ohne Konflikt. Keine Auftrags- oder
 * Vorgangsnummer: Sie entstehen ausschliesslich in `create_workspace_order`.
 */
export interface OrderDraftCloudPayload {
  id: string;
  customerId?: string;
  customerBilling: CustomerBilling;
  title: string;
  baustelle: string;
  positions: OrderDraftPosition[];
  taxStatus: TaxStatus;
  paymentTermsText: string;
  introText?: string;
  closingText?: string;
  createdAt: string;
  updatedAt: string;
}

/** Zeile aus `public.workspace_order_drafts` — exakt die Spalten der Migration. Endzustände ohne `payload`. */
export interface WorkspaceOrderDraftRow {
  id?: string;
  workspace_id: string;
  client_draft_id: string;
  status: string;
  payload?: Record<string, unknown>;
  consumed_vorgang_id: string | null;
  row_version: number;
  deleted: boolean;
  deleted_at: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at: string;
}

/** Die Bindung der Auftragsanlage an den Cloud-Entwurf (Server: atomarer Verbrauch). */
export interface OrderDraftCloudBinding {
  clientDraftId: string;
  expectedDraftRowVersion: number;
}

export interface OrderDraftInput {
  customerId?: string;
  customerBilling: CustomerBilling;
  title: string;
  baustelle: string;
  positions: OrderDraftPosition[];
  taxStatus: TaxStatus;
  paymentTermsText: string;
  introText?: string;
  closingText?: string;
}

/** Gründe, aus denen ein Entwurf noch nicht verbindlich angelegt werden kann. */
export type OrderDraftBlocker =
  | 'customer_missing'
  | 'title_missing'
  | 'positions_missing'
  | 'position_invalid';
