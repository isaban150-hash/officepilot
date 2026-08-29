import type { SyncMeta } from './sync';
import type { WorkspaceVorgangRow } from '../services/vorgang/vorgangCloudService';
import type { WorkspaceCustomerRow } from '../services/customer/customerCloudService';

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export type WorkspaceMemberStatus = 'active' | 'invited' | 'removed';

export interface Workspace {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  sync?: SyncMeta;
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  status: WorkspaceMemberStatus;
  createdAt: string;
  updatedAt: string;
  sync?: SyncMeta;
}

export interface WorkspaceSettings {
  workspaceId: string;
  settings: Record<string, unknown>;
  version: number;
  updatedAt: string;
  updatedBy?: string;
  sync?: SyncMeta;
}

/** Server-side row metadata for singleton workspace entities (setup, profile). */
export interface WorkspaceCloudRowMeta {
  rowVersion: number;
  updatedAt: string;
  updatedBy?: string;
}

export interface WorkspaceSyncPullPayload {
  workspace: Workspace | null;
  members: WorkspaceMember[];
  settings: WorkspaceSettings | null;
  setupPayload: Record<string, unknown> | null;
  setupRowVersion: number;
  setupUpdatedAt: string | null;
  companyProfilePayload: Record<string, unknown> | null;
  companyProfileRowVersion: number;
  companyProfileUpdatedAt: string | null;
  vorgaenge: WorkspaceVorgangRow[];
  /**
   * PRODUCT-FOUNDATION-03A-C1 — enthält bewusst auch Grabsteine
   * (`deleted = true`). Der Backfill braucht sie, um eine anderswo gelöschte
   * Kunden-ID nicht erneut anzulegen.
   */
  customers: WorkspaceCustomerRow[];
}

export interface EnsurePersonalWorkspaceResult {
  success: boolean;
  workspaceId?: string;
  workspace?: Workspace;
  member?: WorkspaceMember;
  /** True only when the server created the workspace in this call. */
  created?: boolean;
  error?: string;
  errorCode?: 'auth' | 'rls' | 'network' | 'unknown';
}
