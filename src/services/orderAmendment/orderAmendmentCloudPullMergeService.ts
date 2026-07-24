import type { ConfirmedOrderAmendment, Vorgang } from '../../types/models';
import { composeOrderPositionsFromAuthoritativePlan } from '../orderPlanCompositionService';
import { cloneConfirmedOrderAmendments } from './orderAmendmentConfirmedNormalize';
import type { OrderAmendmentConfirmIntent } from './orderAmendmentConfirmIntentService';
import {
  buildOrderAmendmentConfirmRpcInputFromConfirmed,
  orderAmendmentConfirmRpcInputsMatch,
} from './orderAmendmentConfirmPayload';
import { parseWorkspaceOrderAmendmentPullRow } from './workspaceOrderAmendmentCloudService';

/** Same convention as syncUiService.shortenSyncId — kept local to avoid sync UI import cycles. */
function shortenReportId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export type OrderAmendmentPullIssueReason =
  | 'invalid_row'
  | 'orphan'
  | 'fingerprint_conflict'
  | 'cloud_id_conflict'
  | 'sequence_conflict'
  | 'position_id_conflict'
  | 'plan_composition_failed'
  | 'intent_content_conflict'
  | 'duplicate_content_warning'
  | 'intent_clear_failure';

export type OrderAmendmentPullIssue = {
  reason: OrderAmendmentPullIssueReason;
  errorKey?: string;
  message: string;
  vorgangId?: string;
  clientAmendmentId?: string;
  cloudId?: string;
  draftId?: string;
};

export type OrderAmendmentIntentClearKey = {
  vorgangId: string;
  draftId: string;
};

export type MapAmendmentPullRowsResult = {
  mapped: ConfirmedOrderAmendment[];
  invalidCount: number;
  issues: OrderAmendmentPullIssue[];
};

export type MergeCloudAmendmentsResult = {
  /** Persist-free candidate vorgänge (original order preserved). */
  vorgaenge: Vorgang[];
  remoteRowsReceived: number;
  validRows: number;
  invalidRows: number;
  appliedCount: number;
  /** Alias for idempotent / no-op count. */
  noopCount: number;
  orphanCount: number;
  conflictCount: number;
  sequenceConflictCount: number;
  positionConflictCount: number;
  duplicateContentWarningCount: number;
  reconciledIntentCount: number;
  pendingIntentClearCount: number;
  affectedVorgangIds: string[];
  issues: OrderAmendmentPullIssue[];
  orphanReferences: Array<{ vorgangId: string; clientAmendmentId: string; cloudId: string }>;
  /** Clear only after successful batch persist. */
  pendingIntentClears: OrderAmendmentIntentClearKey[];
  changed: boolean;
};

function errorKeyForReason(reason: OrderAmendmentPullIssueReason): string {
  const map: Record<OrderAmendmentPullIssueReason, string> = {
    invalid_row: 'order_amendment_invalid_row',
    orphan: 'order_amendment_orphan',
    fingerprint_conflict: 'order_amendment_local_confirmation_conflict',
    cloud_id_conflict: 'order_amendment_cloud_id_conflict',
    sequence_conflict: 'order_amendment_sequence_conflict',
    position_id_conflict: 'order_amendment_position_id_conflict',
    plan_composition_failed: 'order_amendment_plan_composition_failed',
    intent_content_conflict: 'order_amendment_intent_content_conflict',
    duplicate_content_warning: 'order_amendment_duplicate_content_warning',
    intent_clear_failure: 'order_amendment_intent_clear_failure',
  };
  return map[reason];
}

/** Shorten IDs for reports — never emit full identifiers. */
export function sanitizeOrderAmendmentPullIssue(
  issue: OrderAmendmentPullIssue,
): OrderAmendmentPullIssue {
  return {
    reason: issue.reason,
    errorKey: issue.errorKey ?? errorKeyForReason(issue.reason),
    message: issue.message,
    vorgangId: issue.vorgangId ? shortenReportId(issue.vorgangId) : undefined,
    clientAmendmentId: issue.clientAmendmentId
      ? shortenReportId(issue.clientAmendmentId)
      : undefined,
    cloudId: issue.cloudId ? shortenReportId(issue.cloudId) : undefined,
    draftId: issue.draftId ? shortenReportId(issue.draftId) : undefined,
  };
}

