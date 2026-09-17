/**
 * EMAIL-01B1 — Versand eines Geschäftsdokuments (Delivery).
 *
 * Ein Delivery-Datensatz ist der Audit **eines** Versandauftrags: welches
 * historische Dokument, an welche Adresse, mit welchem Betreff/Text, welcher
 * Anhang (nur Referenz + Hash), von wem ausgelöst, mit welchem Ergebnis.
 * Provider-Details bleiben hinter dem Adapter (`emailProviderAdapter`);
 * hier gibt es nur kanonische Zustände und Fehlerkategorien.
 */

export const DELIVERY_DOCUMENT_KINDS = ['invoice', 'invoice_correction', 'letter', 'offer', 'other'] as const;
export type DeliveryDocumentKind = (typeof DELIVERY_DOCUMENT_KINDS)[number];

/**
 * `provider_accepted` = an den Provider übergeben. Das ist **nicht**
 * „zugestellt"; `delivered`/`bounced`/`complained` kommen erst mit
 * Provider-Ereignissen (Webhooks, später).
 */
export const DELIVERY_STATUSES = [
  'prepared',
  'queued',
  'provider_accepted',
  'failed',
  'unknown',
  'delivered',
  'bounced',
  'complained',
  'rejected',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_ERROR_CATEGORIES = ['auth', 'recipient', 'provider', 'attachment', 'network', 'unknown'] as const;
export type DeliveryErrorCategory = (typeof DELIVERY_ERROR_CATEGORIES)[number];

export const DELIVERY_PROVIDERS = ['brevo', 'stub'] as const;
export type DeliveryProvider = (typeof DELIVERY_PROVIDERS)[number];

/** Herkunft der Versandwahrheit einer Rechnung (`workspace_invoices.sent_source`). */
export const INVOICE_SENT_SOURCES = ['manual', 'officepilot'] as const;
export type InvoiceSentSource = (typeof INVOICE_SENT_SOURCES)[number];

export interface DeliveryAttachment {
  storagePath: string;
  sha256: string;
  sizeBytes: number;
  filename: string;
  mimeType: 'application/pdf';
}

export interface DocumentDelivery {
  id: string;
  workspaceId: string;
  clientDeliveryId: string;
  documentKind: DeliveryDocumentKind;
  linkedInvoiceId?: string;
  linkedDocumentId?: string;
  recipientEmail: string;
  subject: string;
  bodyText: string;
  attachment?: DeliveryAttachment;
  provider: DeliveryProvider;
  providerMessageId?: string;
  status: DeliveryStatus;
  requestedBy: string;
  requestedAt: string;
  providerAcceptedAt?: string;
  failedAt?: string;
  errorCategory?: DeliveryErrorCategory;
  errorCode?: string;
  errorMessageSafe?: string;
  retryOfDeliveryId?: string;
  attemptNumber: number;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
}

/**
 * Identität des zu versendenden Dokuments — Rechnung frei oder mit Vorgang
 * gleich adressiert. V1-B2: normale archivierte Dokumente (Brief, Angebot,
 * sonstiges) über ihre Dokument-Kennung, nie über eine Rechnung.
 */
export type DeliveryDocumentIdentity =
  | { kind: 'invoice'; clientInvoiceId: string }
  | { kind: 'invoice_correction'; clientInvoiceId: string }
  | { kind: 'letter' | 'offer' | 'other'; clientDocumentId: string };

export type ArchivedDocumentDeliveryKind = Extract<DeliveryDocumentIdentity, { clientDocumentId: string }>['kind'];

export function isInvoiceDeliveryIdentity(identity: DeliveryDocumentIdentity): identity is Extract<DeliveryDocumentIdentity, { clientInvoiceId: string }> {
  return identity.kind === 'invoice' || identity.kind === 'invoice_correction';
}

/** Stabile Kennung des Dokuments hinter der Identität (Rechnung oder Dokument). */
export function deliveryIdentityDocumentId(identity: DeliveryDocumentIdentity): string {
  return isInvoiceDeliveryIdentity(identity) ? identity.clientInvoiceId : identity.clientDocumentId;
}
