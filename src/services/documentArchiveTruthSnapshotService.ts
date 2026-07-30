/**
 * ARCHIVE-TRUTH-DURABILITY-01 — build / validate / project archive truth snapshots.
 * Reuses DWR projection types and resolveDocumentWorkResult; no second extraction.
 */
import type {
  DocumentArchiveTruthFilingAudit,
  DocumentArchiveTruthSnapshot,
} from '../types/documentArchiveTruthSnapshot';
import { DOCUMENT_ARCHIVE_TRUTH_SNAPSHOT_SCHEMA_VERSION } from '../types/documentArchiveTruthSnapshot';
import {
  DOCUMENT_WORK_RESULT_SCHEMA_VERSION,
  type DocumentWorkResult,
} from '../types/documentWorkResult';
import type { DocumentWorkTruthView } from '../types/documentWorkTruth';
import type { InboxItem } from '../types/models';
import { buildDocumentWorkResultSourceFingerprint } from './documentWorkResultProjectionService';
import { resolveDocumentWorkResult } from './documentWorkResultResolveService';
import { getDocumentWorkResult } from './documentWorkResultStoreService';
import { getSyncClient } from './sync/syncClientService';
import { getWorkspaceStoreSnapshot } from './workspace/workspaceStore';

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveWorkspaceId(): string | null {
  return (
    getWorkspaceStoreSnapshot()?.id ??
    getSyncClient().serverWorkspaceId ??
    getSyncClient().workspaceId ??
    null
  );
}

/** Same gate as documentWorkResultService.isDocumentWorkResultCoreUsable (no facade import). */
function isDocumentWorkResultCoreUsable(
  result: Pick<DocumentWorkResult, 'businessInterpretation' | 'inboxItemId' | 'sourceFingerprint'>,
): boolean {
  if (!isNonEmptyString(result.inboxItemId)) return false;
  if (!isNonEmptyString(result.sourceFingerprint)) return false;
  return result.businessInterpretation != null;
}

/** Same rule as DWR store: mismatch only when both sides are non-empty and differ. */
export function archiveTruthSnapshotWorkspaceMismatch(
  snapshotWorkspaceId: string | null | undefined,
  requestedWorkspaceId: string | null | undefined,
): boolean {
  if (!isNonEmptyString(requestedWorkspaceId)) return false;
  if (!isNonEmptyString(snapshotWorkspaceId)) return false;
  return snapshotWorkspaceId !== requestedWorkspaceId;
}

function filingAuditFromInbox(
  item: InboxItem,
): DocumentArchiveTruthFilingAudit | undefined {
  const decision = item.filingDecision;
  if (!decision || decision.status !== 'confirmed') return undefined;
  const audit: DocumentArchiveTruthFilingAudit = {
    status: 'confirmed',
    scope: decision.scope,
    ...(decision.specialty !== undefined ? { specialty: decision.specialty } : {}),
    ...(decision.customerLabel !== undefined
      ? { customerLabel: decision.customerLabel }
      : {}),
    ...(decision.projectLabel !== undefined ? { projectLabel: decision.projectLabel } : {}),
    ...(decision.companyAreaId !== undefined
      ? { companyAreaId: decision.companyAreaId }
      : {}),
    ...(decision.documentKindLabelKey !== undefined
      ? { documentKindLabelKey: decision.documentKindLabelKey }
      : {}),
    ...(decision.companyAreaLabelKey !== undefined
      ? { companyAreaLabelKey: decision.companyAreaLabelKey }
      : {}),
    ...(decision.confirmedAt !== undefined ? { confirmedAt: decision.confirmedAt } : {}),
  };
  return audit;
}

/**
 * True when the snapshot has a durable BI core (safe to project to TruthView).
 * Does not invent facts; empty/missing BI → not usable.
 */
