import { persistAll } from './persistenceService';
import {
  calculatePaymentSummary,
  isExpectingPayment,
} from './invoicePaymentService';
import { isValidInvoiceSentVia, INVOICE_SENT_VIA_OPTIONS } from './invoiceSentService';
import { getVorgangInvoice } from './vorgangService';
import type {
  DocumentDunningInput,
  DunningDeliveryMethod,
  DunningDocumentationKind,
  InvoiceDunningDocumentation,
} from '../types/dunningDocumentation';
import type { TranslationKey } from '../i18n';

export const DUNNING_DOCUMENTATION_KINDS: readonly DunningDocumentationKind[] = [
  'payment_reminder',
  'dunning_notice',
] as const;

export const DUNNING_DELIVERY_METHODS = INVOICE_SENT_VIA_OPTIONS;

export type DocumentDunningResult =
  | { ok: true; documentation: InvoiceDunningDocumentation }
  | {
      ok: false;
      reason:
        | 'invoice_missing'
        | 'not_sent'
        | 'not_open'
        | 'invalid_kind'
        | 'invalid_date'
        | 'invalid_delivery'
        | 'draft_or_prepared';
    };

function cloneDoc(doc: InvoiceDunningDocumentation): InvoiceDunningDocumentation {
  return { ...doc };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  const time = Date.parse(`${value.trim()}T00:00:00.000Z`);
  return Number.isFinite(time);
}

function isValidKind(value: unknown): value is DunningDocumentationKind {
  return (
    typeof value === 'string' &&
    (DUNNING_DOCUMENTATION_KINDS as readonly string[]).includes(value)
  );
}

let documentations: InvoiceDunningDocumentation[] = [];

export function getDunningDocumentationStoreSnapshot(): InvoiceDunningDocumentation[] {
  return documentations.map(cloneDoc);
}

export function hydrateDunningDocumentations(items: InvoiceDunningDocumentation[]): void {
  documentations = items.map(cloneDoc);
}

export function resetDunningDocumentations(): void {
  documentations = [];
}

export function setDunningDocumentationStoreForTests(
  items: InvoiceDunningDocumentation[],
): void {
  documentations = items.map(cloneDoc);
}

export function getDunningDocumentationsForInvoice(
  vorgangId: string,
  invoiceId: string,
): InvoiceDunningDocumentation[] {
  return documentations
    .filter((doc) => doc.vorgangId === vorgangId && doc.invoiceId === invoiceId)
    .sort((a, b) => b.documentedAt.localeCompare(a.documentedAt) || b.createdAt.localeCompare(a.createdAt))
    .map(cloneDoc);
}

export function getDunningDocumentationsByInvoiceNumber(
  vorgangId: string,
  invoiceNumber: string,
): InvoiceDunningDocumentation[] {
  const norm = invoiceNumber.trim().toLowerCase();
  return documentations
    .filter(
      (doc) =>
        doc.vorgangId === vorgangId && doc.invoiceNumber.trim().toLowerCase() === norm,
    )
    .sort((a, b) => b.documentedAt.localeCompare(a.documentedAt) || b.createdAt.localeCompare(a.createdAt))
    .map(cloneDoc);
}

/**
 * Level from confirmed handoffs only.
 * payment_reminder → 1, dunning_notice → 2. Never decreases an existing higher level.
 */
export function resolveDocumentedDunningLevelFromRecords(
  records: InvoiceDunningDocumentation[],
): 0 | 1 | 2 {
  let level: 0 | 1 | 2 = 0;
  for (const doc of records) {
    if (doc.kind === 'dunning_notice') level = 2;
    else if (doc.kind === 'payment_reminder') level = Math.max(level, 1) as 0 | 1 | 2;
  }
  return level;
}

/**
 * Document that a payment reminder or dunning notice was handed to the customer.
 * Does not send email/post — records user confirmation only.
 */
export function documentDunningDelivery(
  vorgangId: string,
  invoiceId: string,
  input: DocumentDunningInput,
): DocumentDunningResult {
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) {
    return { ok: false, reason: 'invoice_missing' };
  }

  if (invoice.status === 'entwurf' || invoice.status === 'vorbereitet') {
    return { ok: false, reason: 'draft_or_prepared' };
  }

  if (!isExpectingPayment(invoice)) {
    return { ok: false, reason: 'not_sent' };
  }

  const summary = calculatePaymentSummary(invoice);
  if (summary.openAmount <= 0 || summary.status === 'bezahlt') {
    return { ok: false, reason: 'not_open' };
  }

  if (!isValidKind(input.kind)) {
    return { ok: false, reason: 'invalid_kind' };
  }

  const documentedAt = input.documentedAt?.trim() ?? '';
  if (!documentedAt || !isIsoDate(documentedAt)) {
    return { ok: false, reason: 'invalid_date' };
  }

  if (!isValidInvoiceSentVia(input.deliveryMethod)) {
    return { ok: false, reason: 'invalid_delivery' };
  }

  const documentation: InvoiceDunningDocumentation = {
    id: `dunning-doc-${Date.now()}`,
    vorgangId,
    invoiceId,
    invoiceNumber: invoice.number,
    kind: input.kind,
    documentedAt,
    deliveryMethod: input.deliveryMethod as DunningDeliveryMethod,
    note: input.note?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };

  documentations = [documentation, ...documentations];
  persistAll();
  return { ok: true, documentation: cloneDoc(documentation) };
}

export function formatDunningKindLabel(
  kind: DunningDocumentationKind,
  translate: (key: TranslationKey) => string,
): string {
  return translate(`dunning.doc.kind.${kind}` as TranslationKey);
}

export function formatDunningDeliveryLabel(
  method: DunningDeliveryMethod,
  translate: (key: TranslationKey) => string,
): string {
  return translate(`invoice.sent.via.${method}` as TranslationKey);
}
