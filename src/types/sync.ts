/** CLOUD-01B – Sync-Metadaten (lokal, ohne Netzwerk) */

export type SyncPolicy = 'disabled' | 'local_only' | 'cloud_ready';

export type SyncEntityType =
  | 'workspace'
  | 'workspace_member'
  | 'workspace_settings'
  | 'company_setup'
  | 'company_profile'
  | 'inbox_item'
  | 'document'
  | 'document_file'
  | 'document_file_binding'
  | 'document_work_result'
  /** FINANZ-CORE-DURABILITY-01C — Zahlung einer Ausgabe (append-only Cloud-Wahrheit). */
  | 'expense_payment'
  | 'document_memory'
  | 'proof_memory'
  | 'memory_relation'
  | 'paper_register_entry'
  | 'mail_import'
  | 'task'
  | 'expense'
  | 'vorgang'
  | 'customer'
  | 'vorgang_note'
  | 'communication_event'
  /** CLOUD-DURABILITY-CORE-01D — Nachweis einer übergebenen Zahlungserinnerung/Mahnung (append-only). */
  | 'dunning_documentation'
  /** BRIEFE-01B — ausgehendes Geschäftsschreiben als eigenes Dokument. */
  | 'business_letter'
  /** ANGEBOT-01B — eigenes Angebot des Betriebs. */
  | 'offer'
  /**
   * STEUERBERATER-06A — die Kontierung eines Belegs.
   *
   * Eigene Entitaet und kein Feld am Beleg: Sie hat einen eigenen
   * Lebenszyklus (vorgeschlagen, geprueft, bestaetigt), eine eigene
   * Bestaetigungsspur und darf den Beleg selbst nie veraendern.
   */
  | 'accounting_assignment'
  /**
   * STEUERBERATER-06B — eine Abschlussrevision eines Monats.
   *
   * Eigene Entitaet, weil sie einen eigenen Lebenszyklus hat und
   * **angehaengt** wird: Eine bestehende Revision wird nie ueberschrieben,
   * nur um ihre Oeffnungsspur ergaenzt.
   */
  | 'accounting_period_closure'
  | 'knowledge_fact';

export type SyncOutboxOperation = 'create' | 'update' | 'delete';

export type SyncOutboxStatus = 'pending' | 'blocked' | 'failed' | 'completed' | 'error';

export type SyncState =
  | 'idle'
  | 'checking'
  | 'uploading'
  | 'downloading'
  | 'merging'
  | 'synced'
  | 'offline'
  | 'error';

export type MergeResolution = 'noop' | 'local_wins' | 'remote_wins' | 'union' | 'conflict';

export interface SyncHubEntity {
  entityType: SyncEntityType;
  entityId: string;
  payload: unknown;
  sync: SyncMeta;
}

export interface MergeEntityResult<T> {
  entity: T | null;
  resolution: MergeResolution;
  conflict: boolean;
}

export interface SyncSimulationReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  pushCount: number;
  pullCount: number;
  mergedEntityCount: number;
  conflictCount: number;
  errorCount: number;
  completedOutboxCount: number;
  retryAttempts?: number;
  uploadCount?: number;
  downloadCount?: number;
  syncedEntities: Array<{ entityType: SyncEntityType; entityId: string; resolution: MergeResolution }>;
  conflicts: Array<{ entityType: SyncEntityType; entityId: string; resolution: MergeResolution }>;
  errors: Array<{ outboxId: string; message: string }>;
}

export interface SyncCoordinatorReport extends SyncSimulationReport {
  retryAttempts: number;
  uploadCount: number;
  downloadCount: number;
}

export interface VirtualSyncDevice {
  name: string;
  deviceId: string;
  workspaceId: string;
  state: import('./models').AppPersistedState;
  syncState: SyncState;
}

export interface SyncMeta {
  updatedAt: string;
  version: number;
  deleted: boolean;
  deletedAt?: string;
  deviceId: string;
  workspaceId: string;
  payloadHash?: string;
}

export interface SyncClientConfig {
  deviceId: string;
  workspaceId: string;
  serverWorkspaceId?: string;
  createdAt: string;
  migratedAt?: string;
  syncPolicy: SyncPolicy;
  cloudProvisionedAt?: string;
}

export interface SyncOutboxEntry {
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOutboxOperation;
  version: number;
  queuedAt: string;
  retryCount: number;
  status: SyncOutboxStatus;
  blockedReason?: string;
  /**
   * SYNC-DURABILITY-HARDENING-01G4 — was zuletzt tatsächlich abgeschickt wurde.
   *
   * Geht die Bestätigung eines Schreibvorgangs verloren, ist der Server weiter
   * als der Client. Beim Wiederanlauf muss unterscheidbar sein, ob der neuere
   * Serverstand der eigene verlorene Schreibvorgang ist oder die Arbeit eines
   * anderen Geräts. Der **aktuelle** lokale Stand taugt dafür nicht: Der Nutzer
   * kann inzwischen weitergearbeitet haben. Deshalb wird der abgeschickte Stand
   * am Auftrag vermerkt und bleibt dort, bis er bestätigt ist.
   */
  sentContentKey?: string;
  /** Ob der abgeschickte Schreibvorgang eine Löschung war. */
  sentDeleted?: boolean;
  /** Wann er abgeschickt wurde — nur zur Nachvollziehbarkeit. */
  sentAt?: string;
  /**
   * FINANZ-SYNC-BLOCKER-01B — warum dieser Auftrag zuletzt nicht durchkam.
   *
   * Die Sync-Seite konnte den Fehlschlag bisher nur zählen, nicht benennen:
   * Der Grund stand allein im Lauf-Report und war nach einem Neuladen weg. Er
   * gehört an den Auftrag — dort überlebt er den Reload und lässt sich der
   * Zeile zuordnen, die ihn betrifft.
   *
   * Hier steht der rohe Servertext. Die Oberfläche übersetzt ihn in
   * Nutzersprache, statt ihn vorzuzeigen.
   */
  lastErrorMessage?: string;
  lastErrorAt?: string;
  /** Ob ein erneuter Versuch überhaupt Aussicht auf Erfolg hat. */
  lastErrorRetryable?: boolean;
}

export interface SyncableEntity {
  sync?: SyncMeta;
}
