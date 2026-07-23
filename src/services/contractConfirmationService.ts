import { generateEntityId } from './sync/syncMetaService';
import { isSnapshotAlignable } from './contractPositionAlignService';
import {
  getVorgangById,
  replaceVorgangContractConfirmation,
  saveVorgangContractConfirmation,
} from './vorgangService';
import type {
  ConfirmedContractPositionSnapshot,
  ContractConfirmationSnapshot,
  NegotiationDraftSnapshot,
  NegotiationPriceProposal,
  Vorgang,
} from '../types/models';

export type ContractConfirmationResult =
  | { success: true; vorgang: Vorgang; snapshot: ContractConfirmationSnapshot }
  | {
      success: false;
      errorKey:
        | 'vorgang.notFound'
        | 'vorgang.status.invalidTransition'
        | 'confirmation.notInNegotiation'
        | 'confirmation.alreadyExists'
        | 'confirmation.snapshotImmutable'
        | 'confirmation.negotiationClosed'
        | 'confirmation.alignFailed';
    };

function latestPriceProposal(
  proposals: NegotiationPriceProposal[],
  orderPositionId: string,
): NegotiationPriceProposal | undefined {
  for (let i = proposals.length - 1; i >= 0; i -= 1) {
    if (proposals[i]?.orderPositionId === orderPositionId) {
      return proposals[i];
    }
  }
  return undefined;
}

function collectDraftHistory(vorgang: Vorgang): NegotiationDraftSnapshot[] {
  const negotiation = vorgang.negotiation;
  if (!negotiation) return [];
  const history = [...(negotiation.draftHistory ?? [])];
  if (negotiation.draft) {
    history.push({ ...negotiation.draft, sendConfirmed: false as const });
  }
  return history;
}

function buildConfirmationSnapshot(vorgang: Vorgang, confirmedAt: string): ContractConfirmationSnapshot {
  const negotiation = vorgang.negotiation;
  const priceProposals = negotiation?.priceProposals ?? [];

  const positions: ConfirmedContractPositionSnapshot[] = vorgang.orderPositions.map((position) => {
    const proposal = latestPriceProposal(priceProposals, position.id);
    return {
      id: position.id,
      description: position.description,
      plannedQuantity: position.plannedQuantity,
      unit: position.unit,
      unitLabel: position.unitLabel,
      unitPrice: proposal?.proposedUnitPrice ?? position.unitPrice,
      category: position.category,
      billable: position.billable,
    };
  });

  const drafts = collectDraftHistory(vorgang);

  return {
    id: generateEntityId('contract-confirm'),
    confirmedAt,
    customer: vorgang.customer,
    auftraggeber: vorgang.customerBilling?.name?.trim() || vorgang.customer,
    baustelle: vorgang.baustelle,
    title: vorgang.title,
    positions,
    negotiation: {
      notes: [...(negotiation?.notes ?? [])],
      generalHints: [...(negotiation?.generalHints ?? [])],
      priceProposals: priceProposals.map((p) => ({ ...p })),
      positionProposals: (negotiation?.positionProposals ?? []).map((p) => ({ ...p })),
      drafts,
    },
    immutable: true,
  };
}

/**
 * Explicit user confirmation: freeze snapshot, close negotiation, set status beauftragt.
 * Does not mutate linked original contract documents.
 */
export function confirmContractOrder(vorgangId: string): ContractConfirmationResult {
  const current = getVorgangById(vorgangId);
  if (!current) {
    return { success: false, errorKey: 'vorgang.notFound' };
  }

  if (current.contractConfirmation) {
    return { success: false, errorKey: 'confirmation.alreadyExists' };
  }

  if (current.status !== 'in_verhandlung') {
    return { success: false, errorKey: 'confirmation.notInNegotiation' };
  }

  if (current.negotiation?.closed) {
    return { success: false, errorKey: 'confirmation.negotiationClosed' };
  }

  const confirmedAt = new Date().toISOString();
  const snapshot = buildConfirmationSnapshot(current, confirmedAt);
  if (!isSnapshotAlignable(snapshot)) {
    return { success: false, errorKey: 'confirmation.alignFailed' };
  }

  const draftHistory = collectDraftHistory(current);

  const closedNegotiation = {
    startedAt: current.negotiation?.startedAt ?? confirmedAt,
    closed: true,
    completedAt: confirmedAt,
    notes: [...(current.negotiation?.notes ?? [])],
    generalHints: [...(current.negotiation?.generalHints ?? [])],
    priceProposals: (current.negotiation?.priceProposals ?? []).map((p) => ({ ...p })),
    positionProposals: (current.negotiation?.positionProposals ?? []).map((p) => ({ ...p })),
    draft: current.negotiation?.draft
      ? { ...current.negotiation.draft, sendConfirmed: false as const }
      : null,
    draftHistory,
  };

  // Atomic: snapshot + aligned orderPositions + closed negotiation + beauftragt
  const saved = saveVorgangContractConfirmation(vorgangId, snapshot, closedNegotiation);
  if (!saved.success) {
    return { success: false, errorKey: saved.errorKey };
  }

  return {
    success: true,
    vorgang: saved.vorgang,
    snapshot: saved.vorgang.contractConfirmation!,
  };
}

export function getContractConfirmation(
  vorgangId: string,
): ContractConfirmationSnapshot | null {
  return getVorgangById(vorgangId)?.contractConfirmation ?? null;
}

/** Always rejects mutation of an existing snapshot (immutability guard for tests/API). */
export function tryUpdateContractConfirmationSnapshot(
  vorgangId: string,
  next: ContractConfirmationSnapshot,
): ContractConfirmationResult {
  const result = replaceVorgangContractConfirmation(vorgangId, next);
  if (!result.success) {
    return { success: false, errorKey: result.errorKey };
  }
  return { success: false, errorKey: 'confirmation.snapshotImmutable' };
}

export function isContractConfirmationImmutable(
  snapshot: ContractConfirmationSnapshot | null | undefined,
): boolean {
  return Boolean(snapshot?.immutable);
}
