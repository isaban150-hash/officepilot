import { MOCK_EXPENSES } from '../data/expenseMockData';
import type { Expense } from '../types/expense';
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
