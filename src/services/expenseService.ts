import { PAPER_FOLDERS } from '../data/mockData';
import { getCachedSetup, persistAll } from './persistenceService';
import {
  appendExpenseToStore,
  deleteExpenseFromStore,
  getAllExpensesFromStore,
  getExpenseFromStoreById,
  replaceExpenseInStore,
} from './expenseStore';
import {
  buildExpenseDedupeKey,
  normalizeExpense,
} from './expenseNormalize';
import { normalizeExpensePaymentFields } from './expensePaymentCalculations';
import {
  recordExpensePayment,
  removeExpensePayment,
} from './expensePaymentService';
import { EXPENSE_CATEGORIES } from './expenseCategoryMapping';
import type {
  Expense,
  ExpenseCategory,
  ExpenseInput,
  ExpenseSummary,
} from '../types/expense';
import type { DigitalFolder, PaperFilingRule } from '../types/models';

export type ExpenseMutationResult =
  | { success: true; expense: Expense }
  | { success: false; errorKey: string };

export { buildExpenseDedupeKey } from './expenseNormalize';
export { EXPENSE_CATEGORIES } from './expenseCategoryMapping';

function defaultDigitalFolder(): DigitalFolder {
  const year = new Date().getFullYear();
  const month = String(new Date().getMonth() + 1).padStart(2, '0');
  return {
    id: `dig-exp-${Date.now()}`,
    name: 'Ausgaben',
    path: `/Steuerberater/${year}/${month}/Ausgaben/`,
  };
}

function defaultPaperFolder(): PaperFilingRule {
  const folder = PAPER_FOLDERS[0];
  return {
    folderId: folder.id,
    register: folder.registers[0] ?? 'A',
    label: folder.name,
  };
}

function validateInput(input: ExpenseInput): string | null {
  if (!input.supplierName?.trim()) return 'expense.supplierRequired';
  if (!input.title?.trim()) return 'expense.titleRequired';
  if (!input.issueDate?.trim()) return 'expense.issueDateRequired';
  if (!Number.isFinite(input.grossAmount) || input.grossAmount === 0) {
    return 'expense.amountRequired';
  }
  if (!EXPENSE_CATEGORIES.includes(input.category)) return 'expense.categoryRequired';
  return null;
}

function buildExpenseFromInput(
  input: ExpenseInput,
  id: string,
  createdAt: string,
  updatedAt: string,
): Expense {
  const supplierName = input.supplierName.trim();
  const invoiceNumber = input.invoiceNumber?.trim() ?? '';
  const grossAmount = input.grossAmount;
  const netAmount = input.netAmount ?? grossAmount;
  const taxAmount = input.taxAmount ?? Math.max(0, grossAmount - netAmount);

  return normalizeExpense({
    id,
    status: input.status ?? 'gebucht',
    category: input.category,
    supplierName,
    invoiceNumber,
    title: input.title.trim(),
    description: input.description?.trim() ?? '',
    issueDate: input.issueDate,
    paymentDueDate: input.paymentDueDate ?? null,
    taxStatus: input.taxStatus ?? getCachedSetup().taxStatus,
    netAmount,
    taxAmount,
    grossAmount,
    currency: input.currency ?? 'EUR',
    paymentStatus: 'offen',
    payments: [],
    positions: [],
    allocations: [],
    linkedInboxId: input.linkedInboxId,
    archiveDocumentId: input.archiveDocumentId,
    classifiedKind: input.classifiedKind,
    recognizedData: input.recognizedData ? { ...input.recognizedData } : undefined,
    isCreditNote: input.isCreditNote ?? grossAmount < 0,
    dedupeKey: buildExpenseDedupeKey(supplierName, invoiceNumber),
    tags: input.tags ?? [],
    digitalFolder: input.digitalFolder ? { ...input.digitalFolder } : defaultDigitalFolder(),
    paperFolder: input.paperFolder ? { ...input.paperFolder } : defaultPaperFolder(),
    createdAt,
    updatedAt,
  });
}

export function getAllExpenses(): Expense[] {
  return getAllExpensesFromStore().sort((a, b) => b.issueDate.localeCompare(a.issueDate));
}

export function getExpenseById(id: string): Expense | undefined {
  return getExpenseFromStoreById(id);
}

export function searchExpenses(
  query: string,
  categoryFilter?: ExpenseCategory | 'all',
): Expense[] {
  const normalizedQuery = query.trim().toLowerCase();

  return getAllExpenses().filter((expense) => {
    if (categoryFilter && categoryFilter !== 'all' && expense.category !== categoryFilter) {
      return false;
    }
    if (!normalizedQuery) return true;

    const haystack = [
      expense.title,
      expense.supplierName,
      expense.invoiceNumber,
      expense.description,
      expense.dedupeKey,
      ...expense.tags,
    ]
      .join(' ')
      .toLowerCase();

    return haystack.includes(normalizedQuery);
  });
}

