import { PAPER_FOLDERS } from '../data/mockData';
import { getCachedSetup, persistAll } from './persistenceService';
import { getCompanyProfile } from './companyProfileService';
import { resolveDefaultTaxStatus } from './invoice/invoiceDefaults';
import {
  filterSyncActive,
  generateEntityId,
  isEntitySyncActive,
  withNewEntitySync,
  withTombstonedEntity,
  withUpdatedEntitySync,
} from './sync/syncMetaService';
import {
  appendExpenseToStore,
  getAllExpensesFromStore,
  getExpenseFromStoreById,
  replaceExpenseInStore,
} from './expenseStore';
import {
  buildExpenseDedupeKey,
  normalizeDedupePart,
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
    id: generateEntityId('dig-exp'),
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
    // 01B — Steuerstatus-Default aus dem Firmenprofil (Setup nur Legacy-Spiegel).
    taxStatus: input.taxStatus ?? resolveDefaultTaxStatus(getCompanyProfile(), getCachedSetup()),
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
  return filterSyncActive(getAllExpensesFromStore()).sort((a, b) =>
    b.issueDate.localeCompare(a.issueDate),
  );
}

export function getExpenseById(id: string): Expense | undefined {
  const expense = getExpenseFromStoreById(id);
  if (!expense || !isEntitySyncActive(expense)) return undefined;
  return expense;
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
  // EXPENSE-IDENTIFIER-COMPLETENESS-01: Dieser Vergleich ist nummernbasiert.
  // Ohne belastbare Rechnungs-/Belegnummer kollabierte der Schlüssel auf
  // `<lieferant>|` und hätte jeden weiteren nummernlosen Beleg desselben
  // Lieferanten gesperrt. Ohne Nummer wird daher gar keine Duplikatentscheidung
  // getroffen — es tritt keine Ersatzregel an ihre Stelle.
  if (!normalizeDedupePart(invoiceNumber)) return null;

  const dedupeKey = buildExpenseDedupeKey(supplierName, invoiceNumber);
  if (!dedupeKey || dedupeKey === '|') return null;

  const match = filterSyncActive(getAllExpensesFromStore()).find((expense) => {
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
  const expense = withNewEntitySync(
    buildExpenseFromInput(input, generateEntityId('exp'), now, now),
    'expense',
  );
  appendExpenseToStore(expense);
  persistAll();
  return { success: true, expense: getExpenseById(expense.id)! };
}

/**
 * OFFICEPILOT-V1-A — Bearbeitungsregeln nach Buchung.
 * Eine stornierte Ausgabe ist Historie und wird nicht mehr bearbeitet.
 * Sobald eine Zahlung gebucht ist, bleiben die Beträge fest: Eine stille
 * Betragsänderung würde den Zahlstatus (bezahlt/überzahlt) und die
 * Monatsmappe verfälschen. Der saubere Weg ist Storno + Neu-Erfassung.
 * Beschreibung, Kategorie, Datum, Lieferant, Nummer bleiben änderbar.
 */
export function hasBookedExpensePayments(expense: Expense): boolean {
  return (expense.payments ?? []).length > 0;
}

function amountChanged(next: number | undefined, current: number): boolean {
  return next !== undefined && Math.abs(next - current) > 0.004;
}

export function updateExpense(id: string, changes: Partial<ExpenseInput>): ExpenseMutationResult {
  const current = getExpenseFromStoreById(id);
  if (!current || !isEntitySyncActive(current)) return { success: false, errorKey: 'expense.notFound' };
  if (current.status === 'storniert') return { success: false, errorKey: 'expense.edit.cancelled' };
  if (
    hasBookedExpensePayments(current) &&
    (amountChanged(changes.grossAmount, current.grossAmount) ||
      amountChanged(changes.netAmount, current.netAmount) ||
      amountChanged(changes.taxAmount, current.taxAmount))
  ) {
    return { success: false, errorKey: 'expense.edit.amountLockedAfterPayment' };
  }

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
  const updated = withUpdatedEntitySync(
    buildExpenseFromInput(merged, current.id, current.createdAt, now),
    'expense',
  );
  /*
   * FINANZ-CORE-DURABILITY-01D2 — kanonisches Stornodatum. Der Uebergang nach
   * `storniert` setzt `cancelledAt` genau einmal (Zeitpunkt der Entscheidung);
   * die Ruecknahme loescht es. Altbestand ohne Datum wird nicht nachtraeglich
   * erfunden — die Monatsmappe kennzeichnet ihn sichtbar.
   */
  const becomesCancelled = merged.status === 'storniert';
  const cancelledAt = becomesCancelled ? current.cancelledAt ?? now : undefined;
  replaceExpenseInStore(
    id,
    normalizeExpensePaymentFields({
      ...updated,
      payments: current.payments ?? [],
      positions: current.positions,
      allocations: current.allocations,
      cancelledAt,
      cancelReason: becomesCancelled ? current.cancelReason : undefined,
    }),
  );
  persistAll();
  return { success: true, expense: getExpenseById(id)! };
}

/**
 * OFFICEPILOT-V1-A — Ausgabe stornieren.
 * Kein Löschen: Der Beleg bleibt mit allen Daten erhalten und wird als
 * `storniert` mit Stornodatum und Grund geführt — die Monatsmappe zeigt ihn
 * als eigenen Storno-Beleg im Stornomonat (01D2). Regeln wie bei Rechnungen:
 * genau einmal (idempotent: zweiter Aufruf ändert nichts), Grund ist Pflicht,
 * gebuchte Zahlungen halten das Storno auf — sie werden nie still verändert;
 * der Nutzer nimmt sie sichtbar zurück oder lässt den Beleg stehen.
 * Die Cloud erhält den Zustand über den bestehenden Beleg-Weg
 * (`status`, `cancelledAt`, `cancelReason` liegen im Payload).
 */
export function cancelExpense(id: string, reason: string): ExpenseMutationResult {
  const current = getExpenseFromStoreById(id);
  if (!current || !isEntitySyncActive(current)) return { success: false, errorKey: 'expense.notFound' };
  if (current.status === 'storniert') return { success: false, errorKey: 'expense.cancel.alreadyCancelled' };
  const trimmedReason = reason.trim();
  if (!trimmedReason) return { success: false, errorKey: 'expense.cancel.reasonRequired' };
  if (current.status !== 'gebucht') return { success: false, errorKey: 'expense.cancel.notBooked' };
  if (hasBookedExpensePayments(current)) return { success: false, errorKey: 'expense.cancel.hasPayments' };

  const now = new Date().toISOString();
  const cancelled = withUpdatedEntitySync(
    normalizeExpensePaymentFields({
      ...current,
      status: 'storniert',
      cancelledAt: now,
      cancelReason: trimmedReason,
      updatedAt: now,
    }),
    'expense',
  );
  replaceExpenseInStore(id, cancelled);
  persistAll();
  return { success: true, expense: getExpenseById(id)! };
}

export function deleteExpense(id: string): ExpenseMutationResult {
  const current = getExpenseFromStoreById(id);
  if (!current || !isEntitySyncActive(current)) return { success: false, errorKey: 'expense.notFound' };
  // 01C — dieselbe Regel wie in der Cloud: gebuchte Zahlungen halten den Beleg.
  if ((current.payments ?? []).length > 0) return { success: false, errorKey: 'expense.delete.hasPayments' };
  const tombstoned = withTombstonedEntity(current, 'expense');
  replaceExpenseInStore(id, tombstoned);
  persistAll();
  return { success: true, expense: tombstoned };
}

export function getExpenseSummary(): ExpenseSummary {
  const items = filterSyncActive(getAllExpensesFromStore());
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
