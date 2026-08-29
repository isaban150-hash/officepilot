import type { SyncMeta, SyncableEntity, SyncEntityType } from '../../types/sync';
import { getSyncClient } from './syncClientService';

export function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `uuid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function generateEntityId(prefix?: string): string {
  const uuid = generateUuid();
  return prefix ? `${prefix}-${uuid}` : uuid;
}

export function isEntitySyncActive(entity: SyncableEntity): boolean {
  return !entity.sync?.deleted;
}

export function filterSyncActive<T extends SyncableEntity>(items: T[]): T[] {
  return items.filter(isEntitySyncActive);
}

export function createDefaultSyncMeta(
  fallbackUpdatedAt: string,
  client: Pick<{ deviceId: string; workspaceId: string }, 'deviceId' | 'workspaceId'>,
): SyncMeta {
  return {
    updatedAt: fallbackUpdatedAt,
    version: 1,
    deleted: false,
    deviceId: client.deviceId,
    workspaceId: client.workspaceId,
  };
}

export function ensureSyncMeta<T extends SyncableEntity>(
  entity: T,
  fallbackUpdatedAt: string,
): T & { sync: SyncMeta } {
  if (entity.sync) {
    return entity as T & { sync: SyncMeta };
  }
  const client = getSyncClient();
  return {
    ...entity,
    sync: createDefaultSyncMeta(fallbackUpdatedAt, client),
  };
}

export function bumpSyncMeta(existing: SyncMeta): SyncMeta {
  const client = getSyncClient();
  return {
    ...existing,
    updatedAt: new Date().toISOString(),
    version: existing.version + 1,
    deviceId: client.deviceId,
    workspaceId: client.workspaceId,
  };
}

export function applyTombstoneSyncMeta(existing: SyncMeta): SyncMeta {
  const client = getSyncClient();
  const now = new Date().toISOString();
  return {
    ...existing,
    updatedAt: now,
    deleted: true,
    deletedAt: now,
    version: existing.version + 1,
    deviceId: client.deviceId,
    workspaceId: client.workspaceId,
  };
}

export function createInitialSyncMeta(): SyncMeta {
  const client = getSyncClient();
  return createDefaultSyncMeta(new Date().toISOString(), client);
}

export function withNewEntitySync<T extends SyncableEntity & { id: string }>(
  entity: T,
  _entityType: SyncEntityType,
): T & { sync: SyncMeta } {
  const sync = createInitialSyncMeta();
  return { ...entity, sync };
}

export function withUpdatedEntitySync<T extends SyncableEntity & { id: string }>(
  entity: T,
  _entityType: SyncEntityType,
): T & { sync: SyncMeta } {
  const base = ensureSyncMeta(entity, entity.sync?.updatedAt ?? new Date().toISOString());
  const sync = bumpSyncMeta(base.sync);
  return { ...base, sync };
}

export function withTombstonedEntity<T extends SyncableEntity & { id: string }>(
  entity: T,
  _entityType: SyncEntityType,
): T & { sync: SyncMeta } {
  const base = ensureSyncMeta(entity, entity.sync?.updatedAt ?? new Date().toISOString());
  const sync = applyTombstoneSyncMeta(base.sync);
  return { ...base, sync };
}

/**
 * TOMBSTONE-VERSION-CONTRACT-02 — Löschen für Entitäten, die über
 * `upsert_workspace_sync_entity` in die Cloud gehen.
 *
 * Dort ist `sync.version` seit SYNC-VERSION-CONTRACT-02 ausschliesslich die
 * zuletzt vom **Server** bestätigte `row_version`. Eine Löschung ist eine
 * lokale Fachänderung wie jede andere und darf diesen Wert deshalb nicht
 * anfassen: Der Push sendet ihn als Erwartung, und der Server erhöht selbst.
 *
 * Bewusst **ohne** `ensureSyncMeta`, `createDefaultSyncMeta`, `bumpSyncMeta`
 * oder `applyTombstoneSyncMeta` — jeder dieser Wege erzeugt eine Version, die
 * der Server nie bestätigt hat: das `+ 1` des Tombstones ebenso wie der
 * Startwert 1 der Default-Meta. Fehlt die Bestätigung, ist die einzig richtige
 * Erwartung `0`, und genau die bedeutet serverseitig „diese Zeile darf noch
 * nicht existieren" (CREATE-RETRY-CONFLICT-02).
 *
 * `withTombstonedEntity` bleibt unverändert: Alle übrigen Löschpfade —
 * Dokumente, Inbox, Ausgaben, Wissen, Notizen, Memory — haben keinen
 * versionsgeprüften Serververtrag und behalten ihr bisheriges Verhalten.
 */
export function withTombstonedCloudEntityPreservingRemoteVersion<
  T extends SyncableEntity & { id: string },
>(entity: T, _entityType: SyncEntityType): T & { sync: SyncMeta } {
  const client = getSyncClient();
  const now = new Date().toISOString();
  return {
    ...entity,
    sync: {
      ...entity.sync,
      // Die bestätigte Serverversion bleibt stehen; ohne Bestätigung gilt 0.
      version: entity.sync?.version ?? 0,
      updatedAt: now,
      deleted: true,
      deletedAt: now,
      deviceId: client.deviceId,
      workspaceId: client.workspaceId,
    },
  };
}
