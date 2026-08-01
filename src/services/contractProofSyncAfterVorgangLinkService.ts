/**
 * CONTRACT-PROOF-SYNC-ORDER-01 — thin post-link reconciliation for contract proof requirements.
 * Reuses existing analyze/sync helpers; no second proof engine.
 */
import type { ClassifiedDocumentKind, CompanyDocument, InboxItem } from '../types/models';
import type { MemoryRelation, ProofMemory } from '../types/memory';
import {
  analyzeContract,
  analyzeContractFromInbox,
} from './contractAnalysisService';
import { analyzeContractIntelligenceFromInbox } from './contractIntelligenceService';
import {
  buildRequiredDocumentsFromContractIntelligence,
  toRequiredDocuments,
} from './contractProofRequirementsFromIntelligence';
import { archiveTruthSnapshotWorkspaceMismatch } from './documentArchiveTruthSnapshotService';
import { getInboxItemById } from './inboxService';
import { syncContractProofRequirements } from './officePilotMemoryService';
import { persistAll } from './persistenceService';
import { getSyncClient } from './sync/syncClientService';
import { getVorgangById } from './vorgangService';
import { getWorkspaceStoreSnapshot } from './workspace/workspaceStore';
import type { ContractIntelligenceResult } from '../types/documentIntelligence';

export type SyncContractProofAfterVorgangLinkStatus =
  | 'synced'
  | 'noop_not_contract'
  | 'noop_no_requirements'
  | 'skipped_no_vorgang'
  | 'source_unavailable'
  | 'workspace_rejected'
  | 'persist_failed'
  | 'vorgang_not_found';

export type SyncContractProofAfterVorgangLinkResult = {
  status: SyncContractProofAfterVorgangLinkStatus;
  message?: string;
  relations?: MemoryRelation[];
  missingProofs?: ProofMemory[];
};

export type SyncContractProofAfterVorgangLinkInput = {
  vorgangId: string | null | undefined;
  /** Preferred source after Smart Intake create/link. */
  inboxItem?: InboxItem | null;
  /** Fallback / late manual archive link. */
  document?: CompanyDocument | null;
  /** Optional explicit workspace gate (same rule as DWR / archive truth). */
  workspaceId?: string | null;
  /** Default true — set false only when caller persists immediately after. */
  persist?: boolean;
  /**
   * When provided (including null), skips analyzeContractIntelligenceFromInbox.
   * Omit to analyze from the inbox item (standalone callers / archive link).
   */
  precomputedIntelligence?: ContractIntelligenceResult | null;
};

const CONTRACT_CLASSIFIED_KINDS = new Set<ClassifiedDocumentKind>([
  'werkvertrag',
  'subunternehmervertrag',
  'nachunternehmervertrag',
  'auftrag',
  'leistungsverzeichnis',
]);

function resolveWorkspaceId(): string | null {
  return (
    getWorkspaceStoreSnapshot()?.id ??
    getSyncClient().serverWorkspaceId ??
    getSyncClient().workspaceId ??
    null
  );
}

function isExpectedContractInbox(item: InboxItem): boolean {
  // Only explicit contract classifications — not every kundenauftrag.
  return Boolean(item.classifiedKind && CONTRACT_CLASSIFIED_KINDS.has(item.classifiedKind));
}

function isExpectedContractDocument(document: CompanyDocument): boolean {
  if (document.category === 'vertrag') return true;
  if (document.classifiedKind && CONTRACT_CLASSIFIED_KINDS.has(document.classifiedKind)) {
    return true;
  }
  return false;
}

function inboxPayloadText(item: InboxItem): string {
  return Object.values(item.recognizedData ?? {}).join('\n').trim();
}

type ResolvedProofSource =
  | {
      kind: 'ready';
      requiredDocuments: ReturnType<typeof analyzeContract>['requiredDocuments'];
      sourceInboxId: string;
    }
  | { kind: 'noop_not_contract' }
  | { kind: 'noop_no_requirements' }
  | { kind: 'source_unavailable'; message: string };

function resolveContractIntelligence(
  item: InboxItem,
  precomputedIntelligence?: ContractIntelligenceResult | null,
): ContractIntelligenceResult | null {
  return precomputedIntelligence !== undefined
    ? precomputedIntelligence
    : analyzeContractIntelligenceFromInbox(item);
}

function resolveFromInbox(
  item: InboxItem,
  precomputedIntelligence?: ContractIntelligenceResult | null,
): ResolvedProofSource {
  // Expected contract without payload text: do not treat title-only hints as success.
  if (isExpectedContractInbox(item) && !inboxPayloadText(item)) {
    return {
      kind: 'source_unavailable',
      message: 'Vertragsdokument ohne verwertbare Textquelle für Proof-Sync.',
    };
  }

  const analysis = analyzeContractFromInbox(item);
  const intelligence = resolveContractIntelligence(item, precomputedIntelligence);
  const requiredDocuments = toRequiredDocuments(
    buildRequiredDocumentsFromContractIntelligence(
      intelligence,
      analysis.isContract ? analysis.requiredDocuments : [],
    ),
  );

  if (requiredDocuments.length > 0) {
    return {
      kind: 'ready',
      requiredDocuments,
      sourceInboxId: item.id,
    };
  }

  if (analysis.isContract) {
    return { kind: 'noop_no_requirements' };
  }

  return { kind: 'noop_not_contract' };
}

