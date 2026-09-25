import { PAPER_FOLDERS } from '../data/mockData';
import { persistAll } from './persistenceService';
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
import { fromCents, isValidMoneyNumber, toCents } from './invoiceMoney';
import {
  checkExpenseMoneyIntegrity,
  type ExpenseMoneyAmounts,
} from './expense/expenseMoneyIntegrity';
import { getVorgangById } from './vorgangService';
import {
  recordExpensePayment,
  removeExpensePayment,
} from './expensePaymentService';
import { EXPENSE_CATEGORIES } from './expenseCategoryMapping';
import type {
  Expense,
  ExpenseAllocation,
  ExpenseCategory,
  ExpenseInput,
  ExpenseSummary,
} from '../types/expense';
import type { DigitalFolder, PaperFilingRule, TaxStatus } from '../types/models';

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

/**
 * FINANZCORE-05B-FIX1 — der Steuerstatus **dieses Belegs**.
 *
 * ## Was hier falsch war
 *
 * Bis hierher stand an dieser Stelle
 * `resolveDefaultTaxStatus(getCompanyProfile(), getCachedSetup())` — also der
 * Steuerstatus, mit dem der Betrieb **seine eigenen Rechnungen schreibt**.
 *
 * Das ist ein Kategorienfehler. Der Steuerstatus einer Ausgabe ist eine
 * Eigenschaft des Lieferantenbelegs, nicht der eigenen Fakturierung. Wer selbst
 * nach §13b abrechnet oder Kleinunternehmer ist, bekommt trotzdem
 * Lieferantenrechnungen mit ausgewiesenen 19 %. Das Feld sagt es selbst:
 * `defaultTaxStatus` ist dokumentiert als Vorbelegung für **neue
 * Rechnungsentwürfe**, „der Steuerstatus neuer Vorgänge".
 *
 * Sichtbar wurde es in der Abnahme von 05B: Bei einem Betrieb mit
 * Nullsteuer-Status wurde eine völlig korrekte Ausgabe über 100 / 19 / 119 mit
 * „Bei diesem Steuerstatus fällt keine Umsatzsteuer an" abgelehnt — ohne dass
 * es im Formular überhaupt einen Steuerstatus zu sehen gab.
 *
 * ## Was jetzt gilt
 *
 * Der Wert kommt vom Aufrufer. Das manuelle Formular zeigt ihn sichtbar an und
 * schickt ihn mit; sein Vorschlag ist `standard_19`, der Normalfall einer
 * Lieferantenrechnung.
 *
 * Fehlt er — der Weg aus dem Eingangsdokument sendet keinen —, gilt `unclear`.
 * Das ist die ehrliche Antwort: Aus einem eingescannten Beleg ist der
 * Steuerstatus nicht zuverlässig ableitbar, und `unclear` heisst im Modell
 * genau „unbekannt, bitte prüfen". Pauschal 19 % anzunehmen wäre eine
 * erfundene Steuerbehandlung; den Firmenstatus zu nehmen war der Fehler, der
 * gerade behoben wird.
 */
function resolveExpenseTaxStatus(input: ExpenseInput): TaxStatus {
  return input.taxStatus ?? 'unclear';
}

/**
 * FINANZCORE-05B — die **eine** Auflösung der drei Geldwerte.
 *
 * Netto und Steuer sind im Eingabemodell optional; was fehlt, wird hier
 * ergänzt. Diese Funktion ist bewusst die einzige Stelle, an der das geschieht:
 * Prüfte die Validierung andere Werte, als der Bau danach einsetzt, wäre die
 * Invariante wertlos.
 *
 * Gerechnet wird in Cent. Die frühere Ergänzung `Math.max(0, brutto - netto)`
 * ist dabei **entfallen** — sie war die Ursache eines stillen Widerspruchs:
 * Bei einer Gutschrift (brutto −119, netto −100) lieferte die Klammer den
 * Steuerbetrag 0, und damit ergab `netto + steuer` −100 statt −119. Für alle
 * Fälle mit brutto ≥ netto ändert sich nichts; der einzige Unterschied liegt
 * dort, wo die Klammer bisher einen ungültigen Beleg erzeugt hat.
 */
