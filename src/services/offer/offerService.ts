/**
 * ANGEBOT-01B — der Fachdienst für eigene Angebote.
 *
 * Hier liegt alles, was ein Angebot fachlich ausmacht: Anlegen und Ändern des
 * Entwurfs, die Summen (aus derselben Rechenbasis wie die Rechnung), der
 * Aufbau des Freigabe-Kandidaten mit eingefrorenen Schnappschüssen, das
 * Übernehmen der Serverantwort nach der Freigabe und die erlaubten
 * Statusübergänge danach.
 *
 * Was hier **nicht** liegt: kein Cloud-Aufruf (`offerCloudService`,
 * `offerFinalizeCloudService`), kein PDF (`offerPrintModel`, `offerPdfService`),
 * keine Ablage (`offerArchiveService`). Der Weg in die Cloud führt über den
 * Änderungsverfolger und die vorhandene Warteschlange — wie bei Briefen.
 */
import { persistAll, seedSyncChangeTrackerFromCurrentStores } from '../persistenceService';
import { getCompanyProfileStoreSnapshot } from '../companyProfileService';
import {
  filterSyncActive,
  generateEntityId,
  isEntitySyncActive,
  withTombstonedCloudEntityPreservingRemoteVersion,
} from '../sync/syncMetaService';
import {
  buildLegalNotices,
  calculateLineItemTotals,
  freezeBrandingForInvoice,
  toInvoiceCompanySnapshot,
} from '../invoiceService';
import type { CustomerBilling, TaxStatus } from '../../types/models';
import { getBusinessDay } from '../businessDateService';
import { addCalendarDays } from '../invoiceTaxService';
import { copyCustomerBilling } from '../customer/customerBillingCopy';
import {
  OFFER_STATUSES,
  type Offer,
  type OfferDraftInput,
  type OfferPosition,
  type OfferStatus,
  type OfferTotals,
} from '../../types/offer';

/* ------------------------------------------------------------------ */
/* Speicher                                                             */
/* ------------------------------------------------------------------ */

let offers: Offer[] = [];

function cloneOffer(offer: Offer): Offer {
  return {
    ...offer,
    customer: { ...offer.customer },
    positions: offer.positions.map((p) => ({ ...p })),
    companySnapshot: offer.companySnapshot ? { ...offer.companySnapshot } : undefined,
    brandingSnapshot: offer.brandingSnapshot ? { ...offer.brandingSnapshot } : undefined,
    legalNotices: offer.legalNotices ? [...offer.legalNotices] : undefined,
    totals: offer.totals ? { ...offer.totals } : undefined,
  };
}

export function getOfferStoreSnapshot(): Offer[] {
  return offers.map(cloneOffer);
}

export function hydrateOffers(items: Offer[]): void {
  offers = items.map((item) => cloneOffer(normalizeOffer(item)));
}

export function resetOffers(): void {
  offers = [];
}

export function setOfferStoreForTests(items: Offer[]): void {
  hydrateOffers(items);
}

/* ------------------------------------------------------------------ */
/* Normalisierung                                                       */
/* ------------------------------------------------------------------ */

