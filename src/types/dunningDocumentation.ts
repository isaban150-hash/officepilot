import type { InvoiceSentVia } from './models';
import type { SyncMeta } from './sync';

/** Confirmed handoff of a payment reminder or dunning notice to the customer. */
export type DunningDocumentationKind = 'payment_reminder' | 'dunning_notice';

export type DunningDeliveryMethod = InvoiceSentVia;

export interface InvoiceDunningDocumentation {
  id: string;
  /**
   * PAYMENT-REMINDER-WITHOUT-VORGANG-01 — `null` ist die Rechnung ohne Auftrag
   * (freie/manuelle Rechnung). Bestandsdaten tragen weiterhin die Auftragskennung.
   */
  vorgangId: string | null;
  invoiceId: string;
  invoiceNumber: string;
  kind: DunningDocumentationKind;
  /** ISO date YYYY-MM-DD when the user handed the message to the customer. */
  documentedAt: string;
  deliveryMethod: DunningDeliveryMethod;
  note?: string;
  createdAt: string;
  /**
   * CLOUD-DURABILITY-CORE-01D — vom Server bestätigte Version. Fehlt sie, hat
   * dieser Nachweis die Cloud noch nie erreicht.
   */
  sync?: SyncMeta;
}

export interface DocumentDunningInput {
  kind: DunningDocumentationKind;
  documentedAt: string;
  deliveryMethod: DunningDeliveryMethod;
  note?: string;
}