function resolveExpenseAmounts(input: ExpenseInput): ExpenseMoneyAmounts {
  const grossAmount = input.grossAmount;
  const netAmount = input.netAmount ?? grossAmount;
  const taxAmount =
    input.taxAmount ??
    (isValidMoneyNumber(grossAmount) && isValidMoneyNumber(netAmount)
      ? fromCents(toCents(grossAmount) - toCents(netAmount))
      : Number.NaN);
  return { netAmount, taxAmount, grossAmount, taxStatus: resolveExpenseTaxStatus(input) };
}

function validateInput(input: ExpenseInput): string | null {
  if (!input.supplierName?.trim()) return 'expense.supplierRequired';
  if (!input.title?.trim()) return 'expense.titleRequired';
  if (!input.issueDate?.trim()) return 'expense.issueDateRequired';
  if (!Number.isFinite(input.grossAmount) || input.grossAmount === 0) {
    return 'expense.amountRequired';
  }
  if (!EXPENSE_CATEGORIES.includes(input.category)) return 'expense.categoryRequired';

  /*
   * FINANZCORE-05B — die Geldinvariante, an genau einer Stelle für beide
   * Schreibwege. `addExpense` prüft die Eingabe, `updateExpense` prüft den
   * zusammengeführten Stand — beide laufen durch diese Funktion, also kann
   * keiner von beiden die Prüfung umgehen.
   *
   * Fail-closed: Ein widersprüchlicher Beleg wird nicht gerundet, nicht
   * korrigiert und nicht gespeichert. Er wird abgelehnt.
   */
  const money = checkExpenseMoneyIntegrity(resolveExpenseAmounts(input));
  if (!money.ok) {
    /*
     * FINANZCORE-05B-FIX1 — die Reihenfolge der Meldungen.
     *
     * Bei 100 / 19 / 200 lagen zwei Befunde gleichzeitig vor, und gemeldet
     * wurde der über den Steuerstatus. Der Nutzer las „keine Umsatzsteuer
     * erlaubt", während sein eigentliches Problem war, dass 100 + 19 nicht 200
     * ergibt — und suchte an der falschen Stelle.
     *
     * Der Betragswiderspruch kommt deshalb zuerst: Er ist unmittelbar
     * nachrechenbar und muss ohnehin behoben werden, bevor die Frage nach dem
     * Steuerstatus überhaupt sinnvoll ist.
     */
    const codes = money.issues.map((issue) => issue.code);
    if (codes.includes('amount_not_finite')) return 'expense.amountRequired';
    if (codes.includes('equation_mismatch')) return 'expense.amountsInconsistent';
    if (codes.includes('tax_sign_mismatch')) return 'expense.amountsInconsistent';
    return 'expense.taxAmountNotAllowedForStatus';
  }

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
  // FINANZCORE-05B — dieselbe Aufloesung, die auch geprueft wurde.
  const { netAmount, taxAmount, grossAmount, taxStatus } = resolveExpenseAmounts(input);

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
    taxStatus,
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
  /*
   * ORDER-COST-ALLOCATION-01B — ein kleinerer Nettobetrag darf vorhandene
   * Zuordnungen nicht ungültig machen. Statt sie still zu kürzen, lehnt der
   * Dienst die Änderung ab; der Nutzer entscheidet, welche Zuordnung weicht.
   */
  const allocatedCents = allocationCents(current.allocations ?? []);
  if (allocatedCents > 0 && changes.netAmount !== undefined) {
    const nextNetCents = toCents(changes.netAmount);
    if (!Number.isFinite(nextNetCents) || nextNetCents < allocatedCents) {
      return { success: false, errorKey: 'expense.allocation.editBelowAllocated' };
    }
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

/* ------------------------------------------------------------------------ */
/* ORDER-COST-ALLOCATION-01B — Auftragszuordnung einer Ausgabe                */
/* ------------------------------------------------------------------------ */

/**
 * Die Zuordnung ist eine rein betriebliche Auswertung: Sie verändert weder
 * Steuerbeträge noch Kategorie, Zahlungen, Monatsmappe oder Storno-Belege.
 * Sie lebt im vorhandenen Feld `Expense.allocations` und reist über denselben
 * Persistenz-, Fingerprint- und Cloud-Weg wie der Beleg selbst.
 *
 * Verbindliche Regeln (fail-closed, keine stillen Reparaturen):
 *   - Betrag > 0, in Cent gerechnet
 *   - Summe aller Zuordnungen ≤ Nettobetrag des Belegs (Teilzuordnung erlaubt)
 *   - höchstens eine Zuordnung je Auftrag; erneutes Zuordnen **ersetzt** sie
 *   - der Auftrag muss existieren
 *   - eine stornierte Ausgabe wird nicht mehr zugeordnet oder geändert
 *   - vorhandene Zuordnungen anderer Aufträge bleiben unangetastet
 */
export function getExpenseAllocations(expenseId: string): ExpenseAllocation[] {
  const expense = getExpenseFromStoreById(expenseId);
  if (!expense || !isEntitySyncActive(expense)) return [];
  return (expense.allocations ?? []).map((allocation) => ({ ...allocation }));
}

function allocationCents(allocations: readonly ExpenseAllocation[]): number {
  return allocations.reduce((sum, allocation) => {
    const cents = toCents(allocation.amount);
    return Number.isFinite(cents) ? sum + cents : sum;
  }, 0);
}

/** Summe aller Zuordnungen eines Belegs — für Anzeige und Prüfung. */
export function getAllocatedAmount(expense: Expense): number {
  return fromCents(allocationCents(expense.allocations ?? []));
}

export function getUnallocatedAmount(expense: Expense): number {
  return fromCents(Math.max(0, toCents(expense.netAmount) - allocationCents(expense.allocations ?? [])));
}

export interface AssignExpenseToVorgangInput {
  vorgangId: string;
  /** Fehlt der Betrag, wird der noch nicht zugeordnete Rest verwendet. */
  amount?: number;
}

export function assignExpenseToVorgang(
  expenseId: string,
  input: AssignExpenseToVorgangInput,
): ExpenseMutationResult {
  const current = getExpenseFromStoreById(expenseId);
  if (!current || !isEntitySyncActive(current)) return { success: false, errorKey: 'expense.notFound' };
  if (current.status === 'storniert') return { success: false, errorKey: 'expense.allocation.cancelled' };

  const vorgangId = input.vorgangId?.trim() ?? '';
  const vorgang = vorgangId ? getVorgangById(vorgangId) : undefined;
  if (!vorgang) return { success: false, errorKey: 'expense.allocation.vorgangMissing' };

  const others = (current.allocations ?? []).filter((allocation) => allocation.vorgangId !== vorgangId);
  const netCents = toCents(current.netAmount);
  if (!Number.isFinite(netCents) || netCents <= 0) {
    return { success: false, errorKey: 'expense.allocation.noNetAmount' };
  }
  const remainingCents = netCents - allocationCents(others);
  const requestedCents = input.amount === undefined ? remainingCents : toCents(input.amount);
  if (!Number.isFinite(requestedCents) || requestedCents <= 0) {
    return { success: false, errorKey: 'expense.allocation.amountInvalid' };
  }
  if (requestedCents > remainingCents) {
    return { success: false, errorKey: 'expense.allocation.exceedsAmount' };
  }

  const allocation: ExpenseAllocation = {
    vorgangId,
    vorgangTitle: vorgang.title,
    amount: fromCents(requestedCents),
  };
  const existing = (current.allocations ?? []).find((entry) => entry.vorgangId === vorgangId);
  if (existing?.orderPositionId) {
    /* Positionsbezug bleibt erhalten — 01B baut ihn nicht aus, zerstört ihn aber auch nicht. */
    allocation.orderPositionId = existing.orderPositionId;
  }

  const now = new Date().toISOString();
  const updated = withUpdatedEntitySync({ ...current, allocations: [...others, allocation], updatedAt: now }, 'expense');
  replaceExpenseInStore(expenseId, updated);
  persistAll();
  return { success: true, expense: getExpenseById(expenseId)! };
}

export function removeExpenseAllocation(expenseId: string, vorgangId: string): ExpenseMutationResult {
  const current = getExpenseFromStoreById(expenseId);
  if (!current || !isEntitySyncActive(current)) return { success: false, errorKey: 'expense.notFound' };
  if (current.status === 'storniert') return { success: false, errorKey: 'expense.allocation.cancelled' };
  const remaining = (current.allocations ?? []).filter((allocation) => allocation.vorgangId !== vorgangId);
  if (remaining.length === (current.allocations ?? []).length) {
    return { success: false, errorKey: 'expense.allocation.notFound' };
  }
  const now = new Date().toISOString();
  const updated = withUpdatedEntitySync({ ...current, allocations: remaining, updatedAt: now }, 'expense');
  replaceExpenseInStore(expenseId, updated);
  persistAll();
  return { success: true, expense: getExpenseById(expenseId)! };
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
