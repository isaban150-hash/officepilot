import type { Vorgang } from '../../types/models';
import type { SyncMeta } from '../../types/sync';
import { mergeSyncEntities } from '../sync/syncMergeEngine';
import { migrateVorgangStatus } from '../vorgangLifecycleService';

/** Cloud-syncable subset of Vorgang – ohne Rechnungen, Dokumente, Aufgaben, Fotos. */
export interface VorgangCloudPayload {
  id: string;
  title: string;
  customer: string;
  baustelle: string;
  status: Vorgang['status'];
  materialSource: Vorgang['materialSource'];
  customerBilling?: Vorgang['customerBilling'];
  orderPositions: Vorgang['orderPositions'];
  createdFromInboxId?: string;
}

export interface WorkspaceVorgangRow {
  workspace_id: string;
  vorgang_id: string;
  payload: Record<string, unknown>;
  row_version: number;
  deleted: boolean;
  deleted_at: string | null;
  updated_at: string;
  updated_by: string | null;
}

export function stripVorgangForCloud(vorgang: Vorgang): VorgangCloudPayload {
  return {
    id: vorgang.id,
    title: vorgang.title,
    customer: vorgang.customer,
    baustelle: vorgang.baustelle,
    status: vorgang.status,
    materialSource: vorgang.materialSource,
    customerBilling: vorgang.customerBilling ? { ...vorgang.customerBilling } : undefined,
    orderPositions: (vorgang.orderPositions ?? []).map((p) => ({ ...p })),
    createdFromInboxId: vorgang.createdFromInboxId,
  };
}

export function buildVorgangCloudContentKey(vorgang: Vorgang): string {
  return JSON.stringify(stripVorgangForCloud(vorgang));
}

export function buildVorgangCloudPushPayload(
  vorgang: Vorgang,
  deleted = false,
): Record<string, unknown> {
  return {
    vorgang_id: vorgang.id,
    id: vorgang.id,
    deleted,
    payload: stripVorgangForCloud(vorgang),
  };
}

export function parseVorgangCloudPayload(payload: Record<string, unknown> | null): VorgangCloudPayload | null {
  if (!payload) return null;
  const inner =
    (payload.payload as VorgangCloudPayload | undefined) ??
    (payload as unknown as VorgangCloudPayload);
  if (!inner || typeof inner !== 'object' || !inner.id) return null;
  return inner;
}

export function mergeCloudVorgangIntoLocal(
  local: Vorgang | null,
  cloudPayload: VorgangCloudPayload,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): { vorgang: Vorgang | null; conflict: boolean } {
  if (!local) {
    return {
      vorgang: createVorgangFromCloudRow(
        cloudPayload,
        rowVersion,
        updatedAt,
        deleted,
        deviceId,
        workspaceId,
      ),
      conflict: false,
    };
  }

  const localVersion = local.sync?.version ?? 0;
  if (localVersion > 0 && rowVersion > 0 && localVersion !== rowVersion) {
    return { vorgang: local, conflict: true };
  }

  if (rowVersion < localVersion) {
    return { vorgang: local, conflict: false };
  }

  const remoteShell: Vorgang = {
    id: cloudPayload.id,
    title: cloudPayload.title,
    customer: cloudPayload.customer,
    baustelle: cloudPayload.baustelle,
    status: migrateVorgangStatus(cloudPayload.status),
    materialSource: cloudPayload.materialSource,
    customerBilling: cloudPayload.customerBilling,
    orderPositions: cloudPayload.orderPositions ?? [],
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
    createdFromInboxId: cloudPayload.createdFromInboxId,
    sync: {
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : undefined,
      deviceId,
      workspaceId,
    },
  };

  const mergeResult = mergeSyncEntities(local, remoteShell, 'vorgang');
  if (mergeResult.conflict) {
    return { vorgang: local, conflict: true };
  }

  if (!mergeResult.entity) {
    return { vorgang: null, conflict: false };
  }

  const merged: Vorgang = {
    ...mergeResult.entity,
    documents: local?.documents ?? [],
    tasks: local?.tasks ?? [],
    photos: local?.photos ?? [],
    invoices: local?.invoices ?? [],
    customerBilling: mergeResult.entity.customerBilling ?? local?.customerBilling,
    // Local-only fields (not in cloud payload) — preserve on merge.
    negotiation: local?.negotiation,
    contractConfirmation: local?.contractConfirmation,
    executionStartedAt: local?.executionStartedAt,
  };

  return { vorgang: merged, conflict: false };
}

export function applyVorgangPushResultToState(
  vorgaenge: Vorgang[],
  vorgangId: string,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): Vorgang[] {
  return vorgaenge.map((v) => {
    if (v.id !== vorgangId) return v;
    const sync: SyncMeta = {
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : v.sync?.deletedAt,
      deviceId,
      workspaceId,
    };
    return { ...v, sync };
  });
}

export function mapWorkspaceVorgangRow(row: WorkspaceVorgangRow): {
  vorgangId: string;
  payload: VorgangCloudPayload;
  rowVersion: number;
  deleted: boolean;
  updatedAt: string;
} | null {
  const parsed = parseVorgangCloudPayload(row.payload);
  if (!parsed) return null;
  return {
    vorgangId: row.vorgang_id,
    payload: parsed,
    rowVersion: Number(row.row_version),
    deleted: Boolean(row.deleted),
    updatedAt: row.updated_at,
  };
}

export function createVorgangFromCloudRow(
  cloudPayload: VorgangCloudPayload,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): Vorgang {
  return {
    id: cloudPayload.id,
    title: cloudPayload.title,
    customer: cloudPayload.customer,
    baustelle: cloudPayload.baustelle,
    status: migrateVorgangStatus(cloudPayload.status),
    materialSource: cloudPayload.materialSource,
    customerBilling: cloudPayload.customerBilling,
    orderPositions: cloudPayload.orderPositions ?? [],
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
    createdFromInboxId: cloudPayload.createdFromInboxId,
    sync: {
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : undefined,
      deviceId,
      workspaceId,
    },
  };
}

export function mergeVorgaengeFromPull(
  localVorgaenge: Vorgang[],
  remoteRows: WorkspaceVorgangRow[],
  deviceId: string,
  workspaceId: string,
): { vorgaenge: Vorgang[]; conflicts: string[] } {
  const conflicts: string[] = [];
  const byId = new Map(localVorgaenge.map((v) => [v.id, v]));

  for (const row of remoteRows) {
    const mapped = mapWorkspaceVorgangRow(row);
    if (!mapped) continue;

    const local = byId.get(mapped.vorgangId) ?? null;
    const { vorgang, conflict } = mergeCloudVorgangIntoLocal(
      local,
      mapped.payload,
      mapped.rowVersion,
      mapped.updatedAt,
      mapped.deleted,
      deviceId,
      workspaceId,
    );

    if (conflict) {
      conflicts.push(`vorgang:${mapped.vorgangId}`);
      continue;
    }

    if (vorgang) {
      byId.set(vorgang.id, vorgang);
    } else if (mapped.deleted) {
      byId.delete(mapped.vorgangId);
    }
  }

  return { vorgaenge: [...byId.values()], conflicts };
}

export function isVorgangCloudEmpty(vorgaenge: Vorgang[]): boolean {
  return vorgaenge.length === 0;
}
