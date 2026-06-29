import {
  addPaymentToExpense as addPaymentToExpenseStore,
  getExpenseFromStoreById,
  removePaymentFromExpense as removePaymentFromExpenseStore,
} from './expenseStore';
import { persistAll } from './persistenceService';
import {
  calculateExpensePaymentSummary,
  getExpensePayments,
  isExpenseCancelled,
  isExpensePayable,
} from './expensePaymentCalculations';
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
  isExpenseCancelled,
  isExpenseOverdue,
  isExpensePayable,
  normalizeExpensePaymentFields,
  resolveExpensePaymentStatus,
} from './expensePaymentCalculations';

export function recordExpensePayment(
  expenseId: string,
  input: ExpensePaymentInput,
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

  const payment: ExpensePayment = {
    id: `pay-${Date.now()}`,
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

  persistAll();
  return { success: true, expense: updated };
}

export { formatPaymentCurrency } from './invoicePaymentService';
