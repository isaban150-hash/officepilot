/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P1 — Typen des lokalen
 * Rechnungsentwurfsspeichers.
 *
 * Der Kern ist bewusst frei von React, Autosave, Cloud und Sync. Er kennt nur
 * einen versionierten Datensatz, eine ausdrücklich übergebene Identität und
 * einen Revisionsvertrag.
 *
 * `recordKey` und `draftId` sind verschiedene Dinge:
 *  - `recordKey` findet den aktuellen Entwurf für Scope, Vorgang und
 *    Rechnungsart wieder.
 *  - `draftId` ist die unveränderliche Client-Rechnungskennung genau dieses
 *    Entwurfs und wird beim Laden niemals neu erzeugt.
 */
import type { InvoiceDocumentType, InvoiceDraft } from './models';

export const INVOICE_DRAFT_RECORD_KIND = 'officepilot-invoice-draft' as const;
export const INVOICE_DRAFT_FORMAT_VERSION = 1 as const;

/**
 * `active` — laufender Entwurf, speicher- und verwerfbar.
 * `finalizing` — Freigabe begonnen; nicht mehr bearbeitbar, nicht löschbar.
 * `finalized` — Grabstein; bleibt bestehen, damit ein Reload zwischen
 *   Cloud-Erfolg und lokaler Nachbearbeitung denselben Stand nicht erneut als
 *   unfertigen Entwurf anbietet.
 */
export type InvoiceDraftRecordStatus = 'active' | 'finalizing' | 'finalized';

/**
 * Unveränderliche Finalisierungsidentität. Sie wird ausdrücklich übergeben —
 * dieser Kern führt keinen Cloud-Aufruf aus und erzeugt keine Kennungen.
 */
/**
 * 01P4E2B — Art des Abschlusses. `own` ist der bisherige Weg: die eigene
 * Operationskennung wurde selbst zur Rechnung. `resolved_to_existing` heißt,
 * dass ein anderes Gerät dieselbe fachliche Operation bereits abgeschlossen
 * hat und die dortige kanonische Rechnung übernommen wurde.
 *
 * **Rückwärtskompatibel:** ein Grabstein ohne `resolution` bedeutet `own` —
 * dort war `finalizedInvoiceId === clientInvoiceId` bereits erzwungen.
 */
export type InvoiceDraftFinalizationResolution = 'own' | 'resolved_to_existing';

export interface InvoiceDraftFinalization {
  clientInvoiceId: string;
  contentFingerprint: string;
  startedAt: string;
  /** Erst im Status `finalized` vorhanden. */
  finalizedAt?: string;
  finalizedInvoiceId?: string;
  archiveWarning?: boolean;
  /** Fehlend ⇒ `own`. Nur im Status `finalized` zulässig. */
  resolution?: InvoiceDraftFinalizationResolution;
  /** Nur bei `resolved_to_existing`: Zeilen-ID der kanonischen Cloud-Rechnung. */
  canonicalCloudInvoiceId?: string;
  /** Nur bei `resolved_to_existing`: ganze Zahl > 0. */
  canonicalRowVersion?: number;
}

/* -------------------------------------------------------------------------- */
/* 01P4A — Finalisierungsvorbereitung                                         */
/* -------------------------------------------------------------------------- */

export const INVOICE_DRAFT_PREPARATION_KIND =
  'officepilot-invoice-finalization-preparation' as const;

/**
 * Eigene Version, ausdrücklich unabhängig von `INVOICE_DRAFT_FORMAT_VERSION`:
 * die Vorbereitung darf sich weiterentwickeln, ohne den Umschlag des Entwurfs
 * zu berühren.
 */
export const INVOICE_DRAFT_PREPARATION_FORMAT_VERSION = 1 as const;

/**
 * Minimalvertrag der Rechnung im gespeicherten Request. Der Kern prüft nur
 * `id` und `type` — alles Weitere bleibt fachlich fremd und wird ausschließlich
 * als vollständiger Rohtext bewahrt, nie gekürzt und nie neu gebaut.
 */
export interface InvoiceDraftFinalizationRequestInvoice {
  id: string;
  type: InvoiceDocumentType;
}

/**
 * Der vollständige, bereits aufgebaute Cloud-Request. Bewusst der **ganze**
 * Eingabewert und nicht nur die Rechnung: die spätere Ausführung darf die
 * Request-Struktur nicht erneut erzeugen, weil ein Codeupdate sie verändern
 * könnte.
 */
export interface InvoiceDraftFinalizationRequest {
  workspaceId: string;
  vorgangId: string;
  clientInvoiceId: string;
  invoice: InvoiceDraftFinalizationRequestInvoice;
}

/**
 * Genau eine Hülle für Request **und** Freigabekontext. Beide werden gemeinsam
 * serialisiert und gemeinsam gehasht — zwei unabhängige Rohtexte könnten
 * später versehentlich aus verschiedenen Vorbereitungen kombiniert werden.
 *
 * `approvalContext` bleibt in diesem Sprint fachlich **opak**. Der Kern
 * behauptet ausdrücklich nicht, damit seien die UI-Bestätigungen bereits
 * vollständig modelliert; das definiert die spätere Schicht.
 */
