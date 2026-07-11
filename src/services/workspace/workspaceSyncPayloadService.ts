import type { AppPersistedState, Vorgang } from '../../types/models';
import type { SyncEntityType } from '../../types/sync';
import type { Workspace, WorkspaceMember, WorkspaceSettings } from '../../types/workspace';
import {
  getCompanyProfileSyncSnapshot,
  getSetupSyncSnapshot,
  getWorkspaceMembersSnapshot,
  getWorkspaceSettingsSnapshot,
  getWorkspaceStoreSnapshot,
} from './workspaceStore';

export type CloudSyncEntityPayload =
  | { entityType: 'workspace'; entityId: string; entity: Workspace; rowVersion: number }
  | { entityType: 'workspace_member'; entityId: string; entity: WorkspaceMember; rowVersion: number }
  | { entityType: 'workspace_settings'; entityId: string; entity: WorkspaceSettings; rowVersion: number }
  | { entityType: 'company_setup'; entityId: string; entity: AppPersistedState['setup']; rowVersion: number }
  | {
      entityType: 'company_profile';
      entityId: string;
      entity: NonNullable<AppPersistedState['companyProfile']>;
      rowVersion: number;
    }
  | { entityType: 'vorgang'; entityId: string; entity: Vorgang; rowVersion: number; deleted: boolean };

export function resolveCloudWorkspaceId(state: AppPersistedState): string {
  return (
    state.syncClient?.serverWorkspaceId ??
    state.workspace?.id ??
    state.syncClient?.workspaceId ??
    ''
  );
}

export function extractCloudSyncEntity(
  state: AppPersistedState,
  entityType: SyncEntityType,
  entityId: string,
): CloudSyncEntityPayload | null {
  const workspaceId = resolveCloudWorkspaceId(state);

  switch (entityType) {
    case 'workspace': {
      const workspace = state.workspace ?? getWorkspaceStoreSnapshot();
      if (!workspace || workspace.id !== entityId) return null;
      return {
        entityType,
        entityId,
        entity: workspace,
        rowVersion: workspace.sync?.version ?? workspace.version ?? 0,
      };
    }
    case 'workspace_member': {
      const members = state.workspaceMembers ?? getWorkspaceMembersSnapshot();
      const member = members.find((item) => `${item.workspaceId}:${item.userId}` === entityId);
      if (!member) return null;
      return {
        entityType,
        entityId,
        entity: member,
        rowVersion: member.sync?.version ?? 1,
      };
    }
    case 'workspace_settings': {
      const settings = state.workspaceSettings ?? getWorkspaceSettingsSnapshot();
      if (!settings || settings.workspaceId !== entityId) return null;
      return {
        entityType,
        entityId,
        entity: settings,
        rowVersion: settings.sync?.version ?? settings.version ?? 0,
      };
    }
    case 'company_setup':
      if (entityId !== workspaceId) return null;
      return {
        entityType,
        entityId,
        entity: state.setup,
        rowVersion: state.setupSync?.version ?? getSetupSyncSnapshot()?.version ?? 0,
      };
    case 'company_profile': {
      if (entityId !== workspaceId || !state.companyProfile) return null;
      return {
        entityType,
        entityId,
        entity: state.companyProfile,
        rowVersion: state.companyProfileSync?.version ?? getCompanyProfileSyncSnapshot()?.version ?? 0,
      };
    }
    case 'vorgang': {
      const vorgang = state.vorgaenge.find((v) => v.id === entityId);
      if (!vorgang) return null;
      return {
        entityType,
        entityId,
        entity: vorgang,
        rowVersion: vorgang.sync?.version ?? 0,
        deleted: vorgang.sync?.deleted ?? false,
      };
    }
    default:
      return null;
  }
}

export function buildCloudEntityId(
  entityType: SyncEntityType,
  workspaceId: string,
  userId?: string,
): string {
  if (entityType === 'workspace_member' && userId) {
    return `${workspaceId}:${userId}`;
  }
  return workspaceId;
}