export function sortConfirmedOrderAmendmentsForPull(
  list: ConfirmedOrderAmendment[],
): ConfirmedOrderAmendment[] {
  return [...list].sort((left, right) => {
    if (left.sequenceNo !== right.sequenceNo) return left.sequenceNo - right.sequenceNo;
    const clientCmp = left.clientAmendmentId.localeCompare(right.clientAmendmentId);
    if (clientCmp !== 0) return clientCmp;
    return left.cloudId.localeCompare(right.cloudId);
  });
}

function cloneVorgangShallow(vorgang: Vorgang): Vorgang {
  return {
    ...vorgang,
    orderPositions: (vorgang.orderPositions ?? []).map((position) => ({ ...position })),
    orderAmendments: vorgang.orderAmendments
      ? vorgang.orderAmendments.map((draft) => ({
          ...draft,
          positions: draft.positions.map((position) => ({ ...position })),
        }))
      : undefined,
    confirmedOrderAmendments: cloneConfirmedOrderAmendments(vorgang.confirmedOrderAmendments),
  };
}

/** Commercial content without position ids (duplicate-content soft warning). */
export function buildOrderAmendmentCommercialContentKey(
  amendment: Pick<ConfirmedOrderAmendment, 'vorgangId' | 'title' | 'reason' | 'positions'>,
): string {
  return JSON.stringify({
    vorgangId: amendment.vorgangId,
    title: amendment.title.trim(),
    reason: amendment.reason?.trim() || null,
    positions: amendment.positions.map((position) => ({
      changeType: position.changeType,
      parentPositionId: position.parentPositionId?.trim() || null,
      description: position.description.trim(),
      plannedQuantity: position.plannedQuantity,
      unit: position.unit,
      unitLabel: position.unitLabel?.trim() || null,
      unitPrice: position.unitPrice,
      category: position.category ?? null,
      billable: position.billable ?? null,
    })),
  });
}

function positionIdSetsEqual(a: ConfirmedOrderAmendment, b: ConfirmedOrderAmendment): boolean {
  if (a.positions.length !== b.positions.length) return false;
  const left = a.positions.map((p) => p.id).sort();
  const right = b.positions.map((p) => p.id).sort();
  return left.every((id, index) => id === right[index]);
}

function findDuplicateContentWarnings(
  confirmed: ConfirmedOrderAmendment[],
  vorgangId: string,
): OrderAmendmentPullIssue[] {
  const warnings: OrderAmendmentPullIssue[] = [];
  const sorted = sortConfirmedOrderAmendmentsForPull(confirmed);
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const left = sorted[i]!;
      const right = sorted[j]!;
      if (left.clientAmendmentId === right.clientAmendmentId) continue;
      if (left.sequenceNo === right.sequenceNo) continue;
      if (positionIdSetsEqual(left, right)) continue;
      if (
        buildOrderAmendmentCommercialContentKey(left) !==
        buildOrderAmendmentCommercialContentKey(right)
      ) {
        continue;
      }
      warnings.push({
        reason: 'duplicate_content_warning',
        errorKey: errorKeyForReason('duplicate_content_warning'),
        message: 'Fachlich gleicher Nachtragsinhalt mit unterschiedlichen IDs.',
        vorgangId,
        clientAmendmentId: `${left.clientAmendmentId}|${right.clientAmendmentId}`,
        cloudId: `${left.cloudId}|${right.cloudId}`,
      });
    }
  }
  return warnings;
}

/**
 * Validate raw RPC rows; isolate invalid ones; map valid rows.
 */
export function mapAmendmentPullRowsIsolated(
  rawRows: unknown[],
  workspaceId: string,
): MapAmendmentPullRowsResult {
  const mapped: ConfirmedOrderAmendment[] = [];
  const issues: OrderAmendmentPullIssue[] = [];
  let invalidCount = 0;

  for (const raw of rawRows) {
    const parsed = parseWorkspaceOrderAmendmentPullRow(raw, workspaceId);
    if (!parsed) {
      invalidCount += 1;
      const rawRecord =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      issues.push({
        reason: 'invalid_row',
        errorKey: errorKeyForReason('invalid_row'),
        message: 'Ungültige Cloud-Nachtragszeile übersprungen.',
        clientAmendmentId:
          typeof rawRecord?.client_amendment_id === 'string'
            ? rawRecord.client_amendment_id
            : undefined,
        cloudId: typeof rawRecord?.id === 'string' ? rawRecord.id : undefined,
        vorgangId:
          typeof rawRecord?.vorgang_id === 'string' ? rawRecord.vorgang_id : undefined,
      });
      continue;
    }
    mapped.push(parsed);
  }

  return { mapped, invalidCount, issues };
}

