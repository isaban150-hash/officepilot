/**
 * ANGEBOT-01B — Cloud-Anbindung der eigenen Angebote.
 *
 * Nur Transport: Payload, Inhaltsschlüssel, Lesen der Serverzeile, Merge,
 * Altbestand und Wiederanlauf nach verlorener Bestätigung. Keine Fachlogik —
 * die liegt in `offerService`. Die **Freigabe** (Nummernvergabe) läuft nicht
 * über die generische Schreibfunktion, sondern über `finalize_workspace_offer`
 * (`offerFinalizeCloudService`).
 *
 * Aufgebaut nach dem Muster von `businessLetterCloudService`: dieselbe
 * Versionssemantik, dieselbe Konfliktregel, derselbe Wiederanlauf.
 */
import { mergeSyncEntities } from '../sync/syncMergeEngine';
import {
  planLostAckAdoption,
  type LostAckAdoptionPlan,
  type LostAckRemoteRow,
  type LostAckSentWrite,
} from '../sync/syncLostAckAdoptionService';
import type { CompanyProfile, CustomerBilling, TaxStatus } from '../../types/models';
import type { BrandingSnapshot } from '../../types/branding';
import { OFFER_STATUSES, type Offer, type OfferPosition, type OfferStatus, type OfferTotals } from '../../types/offer';
import type { SyncMeta } from '../../types/sync';
import { normalizeOfferPosition } from './offerService';

/** Zeile aus `public.workspace_offers` — exakt die Spalten der Migration. */
export interface WorkspaceOfferRow {
  id?: string;
  workspace_id: string;
  client_offer_id: string;
  client_customer_id: string | null;
  offer_number: string | null;
  offer_sequence_number: number | null;
  status: string | null;
  payload: Record<string, unknown>;
  row_version: number;
  deleted: boolean;
  deleted_at: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at: string;
}

/** Fachlicher Cloud-Payload — ohne jede Cloud-Metainformation. */
export interface OfferCloudPayload {
  id: string;
  workspaceId: string;
  status: OfferStatus;
  customer: CustomerBilling;
  title: string;
  baustelle: string;
  positions: OfferPosition[];
  taxStatus: TaxStatus;
  offerDate: string;
  validUntil: string;
  introText: string;
  closingText: string;
  paymentTermsText: string;
  createdAt: string;
  offerNumber?: string;
  offerSequenceNumber?: number;
  customerId?: string;
  companySnapshot?: CompanyProfile;
  brandingSnapshot?: BrandingSnapshot;
  legalNotices?: string[];
  totals?: OfferTotals;
  contentFingerprint?: string;
  finalizedAt?: string;
  sentAt?: string;
  decidedAt?: string;
  archiveDocumentId?: string;
  supersedesOfferId?: string;
  resultingVorgangId?: string;
  updatedAt?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function resolveStatus(value: unknown): OfferStatus {
  return OFFER_STATUSES.includes(value as OfferStatus) ? (value as OfferStatus) : 'entwurf';
}

function stripCustomer(c: CustomerBilling): CustomerBilling {
  return {
    name: c.name ?? '',
    contactPerson: c.contactPerson ?? '',
    street: c.street ?? '',
    zip: c.zip ?? '',
    city: c.city ?? '',
    email: c.email ?? '',
    phone: c.phone ?? '',
  };
}

function stripPosition(p: OfferPosition): OfferPosition {
  const out: OfferPosition = {
    id: p.id,
    description: p.description,
    quantity: p.quantity,
    unit: p.unit,
    unitPrice: p.unitPrice,
  };
  if (isNonEmptyString(p.unitLabel)) out.unitLabel = p.unitLabel;
  if (p.category) out.category = p.category;
  return out;
}

function parseTotals(value: unknown): OfferTotals | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
  return { subtotal: n(raw.subtotal), taxRate: n(raw.taxRate), tax: n(raw.tax), total: n(raw.total) };
}

/**
 * Ausdrückliche Allowlist statt Rest-Spread; optionale Felder reisen nur mit,
 * wenn sie belegt sind — „fehlt" und „undefined" ergeben denselben Schlüssel.
 */
