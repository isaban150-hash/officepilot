import {
  addPaymentToExpense as addPaymentToExpenseStore,
  getExpenseFromStoreById,
  removePaymentFromExpense as removePaymentFromExpenseStore,
} from './expenseStore';
import { persistAll } from './persistenceService';
import { generateUuid } from './sync/syncMetaService';
import { enqueueSyncOutbox } from './sync/syncOutboxService';
import { buildExpensePaymentEntityId } from './expense/expenseCloudSyncService';
import {
  calculateExpensePaymentSummary,
  getExpenseOpenAmount,
  getExpensePayments,
  isExpenseCancelled,
  isExpensePayable,
} from './expensePaymentCalculations';
import {
  getPaymentOverpayAmount,
  isSettledPaymentStatus,
  requiresOverpaymentConfirmation,
} from './payment/paymentSemantics';
import type { Expense, ExpensePayment, ExpensePaymentInput } from '../types/expense';

export type ExpensePaymentMutationResult =
  | { success: true; expense: Expense; payment: ExpensePayment }
  | { success: false; errorKey: string };

export type RemoveExpensePaymentResult =
  | { success: true; expense: Expense }
  | { success: false; errorKey: string };

export {
  calculateExpensePaymentSummary,
  getExpenseOpenAmount,
  getExpensePaidAmount,
  getExpensePayments,
  getOverdueDays,
  isCreditNoteExpense,
  isExpenseCancelled,
  isExpenseOverdue,
  isExpensePayable,
  normalizeExpensePaymentFields,
  resolveExpensePaymentStatus,
} from './expensePaymentCalculations';

/**
 * FINANZCORE-05C — dieselben Optionen wie auf der Rechnungsseite.
 *
 * Die Ausgabenseite kannte bisher gar keine Bestaetigung: Eine Zahlung ueber
 * dem offenen Betrag wurde stillschweigend gebucht, und der Beleg stand
 * danach als „bezahlt" da. Dass die Rechnungsseite laengst nachfragte, war
 * kein fachlicher Unterschied, sondern ein Versaeumnis.
 */
export interface RecordExpensePaymentOptions {
  /** Erforderlich, sobald der Betrag den offenen Rest uebersteigt. */
  confirmOverpayment?: boolean;
}

/** FINANZCORE-05C — verlangt dieser Betrag eine ausdrueckliche Bestaetigung? */
export function willExpensePaymentNeedOverpayConfirm(
  openAmount: number,
  paymentAmount: number,
): boolean {
  return requiresOverpaymentConfirmation(openAmount, paymentAmount);
}

/**
 * FINANZCORE-05C — darf auf diese Ausgabe noch eine normale Zahlung?
 *
 * `isExpensePayable` beantwortet die Frage nach der **Art** des Belegs
 * (gebucht, nicht storniert, keine Gutschrift). Hier kommt der **Stand**
 * dazu: Ein Beleg ohne offenen Betrag fordert nichts mehr. Eine Korrektur
 * laeuft ueber die Zahlungsliste, nicht ueber weitere Zahlungen.
 */
export function canRecordExpensePayment(
  expense: Expense,
  today: Date | string = new Date(),
): boolean {
  if (!isExpensePayable(expense)) return false;
  return !isSettledPaymentStatus(calculateExpensePaymentSummary(expense, today).status);
}