export function isDocumentArchiveTruthSnapshotUsable(
  snapshot: DocumentArchiveTruthSnapshot | null | undefined,
  options?: { workspaceId?: string | null },
): snapshot is DocumentArchiveTruthSnapshot {
  if (!snapshot) return false;
  if (snapshot.schemaVersion !== DOCUMENT_ARCHIVE_TRUTH_SNAPSHOT_SCHEMA_VERSION) {
    return false;
  }
  if (!isNonEmptyString(snapshot.sourceInboxItemId)) return false;
  if (!isNonEmptyString(snapshot.sourceFingerprint)) return false;
  if (snapshot.businessInterpretation == null) return false;
  if (
    archiveTruthSnapshotWorkspaceMismatch(
      snapshot.workspaceId,
      options?.workspaceId ?? resolveWorkspaceId(),
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Deep-clone a snapshot for store isolation (no shared mutable references).
 */
export function cloneDocumentArchiveTruthSnapshot(
  snapshot: DocumentArchiveTruthSnapshot,
): DocumentArchiveTruthSnapshot {
  return cloneJson(snapshot);
}

/**
 * Prefer an existing durable snapshot over a newly built one (immutability / idempotency).
 */
export function preferExistingArchiveTruthSnapshot(
  existing: DocumentArchiveTruthSnapshot | null | undefined,
  next: DocumentArchiveTruthSnapshot | null | undefined,
  options?: { workspaceId?: string | null },
): DocumentArchiveTruthSnapshot | undefined {
  if (isDocumentArchiveTruthSnapshotUsable(existing, options)) {
    return cloneDocumentArchiveTruthSnapshot(existing);
  }
  if (isDocumentArchiveTruthSnapshotUsable(next, options)) {
    return cloneDocumentArchiveTruthSnapshot(next);
  }
  return undefined;
}

/**
 * Build an archive truth snapshot from the current inbox item + its DWR.
 * No re-analysis. Returns undefined when no durable DWR core is available.
 */
export function buildDocumentArchiveTruthSnapshotFromInbox(input: {
  item: InboxItem;
  documentWorkResult?: DocumentWorkResult | null;
  workspaceId?: string | null;
  createdAt?: string;
}): DocumentArchiveTruthSnapshot | undefined {
  const workspaceId =
    input.workspaceId !== undefined ? input.workspaceId : resolveWorkspaceId();
  const stored =
    input.documentWorkResult !== undefined
      ? input.documentWorkResult
      : getDocumentWorkResult(input.item.id, { workspaceId });

  if (!stored) return undefined;
  if (stored.inboxItemId !== input.item.id) return undefined;
  if (archiveTruthSnapshotWorkspaceMismatch(stored.workspaceId, workspaceId)) {
    return undefined;
  }
  if (!isDocumentWorkResultCoreUsable(stored)) return undefined;
  // Same freshness gate as display: do not freeze a stale/unmatched DWR as archive truth.
  if (stored.sourceFingerprint !== buildDocumentWorkResultSourceFingerprint(input.item)) {
    return undefined;
  }

  const filingDecision = filingAuditFromInbox(input.item);
  const snapshot: DocumentArchiveTruthSnapshot = {
    schemaVersion: DOCUMENT_ARCHIVE_TRUTH_SNAPSHOT_SCHEMA_VERSION,
    workspaceId: stored.workspaceId ?? workspaceId ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
    sourceInboxItemId: stored.inboxItemId,
    analyzedAt: stored.analyzedAt,
    analysisVersion: stored.analysisVersion,
    sourceFingerprint: stored.sourceFingerprint,
    businessInterpretation: cloneJson(stored.businessInterpretation),
    specialistRefs: cloneJson(stored.specialistRefs),
    overlay: cloneJson(stored.overlay),
    ...(filingDecision ? { filingDecision } : {}),
  };

  if (!isDocumentArchiveTruthSnapshotUsable(snapshot, { workspaceId })) {
    return undefined;
  }
  return snapshot;
}

/**
 * Project a durable archive snapshot into an ephemeral TruthView via existing DWR resolver.
 */
export function resolveDocumentWorkTruthViewFromArchiveSnapshot(
  snapshot: DocumentArchiveTruthSnapshot,
  options?: { workspaceId?: string | null },
): DocumentWorkTruthView | null {
  if (!isDocumentArchiveTruthSnapshotUsable(snapshot, options)) {
    return null;
  }

  const asDwr: DocumentWorkResult = {
    schemaVersion: DOCUMENT_WORK_RESULT_SCHEMA_VERSION,
    inboxItemId: snapshot.sourceInboxItemId,
    workspaceId: snapshot.workspaceId ?? null,
    analyzedAt: snapshot.analyzedAt,
    analysisVersion: snapshot.analysisVersion,
    sourceFingerprint: snapshot.sourceFingerprint,
    businessInterpretation: cloneJson(snapshot.businessInterpretation),
    specialistRefs: cloneJson(snapshot.specialistRefs),
    overlay: cloneJson(snapshot.overlay),
  };

  return resolveDocumentWorkResult({
    documentWorkResult: asDwr,
    liveBusinessInterpretation: null,
    inboxItemId: snapshot.sourceInboxItemId,
  });
}