export interface InvoiceDraftFinalizationPreparation {
  kind: typeof INVOICE_DRAFT_PREPARATION_KIND;
  formatVersion: typeof INVOICE_DRAFT_PREPARATION_FORMAT_VERSION;
  preparedAt: string;
  preparedFromRevision: number;
  sourceDraftSha256: string;
  contentFingerprint: string;
  request: InvoiceDraftFinalizationRequest;
  approvalContext: Record<string, unknown>;
}

/**
 * Vollständige Identität. Der Dienst ermittelt nichts selbst — weder den
 * aktiven Scope noch den Workspace. Der Aufrufer nennt beides ausdrücklich.
 */
export interface InvoiceDraftIdentity {
  sourceScopeKey: string;
  workspaceId: string;
  vorgangId: string;
  invoiceType: InvoiceDocumentType;
  draftId: string;
}

/**
 * Findet den gespeicherten Entwurf **ohne** bekannte `draftId` wieder — genau
 * die Lage nach einem vollständigen Reload. Die `draftId` stammt danach
 * ausschließlich aus dem geprüften Umschlag und wird nie neu erzeugt.
 */
export interface InvoiceDraftLocator {
  sourceScopeKey: string;
  workspaceId: string;
  vorgangId: string;
  invoiceType: InvoiceDocumentType;
}

export interface InvoiceDraftRecord {
  kind: typeof INVOICE_DRAFT_RECORD_KIND;
  formatVersion: typeof INVOICE_DRAFT_FORMAT_VERSION;
  recordKey: string;
  sourceScopeKey: string;
  workspaceId: string;
  vorgangId: string;
  invoiceType: InvoiceDocumentType;
  draftId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Vollständiger JSON-Rohtext des InvoiceDraft — nie gekürzt. */
  draftRawJson: string;
  draftSha256: string;
  status: InvoiceDraftRecordStatus;
  /** Nur bei `finalizing` und `finalized` vorhanden. */
  finalization?: InvoiceDraftFinalization;
  /**
   * Vollständiger JSON-Rohtext genau einer Vorbereitungshülle — nie gekürzt.
   * Optional, weil Bestandsdatensätze aus 01P1/01P2 ihn nicht besitzen; ein
   * `finalizing`- oder `finalized`-Datensatz ohne Vorbereitung bleibt gültig
   * lesbar, ist aber blockiert.
   */
  preparationRawJson?: string;
  preparationSha256?: string;
}

export type InvoiceDraftStorageFailure =
  | 'storage_unavailable'
  | 'storage_failed'
  | 'transaction_failed';

/**
 * 01P4A1 — Post-Commit-Vertrag.
 *
 * Die Kontrolllesung läuft grundsätzlich **nach** `transaction.oncomplete`.
 * Scheitert sie, ist die Schreibtransaktion bereits abgeschlossen. Dieser
 * Grund bedeutet deshalb ausdrücklich **nicht** „nicht gespeichert", sondern
 * „dauerhaft geschrieben, aber anschließend nicht verifiziert".
 *
 * Verbindlich für jeden Aufrufer:
 *  - Der neue Stand kann bereits dauerhaft vorhanden sein.
 *  - Der Schreibvorgang darf **nicht blind wiederholt** werden.
 *  - Es muss über Locator beziehungsweise vollständige Identität neu geladen
 *    werden.
 *  - Bei einer Finalisierung darf **niemals** eine neue `clientInvoiceId`
 *    entstehen.
 *  - Ein geladener `finalizing`-Datensatz bestimmt ausschließlich über seine
 *    gespeicherte Vorbereitung die Fortsetzung.
 *  - Ein geladener `finalized`-Datensatz ist ein terminaler Grabstein.
 *
 * Der Kern wiederholt von sich aus nichts und löscht nichts.
 */
export type InvoiceDraftPostCommitFailure = 'committed_but_unverified';

export type InvoiceDraftCreateFailure =
  | InvoiceDraftStorageFailure
  | 'invalid_identity'
  | 'invalid_draft'
  | 'already_exists'
  | InvoiceDraftPostCommitFailure;

export type InvoiceDraftLoadFailure =
  | InvoiceDraftStorageFailure
  | 'invalid_identity'
  | 'not_found'
  | 'unsupported_format'
  | 'corrupt'
  | 'identity_mismatch';

export type InvoiceDraftSaveFailure =
  | InvoiceDraftStorageFailure
  | 'invalid_identity'
  | 'invalid_draft'
  | 'not_found'
  | 'identity_mismatch'
  | 'conflict'
  | 'status_conflict'
  | InvoiceDraftPostCommitFailure;

export type InvoiceDraftDeleteFailure =
  | InvoiceDraftStorageFailure
  | 'invalid_identity'
  | 'not_found'
  | 'identity_mismatch'
  | 'conflict'
  | 'status_conflict';

