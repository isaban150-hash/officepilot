import type { AppPersistedState } from '../../types/models';
import type { SyncEntityType, SyncOutboxOperation, SyncableEntity } from '../../types/sync';
import { listEntitiesByType } from './syncEntityRegistry';
import { enqueueSyncOutbox } from './syncOutboxService';

export const TRACKED_SYNC_ENTITY_TYPES: SyncEntityType[] = [
  'inbox_item',
  'document',
  'document_memory',
  'proof_memory',
  'memory_relation',
  'paper_register_entry',
  'mail_import',
  'task',
  'expense',
  'vorgang',
  'vorgang_note',
  'communication_event',
  'knowledge_fact',
];

interface EntitySyncFingerprint {
  version: number;
  deleted: boolean;
  updatedAt: string;
  contentKey: string;
}

interface TrackedEntityRef {
  entityType: SyncEntityType;
  entityId: string;
  fingerprint: EntitySyncFingerprint;
}

let trackedFingerprints: Map<string, EntitySyncFingerprint> | null = null;

function entityKey(entityType: SyncEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function stripSyncField(entity: SyncableEntity & { id: string }): Record<string, unknown> {
  const { sync: _sync, ...rest } = entity as unknown as Record<string, unknown>;
  return rest;
}

function buildContentKey(entity: SyncableEntity & { id: string }): string {
  return JSON.stringify(stripSyncField(entity));
}

function buildFingerprint(entity: SyncableEntity & { id: string }): EntitySyncFingerprint {
  const sync = entity.sync;
  return {
    version: sync?.version ?? 0,
    deleted: sync?.deleted ?? false,
    updatedAt: sync?.updatedAt ?? '',
    contentKey: buildContentKey(entity),
  };
}

function collectTrackedEntities(state: AppPersistedState): Map<string, TrackedEntityRef> {
  const refs = new Map<string, TrackedEntityRef>();

  for (const entityType of TRACKED_SYNC_ENTITY_TYPES) {
    for (const entity of listEntitiesByType(state, entityType)) {
      refs.set(entityKey(entityType, entity.id), {
        entityType,
        entityId: entity.id,
        fingerprint: buildFingerprint(entity),
      });
    }
  }

  return refs;
}

function fingerprintChanged(
  previous: EntitySyncFingerprint,
  current: EntitySyncFingerprint,
): boolean {
  return (
    previous.version !== current.version ||
    previous.deleted !== current.deleted ||
    previous.updatedAt !== current.updatedAt ||
    previous.contentKey !== current.contentKey
  );
}

function resolveOperation(
  previous: EntitySyncFingerprint | undefined,
  current: EntitySyncFingerprint,
): SyncOutboxOperation {
  if (current.deleted && (!previous || !previous.deleted)) {
    return 'delete';
  }
  if (!previous) {
    return 'create';
  }
  return 'update';
}

function resolveVersion(fingerprint: EntitySyncFingerprint): number {
  return Math.max(1, fingerprint.version);
}

export function resetSyncChangeTrackerFromState(state: AppPersistedState): void {
  trackedFingerprints = new Map(
    [...collectTrackedEntities(state).entries()].map(([key, ref]) => [key, ref.fingerprint]),
  );
}

export function resetSyncChangeTrackerForTests(): void {
  trackedFingerprints = null;
}

export function trackPersistedChanges(state: AppPersistedState): void {
  const currentEntities = collectTrackedEntities(state);

  if (trackedFingerprints === null) {
    trackedFingerprints = new Map(
      [...currentEntities.entries()].map(([key, ref]) => [key, ref.fingerprint]),
    );
    return;
  }

  for (const [key, ref] of currentEntities.entries()) {
    const previous = trackedFingerprints.get(key);
    if (previous && !fingerprintChanged(previous, ref.fingerprint)) {
      continue;
    }

    enqueueSyncOutbox({
      entityType: ref.entityType,
      entityId: ref.entityId,
      operation: resolveOperation(previous, ref.fingerprint),
      version: resolveVersion(ref.fingerprint),
    });
  }

  trackedFingerprints = new Map(
    [...currentEntities.entries()].map(([key, ref]) => [key, ref.fingerprint]),
  );
}

export function getSyncChangeTrackerSnapshotForTests(): Map<string, EntitySyncFingerprint> {
  return new Map(trackedFingerprints ?? []);
}
