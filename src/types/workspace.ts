import type { SyncMeta } from './sync';
import type { WorkspaceVorgangRow } from '../services/vorgang/vorgangCloudService';
import type { WorkspaceCustomerRow } from '../services/customer/customerCloudService';
import type { WorkspaceVorgangNoteRow } from '../services/vorgang/vorgangNoteCloudService';
import type { WorkspaceBusinessLetterRow } from '../services/letter/businessLetterCloudService';
import type { WorkspaceOfferRow } from '../services/offer/offerCloudService';
import type { WorkspaceTaskRow } from '../services/task/taskCloudService';
import type { WorkspaceDunningDocumentationRow } from '../services/invoice/dunningDocumentationCloudService';

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export type WorkspaceMemberStatus = 'active' | 'invited' | 'removed';

export interface Workspace {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  sync?: SyncMeta;
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  status: WorkspaceMemberStatus;
  createdAt: string;
  updatedAt: string;
  sync?: SyncMeta;
}

/** Ein Feld, das lokal und in der Cloud unterschiedlich gesetzt ist. */
export interface WorkspaceSettingsFieldConflict {
  readonly key: string;
  readonly localValue: unknown;
  readonly cloudValue: unknown;
}

/**
 * Ein festgehaltener, noch nicht entschiedener Konflikt.
 *
 * `fields` trägt zu jedem strittigen Schlüssel **beide** Werte. Damit lässt
 * sich die Entscheidung auch nach einem Neustart noch ausführen, ohne dass ein
 * erneuter Abgleich nötig wäre.
 */
export interface WorkspaceSettingsConflictState {
  readonly fields: readonly WorkspaceSettingsFieldConflict[];
  readonly detectedAt: string;
}

export interface WorkspaceSettings {
  workspaceId: string;
  settings: Record<string, unknown>;
  version: number;
  updatedAt: string;
  updatedBy?: string;
  sync?: SyncMeta;
  /**
   * FINANZ-SYNC-BLOCKER-01F — der ungelöste Feldkonflikt, falls einer ansteht.
   *
   * Er hängt **am Einstellungsobjekt**, nicht neben ihm. In 01B lag er in einer
   * Modulvariable und war nach jedem Neuladen weg — die Sync-Seite sagte dann
   * weiter „bitte entscheiden" (das kommt aus dem blockierten Sendeauftrag, der
   * gespeichert ist), bot aber keine Entscheidung mehr an. Beides muss
   * dieselbe Lebensdauer haben.
   *
   * Hier stehen **beide** Stände. Nur deshalb darf die Oberfläche sagen, dass
   * bis zur Entscheidung nichts verloren geht.
   *
   * Geht nie in die Cloud: `buildWorkspaceSettingsCloudPayload` sendet
   * ausschliesslich `settings`.
   */
  conflict?: WorkspaceSettingsConflictState;
  /**
   * FINANZ-SYNC-BLOCKER-01B — welche Felder hier bewusst geändert und noch
   * nicht übertragen wurden.
   *
   * `settings` ist ein offener Beutel: Steht dort ein Wert, sagt er nicht, ob
   * ihn dieses Gerät gesetzt hat oder ob er aus der Cloud kam. Ohne diese
   * Angabe liesse sich bei einem Konflikt nur raten — entweder der neuere
   * Cloud-Stand überschreibt die eigene Änderung, oder ein lokales Objekt mit
   * einem einzigen Feld überschreibt alles, was die Cloud sonst noch hat.
   * Beides ist Datenverlust.
   *
   * Deshalb merkt sich der Schreibweg, welche Schlüssel angefasst wurden.
   * Genau die überleben eine Zusammenführung; alles andere kommt aus der
   * Cloud. Nach erfolgreicher Übertragung ist die Liste leer.
   *
   * Fehlt sie (Altbestand vor diesem Block), wird **nicht** geraten — dann
   * greift die vorsichtigere Regel in `workspaceSettingsConflictService`.
   */
  pendingKeys?: string[];
}

/** Server-side row metadata for singleton workspace entities (setup, profile). */
export interface WorkspaceCloudRowMeta {
  rowVersion: number;
  updatedAt: string;
  updatedBy?: string;
}

export interface WorkspaceSyncPullPayload {
  workspace: Workspace | null;
  members: WorkspaceMember[];
  settings: WorkspaceSettings | null;
  setupPayload: Record<string, unknown> | null;
  setupRowVersion: number;
  setupUpdatedAt: string | null;
  companyProfilePayload: Record<string, unknown> | null;
  companyProfileRowVersion: number;
  companyProfileUpdatedAt: string | null;
  vorgaenge: WorkspaceVorgangRow[];
  /**
   * PRODUCT-FOUNDATION-03A-C1 — enthält bewusst auch Grabsteine
   * (`deleted = true`). Der Backfill braucht sie, um eine anderswo gelöschte
   * Kunden-ID nicht erneut anzulegen.
   */
  customers: WorkspaceCustomerRow[];
  /**
   * CLOUD-DURABILITY-CORE-01B — ebenfalls inklusive Grabsteine: Ohne sie käme
   * eine auf einem anderen Gerät gelöschte Notiz hier nie an, und der Backfill
   * lüde sie wieder hoch.
   */
  vorgangNotes: WorkspaceVorgangNoteRow[];
  /** BRIEFE-01B — Geschaeftsschreiben. */
  businessLetters: WorkspaceBusinessLetterRow[];
  /** ANGEBOT-01B — eigene Angebote, inklusive Grabsteine. */
  offers: WorkspaceOfferRow[];
  /**
   * CLOUD-DURABILITY-CORE-01C — ebenfalls inklusive Grabsteine: Sie tragen auch
   * das Ergebnis der Dedupe-Auflösung auf das zweite Gerät.
   */
  tasks: WorkspaceTaskRow[];
  /**
   * CLOUD-DURABILITY-CORE-01D — Mahnnachweise. Append-only: keine Grabsteine,
   * die mitreisen müssten.
   */
  dunningDocumentations: WorkspaceDunningDocumentationRow[];
}

export interface EnsurePersonalWorkspaceResult {
  success: boolean;
  workspaceId?: string;
  workspace?: Workspace;
  member?: WorkspaceMember;
  /** True only when the server created the workspace in this call. */
  created?: boolean;
  error?: string;
  errorCode?: 'auth' | 'rls' | 'network' | 'unknown';
}