type VorgangMergeOk = {
  ok: true;
  vorgang: Vorgang;
  applied: number;
  noop: number;
  pendingClears: OrderAmendmentIntentClearKey[];
  reconciledIntents: number;
  duplicateWarnings: OrderAmendmentPullIssue[];
  changed: boolean;
};

type VorgangMergeFail = {
  ok: false;
  issues: OrderAmendmentPullIssue[];
};

function identityConflict(
  existing: ConfirmedOrderAmendment,
  remote: ConfirmedOrderAmendment,
  vorgangId: string,
): OrderAmendmentPullIssue | null {
  if (existing.contentFingerprint !== remote.contentFingerprint) {
    return {
      reason: 'fingerprint_conflict',
      errorKey: errorKeyForReason('fingerprint_conflict'),
      message: 'Fingerprint-Konflikt für Nachtrag.',
      vorgangId,
      clientAmendmentId: remote.clientAmendmentId,
      cloudId: remote.cloudId,
    };
  }
  if (existing.cloudId !== remote.cloudId) {
    return {
      reason: 'cloud_id_conflict',
      errorKey: errorKeyForReason('cloud_id_conflict'),
      message: 'Cloud-ID-Konflikt für Nachtrag.',
      vorgangId,
      clientAmendmentId: remote.clientAmendmentId,
      cloudId: remote.cloudId,
    };
  }
  if (existing.sequenceNo !== remote.sequenceNo) {
    return {
      reason: 'sequence_conflict',
      errorKey: errorKeyForReason('sequence_conflict'),
      message: 'Sequenz-Konflikt für Nachtrag.',
      vorgangId,
      clientAmendmentId: remote.clientAmendmentId,
      cloudId: remote.cloudId,
    };
  }
  if (existing.vorgangId !== remote.vorgangId || existing.status !== remote.status) {
    return {
      reason: 'fingerprint_conflict',
      errorKey: errorKeyForReason('fingerprint_conflict'),
      message: 'Identitätskonflikt für Nachtrag.',
      vorgangId,
      clientAmendmentId: remote.clientAmendmentId,
      cloudId: remote.cloudId,
    };
  }
  return null;
}

