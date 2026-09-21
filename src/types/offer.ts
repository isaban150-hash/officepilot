/**
 * ANGEBOT-01B — das eigene Angebot des Betriebs als fachliche Entität.
 *
 * Ein Angebot entsteht als Entwurf, wird vom Betrieb **freigegeben** und ist
 * ab diesem Moment ein Beleg: Kunde, Positionen, Preise, Steuerstatus, Texte,
 * Gültigkeit, Firmen- und Branding-Schnappschuss und die Summen liegen dann
 * eingefroren im Datensatz. Die Angebotsnummer vergibt der Server bei der
 * Freigabe aus einem eigenen Nummernkreis — nie der Client, nie die
 * Rechnungsnummer.
 *
 * Was hier bewusst **nicht** liegt: der Auftrag (Block B), der Versand
 * (`workspace_document_deliveries`, `document_kind = 'offer'`) und jede
 * Kalkulation über Menge × Einzelpreis hinaus.
 */
import type {
  CompanyProfile,
  CustomerBilling,
  OrderPositionCategory,
  OrderUnit,
  TaxStatus,
} from './models';
import type { BrandingSnapshot } from './branding';
import type { SyncableEntity } from './sync';

/**
 * Persistierte Zustände. „Abgelaufen" ist ausdrücklich keiner davon: Es wird
 * aus `validUntil` berechnet (`isOfferExpired`), damit Datum und Status nie
 * zwei Wahrheiten erzählen.
 *
 * `angenommen` und `ersetzt` sind vorbereitet; ihre Übergänge kommen erst mit
 * Block B bzw. dem Nachfolge-Angebot.
 */
export const OFFER_STATUSES = [
  'entwurf',
  'freigegeben',
  'versendet',
  'angenommen',
  'abgelehnt',
  'storniert',
  'ersetzt',
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** Dieselben fachlichen Primitive wie `OrderPositionInput` — bewusst kein eigenes Positionsmodell. */
export interface OfferPosition {
  id: string;
  description: string;
  quantity: number;
  unit: OrderUnit;
  unitLabel?: string;
  unitPrice: number;
  category?: OrderPositionCategory;
}

/** Die bei der Freigabe eingefrorenen Summen — aus derselben Rechenbasis wie die Rechnung. */
export interface OfferTotals {
  subtotal: number;
  taxRate: number;
  tax: number;
  total: number;
}

export interface Offer extends SyncableEntity {
  id: string;
  workspaceId: string;
  /** Erst mit der Freigabe vorhanden; vorher ist der Datensatz ein Entwurf ohne Nummer. */
  offerNumber?: string;
  offerSequenceNumber?: number;
  status: OfferStatus;
  customerId?: string;
  /** Empfänger, wie er auf dem Angebot steht. Im Entwurf editierbar, mit der Freigabe eingefroren. */
  customer: CustomerBilling;
  title: string;
  baustelle: string;
  positions: OfferPosition[];
  taxStatus: TaxStatus;
  /** Angebotsdatum (ISO, nur Tag). */
  offerDate: string;
  /** Gültig bis (ISO, nur Tag). */
  validUntil: string;
  introText: string;
  closingText: string;
  paymentTermsText: string;
  /** Ab der Freigabe: die Wahrheit über dieses Angebot, unabhängig vom heutigen Profil. */
  companySnapshot?: CompanyProfile;
  brandingSnapshot?: BrandingSnapshot;
  legalNotices?: string[];
  totals?: OfferTotals;
  /** Fingerabdruck des eingefrorenen Inhalts; Grundlage der Freigabe-Idempotenz. */
  contentFingerprint?: string;
  finalizedAt?: string;
  sentAt?: string;
  decidedAt?: string;
  /** Archivdokument zum erzeugten PDF. */
  archiveDocumentId?: string;
  /** Nachfolge: dieses Angebot ersetzt ein früheres. */
  supersedesOfferId?: string;
  /** Block B: der aus der Annahme entstandene Auftrag. Hier nur vorbereitet. */
  resultingVorgangId?: string;
  createdAt: string;
  updatedAt?: string;
}

/** Felder, die beim Anlegen und Ändern eines Entwurfs von aussen kommen dürfen. */
export interface OfferDraftInput {
  customerId?: string;
  customer: CustomerBilling;
  title: string;
  baustelle?: string;
  positions: OfferPosition[];
  taxStatus: TaxStatus;
  offerDate?: string;
  validUntil: string;
  introText?: string;
  closingText?: string;
  paymentTermsText?: string;
}