export function stripOfferForCloud(offer: Offer): OfferCloudPayload {
  const payload: OfferCloudPayload = {
    id: offer.id,
    workspaceId: offer.workspaceId,
    status: offer.status,
    customer: stripCustomer(offer.customer),
    title: offer.title,
    baustelle: offer.baustelle,
    positions: offer.positions.map(stripPosition),
    taxStatus: offer.taxStatus,
    offerDate: offer.offerDate,
    validUntil: offer.validUntil,
    introText: offer.introText,
    closingText: offer.closingText,
    paymentTermsText: offer.paymentTermsText,
    createdAt: offer.createdAt,
  };
  if (isNonEmptyString(offer.offerNumber)) payload.offerNumber = offer.offerNumber;
  if (typeof offer.offerSequenceNumber === 'number') payload.offerSequenceNumber = offer.offerSequenceNumber;
  if (isNonEmptyString(offer.customerId)) payload.customerId = offer.customerId;
  if (offer.companySnapshot) payload.companySnapshot = offer.companySnapshot;
  if (offer.brandingSnapshot) payload.brandingSnapshot = offer.brandingSnapshot;
  if (offer.legalNotices) payload.legalNotices = [...offer.legalNotices];
  if (offer.totals) payload.totals = { ...offer.totals };
  if (isNonEmptyString(offer.contentFingerprint)) payload.contentFingerprint = offer.contentFingerprint;
  if (isNonEmptyString(offer.finalizedAt)) payload.finalizedAt = offer.finalizedAt;
  if (isNonEmptyString(offer.sentAt)) payload.sentAt = offer.sentAt;
  if (isNonEmptyString(offer.decidedAt)) payload.decidedAt = offer.decidedAt;
  if (isNonEmptyString(offer.archiveDocumentId)) payload.archiveDocumentId = offer.archiveDocumentId;
  if (isNonEmptyString(offer.supersedesOfferId)) payload.supersedesOfferId = offer.supersedesOfferId;
  if (isNonEmptyString(offer.resultingVorgangId)) payload.resultingVorgangId = offer.resultingVorgangId;
  if (isNonEmptyString(offer.updatedAt)) payload.updatedAt = offer.updatedAt;
  return payload;
}

/** Stabiler fachlicher Vergleichsschlüssel — bewusst ohne `SyncMeta`. */
export function buildOfferCloudContentKey(offer: Offer): string {
  return JSON.stringify(stripOfferForCloud(offer));
}

export function buildOfferCloudPushPayload(offer: Offer, deleted = false): Record<string, unknown> {
  return {
    offer_id: offer.id,
    customer_id: offer.customerId ?? null,
    status: offer.status,
    payload: stripOfferForCloud(offer),
    deleted,
  };
}