function mergeOneVorgang(input: {
  local: Vorgang;
  remotes: ConfirmedOrderAmendment[];
  intents: OrderAmendmentConfirmIntent[];
  workspaceId: string;
}): VorgangMergeOk | VorgangMergeFail {
  const { local, remotes, workspaceId } = input;
  const candidate = cloneVorgangShallow(local);
  let confirmed = sortConfirmedOrderAmendmentsForPull(candidate.confirmedOrderAmendments ?? []);
  let applied = 0;
  let noop = 0;

  const vorgangIntents = input.intents.filter(
    (intent) => intent.workspaceId === workspaceId && intent.vorgangId === local.id,
  );

  const remoteByClient = new Map<string, ConfirmedOrderAmendment>();
  const remoteByCloud = new Map<string, ConfirmedOrderAmendment>();
  const remoteBySequence = new Map<number, ConfirmedOrderAmendment>();
  for (const remote of sortConfirmedOrderAmendmentsForPull(remotes)) {
    const priorClient = remoteByClient.get(remote.clientAmendmentId);
    if (priorClient) {
      const conflict = identityConflict(priorClient, remote, local.id);
      if (conflict) return { ok: false, issues: [conflict] };
    }
    const priorCloud = remoteByCloud.get(remote.cloudId);
    if (priorCloud && priorCloud.clientAmendmentId !== remote.clientAmendmentId) {
      return {
        ok: false,
        issues: [{
          reason: 'cloud_id_conflict',
          errorKey: errorKeyForReason('cloud_id_conflict'),
          message: 'Cloud-ID-Konflikt für Nachtrag.',
          vorgangId: local.id,
          clientAmendmentId: remote.clientAmendmentId,
          cloudId: remote.cloudId,
        }],
      };
    }
    const priorSeq = remoteBySequence.get(remote.sequenceNo);
    if (priorSeq && priorSeq.clientAmendmentId !== remote.clientAmendmentId) {
      return {
        ok: false,
        issues: [{
          reason: 'sequence_conflict',
          errorKey: errorKeyForReason('sequence_conflict'),
          message: 'Sequenz-Konflikt für Nachtrag.',
          vorgangId: local.id,
          clientAmendmentId: remote.clientAmendmentId,
          cloudId: remote.cloudId,
        }],
      };
    }
    remoteByClient.set(remote.clientAmendmentId, remote);
    remoteByCloud.set(remote.cloudId, remote);
    remoteBySequence.set(remote.sequenceNo, remote);
  }

  for (const intent of vorgangIntents) {
    const remote = remoteByClient.get(intent.clientAmendmentId);
    if (!remote) continue;
    const remoteAsInput = buildOrderAmendmentConfirmRpcInputFromConfirmed(remote);
    if (!orderAmendmentConfirmRpcInputsMatch(local.id, intent.rpcInput, remoteAsInput)) {
      return {
        ok: false,
        issues: [{
          reason: 'intent_content_conflict',
          errorKey: errorKeyForReason('intent_content_conflict'),
          message: 'Confirm-Intent weicht vom Cloud-Nachtrag ab.',
          vorgangId: local.id,
          clientAmendmentId: intent.clientAmendmentId,
          draftId: intent.draftId,
          cloudId: remote.cloudId,
        }],
      };
    }
  }

  const nextConfirmed: ConfirmedOrderAmendment[] = confirmed.map((item) => ({
    ...item,
    positions: item.positions.map((position) => ({ ...position })),
  }));
  const nextByClient = new Map(nextConfirmed.map((item) => [item.clientAmendmentId, item]));
  const nextByCloud = new Map(nextConfirmed.map((item) => [item.cloudId, item]));
  const nextBySequence = new Map(nextConfirmed.map((item) => [item.sequenceNo, item]));

  for (const remote of sortConfirmedOrderAmendmentsForPull(remotes)) {
    const existingByClient = nextByClient.get(remote.clientAmendmentId);
    if (existingByClient) {
      const conflict = identityConflict(existingByClient, remote, local.id);
      if (conflict) return { ok: false, issues: [conflict] };
      noop += 1;
      continue;
    }

    const existingByCloud = nextByCloud.get(remote.cloudId);
    if (existingByCloud && existingByCloud.clientAmendmentId !== remote.clientAmendmentId) {
      return {
        ok: false,
        issues: [{
          reason: 'cloud_id_conflict',
          errorKey: errorKeyForReason('cloud_id_conflict'),
          message: 'Cloud-ID-Konflikt für Nachtrag.',
          vorgangId: local.id,
          clientAmendmentId: remote.clientAmendmentId,
          cloudId: remote.cloudId,
        }],
      };
    }

    const existingBySequence = nextBySequence.get(remote.sequenceNo);
    if (
      existingBySequence &&
      existingBySequence.clientAmendmentId !== remote.clientAmendmentId
    ) {
      return {
        ok: false,
        issues: [{
          reason: 'sequence_conflict',
          errorKey: errorKeyForReason('sequence_conflict'),
          message: 'Sequenz-Konflikt für Nachtrag.',
          vorgangId: local.id,
          clientAmendmentId: remote.clientAmendmentId,
          cloudId: remote.cloudId,
        }],
      };
    }

    const inserted: ConfirmedOrderAmendment = {
      ...remote,
      positions: remote.positions.map((position) => ({ ...position })),
    };
    nextConfirmed.push(inserted);
    nextByClient.set(inserted.clientAmendmentId, inserted);
    nextByCloud.set(inserted.cloudId, inserted);
    nextBySequence.set(inserted.sequenceNo, inserted);
    applied += 1;
  }

  confirmed = sortConfirmedOrderAmendmentsForPull(nextConfirmed);

  const pendingClears: OrderAmendmentIntentClearKey[] = [];
  let reconciledIntents = 0;
  let drafts = (candidate.orderAmendments ?? []).map((draft) => ({
    ...draft,
    positions: draft.positions.map((position) => ({ ...position })),
  }));

  for (const intent of vorgangIntents) {
    const matched = confirmed.find(
      (item) => item.clientAmendmentId === intent.clientAmendmentId,
    );
    if (!matched) continue;

    confirmed = confirmed.map((item) =>
      item.clientAmendmentId === matched.clientAmendmentId
        ? {
            ...item,
            localSourceDraftId: item.localSourceDraftId ?? intent.draftId,
          }
        : item,
    );
    drafts = drafts.filter((draft) => draft.id !== intent.draftId);
    pendingClears.push({ vorgangId: local.id, draftId: intent.draftId });
    reconciledIntents += 1;
  }

  const withConfirmed: Vorgang = {
    ...candidate,
    confirmedOrderAmendments: confirmed.length > 0 ? confirmed : undefined,
    orderAmendments: drafts.length > 0 ? drafts : undefined,
  };

  const composed = composeOrderPositionsFromAuthoritativePlan(withConfirmed);
  if (!composed.ok) {
    return {
      ok: false,
      issues: [{
        reason:
          composed.errorKey === 'order_amendment_position_id_conflict'
            ? 'position_id_conflict'
            : 'plan_composition_failed',
        errorKey:
          composed.errorKey === 'order_amendment_position_id_conflict'
            ? errorKeyForReason('position_id_conflict')
            : errorKeyForReason('plan_composition_failed'),
        message: 'Plan-Komposition nach Nachtrags-Merge fehlgeschlagen.',
        vorgangId: local.id,
      }],
    };
  }

  const next: Vorgang = {
    ...withConfirmed,
    orderPositions: composed.positions,
  };

  const duplicateWarnings = findDuplicateContentWarnings(confirmed, local.id);

  const changed =
    applied > 0 ||
    reconciledIntents > 0 ||
    JSON.stringify(local.confirmedOrderAmendments ?? []) !==
      JSON.stringify(next.confirmedOrderAmendments ?? []) ||
    JSON.stringify(local.orderAmendments ?? []) !== JSON.stringify(next.orderAmendments ?? []) ||
    JSON.stringify(local.orderPositions) !== JSON.stringify(next.orderPositions);

  return {
    ok: true,
    vorgang: next,
    applied,
    noop,
    pendingClears,
    reconciledIntents,
    duplicateWarnings,
    changed,
  };
}