export function isDuplicateExpense(
  supplierName: string,
  invoiceNumber: string,
  options?: { excludeExpenseId?: string },
): Expense | null {
  const dedupeKey = buildExpenseDedupeKey(supplierName, invoiceNumber);
  if (!dedupeKey || dedupeKey === '|') return null;

  const match = getAllExpensesFromStore().find((expense) => {
    if (options?.excludeExpenseId && expense.id === options.excludeExpenseId) return false;
    return expense.dedupeKey === dedupeKey;
  });

  return match ?? null;
}

export function addExpense(input: ExpenseInput): ExpenseMutationResult {
  const validationError = validateInput(input);
  if (validationError) return { success: false, errorKey: validationError };

  const duplicate = isDuplicateExpense(input.supplierName, input.invoiceNumber ?? '');
  if (duplicate) return { success: false, errorKey: 'expense.duplicate' };

  const now = new Date().toISOString();
  const expense = buildExpenseFromInput(input, `exp-${Date.now()}`, now, now);
  appendExpenseToStore(expense);
  persistAll();
  return { success: true, expense: getExpenseById(expense.id)! };
}

export function updateExpense(id: string, changes: Partial<ExpenseInput>): ExpenseMutationResult {
  const current = getExpenseFromStoreById(id);
  if (!current) return { success: false, errorKey: 'expense.notFound' };

  const merged: ExpenseInput = {
    title: changes.title ?? current.title,
    category: changes.category ?? current.category,
    supplierName: changes.supplierName ?? current.supplierName,
    invoiceNumber: changes.invoiceNumber ?? current.invoiceNumber,
    description: changes.description ?? current.description,
    issueDate: changes.issueDate ?? current.issueDate,
    paymentDueDate:
      changes.paymentDueDate !== undefined ? changes.paymentDueDate : current.paymentDueDate,
    taxStatus: changes.taxStatus ?? current.taxStatus,
    netAmount: changes.netAmount ?? current.netAmount,
    taxAmount: changes.taxAmount ?? current.taxAmount,
    grossAmount: changes.grossAmount ?? current.grossAmount,
    currency: changes.currency ?? current.currency,
    status: changes.status ?? current.status,
    classifiedKind: changes.classifiedKind ?? current.classifiedKind,
    recognizedData: changes.recognizedData ?? current.recognizedData,
    isCreditNote: changes.isCreditNote ?? current.isCreditNote,
    tags: changes.tags ?? current.tags,
    digitalFolder: changes.digitalFolder ?? current.digitalFolder,
    paperFolder: changes.paperFolder ?? current.paperFolder,
    linkedInboxId: changes.linkedInboxId ?? current.linkedInboxId,
    archiveDocumentId: changes.archiveDocumentId ?? current.archiveDocumentId,
  };

  const validationError = validateInput(merged);
  if (validationError) return { success: false, errorKey: validationError };

  const duplicate = isDuplicateExpense(merged.supplierName, merged.invoiceNumber ?? '', {
    excludeExpenseId: id,
  });
  if (duplicate) return { success: false, errorKey: 'expense.duplicate' };

  const now = new Date().toISOString();
  const updated = buildExpenseFromInput(merged, current.id, current.createdAt, now);
  replaceExpenseInStore(
    id,
    normalizeExpensePaymentFields({
      ...updated,
      payments: current.payments ?? [],
      positions: current.positions,
      allocations: current.allocations,
      cancelledAt: current.cancelledAt,
      cancelReason: current.cancelReason,
    }),
  );
  persistAll();
  return { success: true, expense: getExpenseById(id)! };
}

export function deleteExpense(id: string): ExpenseMutationResult {
  const removed = deleteExpenseFromStore(id);
  if (!removed) return { success: false, errorKey: 'expense.notFound' };
  persistAll();
  return { success: true, expense: removed };
}

export function getExpenseSummary(): ExpenseSummary {
  const items = getAllExpensesFromStore();
  const byCategory: Partial<Record<ExpenseCategory, number>> = {};

  let bookedCount = 0;
  let draftCount = 0;
  let cancelledCount = 0;
  let totalGrossAmount = 0;

  for (const expense of items) {
    if (expense.status === 'gebucht') bookedCount += 1;
    if (expense.status === 'entwurf') draftCount += 1;
    if (expense.status === 'storniert') cancelledCount += 1;
    if (expense.status !== 'storniert') {
      totalGrossAmount += expense.grossAmount;
      byCategory[expense.category] = (byCategory[expense.category] ?? 0) + expense.grossAmount;
    }
  }

  return {
    totalCount: items.length,
    bookedCount,
    draftCount,
    cancelledCount,
    totalGrossAmount,
    byCategory,
  };
}

export function addPaymentToExpense(
  expenseId: string,
  input: Parameters<typeof recordExpensePayment>[1],
) {
  return recordExpensePayment(expenseId, input);
}

export function removePaymentFromExpense(expenseId: string, paymentId: string) {
  return removeExpensePayment(expenseId, paymentId);
}
