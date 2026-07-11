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
  | 'document_memory'
  | 'proof_memory'
  | 'memory_relation'
  | 'paper_register_entry'
  | 'mail_import'
  | 'task'
  | 'expense'
  | 'vorgang'
  | 'vorgang_note'
  | 'communication_event'
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
}

export interface SyncableEntity {
  sync?: SyncMeta;
}