export function recordExpensePayment(
  expenseId: string,
  input: ExpensePaymentInput,
  options: RecordExpensePaymentOptions = {},
): ExpensePaymentMutationResult {
  const expense = getExpenseFromStoreById(expenseId);
  if (!expense) {
    return { success: false, errorKey: 'expense.payment.notFound' };
  }

  if (!isExpensePayable(expense)) {
    return { success: false, errorKey: 'expense.payment.notPayable' };
  }

  if (isExpenseCancelled(expense)) {
    return { success: false, errorKey: 'expense.payment.cancelled' };
  }

  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { success: false, errorKey: 'payment.amountInvalid' };
  }

  if (!input.date?.trim()) {
    return { success: false, errorKey: 'payment.dateRequired' };
  }

  /*
   * FINANZCORE-05C — eine Ueberzahlung ist erlaubt, aber nie beilaeufig.
   *
   * Der Betrag wird **nicht** auf den offenen Rest gekuerzt und nicht
   * abgelehnt: Zu viel gezahltes Geld ist eine echte Tatsache, die der Beleg
   * abbilden muss. Verlangt wird nur, dass der Nutzer sie gesehen hat.
   */
  const overpayAmount = getPaymentOverpayAmount(getExpenseOpenAmount(expense), input.amount);
  if (overpayAmount > 0 && !options.confirmOverpayment) {
    return { success: false, errorKey: 'payment.overpaymentConfirmationRequired' };
  }

  /*
   * FINANZCORE-05B — die Kennung wird genau einmal erzeugt und ist eine echte
   * UUID.
   *
   * `pay-${Date.now()}` war zwischen zwei Buchungen kein tragfähiger
   * Idempotenzschlüssel: Zwei Zahlungen in derselben Millisekunde teilten sich
   * eine Kennung. Der Eindeutigkeitsschlüssel der Cloud
   * `(workspace, expense, payment)` hätte daraus **eine** Zahlung gemacht — zwei
   * echte Geldbewegungen wären zu einer verschmolzen, und niemand hätte es
   * gesehen.
   *
   * Dieselbe Lösung wie auf der Rechnungsseite (PAYMENT-FOUNDATION-04B2A) und
   * derselbe Projekt-Helfer; keine neue Bibliothek. Bestehende `pay-…`-
   * Kennungen bleiben unangetastet — eine gebuchte Zahlung ist ein Beleg, kein
   * Formatproblem.
   */
  const payment: ExpensePayment = {
    id: generateUuid(),
    date: input.date.slice(0, 10),
    amount: input.amount,
    reference: input.reference?.trim() || undefined,
    note: input.note?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };

  const summary = calculateExpensePaymentSummary({
    ...expense,
    payments: [...getExpensePayments(expense), payment],
  });

  const updated = addPaymentToExpenseStore(expenseId, payment, summary.status);
  if (!updated) {
    return { success: false, errorKey: 'expense.payment.notFound' };
  }

  /*
   * FINANZ-CORE-DURABILITY-01C — die Zahlung reist als eigene append-only
   * Cloud-Wahrheit. Kennung bleibt stabil: ein Retry trifft denselben
   * Idempotenzschluessel, nie eine zweite Zahlung. Vor persistAll(), damit
   * der Auftrag mit der Zahlung zusammen gespeichert wird.
   */
  enqueueSyncOutbox({ entityType: 'expense_payment', entityId: buildExpensePaymentEntityId(expenseId, payment.id), operation: 'create', version: 1 });
  persistAll();
  return { success: true, expense: updated, payment };
}

export function removeExpensePayment(
  expenseId: string,
  paymentId: string,
): RemoveExpensePaymentResult {
  const expense = getExpenseFromStoreById(expenseId);
  if (!expense) {
    return { success: false, errorKey: 'expense.payment.notFound' };
  }

  const payments = getExpensePayments(expense);
  if (!payments.some((payment) => payment.id === paymentId)) {
    return { success: false, errorKey: 'payment.notFound' };
  }

  const remaining = payments.filter((payment) => payment.id !== paymentId);
  const summary = calculateExpensePaymentSummary({ ...expense, payments: remaining });
  const updated = removePaymentFromExpenseStore(expenseId, paymentId, summary.status);

  if (!updated) {
    return { success: false, errorKey: 'expense.payment.notFound' };
  }

  // 01C — Reversal in der Cloud (Grabstein), sonst lebt die Zahlung beim naechsten Pull wieder auf.
  enqueueSyncOutbox({ entityType: 'expense_payment', entityId: buildExpensePaymentEntityId(expenseId, paymentId), operation: 'delete', version: 1 });
  persistAll();
  return { success: true, expense: updated };
}

export { formatPaymentCurrency } from './invoicePaymentService';
