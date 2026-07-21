import {
  addPaymentToInvoice,
  getVorgangInvoice,
  removePaymentFromInvoice,
} from './vorgangService';
import { isFinalizedInvoice } from './invoiceArchiveService';
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

export function isInvoiceOverdue(invoice: VorgangInvoice, today: Date | string = new Date()): boolean {
  // Overdue / dunning only for invoices marked as sent to the customer.
  if (invoice.status !== 'versendet') {
    return false;
  }
  if (!invoice.paymentDueDate || getOpenAmount(invoice) <= 0 || isInvoiceCancelled(invoice)) {
    return false;
  }

  return toDateOnly(today) > toDateOnly(invoice.paymentDueDate);
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

export function recordPayment(
  vorgangId: string,
  invoiceId: string,
  input: InvoicePaymentInput,
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

  const payment: InvoicePayment = {
    id: `pay-${Date.now()}`,
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
  if (!updated) {
    return { success: false, errorKey: 'payment.invoiceNotFound' };
  }

  return { success: true, invoice: updated, payment };
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

  if (!updated) {
    return { success: false, errorKey: 'payment.invoiceNotFound' };
  }

  return { success: true, invoice: updated };
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
