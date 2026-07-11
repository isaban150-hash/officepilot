import type { SupabaseClient } from '@supabase/supabase-js';
import type { CompanyProfile, CompanySetup } from '../../types/models';
import type {
  EnsurePersonalWorkspaceResult,
  Workspace,
  WorkspaceMember,
  WorkspaceSettings,
  WorkspaceSyncPullPayload,
} from '../../types/workspace';
import { getSupabaseClient } from '../../lib/supabase';
import { stripLogoFromCompanyProfile } from './workspaceStore';

interface WorkspaceRow {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
  version: number;
}

interface WorkspaceMemberRow {
  workspace_id: string;
  user_id: string;
  role: WorkspaceMember['role'];
  status: WorkspaceMember['status'];
  created_at: string;
  updated_at: string;
}

interface WorkspaceSettingsRow {
  workspace_id: string;
  settings: Record<string, unknown>;
  version: number;
  updated_at: string;
  updated_by: string | null;
}

interface WorkspaceSetupRow {
  workspace_id: string;
  payload: Record<string, unknown>;
  setup_version: number;
  row_version: number;
  updated_at: string;
  updated_by: string | null;
}

interface WorkspaceCompanyProfileRow {
  workspace_id: string;
  payload: Record<string, unknown>;
  row_version: number;
  updated_at: string;
  updated_by: string | null;
}

export type WorkspaceCloudErrorCode = 'auth' | 'rls' | 'network' | 'version_conflict' | 'unknown';

export class WorkspaceCloudError extends Error {
  readonly code: WorkspaceCloudErrorCode;
  readonly retryable: boolean;

  constructor(message: string, code: WorkspaceCloudErrorCode, retryable = false) {
    super(message);
    this.name = 'WorkspaceCloudError';
    this.code = code;
    this.retryable = retryable;
  }
}

function mapWorkspaceRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version),
  };
}

