import type {
  ContractConfirmationSnapshot,
  Vorgang,
  VorgangStatus,
} from '../../types/models';
import type { SyncMeta } from '../../types/sync';
import { mergeSyncEntities } from '../sync/syncMergeEngine';
import { migrateVorgangStatus } from '../vorgangLifecycleService';

/** Cloud-syncable subset of Vorgang – ohne Rechnungen, Dokumente, Aufgaben, Fotos, Negotiation. */
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
  /** CLOUD-ORDER-CHAIN-01: immutable confirm snapshot (write-once on merge). */
  contractConfirmation?: ContractConfirmationSnapshot;
  /** CLOUD-ORDER-CHAIN-01: execution start timestamp (write-once on merge). */
  executionStartedAt?: string;
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

const PRE_BEAUFTRAGT: ReadonlySet<VorgangStatus> = new Set([
  'neu',
  'eingegangen',
  'in_pruefung',
  'in_verhandlung',
]);

const EXECUTION_STATUSES: ReadonlySet<VorgangStatus> = new Set([
  'in_bearbeitung',
  'wartet',
  'abgeschlossen',
]);

function cloneCloudContractConfirmation(
  snapshot: ContractConfirmationSnapshot,
): ContractConfirmationSnapshot {
  return {
    ...snapshot,
    immutable: true,
    positions: (snapshot.positions ?? []).map((p) => ({ ...p })),
    negotiation: {
      notes: [...(snapshot.negotiation?.notes ?? [])],
      generalHints: [...(snapshot.negotiation?.generalHints ?? [])],
      priceProposals: (snapshot.negotiation?.priceProposals ?? []).map((p) => ({ ...p })),
      positionProposals: (snapshot.negotiation?.positionProposals ?? []).map((p) => ({ ...p })),
      drafts: (snapshot.negotiation?.drafts ?? []).map((d) => ({
        ...d,
        sendConfirmed: false as const,
      })),
    },
  };
}

function readCloudContractConfirmation(
  value: unknown,
): ContractConfirmationSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as ContractConfirmationSnapshot;
  if (typeof raw.id !== 'string' || !raw.id) return undefined;
  return cloneCloudContractConfirmation({
    ...raw,
    immutable: true,
    positions: raw.positions ?? [],
    negotiation: {
      notes: raw.negotiation?.notes ?? [],
      generalHints: raw.negotiation?.generalHints ?? [],
      priceProposals: raw.negotiation?.priceProposals ?? [],
      positionProposals: raw.negotiation?.positionProposals ?? [],
      drafts: raw.negotiation?.drafts ?? [],
    },
  });
}

function readCloudExecutionStartedAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

/** Write-once: local wins when present; otherwise take cloud. */
export function resolveWriteOnceContractConfirmation(
  local: ContractConfirmationSnapshot | undefined,
  cloud: ContractConfirmationSnapshot | undefined,
): ContractConfirmationSnapshot | undefined {
  if (local) return cloneCloudContractConfirmation(local);
  if (cloud) return cloneCloudContractConfirmation(cloud);
  return undefined;
}

/** Write-once: local wins when present; otherwise take cloud. */
export function resolveWriteOnceExecutionStartedAt(
  local: string | undefined,
  cloud: string | undefined,
): string | undefined {
  if (local) return local;
  return cloud;
}

/**
 * Repair status after cloud merge so order-chain invariants hold:
 * - confirmation ⇒ status at least beauftragt
 * - in_bearbeitung|wartet|abgeschlossen ⇒ executionStartedAt present
 */
export function applyOrderChainCloudInvariants(vorgang: Vorgang): Vorgang {
  let status = migrateVorgangStatus(vorgang.status);
  const contractConfirmation = vorgang.contractConfirmation
    ? cloneCloudContractConfirmation(vorgang.contractConfirmation)
    : undefined;
  const executionStartedAt = readCloudExecutionStartedAt(vorgang.executionStartedAt);

  if (contractConfirmation && PRE_BEAUFTRAGT.has(status)) {
    status = 'beauftragt';
  }

  if (EXECUTION_STATUSES.has(status) && !executionStartedAt) {
    status = contractConfirmation ? 'beauftragt' : 'eingegangen';
  }

  if (executionStartedAt && status === 'beauftragt') {
    status = 'in_bearbeitung';
  }

  return {
    ...vorgang,
    status,
    contractConfirmation,
    executionStartedAt,
  };
}

export function stripVorgangForCloud(vorgang: Vorgang): VorgangCloudPayload {
  const payload: VorgangCloudPayload = {
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

  if (vorgang.contractConfirmation) {
    payload.contractConfirmation = cloneCloudContractConfirmation(vorgang.contractConfirmation);
  }
  if (vorgang.executionStartedAt) {
    payload.executionStartedAt = vorgang.executionStartedAt;
  }

  return payload;
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

  return {
    id: inner.id,
    title: inner.title,
    customer: inner.customer,
    baustelle: inner.baustelle,
    status: migrateVorgangStatus(inner.status),
    materialSource: inner.materialSource,
    customerBilling: inner.customerBilling,
    orderPositions: inner.orderPositions ?? [],
    createdFromInboxId: inner.createdFromInboxId,
    contractConfirmation: readCloudContractConfirmation(inner.contractConfirmation),
    executionStartedAt: readCloudExecutionStartedAt(inner.executionStartedAt),
  };
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

  const merged: Vorgang = applyOrderChainCloudInvariants({
    ...mergeResult.entity,
    documents: local.documents ?? [],
    tasks: local.tasks ?? [],
    photos: local.photos ?? [],
    invoices: local.invoices ?? [],
    customerBilling: mergeResult.entity.customerBilling ?? local.customerBilling,
    // Live negotiation stays local-only.
    negotiation: local.negotiation,
    contractConfirmation: resolveWriteOnceContractConfirmation(
      local.contractConfirmation,
      cloudPayload.contractConfirmation,
    ),
    executionStartedAt: resolveWriteOnceExecutionStartedAt(
      local.executionStartedAt,
      cloudPayload.executionStartedAt,
    ),
  });

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
  return applyOrderChainCloudInvariants({
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
    contractConfirmation: cloudPayload.contractConfirmation
      ? cloneCloudContractConfirmation(cloudPayload.contractConfirmation)
      : undefined,
    executionStartedAt: cloudPayload.executionStartedAt,
    sync: {
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : undefined,
      deviceId,
      workspaceId,
    },
  });
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
