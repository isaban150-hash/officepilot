/**
 * CLOUD-SYNC S5 — der fachliche Kern eines Rechnungsentwurfs als Cloud-Wahrheit.
 *
 * Hybrid: Die IndexedDB (`officepilot-invoice-drafts`) bleibt die sofortige,
 * dauerhafte lokale Schreibstelle. In die Cloud reist ausschliesslich der
 * fachliche Kern — die Eingaben des Nutzers und die eingefrorenen Snapshots.
 *
 * Nicht im Kern:
 *  - was aus vorhandener Cloud-Wahrheit neu abgeleitet wird (Plan-, Ist-,
 *    abgerechnete und offene Menge je Position, Abschlagsabzüge) — das
 *    leistet schon heute `refreshDraftOrderProjection` bei jedem Laden;
 *  - die Anzeige „ENTWURF" anstelle einer Nummer — eine Nummer gibt es erst bei
 *    der Freigabe;
 *  - alles Gerätelokale: Umschlag, lokale Revision, Hash, Freigabejournal,
 *    Freigabekontext, §13b-Bestätigung, UI-Zustand und das Legacy-Logo
 *    `companySnapshot.logoDataUrl`.
 */
import type {
  AbschlagDeduction,
  InvoiceDocumentType,
  InvoiceDraft,
  InvoiceDraftPosition,
} from './models';
import type { SyncMeta } from './sync';

/** Positionskern: ohne die Auftragsprojektion. */
export type InvoiceDraftCloudPosition = Omit<
  InvoiceDraftPosition,
  'plannedQuantity' | 'executedQuantity' | 'billedQuantity' | 'openQuantity'
>;

/** Der fachliche Kern — genau das, was Client B für eine korrekte Fortsetzung braucht. */
export type InvoiceDraftCloudCore = Omit<
  InvoiceDraft,
  'positions' | 'previousAbschlagDeductions' | 'invoiceNumberPreview'
> & {
  positions: InvoiceDraftCloudPosition[];
};

/** Die beiden Zustände, die nur der Server kennt: aktiv oder zur Rechnung geworden. */
export type InvoiceDraftCloudStatus = 'active' | 'finalized';

/**
 * Was ein anderes Gerät mit demselben Entwurf getan hat, während hier ein
 * eigener, noch nicht übertragener Stand lag. Bewusst **beide** Stände: der
 * eigene liegt in der IndexedDB, der fremde hier — nichts wird still verworfen.
 *
 *  - `version`   — der Entwurf wurde anderswo geändert;
 *  - `deleted`   — er wurde anderswo verworfen;
 *  - `finalized` — er wurde anderswo zur Rechnung;
 *  - `slot`      — für denselben Vorgang und dieselbe Rechnungsart gibt es
 *                  bereits einen anderen aktiven Entwurf (zwei offline
 *                  angelegte Entwürfe).
 */
export type InvoiceDraftCloudConflictKind = 'version' | 'deleted' | 'finalized' | 'slot';

export interface InvoiceDraftCloudRemoteState {
  rowVersion: number;
  status: InvoiceDraftCloudStatus;
  deleted: boolean;
  core: InvoiceDraftCloudCore | null;
  finalizedClientInvoiceId?: string;
}

export interface InvoiceDraftCloudConflict {
  kind: InvoiceDraftCloudConflictKind;
  detectedAt: string;
  /** Der Serverstand des eigenen Entwurfs (nicht bei `slot`). */
  remote?: InvoiceDraftCloudRemoteState;
  /** Nur bei `slot`: die Kennung des anderen aktiven Entwurfs in diesem Slot. */
  slotDraftId?: string;
}

/**
 * Rein lokal: welcher IndexedDB-Stand zuletzt mit dem Spiegel übereinstimmte.
 * Ohne diese Basis wäre „Cloud neuer, lokal unverändert" nicht von „lokal
 * geändert" zu unterscheiden — und genau dort entstünde ein stilles
 * Überschreiben in die eine oder andere Richtung.
 */
export interface InvoiceDraftCloudLocalLink {
  /** SHA-256 des IndexedDB-Rohtexts, der zuletzt gespiegelt oder übernommen wurde. */
  draftSha256: string;
  /** Inhaltsschlüssel des fachlichen Kerns zu diesem Zeitpunkt. */
  coreKey: string;
  /**
   * Rang des lokalen Datensatzes: seine Linie (Anlagezeitpunkt) und Revision.
   * Der Spiegel folgt nur einem jüngeren Stand — ein veralteter Editor (zweiter
   * Tab, verwaiste Instanz) kann ihn weder zurücksetzen noch mit einem
   * gleichrangigen Stand hin- und herschreiben.
   */
  recordCreatedAt?: string;
  revision?: number;
}

/**
 * Der Workspace-Spiegel eines Cloud-Entwurfs (`AppPersistedState.invoiceDrafts`).
 *
 * `sync.version` ist die Serverversion (`row_version`), `sync.deleted` der
 * Grabstein „verworfen". `localLink` und `conflict` sind gerätelokal: Sie
 * stehen weder im Inhaltsschlüssel noch im Push.
 */
export interface InvoiceDraftCloudEntity {
  id: string;
  vorgangId: string | null;
  invoiceType: InvoiceDocumentType;
  status: InvoiceDraftCloudStatus;
  /** `null` nur bei einem Grabstein ohne Fachinhalt. */
  core: InvoiceDraftCloudCore | null;
  finalizedClientInvoiceId?: string;
  localLink?: InvoiceDraftCloudLocalLink;
  conflict?: InvoiceDraftCloudConflict;
  sync?: SyncMeta;
}

/** Zeile aus `public.workspace_invoice_drafts` — exakt die Spalten der Migration. */
export interface WorkspaceInvoiceDraftRow {
  id?: string;
  workspace_id: string;
  client_draft_id: string;
  vorgang_id: string | null;
  invoice_type: string;
  status: string;
  payload: Record<string, unknown>;
  finalized_client_invoice_id: string | null;
  row_version: number;
  deleted: boolean;
  deleted_at: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at: string;
}

/** Die Bindung der Freigabe an den Cloud-Entwurf (Server: atomarer Verbrauch). */
export interface InvoiceDraftCloudBinding {
  clientDraftId: string;
  expectedDraftRowVersion: number;
}

export type { AbschlagDeduction };
