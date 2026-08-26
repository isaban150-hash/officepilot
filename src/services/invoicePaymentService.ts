import {
  addPaymentToInvoice,
  getVorgangInvoice,
  removePaymentFromInvoice,
} from './vorgangService';
import { isFinalizedInvoice } from './invoiceArchiveService';
import { generateUuid } from './sync/syncMetaService';
import type { InvoicePaymentCloudOutcome } from './invoice/workspaceInvoicePaymentCloudService';
import type {
  InvoicePayment,
  InvoicePaymentInput,
  InvoicePaymentStatus,
  PaymentSummary,
  VorgangInvoice,
} from '../types/models';

export type PaymentMutationResult =
  | { success: true; invoice: VorgangInvoice; payment: InvoicePayment }
  | { success: false; errorKey: string };

export type RemovePaymentResult =
  | { success: true; invoice: VorgangInvoice }
  | { success: false; errorKey: string };

function toDateOnly(value: Date | string): string {
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  return value.toISOString().slice(0, 10);
}

export function getInvoicePayments(invoice: VorgangInvoice): InvoicePayment[] {
  return (invoice.payments ?? []).map((payment) => ({ ...payment }));
}

export function getPaidAmount(invoice: VorgangInvoice): number {
  return getInvoicePayments(invoice).reduce((sum, payment) => sum + payment.amount, 0);
}

export function getOpenAmount(invoice: VorgangInvoice): number {
  const totalDue = invoice.amount;
  return Math.max(0, totalDue - getPaidAmount(invoice));
}

export function isInvoiceCancelled(invoice: VorgangInvoice): boolean {
  return invoice.paymentStatus === 'storniert' || Boolean(invoice.cancelledAt);
}

/** Workflow status: invoice was marked as handed to the customer. */
export function isSentInvoice(invoice: VorgangInvoice): boolean {
  return invoice.status === 'versendet';
}

/**
 * Payment is expected only after the invoice was marked as sent.
 * Prepared (vorbereitet) invoices stay visible in open receivables but are not due/dunning.
 */
export function isExpectingPayment(invoice: VorgangInvoice): boolean {
  return isSentInvoice(invoice) && !isInvoiceCancelled(invoice);
}

export function isInvoiceOverdue(invoice: VorgangInvoice, today: Date | string = new Date()): boolean {
  // Overdue / dunning only for invoices marked as sent to the customer.
  if (!isExpectingPayment(invoice)) {
    return false;
  }
  if (!invoice.paymentDueDate || getOpenAmount(invoice) <= 0) {
    return false;
  }

  return toDateOnly(today) > toDateOnly(invoice.paymentDueDate);
}

/** True when sent date is after payment due date — due date is not auto-adjusted. */
export function isSentDateAfterPaymentDue(
  sentAt: string | undefined,
  paymentDueDate: string | undefined,
): boolean {
  if (!sentAt?.trim() || !paymentDueDate?.trim()) return false;
  return toDateOnly(sentAt) > toDateOnly(paymentDueDate);
}

export function getPaymentOverpayAmount(openAmount: number, paymentAmount: number): number {
  if (!Number.isFinite(paymentAmount) || !Number.isFinite(openAmount)) return 0;
  return Math.max(0, paymentAmount - openAmount);
}

/** Prepared invoices require an explicit confirmation before recording payment. */
export function willPaymentNeedUnsentConfirm(invoice: VorgangInvoice): boolean {
  return invoice.status === 'vorbereitet' && !isInvoiceCancelled(invoice);
}

export function calculatePaymentSummary(
  invoice: VorgangInvoice,
  today: Date | string = new Date(),
): PaymentSummary {
  const totalDue = invoice.amount;
  const paidAmount = getPaidAmount(invoice);
  const openAmount = Math.max(0, totalDue - paidAmount);
  const overpaidAmount = Math.max(0, paidAmount - totalDue);
  const status = resolvePaymentStatus(invoice, today, {
    paidAmount,
    openAmount,
    overpaidAmount,
  });

  return {
    totalDue,
    paidAmount,
    openAmount,
    overpaidAmount,
    status,
  };
}