/** Nur die deklarierten Felder werden übernommen — keine Serverspalten. */
export function parseOfferCloudPayload(payload: Record<string, unknown> | null): OfferCloudPayload | null {
  if (!payload) return null;
  const inner = (payload.payload as Record<string, unknown> | undefined) ?? payload;
  if (!inner || typeof inner !== 'object') return null;
  if (!isNonEmptyString(inner.id)) return null;
  const rawCustomer = (inner.customer ?? {}) as Record<string, unknown>;
  const parsed: OfferCloudPayload = {
    id: inner.id,
    workspaceId: text(inner.workspaceId),
    status: resolveStatus(inner.status),
    customer: stripCustomer({
      name: text(rawCustomer.name),
      contactPerson: text(rawCustomer.contactPerson),
      street: text(rawCustomer.street),
      zip: text(rawCustomer.zip),
      city: text(rawCustomer.city),
      email: text(rawCustomer.email),
      phone: text(rawCustomer.phone),
    }),
    title: text(inner.title),
    baustelle: text(inner.baustelle),
    positions: Array.isArray(inner.positions)
      ? (inner.positions as Partial<OfferPosition>[]).map((p) => stripPosition(normalizeOfferPosition(p)))
      : [],
    taxStatus: (text(inner.taxStatus) || 'standard_19') as TaxStatus,
    offerDate: text(inner.offerDate),
    validUntil: text(inner.validUntil),
    introText: text(inner.introText),
    closingText: text(inner.closingText),
    paymentTermsText: text(inner.paymentTermsText),
    createdAt: text(inner.createdAt),
  };
  if (isNonEmptyString(inner.offerNumber)) parsed.offerNumber = inner.offerNumber;
  if (typeof inner.offerSequenceNumber === 'number') parsed.offerSequenceNumber = inner.offerSequenceNumber;
  if (isNonEmptyString(inner.customerId)) parsed.customerId = inner.customerId;
  if (inner.companySnapshot && typeof inner.companySnapshot === 'object') {
    parsed.companySnapshot = inner.companySnapshot as CompanyProfile;
  }
  if (inner.brandingSnapshot && typeof inner.brandingSnapshot === 'object') {
    parsed.brandingSnapshot = inner.brandingSnapshot as BrandingSnapshot;
  }
  if (Array.isArray(inner.legalNotices)) parsed.legalNotices = inner.legalNotices.map(text);
  const totals = parseTotals(inner.totals);
  if (totals) parsed.totals = totals;
  if (isNonEmptyString(inner.contentFingerprint)) parsed.contentFingerprint = inner.contentFingerprint;
  if (isNonEmptyString(inner.finalizedAt)) parsed.finalizedAt = inner.finalizedAt;
  if (isNonEmptyString(inner.sentAt)) parsed.sentAt = inner.sentAt;
  if (isNonEmptyString(inner.decidedAt)) parsed.decidedAt = inner.decidedAt;
  if (isNonEmptyString(inner.archiveDocumentId)) parsed.archiveDocumentId = inner.archiveDocumentId;
  if (isNonEmptyString(inner.supersedesOfferId)) parsed.supersedesOfferId = inner.supersedesOfferId;
  if (isNonEmptyString(inner.resultingVorgangId)) parsed.resultingVorgangId = inner.resultingVorgangId;
  if (isNonEmptyString(inner.updatedAt)) parsed.updatedAt = inner.updatedAt;
  return parsed;
}

export function mapWorkspaceOfferRow(row: WorkspaceOfferRow): {
  offerId: string;
  payload: OfferCloudPayload | null;
  rowVersion: number;
  deleted: boolean;
  updatedAt: string;
} | null {
  if (!isNonEmptyString(row.client_offer_id)) return null;
  const parsed = parseOfferCloudPayload(row.payload);
  if (parsed) {
    // Die Serverspalten sind die Wahrheit über Nummer und Status — sie überschreiben den Payload nie stillschweigend nach unten.
    if (isNonEmptyString(row.offer_number)) parsed.offerNumber = row.offer_number;
    if (typeof row.offer_sequence_number === 'number') parsed.offerSequenceNumber = row.offer_sequence_number;
    if (isNonEmptyString(row.status)) parsed.status = resolveStatus(row.status);
  }
  // Ein Grabstein ohne Fachinhalt bleibt gültig — ohne ihn käme die Löschung nie an.
  if (!parsed && !row.deleted) return null;
  return {
    offerId: row.client_offer_id,
    payload: parsed,
    rowVersion: Number(row.row_version),
    deleted: Boolean(row.deleted),
    updatedAt: row.updated_at,
  };
}

