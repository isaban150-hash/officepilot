import type { AppPersistedState } from '../../types/models';
import type { SyncClientConfig } from '../../types/sync';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { persistAll } from '../persistenceService';
import { ensureSyncClientFromState, hydrateSyncClient } from '../sync/syncClientService';
import { enqueueSyncOutbox } from '../sync/syncOutboxService';
import { filterSyncActive } from '../sync/syncMetaService';
import {
  parseCompanyProfileFromCloud,
  parseCompanySetupFromCloud,
  rpcEnsurePersonalWorkspace,
  rpcPullWorkspaceSyncState,
  WorkspaceCloudError,
} from './workspaceCloudService';
import { mergeVorgaengeFromPull } from '../vorgang/vorgangCloudService';
import {
  applyRemoteCompanyProfileSyncMeta,
  applyRemoteSetupSyncMeta,
  bumpCompanyProfileSyncMeta,
  bumpSetupSyncMeta,
  createDefaultWorkspaceSettings,
  createWorkspaceFromProvisioned,
  hydrateWorkspaceStore,
  isDefaultCompanyProfile,
  isDefaultSetup,
  setWorkspaceMembers,
} from './workspaceStore';

export interface WorkspaceProvisioningResult {
  success: boolean;
  state?: AppPersistedState;
  workspaceId?: string;
  created?: boolean;
  error?: string;
  errorCode?: 'auth' | 'rls' | 'network' | 'unknown';
}

export interface WorkspaceInitialMigrationResult {
  state: AppPersistedState;
  conflicts: string[];
  uploaded: string[];
  downloaded: string[];
}

export async function provisionWorkspaceForAuthenticatedUser(
  state: AppPersistedState,
  workspaceName?: string,
): Promise<WorkspaceProvisioningResult> {
  const result = await rpcEnsurePersonalWorkspace(workspaceName ?? state.setup.companyName);
  if (!result.success || !result.workspace || !result.member) {
    return {
      success: false,
      error: result.error,
      errorCode: result.errorCode,
    };
  }

  const workspace = createWorkspaceFromProvisioned({
    id: result.workspace.id,
    name: result.workspace.name,
    ownerUserId: result.workspace.ownerUserId,
    createdAt: result.workspace.createdAt,
    updatedAt: result.workspace.updatedAt,
    version: result.workspace.version,
  });
  setWorkspaceMembers([result.member]);
  if (!state.workspaceSettings) {
    createDefaultWorkspaceSettings(workspace.id);
  }

  const client = ensureSyncClientFromState(state.syncClient);
  const nextClient: SyncClientConfig = {
    ...client,
    serverWorkspaceId: workspace.id,
    cloudProvisionedAt: new Date().toISOString(),
  };

  if (!state.setup.setupComplete) {
    nextClient.workspaceId = workspace.id;
  }

  hydrateSyncClient(nextClient);

  const nextState: AppPersistedState = {
    ...state,
    syncClient: nextClient,
    workspace,
    workspaceMembers: [result.member],
    workspaceSettings: state.workspaceSettings ?? createDefaultWorkspaceSettings(workspace.id),
    setupSync: state.setupSync ?? bumpSetupSyncMeta(),
    companyProfileSync: state.companyProfileSync ?? bumpCompanyProfileSyncMeta(),
    savedAt: new Date().toISOString(),
  };

  return {
    success: true,
    state: nextState,
    workspaceId: workspace.id,
    created: true,
  };
}

export async function runInitialWorkspaceCloudMigration(
  state: AppPersistedState,
): Promise<WorkspaceInitialMigrationResult> {
  const workspaceId = state.syncClient?.serverWorkspaceId ?? state.workspace?.id;
  const conflicts: string[] = [];
  const uploaded: string[] = [];
  const downloaded: string[] = [];

  if (!workspaceId) {
    return { state, conflicts, uploaded, downloaded };
  }

  let remote;
  try {
    remote = await rpcPullWorkspaceSyncState(workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceCloudError && error.code === 'network') {
      return { state, conflicts, uploaded, downloaded };
    }
    throw error;
  }

  const merged = mergeRemoteWorkspacePullIntoState(state, remote);
  return {
    state: merged.state,
    conflicts: [...conflicts, ...merged.conflicts],
    uploaded,
    downloaded,
  };
}

export function applyWorkspaceStateToStores(state: AppPersistedState): void {
  hydrateWorkspaceStore({
    workspace: state.workspace ?? null,
    workspaceMembers: state.workspaceMembers ?? [],
    workspaceSettings: state.workspaceSettings ?? null,
    setupSync: state.setupSync ?? null,
    companyProfileSync: state.companyProfileSync ?? null,
  });
  if (state.companyProfile) {
    hydrateCompanyProfileStore(state.companyProfile);
  }
  if (state.setup) {
    persistAll(state.setup);
  }
}

