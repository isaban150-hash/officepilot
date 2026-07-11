import { isSupabaseConfigured } from '../../lib/supabase';
import {
  applyPersistedStateFromSync,
  buildPersistedStateSnapshot,
} from '../persistenceService';
import { getSyncCoordinator } from '../sync/syncCoordinator';
import { getSyncClient } from '../sync/syncClientService';
import { createSyncAdapter } from '../sync/syncAdapterFactory';
import {
  applyWorkspaceStateToStores,
  provisionWorkspaceForAuthenticatedUser,
  runInitialWorkspaceCloudMigration,
} from './workspaceProvisioningService';

let bootstrapPromise: Promise<void> | null = null;
let bootstrapCompleted = false;

export function resetWorkspaceCloudBootstrapForTests(): void {
  bootstrapPromise = null;
  bootstrapCompleted = false;
}

export function isWorkspaceCloudBootstrapCompleted(): boolean {
  return bootstrapCompleted;
}

export async function bootstrapWorkspaceCloudSyncIfNeeded(): Promise<void> {
  if (!isSupabaseConfigured()) return;
  if (bootstrapCompleted) return;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const client = getSyncClient();
    if (client.syncPolicy === 'disabled') return;

    let state = buildPersistedStateSnapshot();
    if (!client.cloudProvisionedAt || !state.workspace) {
      const provision = await provisionWorkspaceForAuthenticatedUser(state);
      if (!provision.success || !provision.state) {
        return;
      }
      state = provision.state;
      applyPersistedStateFromSync(state);
      applyWorkspaceStateToStores(state);
    }

    const migration = await runInitialWorkspaceCloudMigration(state);
    state = migration.state;
    applyPersistedStateFromSync(state);
    applyWorkspaceStateToStores(state);

    const syncResult = await (async () => {
      const coordinator = getSyncCoordinator();
      coordinator.setAdapter(createSyncAdapter({ provider: 'supabase' }));
      return coordinator.runSync(buildPersistedStateSnapshot());
    })();
    applyPersistedStateFromSync(syncResult.state);
    applyWorkspaceStateToStores(syncResult.state);

    bootstrapCompleted = true;
  })();

  try {
    await bootstrapPromise;
  } finally {
    bootstrapPromise = null;
  }
}
