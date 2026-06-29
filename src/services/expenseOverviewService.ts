import { getAllExpensesFromStore } from './expenseStore';
import {
  calculateExpensePaymentSummary,
  isExpenseCancelled,
} from './expensePaymentCalculations';
import type {
  Expense,
  ExpenseOverviewItem,
  ExpensePaymentStatus,
} from '../types/expense';

export type ExpenseOverviewFilter =
  | 'all'
  | 'offen'
  | 'teilbezahlt'
  | 'ueberfaellig'
  | 'bezahlt'
  | 'storniert';

export interface ExpenseOverviewTotals {
  openLiabilities: number;
  overdueLiabilities: number;
  paidTotal: number;
  openExpenseCount: number;
  totalExpenseCount: number;
  overdueExpenseCount: number;
}

const STATUS_SORT_ORDER: Record<ExpensePaymentStatus, number> = {
  ueberfaellig: 0,
  offen: 1,
  teilbezahlt: 2,
  bezahlt: 3,
  storniert: 4,
};

function isPayableExpense(expense: Expense): boolean {
  return expense.status === 'gebucht';
}

function buildOverviewItem(expense: Expense, today?: Date | string): ExpenseOverviewItem {
  return {
    expense,
    paymentSummary: calculateExpensePaymentSummary(expense, today),
  };
}

export function getAllExpenseOverview(today?: Date | string): ExpenseOverviewItem[] {
  const items = getAllExpensesFromStore()
    .filter(isPayableExpense)
    .map((expense) => buildOverviewItem(expense, today));

  return sortExpenseOverviewItems(items);
}

export function sortExpenseOverviewItems(items: ExpenseOverviewItem[]): ExpenseOverviewItem[] {
  return [...items].sort((a, b) => {
    const statusDiff =
      STATUS_SORT_ORDER[a.paymentSummary.status] - STATUS_SORT_ORDER[b.paymentSummary.status];
    if (statusDiff !== 0) return statusDiff;

    const dueA = a.expense.paymentDueDate ?? '9999-12-31';
    const dueB = b.expense.paymentDueDate ?? '9999-12-31';
    return dueA.localeCompare(dueB);
  });
}

export function filterExpenseOverview(
  items: ExpenseOverviewItem[],
  filter: ExpenseOverviewFilter,
): ExpenseOverviewItem[] {
  if (filter === 'all') return items;
  return items.filter((item) => item.paymentSummary.status === filter);
}

export function searchExpenseOverview(
  items: ExpenseOverviewItem[],
  query: string,
): ExpenseOverviewItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;

  return items.filter((item) => {
    const haystack = [
      item.expense.title,
      item.expense.supplierName,
      item.expense.invoiceNumber,
      item.expense.description,
      ...item.expense.tags,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

export function getOpenExpenses(today?: Date | string): ExpenseOverviewItem[] {
  return getAllExpenseOverview(today).filter(
    (item) => item.paymentSummary.status === 'offen',
  );
}

export function getOverdueExpenses(today?: Date | string): ExpenseOverviewItem[] {
  return getAllExpenseOverview(today).filter(
    (item) => item.paymentSummary.status === 'ueberfaellig',
  );
}

export function getPaidExpenses(today?: Date | string): ExpenseOverviewItem[] {
  return getAllExpenseOverview(today).filter(
    (item) => item.paymentSummary.status === 'bezahlt',
  );
}

export function getPartialExpenses(today?: Date | string): ExpenseOverviewItem[] {
  return getAllExpenseOverview(today).filter(
    (item) => item.paymentSummary.status === 'teilbezahlt',
  );
}

export function summarizeExpenseOverview(
  items: ExpenseOverviewItem[] = getAllExpenseOverview(),
): ExpenseOverviewTotals {
  let openLiabilities = 0;
  let overdueLiabilities = 0;
  let paidTotal = 0;
  let openExpenseCount = 0;
  let overdueExpenseCount = 0;

  for (const item of items) {
    const { paymentSummary } = item;
    paidTotal += paymentSummary.paidAmount;

    if (isExpenseCancelled(item.expense)) {
      continue;
    }

    if (paymentSummary.openAmount > 0) {
      openLiabilities += paymentSummary.openAmount;
      openExpenseCount += 1;
    }

    if (paymentSummary.status === 'ueberfaellig') {
      overdueLiabilities += paymentSummary.openAmount;
      overdueExpenseCount += 1;
    }
  }

  return {
    openLiabilities,
    overdueLiabilities,
    paidTotal,
    openExpenseCount,
    totalExpenseCount: items.length,
    overdueExpenseCount,
  };
}

export function applyExpenseOverviewFilters(
  items: ExpenseOverviewItem[],
  filter: ExpenseOverviewFilter,
  query: string,
): ExpenseOverviewItem[] {
  return searchExpenseOverview(filterExpenseOverview(items, filter), query);
}
