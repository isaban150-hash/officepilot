import type { AppPersistedState } from '../../types/models';
import type { StorageScope } from './storageScopeService';
import {
  LEGACY_GLOBAL_STORAGE_KEY,
  buildLegacyQuarantineKey,
  buildStorageKey,
} from './storageScopeService';
import { stateContainsDefinitelyMockData } from './mockDataDetectionService';

export type LegacyMigrationOutcome =
  | { action: 'none' }
  | { action: 'migrated'; targetKey: string }
  | { action: 'quarantined'; quarantineKey: string };

function readRawStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRawStorage(key: string, raw: string): void {
  localStorage.setItem(key, raw);
}

function removeRawStorage(key: string): void {
  localStorage.removeItem(key);
}

export function legacyGlobalStateExists(): boolean {
  return readRawStorage(LEGACY_GLOBAL_STORAGE_KEY) !== null;
}

export function canAssignLegacyStateToScope(
  legacy: AppPersistedState,
  scope: StorageScope,
  userId?: string,
): boolean {
  if (stateContainsDefinitelyMockData(legacy) && scope.type !== 'guest') {
    return false;
  }

  if (scope.type === 'workspace') {
    const workspaceId = scope.workspaceId;
    if (legacy.workspace?.id === workspaceId) return true;
    if (legacy.syncClient?.serverWorkspaceId === workspaceId) return true;
    if (legacy.workspace?.ownerUserId && userId && legacy.workspace.ownerUserId === userId) {
      return true;
    }
    return false;
  }

  if (scope.type === 'user') {
    if (!userId) return false;
    if (legacy.workspace?.ownerUserId === userId) return true;
    if (
      !legacy.workspace &&
      !legacy.syncClient?.serverWorkspaceId &&
      legacy.vorgaenge.length === 0 &&
      legacy.inboxItems.length === 0
    ) {
      return true;
    }
    return false;
  }

  return false;
}

export function quarantineLegacyGlobalState(): string | null {
  const raw = readRawStorage(LEGACY_GLOBAL_STORAGE_KEY);
  if (!raw) return null;

  const quarantineKey = buildLegacyQuarantineKey();
  writeRawStorage(quarantineKey, raw);
  removeRawStorage(LEGACY_GLOBAL_STORAGE_KEY);
  return quarantineKey;
}

export function tryMigrateLegacyGlobalState(
  scope: StorageScope,
  userId?: string,
): LegacyMigrationOutcome {
  const targetKey = buildStorageKey(scope);
  if (readRawStorage(targetKey)) {
    if (legacyGlobalStateExists()) {
      const quarantineKey = quarantineLegacyGlobalState();
      return quarantineKey ? { action: 'quarantined', quarantineKey } : { action: 'none' };
    }
    return { action: 'none' };
  }

  const legacyRaw = readRawStorage(LEGACY_GLOBAL_STORAGE_KEY);
  if (!legacyRaw) {
    return { action: 'none' };
  }

  let legacy: AppPersistedState;
  try {
    legacy = JSON.parse(legacyRaw) as AppPersistedState;
  } catch {
    const quarantineKey = quarantineLegacyGlobalState();
    return quarantineKey ? { action: 'quarantined', quarantineKey } : { action: 'none' };
  }

  if (!canAssignLegacyStateToScope(legacy, scope, userId)) {
    const quarantineKey = quarantineLegacyGlobalState();
    return quarantineKey ? { action: 'quarantined', quarantineKey } : { action: 'none' };
  }

  writeRawStorage(targetKey, legacyRaw);
  removeRawStorage(LEGACY_GLOBAL_STORAGE_KEY);
  return { action: 'migrated', targetKey };
}

export function migrateUserScopeToWorkspaceScope(
  userId: string,
  workspaceId: string,
): boolean {
  const userKey = buildStorageKey({ type: 'user', userId });
  const workspaceKey = buildStorageKey({ type: 'workspace', workspaceId });

  const userRaw = readRawStorage(userKey);
  if (!userRaw) return false;
  if (readRawStorage(workspaceKey)) {
    removeRawStorage(userKey);
    return false;
  }

  writeRawStorage(workspaceKey, userRaw);
  removeRawStorage(userKey);
  return true;
}
