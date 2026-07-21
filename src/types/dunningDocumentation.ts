import type { InvoiceSentVia } from './models';

/** Confirmed handoff of a payment reminder or dunning notice to the customer. */
export type DunningDocumentationKind = 'payment_reminder' | 'dunning_notice';

export type DunningDeliveryMethod = InvoiceSentVia;

export interface InvoiceDunningDocumentation {
  id: string;
  vorgangId: string;
  invoiceId: string;
  invoiceNumber: string;
  kind: DunningDocumentationKind;
  /** ISO date YYYY-MM-DD when the user handed the message to the customer. */
  documentedAt: string;
  deliveryMethod: DunningDeliveryMethod;
  note?: string;
  createdAt: string;
}

export interface DocumentDunningInput {
  kind: DunningDocumentationKind;
  documentedAt: string;
  deliveryMethod: DunningDeliveryMethod;
  note?: string;
}
