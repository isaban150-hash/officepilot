import type {
  ContractConfirmationSnapshot,
  Vorgang,
  VorgangStatus,
} from '../../types/models';
import type { SyncMeta } from '../../types/sync';
import { mergeSyncEntities } from '../sync/syncMergeEngine';
import { repairContractPlanFromSnapshot } from '../orderPlanIntegrityService';
import {
  canTransitionVorgangStatus,
  migrateVorgangStatus,
} from '../vorgangLifecycleService';

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

export interface ResolveVorgangStatusForCloudMergeInput {
  /** Local status before merge (undefined when creating from cloud only). */
  localStatus: VorgangStatus | undefined;
  contractConfirmation: ContractConfirmationSnapshot | undefined;
  executionStartedAt: string | undefined;
}

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

/** Sanitize chain facts: start without snapshot is invalid and dropped. */
export function sanitizeOrderChainCloudFacts(
  contractConfirmation: ContractConfirmationSnapshot | undefined,
  executionStartedAt: string | undefined,
): {
  contractConfirmation: ContractConfirmationSnapshot | undefined;
  executionStartedAt: string | undefined;
} {
  const confirmation = contractConfirmation
    ? cloneCloudContractConfirmation(contractConfirmation)
    : undefined;
  let startedAt = readCloudExecutionStartedAt(executionStartedAt);
  if (startedAt && !confirmation) {
    startedAt = undefined;
  }
  return { contractConfirmation: confirmation, executionStartedAt: startedAt };
}

/**
 * CLOUD-ORDER-CHAIN-02: derive merge status from lifecycle + chain facts.
 * Does not take cloud status as input. No UI events / updateVorgangStatus calls.
 */