export function resolvePaymentStatus(
  invoice: VorgangInvoice,
  today: Date | string = new Date(),
  amounts?: Pick<PaymentSummary, 'paidAmount' | 'openAmount' | 'overpaidAmount'>,
): InvoicePaymentStatus {
  if (isInvoiceCancelled(invoice)) {
    return 'storniert';
  }

  const paidAmount = amounts?.paidAmount ?? getPaidAmount(invoice);
  const openAmount = amounts?.openAmount ?? getOpenAmount(invoice);
  const overdue = isInvoiceOverdue({ ...invoice, payments: invoice.payments ?? [] }, today);

  if (openAmount <= 0) {
    return 'bezahlt';
  }

  if (paidAmount > 0) {
    return overdue ? 'ueberfaellig' : 'teilbezahlt';
  }

  return overdue ? 'ueberfaellig' : 'offen';
}

export function normalizeInvoicePaymentFields(invoice: VorgangInvoice): VorgangInvoice {
  const payments = getInvoicePayments(invoice);
  const summary = calculatePaymentSummary({ ...invoice, payments });

  return {
    ...invoice,
    payments,
    paymentStatus: summary.status,
  };
}

export interface RecordPaymentOptions {
  /** Required when invoice.status is `vorbereitet` — does not change send status. */
  confirmUnsent?: boolean;
  /** Required when amount exceeds the current open remainder. */
  confirmOverpayment?: boolean;
}

export function recordPayment(
  vorgangId: string,
  invoiceId: string,
  input: InvoicePaymentInput,
  options: RecordPaymentOptions = {},
): PaymentMutationResult {
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) {
    return { success: false, errorKey: 'payment.invoiceNotFound' };
  }

  if (!isFinalizedInvoice(invoice)) {
    return { success: false, errorKey: 'payment.invoiceNotFinalized' };
  }

  if (isInvoiceCancelled(invoice)) {
    return { success: false, errorKey: 'payment.invoiceCancelled' };
  }

  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { success: false, errorKey: 'payment.amountInvalid' };
  }

  if (!input.date?.trim()) {
    return { success: false, errorKey: 'payment.dateRequired' };
  }

  if (invoice.status === 'vorbereitet' && !options.confirmUnsent) {
    return { success: false, errorKey: 'payment.unsentConfirmationRequired' };
  }

  const openAmount = getOpenAmount(invoice);
  const overpayAmount = getPaymentOverpayAmount(openAmount, input.amount);
  if (overpayAmount > 0 && !options.confirmOverpayment) {
    return { success: false, errorKey: 'payment.overpaymentConfirmationRequired' };
  }

  /*
   * PAYMENT-FOUNDATION-04B2A — die Kennung wird genau einmal erzeugt und ist
   * eine echte UUID. Der frühere `pay-${Date.now()}` war zwischen zwei Geräten
   * kein tragfähiger Idempotenzschlüssel: Zwei Zahlungen in derselben
   * Millisekunde teilten sich eine Kennung, und ein späterer Abgleich hätte
   * zwei echte Geldbewegungen zu einer verschmolzen.
   *
   * Bestehende `pay-…`-Kennungen bleiben unangetastet — eine gebuchte Zahlung
   * ist ein Beleg, kein Formatproblem.
   */
  const payment: InvoicePayment = {
    id: generateUuid(),
    date: input.date.slice(0, 10),
    amount: input.amount,
    reference: input.reference?.trim() || undefined,
    note: input.note?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };

  const summary = calculatePaymentSummary({
    ...invoice,
    payments: [...getInvoicePayments(invoice), payment],
  });

  const updated = addPaymentToInvoice(vorgangId, invoiceId, payment, summary.status);
  if (!updated.ok) {
    return {
      success: false,
      errorKey:
        updated.reason === 'persist_failed' ? 'payment.persistFailed' : 'payment.invoiceNotFound',
    };
  }

  return { success: true, invoice: updated.invoice, payment };
}

export function removePayment(
  vorgangId: string,
  invoiceId: string,
  paymentId: string,
): RemovePaymentResult {
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) {
    return { success: false, errorKey: 'payment.invoiceNotFound' };
  }

  const payments = getInvoicePayments(invoice);
  if (!payments.some((payment) => payment.id === paymentId)) {
    return { success: false, errorKey: 'payment.notFound' };
  }

  const remaining = payments.filter((payment) => payment.id !== paymentId);
  const summary = calculatePaymentSummary({ ...invoice, payments: remaining });
  const updated = removePaymentFromInvoice(vorgangId, invoiceId, paymentId, summary.status);

  if (!updated.ok) {
    return {
      success: false,
      errorKey:
        updated.reason === 'persist_failed' ? 'payment.persistFailed' : 'payment.invoiceNotFound',
    };
  }

  return { success: true, invoice: updated.invoice };
}