export function emptyCustomerBilling(): CustomerBilling {
  return { name: '', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' };
}

// FINANZ-CORE-01A (KUN-01) — die E-Rechnungsfelder gehen beim Speichern nicht mehr verloren.
function normalizeCustomer(customer: Partial<CustomerBilling> | undefined): CustomerBilling {
  return copyCustomerBilling(customer, { trim: true });
}

function cleanNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function normalizeOfferPosition(position: Partial<OfferPosition>): OfferPosition {
  const out: OfferPosition = {
    id: position.id || generateEntityId('offer-pos'),
    description: (position.description ?? '').trim(),
    quantity: cleanNumber(position.quantity),
    unit: position.unit ?? 'Stück',
    unitPrice: cleanNumber(position.unitPrice),
  };
  if (position.unitLabel?.trim()) out.unitLabel = position.unitLabel.trim();
  if (position.category) out.category = position.category;
  return out;
}

function today(): string {
  // 03D — der lokale Geschäftstag; ein Angebot vom 23. darf nicht den 22. tragen.
  return getBusinessDay();
}

function normalizeOffer(
  offer: Partial<Offer> & Pick<Offer, 'id' | 'workspaceId'>,
): Offer {
  const now = new Date().toISOString();
  const status: OfferStatus = OFFER_STATUSES.includes(offer.status as OfferStatus)
    ? (offer.status as OfferStatus)
    : 'entwurf';
  const out: Offer = {
    id: offer.id,
    workspaceId: offer.workspaceId,
    status,
    customer: normalizeCustomer(offer.customer),
    title: (offer.title ?? '').trim(),
    baustelle: (offer.baustelle ?? '').trim(),
    positions: (offer.positions ?? []).map(normalizeOfferPosition),
    taxStatus: offer.taxStatus ?? 'standard_19',
    offerDate: (offer.offerDate || today()).slice(0, 10),
    validUntil: (offer.validUntil || '').slice(0, 10),
    introText: offer.introText ?? '',
    closingText: offer.closingText ?? '',
    paymentTermsText: offer.paymentTermsText ?? '',
    createdAt: offer.createdAt ?? now,
  };
  if (offer.offerNumber) out.offerNumber = offer.offerNumber;
  if (typeof offer.offerSequenceNumber === 'number') out.offerSequenceNumber = offer.offerSequenceNumber;
  if (offer.customerId) out.customerId = offer.customerId;
  if (offer.companySnapshot) out.companySnapshot = offer.companySnapshot;
  if (offer.brandingSnapshot) out.brandingSnapshot = offer.brandingSnapshot;
  if (offer.legalNotices) out.legalNotices = [...offer.legalNotices];
  if (offer.totals) out.totals = { ...offer.totals };
  if (offer.contentFingerprint) out.contentFingerprint = offer.contentFingerprint;
  if (offer.finalizedAt) out.finalizedAt = offer.finalizedAt;
  if (offer.sentAt) out.sentAt = offer.sentAt;
  if (offer.decidedAt) out.decidedAt = offer.decidedAt;
  if (offer.archiveDocumentId) out.archiveDocumentId = offer.archiveDocumentId;
  if (offer.supersedesOfferId) out.supersedesOfferId = offer.supersedesOfferId;
  if (offer.resultingVorgangId) out.resultingVorgangId = offer.resultingVorgangId;
  if (offer.updatedAt) out.updatedAt = offer.updatedAt;
  if (offer.sync) out.sync = offer.sync;
  return out;
}

/* ------------------------------------------------------------------ */
/* Lesen                                                                */
/* ------------------------------------------------------------------ */

export function listOffers(): Offer[] {
  return filterSyncActive(offers)
    .map(cloneOffer)
    .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
}

export function getOfferById(offerId: string): Offer | null {
  const found = offers.find((item) => item.id === offerId && isEntitySyncActive(item));
  return found ? cloneOffer(found) : null;
}

export function getOffersForCustomer(customerId: string): Offer[] {
  return listOffers().filter((offer) => offer.customerId === customerId);
}

/** „Abgelaufen" ist ein berechneter Zustand — nie gespeichert. */
export function isOfferExpired(offer: Pick<Offer, 'status' | 'validUntil'>, todayIso = today()): boolean {
  if (!offer.validUntil) return false;
  if (offer.status !== 'freigegeben' && offer.status !== 'versendet') return false;
  return offer.validUntil < todayIso;
}

export function isOfferFrozen(offer: Pick<Offer, 'status'>): boolean {
  return offer.status !== 'entwurf';
}

/* ------------------------------------------------------------------ */
/* Summen                                                               */
/* ------------------------------------------------------------------ */

/** Nur Positionen mit Menge > 0 zählen — dieselbe Regel wie in der Rechnung. */
export function computeOfferTotals(
  positions: ReadonlyArray<Pick<OfferPosition, 'quantity' | 'unitPrice'>>,
  taxStatus: TaxStatus,
): OfferTotals {
  const t = calculateLineItemTotals(positions, taxStatus);
  return { subtotal: t.subtotal, taxRate: t.taxRate, tax: t.tax, total: t.total };
}

export function getOfferTotals(offer: Offer): OfferTotals {
  // Ab der Freigabe gilt der eingefrorene Stand, nicht eine Neuberechnung.
  if (isOfferFrozen(offer) && offer.totals) return { ...offer.totals };
  return computeOfferTotals(offer.positions, offer.taxStatus);
}

/* ------------------------------------------------------------------ */
/* Entwurf                                                              */
/* ------------------------------------------------------------------ */

export type OfferMutationResult =
  | { success: true; offer: Offer }
  | { success: false; errorKey: string };

function validateDraft(input: Partial<OfferDraftInput>): string | null {
  if (input.title !== undefined && !input.title.trim()) return 'offer.error.titleRequired';
  if (input.validUntil !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil)) {
    return 'offer.error.validUntilRequired';
  }
  return null;
}