export function resolveVorgangStatusForCloudMerge(
  input: ResolveVorgangStatusForCloudMergeInput,
): VorgangStatus {
  const { contractConfirmation, executionStartedAt } = sanitizeOrderChainCloudFacts(
    input.contractConfirmation,
    input.executionStartedAt,
  );
  const localStatus =
    input.localStatus !== undefined ? migrateVorgangStatus(input.localStatus) : undefined;

  // Terminal local status: never silently downgrade to beauftragt / in_bearbeitung.
  if (localStatus === 'abgeschlossen') {
    if (contractConfirmation && executionStartedAt) {
      return 'abgeschlossen';
    }
    // Corrupt terminal without facts — fall through to fact floors.
  }

  if (executionStartedAt && contractConfirmation) {
    if (localStatus === 'abgeschlossen') {
      return 'abgeschlossen';
    }
    if (
      localStatus === 'wartet' &&
      (canTransitionVorgangStatus('in_bearbeitung', 'wartet') ||
        canTransitionVorgangStatus('wartet', 'in_bearbeitung'))
    ) {
      return 'wartet';
    }
    return 'in_bearbeitung';
  }

  if (contractConfirmation) {
    return 'beauftragt';
  }

  // No chain facts: keep a pre-confirm local status when it does not require facts.
  if (
    localStatus &&
    localStatus !== 'beauftragt' &&
    !EXECUTION_STATUSES.has(localStatus)
  ) {
    return localStatus;
  }

  return 'eingegangen';
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
 * Order-chain invariant check after status resolution.
 * Sanitizes facts and ensures status matches the fact-derived end state.
 */
export function applyOrderChainCloudInvariants(
  vorgang: Vorgang,
  options: { protectLocalStatus?: VorgangStatus } = {},
): Vorgang {
  const { contractConfirmation, executionStartedAt } = sanitizeOrderChainCloudFacts(
    vorgang.contractConfirmation,
    vorgang.executionStartedAt,
  );

  const status = resolveVorgangStatusForCloudMerge({
    localStatus: options.protectLocalStatus ?? vorgang.status,
    contractConfirmation,
    executionStartedAt,
  });

  return {
    ...vorgang,
    status,
    contractConfirmation,
    executionStartedAt,
  };
}

export function stripVorgangForCloud(vorgang: Vorgang): VorgangCloudPayload {
  // Avoid pushing reparable contract-plan drift from this client.
  const planSource = repairContractPlanFromSnapshot(vorgang).vorgang;

  const payload: VorgangCloudPayload = {
    id: planSource.id,
    title: planSource.title,
    customer: planSource.customer,
    baustelle: planSource.baustelle,
    status: planSource.status,
    materialSource: planSource.materialSource,
    customerBilling: planSource.customerBilling ? { ...planSource.customerBilling } : undefined,
    orderPositions: (planSource.orderPositions ?? []).map((p) => ({ ...p })),
    createdFromInboxId: planSource.createdFromInboxId,
  };

  if (planSource.contractConfirmation) {
    payload.contractConfirmation = cloneCloudContractConfirmation(planSource.contractConfirmation);
  }
  if (planSource.executionStartedAt) {
    payload.executionStartedAt = planSource.executionStartedAt;
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
    // Parsed for payload compatibility only — merge must not treat this as authority.
    status: migrateVorgangStatus(inner.status),
    materialSource: inner.materialSource,
    customerBilling: inner.customerBilling,
    orderPositions: inner.orderPositions ?? [],
    createdFromInboxId: inner.createdFromInboxId,
    contractConfirmation: readCloudContractConfirmation(inner.contractConfirmation),
    executionStartedAt: readCloudExecutionStartedAt(inner.executionStartedAt),
  };
}

function buildMergedVorgangFromFacts(
  shell: Vorgang,
  local: Vorgang | null,
  cloudPayload: VorgangCloudPayload,
  sync: SyncMeta,
): Vorgang {
  // 2–3 write-once chain facts
  const contractConfirmation = resolveWriteOnceContractConfirmation(
    local?.contractConfirmation,
    cloudPayload.contractConfirmation,
  );
  const executionStartedAtRaw = resolveWriteOnceExecutionStartedAt(
    local?.executionStartedAt,
    cloudPayload.executionStartedAt,
  );
  const { contractConfirmation: confirmation, executionStartedAt } = sanitizeOrderChainCloudFacts(
    contractConfirmation,
    executionStartedAtRaw,
  );

  // 4 orderPositions already on shell from merge / cloud row
  const withFacts: Vorgang = {
    ...shell,
    sync,
    documents: local?.documents ?? [],
    tasks: local?.tasks ?? [],
    photos: local?.photos ?? [],
    invoices: local?.invoices ?? [],
    customerBilling: shell.customerBilling ?? local?.customerBilling,
    negotiation: local?.negotiation,
    contractConfirmation: confirmation,
    executionStartedAt,
    orderPositions: shell.orderPositions ?? [],
  };

  // 5 resolve status from facts (ignore cloud/shell status)
  const resolvedStatus = resolveVorgangStatusForCloudMerge({
    localStatus: local?.status,
    contractConfirmation: confirmation,
    executionStartedAt,
  });

  // 6 invariant check
  const withInvariants = applyOrderChainCloudInvariants(
    {
      ...withFacts,
      status: resolvedStatus,
    },
    { protectLocalStatus: local?.status },
  );

  // 7 ORDER-PLAN-INTEGRITY-01: after merge winner is chosen, canonicalize contract fields
  // from snapshot; keep executedQuantity from the selected merged positions by id.
  return repairContractPlanFromSnapshot(withInvariants).vorgang;
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

  // 1 Shell merge — status on remoteShell is a placeholder; final status comes from resolver.
  const remoteShell: Vorgang = {
    id: cloudPayload.id,
    title: cloudPayload.title,
    customer: cloudPayload.customer,
    baustelle: cloudPayload.baustelle,
    status: migrateVorgangStatus(local.status),
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

  const sync: SyncMeta = {
    updatedAt,
    version: rowVersion,
    deleted,
    deletedAt: deleted ? updatedAt : undefined,
    deviceId,
    workspaceId,
  };

  const vorgang = buildMergedVorgangFromFacts(mergeResult.entity, local, cloudPayload, sync);
  return { vorgang, conflict: false };
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
  const sync: SyncMeta = {
    updatedAt,
    version: rowVersion,
    deleted,
    deletedAt: deleted ? updatedAt : undefined,
    deviceId,
    workspaceId,
  };

  // Shell from cloud row (status ignored by resolver).
  const shell: Vorgang = {
    id: cloudPayload.id,
    title: cloudPayload.title,
    customer: cloudPayload.customer,
    baustelle: cloudPayload.baustelle,
    status: 'eingegangen',
    materialSource: cloudPayload.materialSource,
    customerBilling: cloudPayload.customerBilling,
    orderPositions: cloudPayload.orderPositions ?? [],
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
    createdFromInboxId: cloudPayload.createdFromInboxId,
    sync,
  };

  return buildMergedVorgangFromFacts(shell, null, cloudPayload, sync);
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
