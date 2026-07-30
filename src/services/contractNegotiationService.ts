import { buildCommunicationContext } from './communicationContextService';
import { confirmContractOrder } from './contractConfirmationService';
import { buildNegotiationDraftCore } from './communicationDraftService';
import { generateEntityId } from './sync/syncMetaService';
import {
  getVorgangById,
  saveVorgangNegotiation,
  updateVorgangStatus,
} from './vorgangService';
import type {
  ContractNegotiationState,
  NegotiationDraftKind,
  NegotiationDraftSnapshot,
  NegotiationPositionProposal,
  NegotiationPriceProposal,
  OrderPosition,
  Vorgang,
  VorgangStatus,
} from '../types/models';

export type NegotiationResult =
  | { success: true; vorgang: Vorgang }
  | {
      success: false;
      errorKey:
        | 'vorgang.notFound'
        | 'vorgang.status.invalidTransition'
        | 'negotiation.positionNotFound'
        | 'negotiation.invalidPrice'
        | 'negotiation.draftFailed'
        | 'negotiation.notInNegotiation'
        | 'negotiation.closed'
        | 'confirmation.alreadyExists'
        | 'confirmation.notInNegotiation'
        | 'confirmation.negotiationClosed'
        | 'confirmation.snapshotImmutable'
        | 'confirmation.alignFailed'
        | 'confirmation.persistFailed';
    };

function emptyNegotiation(startedAt?: string): ContractNegotiationState {
  return {
    startedAt,
    closed: false,
    notes: [],
    generalHints: [],
    priceProposals: [],
    positionProposals: [],
    draft: null,
    draftHistory: [],
  };
}

function ensureState(vorgang: Vorgang): ContractNegotiationState {
  return vorgang.negotiation
    ? {
        startedAt: vorgang.negotiation.startedAt,
        closed: vorgang.negotiation.closed === true,
        completedAt: vorgang.negotiation.completedAt,
        notes: [...vorgang.negotiation.notes],
        generalHints: [...vorgang.negotiation.generalHints],
        priceProposals: vorgang.negotiation.priceProposals.map((p) => ({ ...p })),
        positionProposals: vorgang.negotiation.positionProposals.map((p) => ({ ...p })),
        draft: vorgang.negotiation.draft ? { ...vorgang.negotiation.draft } : null,
        draftHistory: (vorgang.negotiation.draftHistory ?? []).map((d) => ({ ...d })),
      }
    : emptyNegotiation();
}

function isNegotiationClosed(vorgang: Vorgang): boolean {
  return Boolean(vorgang.negotiation?.closed || vorgang.contractConfirmation);
}

function persist(vorgangId: string, negotiation: ContractNegotiationState): NegotiationResult {
  const saved = saveVorgangNegotiation(vorgangId, negotiation);
  if (!saved.success) {
    return { success: false, errorKey: saved.errorKey };
  }
  return { success: true, vorgang: saved.vorgang };
}

/**
 * Moves the Vorgang into `in_verhandlung` via lifecycle steps.
 * Does not jump to `beauftragt`.
 */
export function startContractNegotiation(vorgangId: string): NegotiationResult {
  const current = getVorgangById(vorgangId);
  if (!current) {
    return { success: false, errorKey: 'vorgang.notFound' };
  }

  if (isNegotiationClosed(current)) {
    return { success: false, errorKey: 'negotiation.closed' };
  }

  let status: VorgangStatus = current.status;

  if (status === 'beauftragt' || status === 'in_bearbeitung' || status === 'wartet' || status === 'abgeschlossen') {
    return { success: false, errorKey: 'vorgang.status.invalidTransition' };
  }

  if (status === 'eingegangen') {
    const step = updateVorgangStatus(vorgangId, 'in_pruefung');
    if (!step.success) {
      return { success: false, errorKey: step.errorKey };
    }
    status = step.vorgang.status;
  }

  if (status === 'in_pruefung') {
    const step = updateVorgangStatus(vorgangId, 'in_verhandlung');
    if (!step.success) {
      return { success: false, errorKey: step.errorKey };
    }
    status = step.vorgang.status;
  }

  if (status !== 'in_verhandlung') {
    return { success: false, errorKey: 'vorgang.status.invalidTransition' };
  }

  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) {
    return { success: false, errorKey: 'vorgang.notFound' };
  }

  const negotiation = ensureState(vorgang);
  if (!negotiation.startedAt) {
    negotiation.startedAt = new Date().toISOString();
  }

  return persist(vorgangId, negotiation);
}

/**
 * Explicit confirmation path — delegates to contractConfirmationService
 * (snapshot + close negotiation + beauftragt).
 */
export function confirmNegotiationBeauftragt(vorgangId: string): NegotiationResult {
  const result = confirmContractOrder(vorgangId);
  if (!result.success) {
    return { success: false, errorKey: result.errorKey };
  }
  return { success: true, vorgang: result.vorgang };
}

export function addNegotiationNote(vorgangId: string, note: string): NegotiationResult {
  const trimmed = note.trim();
  if (!trimmed) {
    return { success: false, errorKey: 'negotiation.draftFailed' };
  }
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) {
    return { success: false, errorKey: 'vorgang.notFound' };
  }
  if (isNegotiationClosed(vorgang)) {
    return { success: false, errorKey: 'negotiation.closed' };
  }
  const negotiation = ensureState(vorgang);
  negotiation.notes.push(trimmed);
  return persist(vorgangId, negotiation);
}

