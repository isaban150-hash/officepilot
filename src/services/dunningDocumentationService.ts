import { persistAll } from './persistenceService';
import { generateEntityId } from './sync/syncMetaService';
import {
  calculatePaymentSummary,
  isExpectingPayment,
} from './invoicePaymentService';
import { isValidInvoiceSentVia, INVOICE_SENT_VIA_OPTIONS } from './invoiceSentService';
import { getVorgangInvoice } from './vorgangService';
import type { VorgangInvoice } from '../types/models';
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
  | {
      ok: true;
      documentation: InvoiceDunningDocumentation;
      /**
       * PAYMENT-REMINDER-01 — derselbe Vorgang (Rechnung, Art, Datum, Weg) war
       * bereits dokumentiert. Es entsteht kein zweiter Eintrag; der Nutzer
       * erfährt, dass seine Angabe schon festgehalten ist.
       */
      alreadyDocumented?: boolean;
    }
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

/** `null` ist die Rechnung ohne Auftrag; Bestandsdaten behalten ihre Auftragskennung. */
function sameScope(doc: InvoiceDunningDocumentation, vorgangId: string | null): boolean {
  return (doc.vorgangId ?? null) === (vorgangId ?? null);
}

export function getDunningDocumentationsForInvoice(
  vorgangId: string | null,
  invoiceId: string,
): InvoiceDunningDocumentation[] {
  return documentations
    .filter((doc) => sameScope(doc, vorgangId) && doc.invoiceId === invoiceId)
    .sort((a, b) => b.documentedAt.localeCompare(a.documentedAt) || b.createdAt.localeCompare(a.createdAt))
    .map(cloneDoc);
}

export function getDunningDocumentationsByInvoiceNumber(
  vorgangId: string | null,
  invoiceNumber: string,
): InvoiceDunningDocumentation[] {
  const norm = invoiceNumber.trim().toLowerCase();
  return documentations
    .filter(
      (doc) => sameScope(doc, vorgangId) && doc.invoiceNumber.trim().toLowerCase() === norm,
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

/** Dokumentierte Mahnstufe einer Rechnung (0 = noch keine Erinnerung dokumentiert). */
export function getDocumentedDunningLevel(
  vorgangId: string | null,
  invoiceId: string,
): 0 | 1 | 2 {
  return resolveDocumentedDunningLevelFromRecords(
    getDunningDocumentationsForInvoice(vorgangId, invoiceId),
  );
}

/** Die jüngste dokumentierte Erinnerung/Mahnung — für die Anzeige am Beleg. */
export function getLatestDunningDocumentation(
  vorgangId: string | null,
  invoiceId: string,
): InvoiceDunningDocumentation | undefined {
  return getDunningDocumentationsForInvoice(vorgangId, invoiceId)[0];
}

/**
 * PAYMENT-REMINDER-01 — darf zu dieser Rechnung überhaupt gemahnt werden?
 * Dieselben Regeln wie `documentDunningDelivery`, damit die Oberfläche keine
 * Aktion anbietet, die der Dienst anschließend ablehnt: nur eine versendete,
 * nicht stornierte Rechnung mit offenem Betrag. Entwurf/vorbereitet, bezahlt
 * und storniert sind nicht mahnbar.
 */
export function canDocumentDunningForInvoice(invoice: VorgangInvoice): boolean {
  if (invoice.status === 'entwurf' || invoice.status === 'vorbereitet') return false;
  if (!isExpectingPayment(invoice)) return false;
  const summary = calculatePaymentSummary(invoice);
  return summary.openAmount > 0 && summary.status !== 'bezahlt';
}

/**
 * Document that a payment reminder or dunning notice was handed to the customer.
 * Does not send email/post — records user confirmation only.
 */
export function documentDunningDelivery(
  vorgangId: string | null,
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

  /*
   * Schutz gegen unbeabsichtigte Duplikate: Dieselbe Übergabe (Rechnung, Art,
   * Datum, Weg) zweimal bestätigt — etwa durch Doppelklick oder erneutes
   * Öffnen des Dialogs — erzeugt keinen zweiten Eintrag. Eine bewusst andere
   * Angabe (anderes Datum, andere Art, anderer Weg) bleibt eine eigene Zeile.
   */
  const existing = documentations.find(
    (doc) =>
      sameScope(doc, vorgangId) &&
      doc.invoiceId === invoiceId &&
      doc.kind === input.kind &&
      doc.documentedAt === documentedAt &&
      doc.deliveryMethod === input.deliveryMethod,
  );
  if (existing) {
    return { ok: true, documentation: cloneDoc(existing), alreadyDocumented: true };
  }

  /*
   * CLOUD-DURABILITY-CORE-01D — die Kennung kommt jetzt aus `generateEntityId`.
   *
   * Bisher stand hier `dunning-doc-<Millisekunde>`. Lokal reichte das; als
   * Cloud-Schlüssel nicht: Zwei Geräte — und in derselben Millisekunde sogar
   * ein einzelnes — könnten dieselbe Kennung für **verschiedene** Nachweise
   * vergeben, und die Cloud führt sie unter `client_documentation_id` zusammen.
   * Ein Nachweis überschriebe den anderen.
   *
   * Vorhandene Kennungen bleiben unangetastet; es gibt keine Migration. Der
   * Datensatz bekommt auch **keine** Sync-Meta: `sync.version` ist allein die
   * vom Server bestätigte `row_version` (SYNC-VERSION-CONTRACT-02).
   */
  const documentation: InvoiceDunningDocumentation = {
    id: generateEntityId('dunning-doc'),
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