function resolveFromDocument(
  document: CompanyDocument,
  precomputedIntelligence?: ContractIntelligenceResult | null,
): ResolvedProofSource {
  const recognizedText = (document.recognizedText ?? '').trim();
  // Expected contract without body text: title/kind alone is not a usable proof source.
  if (isExpectedContractDocument(document) && !recognizedText) {
    return {
      kind: 'source_unavailable',
      message: 'Vertragsdokument ohne verwertbare Textquelle für Proof-Sync.',
    };
  }

  const analysis = analyzeContract({
    recognizedText,
    titleHint: document.title,
    senderHint: document.issuer,
    kindHint: document.classifiedKind,
    sourceFileName: document.originalFileName,
  });

  if (analysis.isContract) {
    const linkedInbox = document.sourceInboxItemId
      ? getInboxItemById(document.sourceInboxItemId)
      : null;
    const intelligence = linkedInbox
      ? resolveContractIntelligence(linkedInbox, precomputedIntelligence)
      : precomputedIntelligence !== undefined
        ? precomputedIntelligence
        : null;
    const requiredDocuments = toRequiredDocuments(
      buildRequiredDocumentsFromContractIntelligence(
        intelligence,
        analysis.requiredDocuments,
      ),
    );
    if (requiredDocuments.length === 0) {
      return { kind: 'noop_no_requirements' };
    }
    return {
      kind: 'ready',
      requiredDocuments,
      sourceInboxId: document.sourceInboxItemId?.trim() || document.id,
    };
  }

  return { kind: 'noop_not_contract' };
}

/**
 * After authoritative vorgang create/link: sync contract proof requirements idempotently.
 */
export function syncContractProofRequirementsAfterVorgangLink(
  input: SyncContractProofAfterVorgangLinkInput,
): SyncContractProofAfterVorgangLinkResult {
  const vorgangId = typeof input.vorgangId === 'string' ? input.vorgangId.trim() : '';
  if (!vorgangId) {
    return { status: 'skipped_no_vorgang' };
  }

  const ambientWorkspaceId = resolveWorkspaceId();
  const gateWorkspaceId =
    input.workspaceId !== undefined ? input.workspaceId : ambientWorkspaceId;

  if (archiveTruthSnapshotWorkspaceMismatch(gateWorkspaceId, ambientWorkspaceId)) {
    return {
      status: 'workspace_rejected',
      message: 'Proof-Sync abgelehnt: Workspace stimmt nicht überein.',
    };
  }

  if (!getVorgangById(vorgangId)) {
    return {
      status: 'vorgang_not_found',
      message: 'Proof-Sync abgelehnt: Vorgang im aktuellen Workspace nicht gefunden.',
    };
  }

  const document = input.document ?? null;
  if (
    document?.archiveTruthSnapshot &&
    archiveTruthSnapshotWorkspaceMismatch(
      document.archiveTruthSnapshot.workspaceId,
      gateWorkspaceId ?? ambientWorkspaceId,
    )
  ) {
    return {
      status: 'workspace_rejected',
      message: 'Proof-Sync abgelehnt: Dokument-Workspace stimmt nicht überein.',
    };
  }

  let inboxItem = input.inboxItem ?? null;
  if (!inboxItem && document?.sourceInboxItemId) {
    inboxItem = getInboxItemById(document.sourceInboxItemId) ?? null;
  }

  const precomputedIntelligence = input.precomputedIntelligence;
  let resolved: ResolvedProofSource | null = null;

  if (inboxItem) {
    resolved = resolveFromInbox(inboxItem, precomputedIntelligence);
    if (resolved.kind === 'noop_not_contract' && document) {
      resolved = resolveFromDocument(document, precomputedIntelligence);
    }
  } else if (document) {
    resolved = resolveFromDocument(document, precomputedIntelligence);
  } else {
    return { status: 'noop_not_contract' };
  }

  if (resolved.kind === 'noop_not_contract') {
    return { status: 'noop_not_contract' };
  }
  if (resolved.kind === 'noop_no_requirements') {
    return { status: 'noop_no_requirements' };
  }
  if (resolved.kind === 'source_unavailable') {
    return { status: 'source_unavailable', message: resolved.message };
  }

  const synced = syncContractProofRequirements(
    vorgangId,
    resolved.sourceInboxId,
    resolved.requiredDocuments,
  );

  if (input.persist !== false) {
    const persistResult = persistAll();
    if (!persistResult.success) {
      return {
        status: 'persist_failed',
        message: 'Proof-Sync konnte nicht dauerhaft gespeichert werden.',
        relations: synced.relations,
        missingProofs: synced.missingProofs,
      };
    }
  }

  return {
    status: 'synced',
    relations: synced.relations,
    missingProofs: synced.missingProofs,
  };
}

export function isContractProofSyncHardFailure(
  result: SyncContractProofAfterVorgangLinkResult,
): boolean {
  return (
    result.status === 'persist_failed' ||
    result.status === 'source_unavailable' ||
    result.status === 'workspace_rejected' ||
    result.status === 'vorgang_not_found'
  );
}