export function addOfferDraft(workspaceId: string, input: OfferDraftInput): OfferMutationResult {
  if (!workspaceId) return { success: false, errorKey: 'offer.error.workspaceRequired' };
  const problem = validateDraft(input);
  if (problem) return { success: false, errorKey: problem };

  // SYNC-VERSION-CONTRACT-02 — keine selbst gesetzte Sync-Meta; die erste Version bestätigt der Server.
  const offer = normalizeOffer({
    id: generateEntityId('offer'),
    workspaceId,
    status: 'entwurf',
    customerId: input.customerId,
    customer: input.customer,
    title: input.title,
    baustelle: input.baustelle,
    positions: input.positions,
    taxStatus: input.taxStatus,
    offerDate: input.offerDate,
    validUntil: input.validUntil,
    introText: input.introText,
    closingText: input.closingText,
    paymentTermsText: input.paymentTermsText,
  });

  offers = [offer, ...offers];
  persistAll();
  return { success: true, offer: cloneOffer(offer) };
}

export function updateOfferDraft(offerId: string, changes: Partial<OfferDraftInput>): OfferMutationResult {
  const index = offers.findIndex((item) => item.id === offerId && isEntitySyncActive(item));
  if (index === -1) return { success: false, errorKey: 'offer.error.notFound' };
  const current = offers[index];
  // Ein freigegebenes Angebot ist ein Beleg — es wird nicht umgeschrieben.
  if (isOfferFrozen(current)) return { success: false, errorKey: 'offer.error.frozen' };
  const problem = validateDraft(changes);
  if (problem) return { success: false, errorKey: problem };

  const updated = normalizeOffer({
    ...current,
    customerId: changes.customerId !== undefined ? changes.customerId || undefined : current.customerId,
    customer: changes.customer ?? current.customer,
    title: changes.title ?? current.title,
    baustelle: changes.baustelle ?? current.baustelle,
    positions: changes.positions ?? current.positions,
    taxStatus: changes.taxStatus ?? current.taxStatus,
    offerDate: changes.offerDate ?? current.offerDate,
    validUntil: changes.validUntil ?? current.validUntil,
    introText: changes.introText ?? current.introText,
    closingText: changes.closingText ?? current.closingText,
    paymentTermsText: changes.paymentTermsText ?? current.paymentTermsText,
    updatedAt: new Date().toISOString(),
  });
  offers = [...offers.slice(0, index), updated, ...offers.slice(index + 1)];
  persistAll();
  return { success: true, offer: cloneOffer(updated) };
}

/** Nur Entwürfe dürfen verschwinden; ein freigegebenes Angebot wird storniert, nicht gelöscht. */
export function deleteOfferDraft(offerId: string): OfferMutationResult {
  const index = offers.findIndex((item) => item.id === offerId && isEntitySyncActive(item));
  if (index === -1) return { success: false, errorKey: 'offer.error.notFound' };
  if (isOfferFrozen(offers[index])) return { success: false, errorKey: 'offer.error.frozen' };
  const tombstoned = withTombstonedCloudEntityPreservingRemoteVersion(cloneOffer(offers[index]), 'offer');
  offers = [...offers.slice(0, index), tombstoned, ...offers.slice(index + 1)];
  persistAll();
  return { success: true, offer: cloneOffer(tombstoned) };
}

/* ------------------------------------------------------------------ */
/* Freigabe                                                             */
/* ------------------------------------------------------------------ */