export function mergeRemoteWorkspacePullIntoState(
  state: AppPersistedState,
  pull: Awaited<ReturnType<typeof rpcPullWorkspaceSyncState>>,
): { state: AppPersistedState; conflicts: string[] } {
  const conflicts: string[] = [];
  const workspaceId = state.syncClient?.serverWorkspaceId ?? state.workspace?.id ?? '';
  let next: AppPersistedState = { ...state };

  if (pull.workspace) {
    const localVersion = state.workspace?.sync?.version ?? state.workspace?.version ?? 0;
    const remoteVersion = pull.workspace.version;
    if (localVersion > 0 && remoteVersion > 0 && localVersion !== remoteVersion) {
      conflicts.push('workspace');
    } else {
      next.workspace = pull.workspace;
    }
  }

  if (pull.settings) {
    const localVersion = state.workspaceSettings?.version ?? 0;
    if (localVersion > 0 && pull.settings.version > 0 && localVersion !== pull.settings.version) {
      conflicts.push('workspace_settings');
    } else if (pull.settings.version >= localVersion) {
      next.workspaceSettings = pull.settings;
    }
  }

  const remoteSetup = parseCompanySetupFromCloud(pull.setupPayload);
  if (remoteSetup) {
    const localVersion = state.setupSync?.version ?? 0;
    if (localVersion > 0 && pull.setupRowVersion > 0 && localVersion !== pull.setupRowVersion) {
      conflicts.push('company_setup');
    } else if (pull.setupRowVersion >= localVersion) {
      next.setup = remoteSetup;
      applyRemoteSetupSyncMeta(pull.setupRowVersion, pull.setupUpdatedAt ?? new Date().toISOString());
      next.setupSync = {
        version: pull.setupRowVersion,
        updatedAt: pull.setupUpdatedAt ?? new Date().toISOString(),
        deleted: false,
        deviceId: state.syncClient!.deviceId,
        workspaceId,
      };
    }
  } else if (!isDefaultSetup(state.setup)) {
    /* local-only until push */
  }

  const remoteProfile = parseCompanyProfileFromCloud(
    pull.companyProfilePayload,
    state.companyProfile?.logoDataUrl,
  );
  if (remoteProfile) {
    const localVersion = state.companyProfileSync?.version ?? 0;
    if (
      localVersion > 0 &&
      pull.companyProfileRowVersion > 0 &&
      localVersion !== pull.companyProfileRowVersion
    ) {
      conflicts.push('company_profile');
    } else if (pull.companyProfileRowVersion >= localVersion) {
      next.companyProfile = remoteProfile;
      applyRemoteCompanyProfileSyncMeta(
        pull.companyProfileRowVersion,
        pull.companyProfileUpdatedAt ?? new Date().toISOString(),
      );
      next.companyProfileSync = {
        version: pull.companyProfileRowVersion,
        updatedAt: pull.companyProfileUpdatedAt ?? new Date().toISOString(),
        deleted: false,
        deviceId: state.syncClient!.deviceId,
        workspaceId,
      };
    }
  } else if (!isDefaultCompanyProfile(state.companyProfile)) {
    /* local-only until push */
  }

  if (pull.members.length > 0) {
    next.workspaceMembers = pull.members;
  }

  const activeLocalVorgaenge = filterSyncActive(state.vorgaenge);
  if ((pull.vorgaenge ?? []).length === 0 && activeLocalVorgaenge.length > 0) {
    for (const vorgang of activeLocalVorgaenge) {
      enqueueSyncOutbox({
        entityType: 'vorgang',
        entityId: vorgang.id,
        operation: 'create',
        version: Math.max(1, vorgang.sync?.version ?? 1),
      });
    }
  } else if ((pull.vorgaenge ?? []).length > 0) {
    const deviceId = state.syncClient!.deviceId;
    const vorgangMerge = mergeVorgaengeFromPull(
      state.vorgaenge,
      pull.vorgaenge ?? [],
      deviceId,
      workspaceId,
    );
    if (vorgangMerge.conflicts.length > 0) {
      conflicts.push(...vorgangMerge.conflicts);
    } else {
      next.vorgaenge = vorgangMerge.vorgaenge;
    }
  }

  next.savedAt = new Date().toISOString();
  return { state: next, conflicts };
}

export function bumpCloudEntitiesAfterLocalChange(
  kind: 'setup' | 'company_profile' | 'workspace_settings',
): void {
  if (kind === 'setup') bumpSetupSyncMeta();
  if (kind === 'company_profile') bumpCompanyProfileSyncMeta();
}
