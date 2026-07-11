import type { CompanyProfile, CompanySetup } from '../../types/models';
import type { SyncMeta } from '../../types/sync';
import type { Workspace, WorkspaceMember, WorkspaceSettings } from '../../types/workspace';
import { persistAll } from '../persistenceService';
import { getSyncClient } from '../sync/syncClientService';
import { bumpSyncMeta, createDefaultSyncMeta, createInitialSyncMeta } from '../sync/syncMetaService';

let workspace: Workspace | null = null;
let workspaceMembers: WorkspaceMember[] = [];
let workspaceSettings: WorkspaceSettings | null = null;
let setupSync: SyncMeta | null = null;
let companyProfileSync: SyncMeta | null = null;

function cloneWorkspace(value: Workspace): Workspace {
  return { ...value, sync: value.sync ? { ...value.sync } : undefined };
}

function cloneMember(value: WorkspaceMember): WorkspaceMember {
  return { ...value, sync: value.sync ? { ...value.sync } : undefined };
}

function cloneSettings(value: WorkspaceSettings): WorkspaceSettings {
  return {
    ...value,
    settings: { ...value.settings },
    sync: value.sync ? { ...value.sync } : undefined,
  };
}

function cloneSyncMeta(meta: SyncMeta): SyncMeta {
  return { ...meta };
}

export function getWorkspaceStoreSnapshot(): Workspace | null {
  return workspace ? cloneWorkspace(workspace) : null;
}

export function getWorkspaceMembersSnapshot(): WorkspaceMember[] {
  return workspaceMembers.map(cloneMember);
}

export function getWorkspaceSettingsSnapshot(): WorkspaceSettings | null {
  return workspaceSettings ? cloneSettings(workspaceSettings) : null;
}

export function getSetupSyncSnapshot(): SyncMeta | null {
  return setupSync ? cloneSyncMeta(setupSync) : null;
}

export function getCompanyProfileSyncSnapshot(): SyncMeta | null {
  return companyProfileSync ? cloneSyncMeta(companyProfileSync) : null;
}

export function hydrateWorkspaceStore(input: {
  workspace?: Workspace | null;
  workspaceMembers?: WorkspaceMember[];
  workspaceSettings?: WorkspaceSettings | null;
  setupSync?: SyncMeta | null;
  companyProfileSync?: SyncMeta | null;
}): void {
  workspace = input.workspace ? cloneWorkspace(input.workspace) : null;
  workspaceMembers = (input.workspaceMembers ?? []).map(cloneMember);
  workspaceSettings = input.workspaceSettings ? cloneSettings(input.workspaceSettings) : null;
  setupSync = input.setupSync ? cloneSyncMeta(input.setupSync) : null;
  companyProfileSync = input.companyProfileSync ? cloneSyncMeta(input.companyProfileSync) : null;
}

export function resetWorkspaceStore(): void {
  workspace = null;
  workspaceMembers = [];
  workspaceSettings = null;
  setupSync = null;
  companyProfileSync = null;
}

export function setWorkspace(next: Workspace): void {
  workspace = cloneWorkspace(next);
}

export function setWorkspaceMembers(members: WorkspaceMember[]): void {
  workspaceMembers = members.map(cloneMember);
}

export function setWorkspaceSettings(next: WorkspaceSettings): void {
  workspaceSettings = cloneSettings(next);
}

export function ensureSetupSyncMeta(fallbackUpdatedAt?: string): SyncMeta {
  if (setupSync) return cloneSyncMeta(setupSync);
  const client = getSyncClient();
  setupSync = createDefaultSyncMeta(fallbackUpdatedAt ?? new Date().toISOString(), client);
  return cloneSyncMeta(setupSync);
}

export function ensureCompanyProfileSyncMeta(fallbackUpdatedAt?: string): SyncMeta {
  if (companyProfileSync) return cloneSyncMeta(companyProfileSync);
  const client = getSyncClient();
  companyProfileSync = createDefaultSyncMeta(fallbackUpdatedAt ?? new Date().toISOString(), client);
  return cloneSyncMeta(companyProfileSync);
}

export function bumpSetupSyncMeta(): SyncMeta {
  const base = ensureSetupSyncMeta();
  setupSync = bumpSyncMeta(base);
  return cloneSyncMeta(setupSync);
}

export function bumpCompanyProfileSyncMeta(): SyncMeta {
  const base = ensureCompanyProfileSyncMeta();
  companyProfileSync = bumpSyncMeta(base);
  return cloneSyncMeta(companyProfileSync);
}

export function applyRemoteSetupSyncMeta(rowVersion: number, updatedAt: string): void {
  const client = getSyncClient();
  setupSync = {
    updatedAt,
    version: rowVersion,
    deleted: false,
    deviceId: client.deviceId,
    workspaceId: client.serverWorkspaceId ?? client.workspaceId,
  };
}

export function applyRemoteCompanyProfileSyncMeta(rowVersion: number, updatedAt: string): void {
  const client = getSyncClient();
  companyProfileSync = {
    updatedAt,
    version: rowVersion,
    deleted: false,
    deviceId: client.deviceId,
    workspaceId: client.serverWorkspaceId ?? client.workspaceId,
  };
}

export function createWorkspaceFromProvisioned(input: {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}): Workspace {
  const next: Workspace = {
    id: input.id,
    name: input.name,
    ownerUserId: input.ownerUserId,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    version: input.version,
    sync: createInitialSyncMeta(),
  };
  next.sync!.workspaceId = input.id;
  workspace = next;
  return cloneWorkspace(next);
}

export function createDefaultWorkspaceSettings(workspaceId: string): WorkspaceSettings {
  const next: WorkspaceSettings = {
    workspaceId,
    settings: {},
    version: 1,
    updatedAt: new Date().toISOString(),
    sync: createInitialSyncMeta(),
  };
  next.sync!.workspaceId = workspaceId;
  workspaceSettings = next;
  return cloneSettings(next);
}

export function updateWorkspaceSettingsLocally(
  partial: Record<string, unknown>,
): WorkspaceSettings {
  const workspaceId = workspace?.id ?? getSyncClient().serverWorkspaceId ?? getSyncClient().workspaceId;
  const current =
    workspaceSettings ??
    createDefaultWorkspaceSettings(workspaceId);
  const next: WorkspaceSettings = {
    ...current,
    settings: { ...current.settings, ...partial },
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
    sync: bumpSyncMeta(current.sync ?? createInitialSyncMeta()),
  };
  workspaceSettings = next;
  return cloneSettings(next);
}

export function stripLogoFromCompanyProfile(profile: CompanyProfile): CompanyProfile {
  const { logoDataUrl: _logo, ...rest } = profile;
  return { ...rest };
}

export function isDefaultSetup(setup: CompanySetup): boolean {
  return !setup.setupComplete && !setup.companyName.trim();
}

export function isDefaultCompanyProfile(profile: CompanyProfile | undefined): boolean {
  if (!profile) return true;
  return !profile.companyName.trim() && !profile.street.trim() && !profile.email.trim();
}

export function persistWorkspaceCloudChanges(setupOverride?: CompanySetup): void {
  persistAll(setupOverride);
}
