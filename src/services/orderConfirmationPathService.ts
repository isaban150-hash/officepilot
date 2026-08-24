/**
 * BUSINESS-STATE-DIRECT-CONFIRMATION-01B — which confirmation path a Vorgang
 * may offer.
 *
 * A signed subcontract documents an order that already exists; asking the user
 * to open a price negotiation before confirming it is factually wrong. An offer
 * documents nothing of the sort — there the negotiation step is exactly right.
 * The distinction is the business state, never the document name alone, and it
 * decides only which path the UI may offer: this module reads no store, writes
 * nothing and confirms nothing.
 */
import { analyzeContractIntelligenceFromInbox } from './contractIntelligenceService';
import { getCompanyProfile } from './companyProfileService';
import { getInboxItemById } from './inboxService';
import { findOwnCompanyParty } from './ownCompanyPartyResolver';
import type { ClassifiedDocumentKind, OrderPosition, Vorgang } from '../types/models';
import type { ContractFamily, ContractPartyRole } from '../types/documentIntelligence';

export type OrderConfirmationPath =
  /** The documented order stand may be reviewed and confirmed directly. */
  | 'direct_confirmation_review'
  /** Initiation or explicit negotiation — the existing path stays mandatory. */
  | 'negotiation'
  /** Not enough certainty for a shortcut — safety before convenience. */
  | 'unclear';

export interface OrderConfirmationPathSignals {
  /** Document kind as classified on intake. */
  classifiedKind?: ClassifiedDocumentKind | string;
  /** Contract family from contract intelligence, when the document is one. */
  contractFamily?: ContractFamily;
  /** Role of the own company, as far as it could be determined at all. */
  ownCompanyRole?: ContractPartyRole | 'unknown';
  /** Name of the recognised counterparty. */
  counterpartyName?: string;
  /** How many order positions were taken over from the document. */
  positionCount?: number;
  /** Whether those positions carry usable quantities and prices. */
  positionsUsable?: boolean;
}

/**
 * Kinds that document an order which has already been placed. `auftrag` and
 * `auftragsbestaetigung` mirror the existing ORDER_CONFIRM_KINDS semantics of
 * businessInterpretationService; the contract kinds are those where signing is
 * itself the placement of the order.
 */
const ALREADY_ORDERED_KINDS: ReadonlySet<string> = new Set([
  'auftrag',
  'auftragsbestaetigung',
  'werkvertrag',
  'subunternehmervertrag',
  'nachunternehmervertrag',
]);

/**
 * Kinds that are an initiation and nothing more. Listed explicitly and checked
 * first: an offer carrying a customer, positions, prices and a total is still
 * an offer, and completeness must never turn it into a placed order.
 */
const INITIATION_ONLY_KINDS: ReadonlySet<string> = new Set([
  'angebot',
  'kostenvoranschlag',
  'anfrage',
]);

/** Contract families where signing places the order on the own company. */
const ALREADY_ORDERED_FAMILIES: ReadonlySet<ContractFamily> = new Set([
  'werkvertrag',
  'subunternehmervertrag',
]);

/** Roles in which the own company is the commissioned side. */
const COMMISSIONED_ROLES: ReadonlySet<string> = new Set([
  'auftragnehmer',
  'subunternehmer',
  'nachunternehmer',
  'dienstleister',
]);

/**
 * Decides which path may be offered. Deliberately conservative: everything that
 * is not clearly an already-placed order keeps the existing route.
 *
 * A `direct_confirmation_review` result asserts only that a commercial review
 * and confirmation is admissible — never that the document is legally binding,
 * and never that anything may be confirmed without the user.
 */
export function resolveOrderConfirmationPath(
  signals: OrderConfirmationPathSignals,
): OrderConfirmationPath {
  const kind = signals.classifiedKind?.trim().toLowerCase();

  // Initiation wins over every completeness signal.
  if (kind && INITIATION_ONLY_KINDS.has(kind)) return 'negotiation';

  const documentsPlacedOrder =
    (kind !== undefined && ALREADY_ORDERED_KINDS.has(kind)) ||
    (signals.contractFamily !== undefined && ALREADY_ORDERED_FAMILIES.has(signals.contractFamily));
  if (!documentsPlacedOrder) return 'unclear';

  // The own company must be the commissioned side — otherwise the document
  // describes an order we placed, which is a different business state.
  const role = signals.ownCompanyRole;
  if (!role || role === 'unknown' || !COMMISSIONED_ROLES.has(role)) return 'unclear';

  if (!signals.counterpartyName?.trim()) return 'unclear';

  if (!signals.positionsUsable) return 'unclear';
  if ((signals.positionCount ?? 0) < 1) return 'unclear';

  return 'direct_confirmation_review';
}

/** True only for the one path that may skip the negotiation step. */
export function allowsDirectConfirmationReview(
  signals: OrderConfirmationPathSignals | undefined,
): boolean {
  if (!signals) return false;
  return resolveOrderConfirmationPath(signals) === 'direct_confirmation_review';
}

/** A position is usable for a snapshot when quantity and price are real numbers. */
function isUsablePosition(position: OrderPosition): boolean {
  return (
    Number.isFinite(position.plannedQuantity) &&
    position.plannedQuantity >= 0 &&
    Number.isFinite(position.unitPrice) &&
    position.unitPrice >= 0 &&
    Boolean(position.unit)
  );
}

/**
 * Collects the signals for an existing Vorgang from the document it came from.
 * Read-only: no store is written, nothing is confirmed. When the originating
 * inbox item is gone the signals stay incomplete on purpose, and the resolver
 * then answers `unclear` — the long route.
 */
export function collectOrderConfirmationSignals(
  vorgang: Pick<Vorgang, 'customer' | 'orderPositions' | 'createdFromInboxId'>,
): OrderConfirmationPathSignals {
  const positions = vorgang.orderPositions ?? [];
  const base: OrderConfirmationPathSignals = {
    counterpartyName: vorgang.customer,
    positionCount: positions.length,
    positionsUsable: positions.length > 0 && positions.every(isUsablePosition),
  };

  const item = vorgang.createdFromInboxId ? getInboxItemById(vorgang.createdFromInboxId) : null;
  if (!item) return base;

  const intelligence = analyzeContractIntelligenceFromInbox(item);
  // Identity first — the role of that party is read afterwards and only serves
  // as the direction check inside resolveOrderConfirmationPath.
  const ownParty = findOwnCompanyParty(intelligence?.parties, getCompanyProfile());

  return {
    ...base,
    classifiedKind: item.classifiedKind,
    contractFamily: intelligence?.contractType?.family,
    ownCompanyRole: ownParty?.role,
  };
}

/** Convenience wrapper for the UI — same pure decision, signals collected first. */
export function resolveOrderConfirmationPathForVorgang(
  vorgang: Pick<Vorgang, 'customer' | 'orderPositions' | 'createdFromInboxId'>,
): { path: OrderConfirmationPath; signals: OrderConfirmationPathSignals } {
  const signals = collectOrderConfirmationSignals(vorgang);
  return { path: resolveOrderConfirmationPath(signals), signals };
}