/* -------------------------------------------------------------------------- */
/* PAYMENT-CLOUD-DURABILITY-04B2B                                             */
/* -------------------------------------------------------------------------- */

/**
 * PAYMENT-CLOUD-CLOSURE-04B2B1 — für eine Geldbewegung ist nur `synced` genug.
 *
 * Beim Versandstatus durfte `supabase_not_configured` schweigen: ohne Cloud
 * gibt es dort nichts zu sichern. Bei einer Zahlung ist das anders — sie steht
 * dann nachweislich nur auf diesem Gerät, und genau das muss der Nutzer wissen.
 * Deshalb ein eigenes, strengeres Prädikat statt des geteilten `…Silent`.
 */
export function isInvoicePaymentCloudSynced(outcome: InvoicePaymentCloudOutcome): boolean {
  return outcome === 'synced';
}

/**
 * Sichert eine **bereits lokal gespeicherte** Zahlung in der Cloud.
 *
 * Bewusst ein eigener Schritt nach dem lokalen Commit: Die Zahlung ist damit
 * bereits erfasst und wird bei einem Cloud-Fehler nicht zurückgenommen — der
 * Nutzer hat sie schließlich gebucht. Gemeldet wird nur, ob sie auch
 * geräteübergreifend gesichert ist.
 *
 * Es wird **nie** eine neue Kennung erzeugt: Ein Wiederholungsversuch nutzt
 * dieselbe `payment.id` und trifft damit denselben Idempotenzschlüssel.
 */
export async function syncInvoicePaymentToCloud(
  invoiceId: string,
  payment: InvoicePayment,
): Promise<InvoicePaymentCloudOutcome> {
  try {
    const { addInvoicePaymentToCloud } = await import(
      './invoice/workspaceInvoicePaymentCloudService'
    );
    const result = await addInvoicePaymentToCloud({
      clientInvoiceId: invoiceId,
      clientPaymentId: payment.id,
      amount: payment.amount,
      paidOn: payment.date,
      reference: payment.reference,
      note: payment.note,
    });
    return result.outcome;
  } catch {
    return 'failed';
  }
}

/**
 * Storniert eine Zahlung in der Cloud. **Vor** dem lokalen Entfernen aufzurufen:
 * Ein hartes lokales Löschen bei fehlgeschlagenem Reversal ließe die Zahlung
 * beim nächsten Pull überraschend wieder erscheinen.
 */
export async function reverseInvoicePaymentInCloudForRemoval(
  invoiceId: string,
  paymentId: string,
): Promise<InvoicePaymentCloudOutcome> {
  try {
    const { reverseInvoicePaymentInCloud } = await import(
      './invoice/workspaceInvoicePaymentCloudService'
    );
    const result = await reverseInvoicePaymentInCloud({
      clientInvoiceId: invoiceId,
      clientPaymentId: paymentId,
    });
    return result.outcome;
  } catch {
    return 'failed';
  }
}

/**
 * Zahlungen, die lokal existieren, in der Cloud aber unbekannt sind.
 *
 * Grundlage des Confirm-first-Hinweises „noch nicht in der Cloud gesichert".
 * **Nur nach einem nachweislich erfolgreichen Pull aufrufen** — unbekannt ist
 * nicht dasselbe wie ungesichert.
 */
export function findLocallyOnlyPayments(
  invoice: VorgangInvoice,
  cloudPaymentIds: readonly string[],
): InvoicePayment[] {
  const known = new Set(cloudPaymentIds);
  return getInvoicePayments(invoice).filter((payment) => !known.has(payment.id));
}

export function getOverdueDays(
  invoice: VorgangInvoice,
  today: Date | string = new Date(),
): number {
  if (!invoice.paymentDueDate || !isInvoiceOverdue(invoice, today)) {
    return 0;
  }

  const due = new Date(toDateOnly(invoice.paymentDueDate));
  const now = new Date(toDateOnly(today));
  const diffMs = now.getTime() - due.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

export function summarizeVorgangInvoicePayments(invoices: VorgangInvoice[]): {
  openTotal: number;
  paidTotal: number;
} {
  let openTotal = 0;
  let paidTotal = 0;

  for (const invoice of invoices) {
    if (!isFinalizedInvoice(invoice)) continue;
    const summary = calculatePaymentSummary(invoice);
    openTotal += summary.openAmount;
    paidTotal += summary.paidAmount;
  }

  return { openTotal, paidTotal };
}

export function formatPaymentCurrency(value: number): string {
  return `${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}