function mapMemberRow(row: WorkspaceMemberRow): WorkspaceMember {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSettingsRow(row: WorkspaceSettingsRow): WorkspaceSettings {
  return {
    workspaceId: row.workspace_id,
    settings: row.settings ?? {},
    version: Number(row.version),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? undefined,
  };
}

function classifySupabaseError(error: { message?: string; code?: string }): WorkspaceCloudError {
  const message = error.message ?? 'Unbekannter Cloud-Fehler';
  if (message.includes('Nicht angemeldet') || error.code === 'PGRST301') {
    return new WorkspaceCloudError(message, 'auth', false);
  }
  if (
    message.includes('Kein Zugriff') ||
    message.includes('Keine Schreibberechtigung') ||
    message.includes('permission') ||
    error.code === '42501'
  ) {
    return new WorkspaceCloudError(message, 'rls', false);
  }
  if (message.includes('Versionskonflikt')) {
    return new WorkspaceCloudError(message, 'version_conflict', false);
  }
  if (message.includes('Failed to fetch') || message.includes('Network')) {
    return new WorkspaceCloudError(message, 'network', true);
  }
  return new WorkspaceCloudError(message, 'unknown', true);
}

function getClient(client?: SupabaseClient | null): SupabaseClient {
  const resolved = client ?? getSupabaseClient();
  if (!resolved) {
    throw new WorkspaceCloudError('Supabase ist nicht konfiguriert.', 'unknown', false);
  }
  return resolved;
}

export async function rpcEnsurePersonalWorkspace(
  workspaceName?: string,
  client?: SupabaseClient | null,
): Promise<EnsurePersonalWorkspaceResult> {
  try {
    const supabase = getClient(client);
    const { data, error } = await supabase.rpc('ensure_personal_workspace', {
      p_name: workspaceName ?? null,
    });
    if (error) {
      const mapped = classifySupabaseError(error);
      return { success: false, error: mapped.message, errorCode: mapped.code === 'auth' ? 'auth' : mapped.code === 'rls' ? 'rls' : mapped.code === 'network' ? 'network' : 'unknown' };
    }

    const workspaceRow = data?.workspace as WorkspaceRow | undefined;
    const memberRow = data?.member as WorkspaceMemberRow | undefined;
    if (!workspaceRow || !memberRow) {
      return { success: false, error: 'Ungültige Server-Antwort bei Workspace-Provisioning.', errorCode: 'unknown' };
    }

    return {
      success: true,
      workspaceId: workspaceRow.id,
      workspace: mapWorkspaceRow(workspaceRow),
      member: mapMemberRow(memberRow),
    };
  } catch (error) {
    if (error instanceof WorkspaceCloudError) {
      return {
        success: false,
        error: error.message,
        errorCode: error.code === 'auth' ? 'auth' : error.code === 'rls' ? 'rls' : error.code === 'network' ? 'network' : 'unknown',
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unbekannter Fehler',
      errorCode: 'network',
    };
  }
}

export async function rpcPullWorkspaceSyncState(
  workspaceId: string,
  client?: SupabaseClient | null,
): Promise<WorkspaceSyncPullPayload> {
  const supabase = getClient(client);
  const { data, error } = await supabase.rpc('pull_workspace_sync_state', {
    p_workspace_id: workspaceId,
  });
  if (error) throw classifySupabaseError(error);

  const workspaceRow = data?.workspace as WorkspaceRow | null;
  const membersRaw = (data?.members as WorkspaceMemberRow[] | null) ?? [];
  const settingsRow = data?.settings as WorkspaceSettingsRow | null;
  const setupRow = data?.setup as WorkspaceSetupRow | null;
  const profileRow = data?.company_profile as WorkspaceCompanyProfileRow | null;

  return {
    workspace: workspaceRow ? mapWorkspaceRow(workspaceRow) : null,
    members: membersRaw.map(mapMemberRow),
    settings: settingsRow ? mapSettingsRow(settingsRow) : null,
    setupPayload: setupRow?.payload ?? null,
    setupRowVersion: setupRow ? Number(setupRow.row_version) : 0,
    setupUpdatedAt: setupRow?.updated_at ?? null,
    companyProfilePayload: profileRow?.payload ?? null,
    companyProfileRowVersion: profileRow ? Number(profileRow.row_version) : 0,
    companyProfileUpdatedAt: profileRow?.updated_at ?? null,
  };
}

export async function rpcUpsertWorkspaceSyncEntity(
  workspaceId: string,
  entityType: string,
  payload: Record<string, unknown>,
  rowVersion: number,
  client?: SupabaseClient | null,
): Promise<{ rowVersion: number; payload: Record<string, unknown> }> {
  const supabase = getClient(client);
  const { data, error } = await supabase.rpc('upsert_workspace_sync_entity', {
    p_workspace_id: workspaceId,
    p_entity_type: entityType,
    p_payload: payload,
    p_row_version: rowVersion,
  });
  if (error) throw classifySupabaseError(error);
  return {
    rowVersion: Number(data?.row_version ?? rowVersion),
    payload: (data?.payload as Record<string, unknown>) ?? {},
  };
}

export function buildCompanySetupCloudPayload(setup: CompanySetup): Record<string, unknown> {
  return {
    payload: { ...setup },
    setup_version: setup.setupVersion,
  };
}

export function buildCompanyProfileCloudPayload(profile: CompanyProfile): Record<string, unknown> {
  return {
    payload: stripLogoFromCompanyProfile(profile),
  };
}

export function buildWorkspaceSettingsCloudPayload(settings: WorkspaceSettings): Record<string, unknown> {
  return {
    settings: settings.settings,
  };
}

export function buildWorkspaceCloudPayload(workspace: Workspace): Record<string, unknown> {
  return {
    name: workspace.name,
  };
}

export function parseCompanySetupFromCloud(payload: Record<string, unknown> | null): CompanySetup | null {
  if (!payload) return null;
  const inner = (payload.payload as CompanySetup | undefined) ?? (payload as unknown as CompanySetup);
  if (!inner || typeof inner !== 'object') return null;
  return inner;
}

export function parseCompanyProfileFromCloud(
  payload: Record<string, unknown> | null,
  existingLogo?: string,
): CompanyProfile | null {
  if (!payload) return null;
  const inner =
    (payload.payload as CompanyProfile | undefined) ?? (payload as unknown as CompanyProfile);
  if (!inner || typeof inner !== 'object') return null;
  if (existingLogo) {
    return { ...inner, logoDataUrl: existingLogo };
  }
  return inner;
}