export function addNegotiationGeneralHint(vorgangId: string, hint: string): NegotiationResult {
  const trimmed = hint.trim();
  if (!trimmed) {
    return { success: false, errorKey: 'negotiation.draftFailed' };
  }
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) {
    return { success: false, errorKey: 'vorgang.notFound' };
  }
  if (isNegotiationClosed(vorgang)) {
    return { success: false, errorKey: 'negotiation.closed' };
  }
  const negotiation = ensureState(vorgang);
  negotiation.generalHints.push(trimmed);
  return persist(vorgangId, negotiation);
}

/**
 * Stores a price proposal on the Vorgang.
 * Leaves `orderPositions` and linked contract documents unchanged.
 */
export function addNegotiationPriceProposal(
  vorgangId: string,
  input: {
    orderPositionId: string;
    proposedUnitPrice: number;
    note?: string;
  },
): NegotiationResult {
  if (!Number.isFinite(input.proposedUnitPrice) || input.proposedUnitPrice < 0) {
    return { success: false, errorKey: 'negotiation.invalidPrice' };
  }

  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) {
    return { success: false, errorKey: 'vorgang.notFound' };
  }
  if (isNegotiationClosed(vorgang)) {
    return { success: false, errorKey: 'negotiation.closed' };
  }

  const position = vorgang.orderPositions.find((p) => p.id === input.orderPositionId);
  if (!position) {
    return { success: false, errorKey: 'negotiation.positionNotFound' };
  }

  const proposal: NegotiationPriceProposal = {
    id: generateEntityId('neg-price'),
    orderPositionId: position.id,
    positionLabel: position.description,
    originalUnitPrice: position.unitPrice,
    proposedUnitPrice: input.proposedUnitPrice,
    unit: position.unit,
    note: input.note?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };

  const negotiation = ensureState(vorgang);
  negotiation.priceProposals.push(proposal);
  return persist(vorgangId, negotiation);
}

export function addNegotiationPositionProposal(
  vorgangId: string,
  input: Omit<NegotiationPositionProposal, 'id' | 'createdAt'>,
): NegotiationResult {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) {
    return { success: false, errorKey: 'vorgang.notFound' };
  }
  if (isNegotiationClosed(vorgang)) {
    return { success: false, errorKey: 'negotiation.closed' };
  }

  const proposal: NegotiationPositionProposal = {
    id: generateEntityId('neg-pos'),
    description: input.description.trim(),
    proposedUnitPrice: input.proposedUnitPrice,
    proposedQuantity: input.proposedQuantity,
    unit: input.unit,
    note: input.note?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };

  if (!proposal.description) {
    return { success: false, errorKey: 'negotiation.draftFailed' };
  }

  const negotiation = ensureState(vorgang);
  negotiation.positionProposals.push(proposal);
  return persist(vorgangId, negotiation);
}

export function prepareNegotiationDraft(
  vorgangId: string,
  kind: NegotiationDraftKind,
  options: {
    priceProposalId?: string;
    message?: string;
    appointmentDate?: string;
  } = {},
): NegotiationResult {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) {
    return { success: false, errorKey: 'vorgang.notFound' };
  }
  if (isNegotiationClosed(vorgang)) {
    return { success: false, errorKey: 'negotiation.closed' };
  }

  const negotiation = ensureState(vorgang);
  const context = buildCommunicationContext({ type: 'vorgang', id: vorgangId });

  let priceProposal: NegotiationPriceProposal | undefined;
  if (options.priceProposalId) {
    priceProposal = negotiation.priceProposals.find((p) => p.id === options.priceProposalId);
  } else if (kind === 'price_change') {
    priceProposal = negotiation.priceProposals[negotiation.priceProposals.length - 1];
  }

  const core = buildNegotiationDraftCore(
    {
      kind,
      positionLabel: priceProposal?.positionLabel,
      originalUnitPrice: priceProposal?.originalUnitPrice,
      proposedUnitPrice: priceProposal?.proposedUnitPrice,
      unit: priceProposal?.unit,
      message: options.message ?? priceProposal?.note,
      appointmentDate: options.appointmentDate,
    },
    context,
  );

  if (!core) {
    return { success: false, errorKey: 'negotiation.draftFailed' };
  }

  const draft: NegotiationDraftSnapshot = {
    id: generateEntityId('neg-draft'),
    kind,
    intent:
      core.intent === 'price_adjustment' ||
      core.intent === 'document_reply' ||
      core.intent === 'appointment_change'
        ? core.intent
        : 'document_reply',
    subject: core.subject ?? 'Verhandlungsentwurf',
    body: core.body,
    createdAt: new Date().toISOString(),
    sendConfirmed: false,
  };

  if (negotiation.draft) {
    negotiation.draftHistory = [...(negotiation.draftHistory ?? []), negotiation.draft];
  }
  negotiation.draft = draft;
  return persist(vorgangId, negotiation);
}

export function getContractNegotiation(vorgangId: string): ContractNegotiationState | null {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return null;
  return vorgang.negotiation ? ensureState(vorgang) : null;
}

/** Snapshot of order position prices — used by tests to prove originals stay untouched. */
export function snapshotOrderPositionPrices(vorgang: Vorgang): Array<Pick<OrderPosition, 'id' | 'unitPrice'>> {
  return vorgang.orderPositions.map((p) => ({ id: p.id, unitPrice: p.unitPrice }));
}