export type InvoiceDraftFinalizationFailure =
  | InvoiceDraftStorageFailure
  | 'invalid_identity'
  | 'invalid_finalization'
  | 'not_found'
  | 'identity_mismatch'
  | 'unsupported_format'
  | 'conflict'
  | 'status_conflict'
  | 'finalization_mismatch'
  | 'invalid_preparation'
  | 'unsupported_preparation'
  | 'corrupt'
  | InvoiceDraftPostCommitFailure;

export type InvoiceDraftFinalizationResult =
  | { ok: true; record: InvoiceDraftRecord }
  | {
      ok: false;
      reason: InvoiceDraftFinalizationFailure;
      detail?: string;
      currentRevision?: number;
      currentStatus?: InvoiceDraftRecordStatus;
    };

export interface BeginInvoiceDraftFinalizationInput {
  identity: InvoiceDraftIdentity;
  expectedRevision: number;
  clientInvoiceId: string;
  contentFingerprint: string;
  /** Vollständiger Cloud-Request — wird unverändert und ungekürzt bewahrt. */
  request: InvoiceDraftFinalizationRequest;
  /** Fachlich opakes JSON-Objekt der späteren Freigabeschicht. */
  approvalContext: Record<string, unknown>;
  now?: string;
}

export type InvoiceDraftPreparationLoadFailure =
  | InvoiceDraftStorageFailure
  | 'invalid_identity'
  | 'not_found'
  | 'identity_mismatch'
  | 'unsupported_format'
  | 'conflict'
  | 'status_conflict'
  | 'corrupt'
  | 'invalid_preparation'
  | 'unsupported_preparation';

export type InvoiceDraftPreparationLoadResult =
  | {
      ok: true;
      record: InvoiceDraftRecord;
      preparation: InvoiceDraftFinalizationPreparation;
    }
  | {
      ok: false;
      reason: InvoiceDraftPreparationLoadFailure;
      detail?: string;
      currentRevision?: number;
      currentStatus?: InvoiceDraftRecordStatus;
    };

export interface LoadInvoiceDraftFinalizationPreparationInput {
  identity: InvoiceDraftIdentity;
  expectedRevision: number;
}

export interface CompleteInvoiceDraftFinalizationInput {
  identity: InvoiceDraftIdentity;
  expectedRevision: number;
  /** Muss exakt zum begonnenen Vorgang passen. */
  clientInvoiceId: string;
  contentFingerprint: string;
  finalizedInvoiceId: string;
  archiveWarning: boolean;
  now?: string;
}

/**
 * 01P4E2B — Auflösung einer lokal begonnenen Finalisierung auf eine bereits
 * vorhandene kanonische Cloud-Rechnung.
 *
 * **Vorbedingung des Aufrufers:** die kanonische Rechnung muss zuvor
 * nachweislich lokal dauerhaft persistiert worden sein. Der Kern prüft das
 * nicht und behauptet es nicht — er liest keinen Vorgangsspeicher.
 */
export interface ResolveInvoiceDraftFinalizationToExistingInput {
  identity: InvoiceDraftIdentity;
  expectedRevision: number;
  /** Die eigene Operationskennung B — bleibt unverändert. */
  clientInvoiceId: string;
  contentFingerprint: string;
  /** Die kanonische Rechnungskennung A. Muss von B abweichen. */
  finalizedInvoiceId: string;
  canonicalCloudInvoiceId: string;
  canonicalRowVersion: number;
  archiveWarning: boolean;
  now?: string;
}

export type InvoiceDraftCreateResult =
  | { ok: true; record: InvoiceDraftRecord }
  | { ok: false; reason: InvoiceDraftCreateFailure; detail?: string; currentRevision?: number };

export type InvoiceDraftLoadResult =
  | { ok: true; record: InvoiceDraftRecord; draft: InvoiceDraft }
  | { ok: false; reason: InvoiceDraftLoadFailure; detail?: string };

export type InvoiceDraftSaveResult =
  | { ok: true; record: InvoiceDraftRecord }
  | { ok: false; reason: InvoiceDraftSaveFailure; detail?: string; currentRevision?: number };

export type InvoiceDraftDeleteResult =
  | { ok: true; deletedRevision: number }
  | { ok: false; reason: InvoiceDraftDeleteFailure; detail?: string; currentRevision?: number };

export interface CreateInvoiceDraftRecordInput {
  identity: InvoiceDraftIdentity;
  draft: InvoiceDraft;
  /** Injizierbar, damit Tests ohne Uhrzeitabhängigkeit auskommen. */
  now?: string;
}

export interface SaveInvoiceDraftRecordInput {
  identity: InvoiceDraftIdentity;
  draft: InvoiceDraft;
  expectedRevision: number;
  now?: string;
}

export interface DeleteInvoiceDraftRecordInput {
  identity: InvoiceDraftIdentity;
  expectedRevision: number;
}
