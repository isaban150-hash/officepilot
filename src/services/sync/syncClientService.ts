import { isBetaTestMode } from '../../config/betaTestMode';
import type { SyncClientConfig, SyncPolicy } from '../../types/sync';
import { generateUuid } from './syncMetaService';

let cachedClient: SyncClientConfig | null = null;

export function resolveSyncPolicy(): SyncPolicy {
  if (isBetaTestMode()) {
    return 'disabled';
  }
  return 'cloud_ready';
}

export function createSyncClient(migratedAt?: string): SyncClientConfig {
  const now = new Date().toISOString();
  return {
    deviceId: generateUuid(),
    workspaceId: generateUuid(),
    createdAt: now,
    migratedAt,
    syncPolicy: resolveSyncPolicy(),
  };
}

export function hydrateSyncClient(client: SyncClientConfig): void {
  cachedClient = {
    ...client,
    syncPolicy: isBetaTestMode() ? 'disabled' : client.syncPolicy,
  };
}

export function getSyncClient(): SyncClientConfig {
  if (!cachedClient) {
    cachedClient = createSyncClient();
  }
  return { ...cachedClient };
}

export function getSyncClientSnapshot(): SyncClientConfig {
  return getSyncClient();
}

export function resetSyncClientForTests(client?: SyncClientConfig): void {
  cachedClient = client ?? createSyncClient();
}

export function ensureSyncClientFromState(client?: SyncClientConfig): SyncClientConfig {
  if (client) {
    hydrateSyncClient(client);
    return getSyncClient();
  }
  if (!cachedClient) {
    cachedClient = createSyncClient();
  }
  return getSyncClient();
}