/**
 * Persist-free write-once merge of validated remote amendments into local vorgänge.
 * Per-vorgang atomic: on conflict the local vorgang stays unchanged.
 */
export function mergeCloudAmendmentsIntoVorgaenge(
  vorgaenge: Vorgang[],
  remoteAmendments: ConfirmedOrderAmendment[],
  options: {
    workspaceId: string;
    intents?: OrderAmendmentConfirmIntent[];
  },
): MergeCloudAmendmentsResult {
  const workspaceId = options.workspaceId.trim();
  const intents = options.intents ?? [];
  const byVorgangId = new Map(vorgaenge.map((item) => [item.id, item]));
  const remotesByVorgang = new Map<string, ConfirmedOrderAmendment[]>();

  const issues: OrderAmendmentPullIssue[] = [];
  const orphanReferences: MergeCloudAmendmentsResult['orphanReferences'] = [];
  let orphanCount = 0;

  for (const remote of remoteAmendments) {
    if (!byVorgangId.has(remote.vorgangId)) {
      orphanCount += 1;
      issues.push({
        reason: 'orphan',
        errorKey: errorKeyForReason('orphan'),
        message: 'Orphan-Nachtrag: lokaler Vorgang fehlt.',
        vorgangId: remote.vorgangId,
        clientAmendmentId: remote.clientAmendmentId,
        cloudId: remote.cloudId,
      });
      orphanReferences.push({
        vorgangId: remote.vorgangId,
        clientAmendmentId: remote.clientAmendmentId,
        cloudId: remote.cloudId,
      });
      continue;
    }
    const list = remotesByVorgang.get(remote.vorgangId) ?? [];
    list.push(remote);
    remotesByVorgang.set(remote.vorgangId, list);
  }

  let appliedCount = 0;
  let noopCount = 0;
  let conflictCount = 0;
  let sequenceConflictCount = 0;
  let positionConflictCount = 0;
  let duplicateContentWarningCount = 0;
  let reconciledIntentCount = 0;
  const pendingIntentClears: OrderAmendmentIntentClearKey[] = [];
  const affectedVorgangIds: string[] = [];
  let changed = false;

  const nextById = new Map(vorgaenge.map((item) => [item.id, item]));

  for (const [vorgangId, remotes] of remotesByVorgang) {
    const local = byVorgangId.get(vorgangId)!;
    const result = mergeOneVorgang({
      local,
      remotes,
      intents,
      workspaceId,
    });
    if (!result.ok) {
      conflictCount += 1;
      for (const issue of result.issues) {
        issues.push(issue);
        if (issue.reason === 'sequence_conflict') sequenceConflictCount += 1;
        if (issue.reason === 'position_id_conflict') positionConflictCount += 1;
      }
      continue;
    }
    // Counts only after the whole vorgang candidate is accepted.
    appliedCount += result.applied;
    noopCount += result.noop;
    reconciledIntentCount += result.reconciledIntents;
    pendingIntentClears.push(...result.pendingClears);
    for (const warning of result.duplicateWarnings) {
      issues.push(warning);
      duplicateContentWarningCount += 1;
    }
    if (result.changed) {
      changed = true;
      affectedVorgangIds.push(vorgangId);
      nextById.set(vorgangId, result.vorgang);
    } else if (result.duplicateWarnings.length > 0 || result.noop > 0) {
      // no-op only: still expose warnings on current state if needed
    }
  }

  for (const intent of intents) {
    if (intent.workspaceId !== workspaceId) continue;
    if (pendingIntentClears.some(
      (item) => item.vorgangId === intent.vorgangId && item.draftId === intent.draftId,
    )) {
      continue;
    }
    const local = nextById.get(intent.vorgangId);
    if (!local) continue;
    const matched = (local.confirmedOrderAmendments ?? []).find(
      (item) => item.clientAmendmentId === intent.clientAmendmentId,
    );
    if (!matched) continue;
    const remoteAsInput = buildOrderAmendmentConfirmRpcInputFromConfirmed(matched);
    if (!orderAmendmentConfirmRpcInputsMatch(intent.vorgangId, intent.rpcInput, remoteAsInput)) {
      continue;
    }
    if (!remotesByVorgang.has(intent.vorgangId)) {
      const drafts = (local.orderAmendments ?? []).filter((draft) => draft.id !== intent.draftId);
      const confirmed = (local.confirmedOrderAmendments ?? []).map((item) =>
        item.clientAmendmentId === matched.clientAmendmentId
          ? { ...item, localSourceDraftId: item.localSourceDraftId ?? intent.draftId }
          : item,
      );
      const next: Vorgang = {
        ...local,
        orderAmendments: drafts.length > 0 ? drafts : undefined,
        confirmedOrderAmendments: confirmed,
      };
      const composed = composeOrderPositionsFromAuthoritativePlan(next);
      if (!composed.ok) continue;
      nextById.set(intent.vorgangId, { ...next, orderPositions: composed.positions });
      pendingIntentClears.push({ vorgangId: intent.vorgangId, draftId: intent.draftId });
      reconciledIntentCount += 1;
      changed = true;
      if (!affectedVorgangIds.includes(intent.vorgangId)) {
        affectedVorgangIds.push(intent.vorgangId);
      }
    }
  }

  return {
    vorgaenge: vorgaenge.map((item) => nextById.get(item.id) ?? item),
    remoteRowsReceived: remoteAmendments.length,
    validRows: remoteAmendments.length,
    invalidRows: 0,
    appliedCount,
    noopCount,
    orphanCount,
    conflictCount,
    sequenceConflictCount,
    positionConflictCount,
    duplicateContentWarningCount,
    reconciledIntentCount,
    pendingIntentClearCount: pendingIntentClears.length,
    affectedVorgangIds,
    issues: issues.map(sanitizeOrderAmendmentPullIssue),
    orphanReferences: orphanReferences.map((ref) => ({
      vorgangId: shortenReportId(ref.vorgangId),
      clientAmendmentId: shortenReportId(ref.clientAmendmentId),
      cloudId: shortenReportId(ref.cloudId),
    })),
    pendingIntentClears,
    changed,
  };
}
