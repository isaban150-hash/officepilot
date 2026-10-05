import { MOCK_EXPENSES } from '../data/expenseMockData';
import type { Expense, ExpensePayment, ExpensePaymentStatus } from '../types/expense';
import { normalizeExpense } from './expenseNormalize';

function cloneExpense(expense: Expense): Expense {
  return normalizeExpense(expense);
}

let expenses: Expense[] = [];

export function getExpenseStoreSnapshot(): Expense[] {
  return expenses.map(cloneExpense);
}

export function hydrateExpenseStore(items: Expense[]): void {
  expenses = items.map((item) => normalizeExpense(item));
}

export function resetExpenses(): void {
  expenses = MOCK_EXPENSES.map(cloneExpense);
}

export function getAllExpensesFromStore(): Expense[] {
  return expenses.map(cloneExpense);
}

export function getExpenseFromStoreById(id: string): Expense | undefined {
  const expense = expenses.find((item) => item.id === id);
  return expense ? cloneExpense(expense) : undefined;
}

export function appendExpenseToStore(expense: Expense): Expense {
  const normalized = normalizeExpense(expense);
  expenses = [normalized, ...expenses];
  return cloneExpense(normalized);
}

export function replaceExpenseInStore(id: string, next: Expense): Expense | null {
  const index = expenses.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const normalized = normalizeExpense(next);
  expenses = [...expenses.slice(0, index), normalized, ...expenses.slice(index + 1)];
  return cloneExpense(normalized);
}

export function deleteExpenseFromStore(id: string): Expense | null {
  const index = expenses.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const removed = cloneExpense(expenses[index]);
  expenses = expenses.filter((item) => item.id !== id);
  return removed;
}

export function setExpenseStoreForTests(items: Expense[]): void {
  expenses = items.map((item) => normalizeExpense(item));
}

function cloneExpensePayment(payment: ExpensePayment): ExpensePayment {
  return { ...payment };
}

function updateExpensePaymentFields(
  expenseId: string,
  payments: ExpensePayment[],
  paymentStatus: ExpensePaymentStatus,
): Expense | null {
  const current = expenses.find((item) => item.id === expenseId);
  if (!current) return null;

  const normalized = normalizeExpense({
    ...current,
    payments: payments.map(cloneExpensePayment),
    paymentStatus,
    updatedAt: new Date().toISOString(),
  });

  expenses = expenses.map((item) => (item.id === expenseId ? normalized : item));
  return cloneExpense(normalized);
}

export function addPaymentToExpense(
  expenseId: string,
  payment: ExpensePayment,
  paymentStatus: ExpensePaymentStatus,
): Expense | null {
  const current = expenses.find((item) => item.id === expenseId);
  if (!current) return null;

  return updateExpensePaymentFields(
    expenseId,
    [...(current.payments ?? []), cloneExpensePayment(payment)],
    paymentStatus,
  );
}

/**
 * BARZAHLUNG-V1 BLOCK 1 — eine vorhandene Zahlung an Ort und Stelle ersetzen.
 *
 * Nur fuer Felder **ohne** Geldwirkung gedacht (heute: der Zahlungsnachweis).
 * Der Zahlungsstatus wird deshalb nicht neu gesetzt, sondern unveraendert
 * uebernommen — eine Belegzuordnung darf einen Beleg nicht umbuchen.
 *
 * Die Reihenfolge bleibt erhalten: Eine Zahlungshistorie, die nach dem
 * Anhaengen einer Quittung die Zeilen vertauscht, waere verwirrend.
 */
export function replaceExpensePayment(
  expenseId: string,
  payment: ExpensePayment,
): Expense | null {
  const current = expenses.find((item) => item.id === expenseId);
  if (!current) return null;

  const payments = current.payments ?? [];
  if (!payments.some((entry) => entry.id === payment.id)) return null;

  return updateExpensePaymentFields(
    expenseId,
    payments.map((entry) => (entry.id === payment.id ? cloneExpensePayment(payment) : entry)),
    current.paymentStatus,
  );
}

export function removePaymentFromExpense(
  expenseId: string,
  paymentId: string,
  paymentStatus: ExpensePaymentStatus,
): Expense | null {
  const current = expenses.find((item) => item.id === expenseId);
  if (!current) return null;

  const payments = (current.payments ?? []).filter((payment) => payment.id !== paymentId);
  if (payments.length === (current.payments ?? []).length) {
    return null;
  }

  return updateExpensePaymentFields(expenseId, payments, paymentStatus);
}
