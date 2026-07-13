export const LEGACY_GLOBAL_STORAGE_KEY = 'officepilot-state';
export const LEGACY_SETUP_KEY = 'officepilot-setup';
export const LEGACY_QUARANTINE_PREFIX = 'officepilot-legacy-state:';
export const STORAGE_KEY_PREFIX = 'officepilot-state';

export type StorageScope =
  | { type: 'guest' }
  | { type: 'user'; userId: string }
  | { type: 'workspace'; workspaceId: string };

let activeScope: StorageScope = { type: 'guest' };

export function buildStorageKey(scope: StorageScope): string {
  switch (scope.type) {
    case 'guest':
      return `${STORAGE_KEY_PREFIX}:guest`;
    case 'user':
      return `${STORAGE_KEY_PREFIX}:user:${scope.userId}`;
    case 'workspace':
      return `${STORAGE_KEY_PREFIX}:workspace:${scope.workspaceId}`;
    default:
      return `${STORAGE_KEY_PREFIX}:guest`;
  }
}

export function getActiveStorageScope(): StorageScope {
  return activeScope;
}

export function getActiveStorageKey(): string {
  return buildStorageKey(activeScope);
}

export function setActiveStorageScope(scope: StorageScope): void {
  activeScope = scope;
}

export function buildLegacyQuarantineKey(timestamp = Date.now()): string {
  return `${LEGACY_QUARANTINE_PREFIX}${timestamp}`;
}

export function resetStorageScopeForTests(): void {
  activeScope = { type: 'guest' };
}

/** @deprecated Use getActiveStorageKey() – kept for existing tests referencing the global key name. */
export const STORAGE_KEY = LEGACY_GLOBAL_STORAGE_KEY;
