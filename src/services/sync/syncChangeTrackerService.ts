import type { AppPersistedState } from '../../types/models';
import type { SyncEntityType, SyncOutboxOperation, SyncableEntity } from '../../types/sync';
import { listEntitiesByType } from './syncEntityRegistry';
import { enqueueSyncOutbox } from './syncOutboxService';
import { stripLogoFromCompanyProfile } from '../workspace/workspaceStore';
import { buildVorgangCloudContentKey } from '../vorgang/vorgangCloudService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { buildCloudEntityId } from '../workspace/workspaceSyncPayloadService';
import type { Vorgang } from '../../types/models';

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

export const TRACKED_CLOUD_SYNC_ENTITY_TYPES: SyncEntityType[] = [
  'workspace',
  'workspace_member',
  'workspace_settings',
  'company_setup',
  'company_profile',
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

function buildVorgangFingerprint(vorgang: Vorgang): EntitySyncFingerprint {
  const sync = vorgang.sync;
  return {
    version: sync?.version ?? 0,
    deleted: sync?.deleted ?? false,
    updatedAt: sync?.updatedAt ?? '',
    contentKey: buildVorgangCloudContentKey(vorgang),
  };
}

function collectTrackedEntities(state: AppPersistedState): Map<string, TrackedEntityRef> {
  const refs = new Map<string, TrackedEntityRef>();

  for (const entityType of TRACKED_SYNC_ENTITY_TYPES) {
    for (const entity of listEntitiesByType(state, entityType)) {
      refs.set(entityKey(entityType, entity.id), {
        entityType,
        entityId: entity.id,
        fingerprint:
          entityType === 'vorgang'
            ? buildVorgangFingerprint(entity as Vorgang)
            : buildFingerprint(entity),
      });
    }
  }

  const workspaceId = resolveCloudWorkspaceId(state);
  if (workspaceId) {
    if (state.workspace) {
      refs.set(entityKey('workspace', state.workspace.id), {
        entityType: 'workspace',
        entityId: state.workspace.id,
        fingerprint: buildFingerprint(state.workspace as SyncableEntity & { id: string }),
      });
    }
    if (state.workspaceSettings) {
      refs.set(entityKey('workspace_settings', state.workspaceSettings.workspaceId), {
        entityType: 'workspace_settings',
        entityId: state.workspaceSettings.workspaceId,
        fingerprint: buildFingerprint({
          ...state.workspaceSettings,
          id: state.workspaceSettings.workspaceId,
        } as SyncableEntity & { id: string }),
      });
    }
    for (const member of state.workspaceMembers ?? []) {
      const memberId = buildCloudEntityId('workspace_member', member.workspaceId, member.userId);
      refs.set(entityKey('workspace_member', memberId), {
        entityType: 'workspace_member',
        entityId: memberId,
        fingerprint: buildFingerprint({ ...member, id: memberId } as SyncableEntity & { id: string }),
      });
    }
    refs.set(entityKey('company_setup', workspaceId), {
      entityType: 'company_setup',
      entityId: workspaceId,
      fingerprint: {
        version: state.setupSync?.version ?? 0,
        deleted: state.setupSync?.deleted ?? false,
        updatedAt: state.setupSync?.updatedAt ?? '',
        contentKey: JSON.stringify(state.setup),
      },
    });
    if (state.companyProfile) {
      refs.set(entityKey('company_profile', workspaceId), {
        entityType: 'company_profile',
        entityId: workspaceId,
        fingerprint: {
          version: state.companyProfileSync?.version ?? 0,
          deleted: state.companyProfileSync?.deleted ?? false,
          updatedAt: state.companyProfileSync?.updatedAt ?? '',
          contentKey: JSON.stringify(stripLogoFromCompanyProfile(state.companyProfile)),
        },
      });
    }
  }

  return refs;
}

function fingerprintChanged(
  previous: EntitySyncFingerprint,
  current: EntitySyncFingerprint,
  entityType?: SyncEntityType,
): boolean {
  if (entityType === 'vorgang') {
    return (
      previous.deleted !== current.deleted ||
      previous.contentKey !== current.contentKey
    );
  }
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
    if (previous && !fingerprintChanged(previous, ref.fingerprint, ref.entityType)) {
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