export function offerFromCloud(
  offerId: string,
  payload: OfferCloudPayload,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): Offer {
  return {
    ...payload,
    id: offerId,
    workspaceId: payload.workspaceId || workspaceId,
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

/**
 * Zeilenweiser Merge nach `offer.id` — dieselbe Regel wie bei Briefen (01G/01G2).
 *
 * ANGEBOT-01B (Recovery) — eine Ausnahme davor: Ist die Serverzeile bereits
 * **freigegeben** (Nummer vergeben) und lokal steht noch ein Entwurf, gewinnt
 * der Server ohne Streit. Der Fall entsteht, wenn der Client nach der
 * Freigabe-RPC beendet wurde, bevor er die Antwort übernehmen konnte. Ein
 * inzwischen lokal geänderter Entwurf ist dann kein Konflikt, sondern
 * überholt: Der Beleg mit Nummer ist die Wahrheit, und er wird nie durch den
 * Entwurf überschrieben. Die Kennungen kommen in `finalizedOverDraft`, damit
 * der Aufrufer die überholten Sendeaufträge abschliesst.
 */
export function mergeOffersFromPull(
  localOffers: Offer[],
  remoteRows: WorkspaceOfferRow[],
  deviceId: string,
  workspaceId: string,
  dirtyIds: ReadonlySet<string> = new Set(),
): { offers: Offer[]; conflicts: string[]; finalizedOverDraft: string[] } {
  const conflicts: string[] = [];
  const finalizedOverDraft: string[] = [];
  const byId = new Map(localOffers.map((offer) => [offer.id, offer]));

  for (const row of remoteRows) {
    const mapped = mapWorkspaceOfferRow(row);
    if (!mapped) continue;

    if (mapped.deleted) {
      if (dirtyIds.has(mapped.offerId) && byId.has(mapped.offerId)) {
        conflicts.push(`offer:${mapped.offerId}`);
        continue;
      }
      byId.delete(mapped.offerId);
      continue;
    }
    if (!mapped.payload) continue;

    const local = byId.get(mapped.offerId) ?? null;
    const remote = offerFromCloud(mapped.offerId, mapped.payload, mapped.rowVersion, mapped.updatedAt, false, deviceId, workspaceId);

    if (!local) {
      byId.set(remote.id, remote);
      continue;
    }

    if (remote.status !== 'entwurf' && remote.offerNumber && local.status === 'entwurf') {
      byId.set(remote.id, remote);
      finalizedOverDraft.push(remote.id);
      continue;
    }

    if (local.sync?.deleted === true) continue;

    if (local.sync && local.sync.version === mapped.rowVersion) {
      if (buildOfferCloudContentKey(local) === buildOfferCloudContentKey(remote)) {
        byId.set(remote.id, remote);
      } else {
        conflicts.push(`offer:${mapped.offerId}`);
      }
      continue;
    }

    if (dirtyIds.has(mapped.offerId) && mapped.rowVersion !== (local.sync?.version ?? 0)) {
      if (buildOfferCloudContentKey(local) !== buildOfferCloudContentKey(remote)) {
        conflicts.push(`offer:${mapped.offerId}`);
        continue;
      }
      byId.set(remote.id, remote);
      continue;
    }

    const merged = mergeSyncEntities(local, remote, 'offer');
    if (merged.conflict) {
      conflicts.push(`offer:${mapped.offerId}`);
      continue;
    }
    if (merged.entity) byId.set(merged.entity.id, merged.entity);
  }

  return { offers: [...byId.values()], conflicts, finalizedOverDraft };
}

/** Altbestand — Angebote, die der Server (einschliesslich Grabsteine) noch nicht kennt. */
export function planOfferBackfill(localOffers: Offer[], remoteRows: WorkspaceOfferRow[]): string[] {
  const remoteIds = new Set(remoteRows.map((row) => row.client_offer_id).filter(isNonEmptyString));
  return localOffers
    .filter((offer) => offer.sync?.deleted !== true)
    .filter((offer) => !remoteIds.has(offer.id))
    .map((offer) => offer.id);
}

/** Setzt nach erfolgreichem Versand die Serverversion — ohne Fachdaten anzufassen. */
export function applyOfferPushResultToState(
  offers: Offer[],
  offerId: string,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): Offer[] {
  return offers.map((offer) => {
    if (offer.id !== offerId) return offer;
    const sync: SyncMeta = {
      ...offer.sync,
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : offer.sync?.deletedAt,
      deviceId,
      workspaceId,
    };
    return { ...offer, sync };
  });
}

export function planOfferLostAckAdoption(
  localOffers: Offer[],
  remoteRows: WorkspaceOfferRow[],
  activeOutboxOfferIds: ReadonlySet<string>,
  sentWrites?: ReadonlyMap<string, LostAckSentWrite>,
): LostAckAdoptionPlan {
  const remotes = new Map<string, LostAckRemoteRow>();
  for (const row of remoteRows) {
    const mapped = mapWorkspaceOfferRow(row);
    if (!mapped) continue;
    remotes.set(mapped.offerId, {
      rowVersion: mapped.rowVersion,
      deleted: mapped.deleted,
      contentKey: mapped.payload
        ? buildOfferCloudContentKey(offerFromCloud(mapped.offerId, mapped.payload, mapped.rowVersion, mapped.updatedAt, false, '', ''))
        : undefined,
    });
  }
  return planLostAckAdoption(localOffers, remotes, activeOutboxOfferIds, {
    sentWrites,
    localContentKey: buildOfferCloudContentKey,
  });
}