/** Die eingefrorenen Felder — genau diese gehen in den Fingerabdruck. */
export interface OfferFrozenContent {
  customerId?: string;
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
  companySnapshot: Offer['companySnapshot'];
  brandingSnapshot: Offer['brandingSnapshot'];
  legalNotices: string[];
  totals: OfferTotals;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/** Stabiler Fingerabdruck — Schlüsselreihenfolge unabhängig, `undefined` ausgelassen. */
export function buildOfferContentFingerprint(content: OfferFrozenContent): string {
  return JSON.stringify(canonical(content));
}

export type OfferFinalizeBlocker =
  | 'customer_missing'
  | 'positions_missing'
  | 'position_invalid'
  | 'title_missing'
  | 'valid_until_missing'
  | 'valid_until_before_date'
  | 'company_profile_missing'
  /** FINANZ-CORE-01A (ANG-01) — „noch unklar" ist keine Steuerangabe für ein verbindliches Angebot. */
  | 'tax_status_unclear'
  /** FINANZ-CORE-01A (ANG-14) — das Nummernjahr kommt aus dem Angebotsdatum (2000 bis 2100). */
  | 'offer_date_invalid';

export type OfferFinalizationCandidate =
  | { ok: true; offer: Offer; content: OfferFrozenContent; fingerprint: string }
  | { ok: false; blockers: OfferFinalizeBlocker[] };

/**
 * Baut den Stand, der bei der Freigabe eingefroren wird — aus dem Entwurf und
 * dem **aktuellen** Firmenprofil. Ändert nichts, speichert nichts.
 *
 * Dieselben Regeln prüft der Server noch einmal (Kunde, Positionen); hier
 * stehen sie, damit die Oberfläche vor dem Aufruf ehrlich sagen kann, was
 * fehlt.
 */
/** Ein echtes Kalenderdatum JJJJ-MM-TT im Bereich des Nummernkreises (2000 bis 2100). */
function isPlausibleOfferDate(value: string): boolean {
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  if (year < 2000 || year > 2100) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function buildOfferFinalizationCandidate(offerId: string): OfferFinalizationCandidate {
  const offer = getOfferById(offerId);
  if (!offer) return { ok: false, blockers: ['positions_missing'] };
  const blockers: OfferFinalizeBlocker[] = [];
  if (!offer.customer.name.trim()) blockers.push('customer_missing');
  if (!offer.title.trim()) blockers.push('title_missing');
  const billable = offer.positions.filter((p) => p.quantity > 0);
  if (billable.length === 0) blockers.push('positions_missing');
  if (offer.positions.some((p) => !p.description.trim() || p.quantity < 0 || p.unitPrice < 0)) {
    blockers.push('position_invalid');
  }
  if (!offer.validUntil) blockers.push('valid_until_missing');
  else if (offer.validUntil < offer.offerDate) blockers.push('valid_until_before_date');
  /*
   * FINANZ-CORE-01A (ANG-14) — der Server leitet das Jahr der Angebotsnummer aus dem
   * Angebotsdatum ab und kennt nur 2000 bis 2100. Ein Datum außerhalb endete in einer
   * rohen Check-Constraint-Meldung; jetzt sagt es die Seite vorher.
   */
  if (offer.offerDate && !isPlausibleOfferDate(offer.offerDate)) blockers.push('offer_date_invalid');
  /*
   * FINANZ-CORE-01A (ANG-01) — ohne Steuerentscheidung rechnet das Angebot mit
   * 0 %, und die Annahme trug den ungeklärten Status in den Auftrag. Der
   * Server weist dasselbe ab; hier steht es, damit die Seite es vorher sagt.
   */
  if (!offer.taxStatus || offer.taxStatus === 'unclear') blockers.push('tax_status_unclear');
  /*
   * FINANZ-CORE-01A (ANG-06) — der Store liefert immer ein Profil, notfalls mit
   * Leerwerten; die bisherige Prüfung „kein Profil" griff deshalb nie, und ein
   * Angebot ohne Absender wurde mit Nummer eingefroren. Geprüft wird jetzt, was das
   * Angebot als Absender druckt: Name und Anschrift.
   */
  const profile = getCompanyProfileStoreSnapshot();
  const absenderVollstaendig = Boolean(
    profile?.companyName?.trim() && profile.street?.trim() && profile.zip?.trim() && profile.city?.trim(),
  );
  if (!absenderVollstaendig) blockers.push('company_profile_missing');
  if (blockers.length > 0 || !profile) return { ok: false, blockers };

  const content: OfferFrozenContent = {
    customerId: offer.customerId,
    customer: { ...offer.customer },
    title: offer.title,
    baustelle: offer.baustelle,
    positions: offer.positions.map((p) => ({ ...p })),
    taxStatus: offer.taxStatus,
    offerDate: offer.offerDate,
    validUntil: offer.validUntil,
    introText: offer.introText,
    closingText: offer.closingText,
    paymentTermsText: offer.paymentTermsText,
    companySnapshot: toInvoiceCompanySnapshot(profile),
    brandingSnapshot: freezeBrandingForInvoice(profile.branding),
    legalNotices: buildLegalNotices(offer.taxStatus, profile),
    totals: computeOfferTotals(offer.positions, offer.taxStatus),
  };
  return { ok: true, offer, content, fingerprint: buildOfferContentFingerprint(content) };
}

export interface OfferFinalizationConfirmed {
  /** Die Serverzeile, wie sie nach der Freigabe gespeichert ist — sie ersetzt den lokalen Entwurf vollständig. */
  serverOffer: Omit<Offer, 'sync'>;
  rowVersion: number;
  updatedAt: string;
  deviceId: string;
  workspaceId: string;
}

/**
 * Übernimmt die vom Server bestätigte Freigabe. Der lokale Datensatz wird
 * durch die Serverzeile ersetzt — nicht durch den eigenen Kandidaten —, damit
 * Inhaltsschlüssel und Serverpayload ab hier identisch sind und kein späterer
 * Abgleich einen Scheinkonflikt meldet. Die Nummer kommt ausschliesslich vom
 * Server.
 */
export function applyConfirmedOfferFinalization(
  offerId: string,
  confirmed: OfferFinalizationConfirmed,
): OfferMutationResult {
  const index = offers.findIndex((item) => item.id === offerId && isEntitySyncActive(item));
  if (index === -1) return { success: false, errorKey: 'offer.error.notFound' };
  if (!confirmed.serverOffer.offerNumber || confirmed.serverOffer.status === 'entwurf') {
    return { success: false, errorKey: 'offer.error.finalizeFailed' };
  }
  const finalized = normalizeOffer({
    ...confirmed.serverOffer,
    id: offerId,
    workspaceId: confirmed.serverOffer.workspaceId || offers[index].workspaceId,
    // FINANZ-CORE-01A (ANG-11) — eine ältere Serverzeile ohne Bezug verliert den lokalen nicht.
    supersedesOfferId: confirmed.serverOffer.supersedesOfferId || offers[index].supersedesOfferId,
    sync: {
      ...offers[index].sync,
      updatedAt: confirmed.updatedAt,
      version: confirmed.rowVersion,
      deleted: false,
      deviceId: confirmed.deviceId,
      workspaceId: confirmed.workspaceId,
    },
  });
  offers = [...offers.slice(0, index), finalized, ...offers.slice(index + 1)];
  /*
   * Der Server hat diesen Stand bereits bestätigt — der Änderungsverfolger
   * soll ihn nicht ein zweites Mal einreihen. Grundlinie vor dem Speichern.
   */
  seedSyncChangeTrackerFromCurrentStores();
  persistAll();
  /*
   * FINANZ-CORE-01A (ANG-11) — erst jetzt, mit der freigegebenen Überarbeitung, ist das
   * frühere Angebot ersetzt. Bricht man die Überarbeitung ab, bleibt das alte gültig.
   * Nach der Grundlinie oben, damit der Statuswechsel als eigene Änderung in die Cloud geht.
   */
  supersedePredecessor(finalized);
  return { success: true, offer: cloneOffer(finalized) };
}

function supersedePredecessor(successor: Offer): void {
  const predecessorId = successor.supersedesOfferId?.trim();
  if (!predecessorId || predecessorId === successor.id) return;
  const predecessor = getOfferById(predecessorId);
  if (!predecessor || !canTransitionOfferStatus(predecessor.status, 'ersetzt')) return;
  transition(predecessorId, 'ersetzt', 'decidedAt');
}

/** Tage zwischen zwei ISO-Daten; ungültig -> null. */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * FINANZ-CORE-01A (ANG-11) — Überarbeiten bzw. als Vorlage kopieren.
 *
 * Der Freigabedialog sagt: „Änderungen sind danach nur über ein neues Angebot möglich."
 * Einen Weg dorthin gab es nicht; jede Korrektur verlangte vollständige Neuerfassung.
 *
 * Aus einem freigegebenen Angebot entsteht ein neuer Entwurf mit demselben Inhalt, dem
 * heutigen Angebotsdatum und derselben Gültigkeitsdauer. Ist das Ausgangsangebot noch
 * offen (freigegeben oder versendet), trägt der Entwurf den Nachfolgebezug: Mit seiner
 * Freigabe wird das alte Angebot „ersetzt". Ein abgeschlossenes Angebot (angenommen,
 * abgelehnt, storniert, ersetzt) dient nur als Vorlage, ohne Bezug.
 */
export function reviseOffer(offerId: string): OfferMutationResult {
  const source = getOfferById(offerId);
  if (!source) return { success: false, errorKey: 'offer.error.notFound' };
  if (!isOfferFrozen(source)) return { success: false, errorKey: 'offer.error.reviseDraft' };
  const replaces = source.status === 'freigegeben' || source.status === 'versendet';
  const offerDate = today();
  const span = daysBetween(source.offerDate, source.validUntil);
  const validUntil = addCalendarDays(offerDate, span !== null && span > 0 ? span : 30);
  const offer = normalizeOffer({
    id: generateEntityId('offer'),
    workspaceId: source.workspaceId,
    status: 'entwurf',
    customerId: source.customerId,
    customer: { ...source.customer },
    title: source.title,
    baustelle: source.baustelle,
    // Neue Positionskennungen: der Entwurf ist ein eigener Beleg.
    positions: source.positions.map((position) => ({ ...position, id: '' })),
    taxStatus: source.taxStatus,
    offerDate,
    validUntil,
    introText: source.introText,
    closingText: source.closingText,
    paymentTermsText: source.paymentTermsText,
    ...(replaces ? { supersedesOfferId: source.id } : {}),
  });
  offers = [offer, ...offers];
  persistAll();
  return { success: true, offer: cloneOffer(offer) };
}

/**
 * ANGEBOT->AUFTRAG-02B — den vom Server bestaetigten Stand nach der Annahme
 * uebernehmen (Status `angenommen`, `resultingVorgangId`, Version). Ohne
 * Persist — der Aufrufer speichert Angebot und Auftrag gemeinsam.
 */
export function adoptAcceptedOfferFromServer(
  offerId: string,
  serverOffer: Omit<Offer, 'sync'>,
  sync: { rowVersion: number; updatedAt: string; deviceId: string; workspaceId: string },
): OfferMutationResult {
  const index = offers.findIndex((item) => item.id === offerId && isEntitySyncActive(item));
  if (index === -1) return { success: false, errorKey: 'offer.error.notFound' };
  if (serverOffer.status !== 'angenommen' || !serverOffer.resultingVorgangId) {
    return { success: false, errorKey: 'offer.error.acceptFailed' };
  }
  const accepted = normalizeOffer({
    ...serverOffer,
    id: offerId,
    workspaceId: serverOffer.workspaceId || offers[index].workspaceId,
    sync: {
      ...offers[index].sync,
      updatedAt: sync.updatedAt,
      version: sync.rowVersion,
      deleted: false,
      deviceId: sync.deviceId,
      workspaceId: sync.workspaceId,
    },
  });
  offers = [...offers.slice(0, index), accepted, ...offers.slice(index + 1)];
  return { success: true, offer: cloneOffer(accepted) };
}

/** Annahme ist nur aus freigegeben/versendet moeglich — auch abgelaufen, mit ausdruecklicher Bestaetigung. */
export function canAcceptOffer(offer: Pick<Offer, 'status'>): boolean {
  return offer.status === 'freigegeben' || offer.status === 'versendet';
}

/**
 * FINANZ-CORE-01A (ANG-09) — versendet wird nur ein gültiges, noch offenes
 * Angebot: freigegeben oder bereits versendet (Zweitversand). Ein
 * abgelehntes, storniertes, ersetztes oder angenommenes Angebot ging bisher
 * genauso an den Kunden — der Statuswechsel scheiterte danach still.
 */
export function canSendOffer(offer: Pick<Offer, 'status'>): boolean {
  return offer.status === 'freigegeben' || offer.status === 'versendet';
}

/* ------------------------------------------------------------------ */
/* Status nach der Freigabe                                             */
/* ------------------------------------------------------------------ */

const ALLOWED_TRANSITIONS: Record<OfferStatus, readonly OfferStatus[]> = {
  entwurf: ['freigegeben'],
  freigegeben: ['versendet', 'abgelehnt', 'storniert', 'angenommen', 'ersetzt'],
  versendet: ['abgelehnt', 'storniert', 'angenommen', 'ersetzt'],
  angenommen: [],
  abgelehnt: [],
  storniert: [],
  ersetzt: [],
};

export function canTransitionOfferStatus(from: OfferStatus, to: OfferStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Die Übergänge, die 01B in der Oberfläche anbietet; `angenommen`/`ersetzt` folgen später. */
export function listOfferStatusActions(offer: Pick<Offer, 'status'>): OfferStatus[] {
  return (['versendet', 'abgelehnt', 'storniert'] as const).filter((to) =>
    canTransitionOfferStatus(offer.status, to),
  );
}

function transition(offerId: string, to: OfferStatus, stamp: 'sentAt' | 'decidedAt'): OfferMutationResult {
  const index = offers.findIndex((item) => item.id === offerId && isEntitySyncActive(item));
  if (index === -1) return { success: false, errorKey: 'offer.error.notFound' };
  const current = offers[index];
  if (!canTransitionOfferStatus(current.status, to)) {
    return { success: false, errorKey: 'offer.error.transitionNotAllowed' };
  }
  const now = new Date().toISOString();
  const next = normalizeOffer({ ...current, status: to, [stamp]: current[stamp] ?? now, updatedAt: now });
  offers = [...offers.slice(0, index), next, ...offers.slice(index + 1)];
  persistAll();
  return { success: true, offer: cloneOffer(next) };
}

/** Versand ändert keinen fachlichen Inhalt — nur den Zustand und den Zeitstempel. */
export function markOfferSent(offerId: string): OfferMutationResult {
  const current = offers.find((item) => item.id === offerId && isEntitySyncActive(item));
  // Zweitversand: Zustand bleibt, kein Fehler.
  if (current?.status === 'versendet') return { success: true, offer: cloneOffer(current) };
  return transition(offerId, 'versendet', 'sentAt');
}

export function rejectOffer(offerId: string): OfferMutationResult {
  return transition(offerId, 'abgelehnt', 'decidedAt');
}

export function cancelOffer(offerId: string): OfferMutationResult {
  return transition(offerId, 'storniert', 'decidedAt');
}

/** Die einzige Änderung am freigegebenen Angebot: der Verweis auf die Ablage. Nie überschreibend. */
export function attachArchiveDocumentToOffer(offerId: string, documentId: string): OfferMutationResult {
  const index = offers.findIndex((item) => item.id === offerId && isEntitySyncActive(item));
  if (index === -1) return { success: false, errorKey: 'offer.error.notFound' };
  const current = offers[index];
  if (!isOfferFrozen(current)) return { success: false, errorKey: 'offer.error.archiveDraftNotAllowed' };
  const wanted = documentId.trim();
  if (!wanted) return { success: false, errorKey: 'offer.error.archiveFailed' };
  if (current.archiveDocumentId?.trim()) return { success: true, offer: cloneOffer(current) };
  const linked = normalizeOffer({ ...current, archiveDocumentId: wanted });
  offers = [...offers.slice(0, index), linked, ...offers.slice(index + 1)];
  persistAll();
  return { success: true, offer: cloneOffer(linked) };
}
