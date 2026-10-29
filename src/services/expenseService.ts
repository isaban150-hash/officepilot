import { PAPER_FOLDERS } from '../data/mockData';
import { persistAll } from './persistenceService';
import { requireAccountingReviewAfterSourceChange } from './accounting/accountingAssignmentService';
import {
  filterSyncActive,
  generateEntityId,
  isEntitySyncActive,
  withNewEntitySync,
  withTombstonedCloudEntityPreservingRemoteVersion,
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
import { fromCents, toCents } from './invoiceMoney';
import {
  checkExpenseMoneyIntegrity,
  isZeroRateTaxStatus,
  type ExpenseMoneyAmounts,
} from './expense/expenseMoneyIntegrity';
import { getVorgangById } from './vorgangService';
import { getActiveClosureForMonth } from './accounting/accountingPeriodStore';
import { closureFingerprintVersion } from './accounting/accountingPeriodFingerprint';
import {
  buildExpenseTaxSplitRequestForUpdate,
  expenseTaxSplitClosureAttributesChanged,
  isExpenseTaxSplitOpen,
  planExpenseTaxSplit,
  resolveExpenseInputTaxDeduction,
  resolveExpenseTaxSplitState,
  touchesExpenseTaxSplit,
  type ExpenseTaxSplitPlan,
} from './expense/expenseTaxSplit';
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
  ExpenseInputTaxDeduction,
  ExpenseSummary,
  ExpenseTaxSplit,
} from '../types/expense';
import type { DigitalFolder, PaperFilingRule, TaxStatus } from '../types/models';

export type ExpenseMutationResult =
  | { success: true; expense: Expense }
  | { success: false; errorKey: string };

export { buildExpenseDedupeKey } from './expenseNormalize';
export { EXPENSE_CATEGORIES } from './expenseCategoryMapping';

/**
 * P1 EXPENSE-SYNC-VERSIONSVERTRAG — lokale Fachänderung: `sync` bleibt die
 * zuletzt vom Server bestätigte Fassung (wie der Intake-Fix 5e5425a).
 *
 * `upsert_workspace_expense` erwartet beim Update und beim Löschen **exakt**
 * die bestätigte `row_version` und erhöht sie selbst. Das frühere
 * `withUpdatedEntitySync` zählte lokal hoch — `updateExpense` setzte über den
 * neu gebauten Beleg sogar immer 2. Folgen: jede Änderung an einer gesyncten
 * Ausgabe endete als Versionskonflikt (blocked), und traf die erfundene Zahl
 * die echte Remote-Version eines anderen Geräts, überschrieb sie dessen
 * Änderung still. Die Änderung erkennt der Change-Tracker am Inhalt.
 */
function withConfirmedExpenseSync(next: Expense, current: Expense): Expense {
  return current.sync ? { ...next, sync: current.sync } : next;
}

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
 *
 * P1-KORREKTURBLOCK A-04 — fehlen Netto **und** Steuer, wird daraus keine Nullsteuer mehr: Die Aufteilung ist
 * dann `offen` (Platzhalter Netto = Brutto, Steuer 0, ausdrücklich gekennzeichnet; siehe `planExpenseTaxSplit`).
 * Ein angegebener Betrag ergänzt den fehlenden wie bisher als Differenz zum Brutto — nie über einen Steuersatz.
 */
type ResolvedExpenseMoney = ExpenseMoneyAmounts & {
  readonly taxSplit?: ExpenseTaxSplit;
  readonly inputTaxDeduction?: ExpenseInputTaxDeduction;
  readonly deductibleTaxAmount?: number;
};

function moneyFromPlan(
  input: Pick<ExpenseInput, 'grossAmount'>,
  taxStatus: TaxStatus,
  plan: Extract<ExpenseTaxSplitPlan, { ok: true }>,
): ResolvedExpenseMoney {
  return {
    netAmount: plan.netAmount,
    taxAmount: plan.taxAmount,
    grossAmount: input.grossAmount,
    taxStatus,
    taxSplit: plan.taxSplit,
    ...(plan.inputTaxDeduction ? { inputTaxDeduction: plan.inputTaxDeduction } : {}),
    ...(plan.deductibleTaxAmount !== undefined ? { deductibleTaxAmount: plan.deductibleTaxAmount } : {}),
  };
}

function resolveExpenseAmounts(input: ExpenseInput): { ok: true; money: ResolvedExpenseMoney } | { ok: false; errorKey: string } {
  const taxStatus = resolveExpenseTaxStatus(input);
  const plan = planExpenseTaxSplit({
    grossAmount: input.grossAmount,
    taxStatus,
    netAmount: input.netAmount,
    taxAmount: input.taxAmount,
    taxSplit: input.taxSplit,
    inputTaxDeduction: input.inputTaxDeduction,
    deductibleTaxAmount: input.deductibleTaxAmount,
  });
  if (!plan.ok) return plan;
  return { ok: true, money: moneyFromPlan(input, taxStatus, plan) };
}

function validateBaseInput(input: ExpenseInput): string | null {
  if (!input.supplierName?.trim()) return 'expense.supplierRequired';
  if (!input.title?.trim()) return 'expense.titleRequired';
  if (!input.issueDate?.trim()) return 'expense.issueDateRequired';
  if (!Number.isFinite(input.grossAmount) || input.grossAmount === 0) {
    return 'expense.amountRequired';
  }
  if (!EXPENSE_CATEGORIES.includes(input.category)) return 'expense.categoryRequired';
  return null;
}

/**
 * FINANZCORE-05B — die Geldinvariante, an genau einer Stelle für beide
 * Schreibwege. `addExpense` prüft die Eingabe, `updateExpense` prüft den
 * zusammengeführten Stand — beide laufen durch diese Funktion, also kann
 * keiner von beiden die Prüfung umgehen.
 *
 * Fail-closed: Ein widersprüchlicher Beleg wird nicht gerundet, nicht
 * korrigiert und nicht gespeichert. Er wird abgelehnt.
 */
function validateMoney(amounts: ExpenseMoneyAmounts): string | null {
  const money = checkExpenseMoneyIntegrity(amounts);
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
  money: ResolvedExpenseMoney,
  id: string,
  createdAt: string,
  updatedAt: string,
): Expense {
  const supplierName = input.supplierName.trim();
  const invoiceNumber = input.invoiceNumber?.trim() ?? '';
  // FINANZCORE-05B — dieselbe Aufloesung, die auch geprueft wurde.
  const { netAmount, taxAmount, grossAmount, taxStatus } = money;

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
    // A-04 — wie die Aufteilung belegt ist (offen = Platzhalter, keine Steueraussage).
    ...(money.taxSplit ? { taxSplit: money.taxSplit } : {}),
    ...(money.inputTaxDeduction ? { inputTaxDeduction: money.inputTaxDeduction } : {}),
    ...(money.deductibleTaxAmount !== undefined ? { deductibleTaxAmount: money.deductibleTaxAmount } : {}),
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
  const baseError = validateBaseInput(input);
  if (baseError) return { success: false, errorKey: baseError };
  const resolved = resolveExpenseAmounts(input);
  if (!resolved.ok) return { success: false, errorKey: resolved.errorKey };
  const moneyError = validateMoney(resolved.money);
  if (moneyError) return { success: false, errorKey: moneyError };

  const duplicate = isDuplicateExpense(input.supplierName, input.invoiceNumber ?? '');
  if (duplicate) return { success: false, errorKey: 'expense.duplicate' };

  const now = new Date().toISOString();
  const expense = withNewEntitySync(
    buildExpenseFromInput(input, resolved.money, generateEntityId('exp'), now, now),
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

/** FINANZ-CORE-01A (Gesamtnacharbeit INV-09) — in Cent verglichen, wie der Server (bisher Gleitkomma ±0,004). */
function amountChanged(next: number | undefined, current: number): boolean {
  return next !== undefined && toCents(next) !== toCents(current);
}

/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N06) — ändert sich an der Ausgabe etwas, das die
 * Kontierung trägt (Beträge, Steuerstatus, Belegdatum, Lieferant, Art, Gutschrift),
 * gilt eine frühere Bestätigung der Kontierung nicht mehr. Titel, Beschreibung, Ablage
 * und Zuordnungen ändern die Buchung nicht.
 */
function isAccountingRelevantExpenseChange(before: Expense, after: ExpenseInput): boolean {
  return (
    amountChanged(after.grossAmount, before.grossAmount) ||
    amountChanged(after.netAmount, before.netAmount) ||
    amountChanged(after.taxAmount, before.taxAmount) ||
    after.taxStatus !== before.taxStatus ||
    (after.issueDate ?? '') !== (before.issueDate ?? '') ||
    (after.supplierName ?? '').trim() !== (before.supplierName ?? '').trim() ||
    after.category !== before.category ||
    Boolean(after.isCreditNote) !== Boolean(before.isCreditNote)
  );
}

/**
 * P1-KORREKTURBLOCK A-04 — ändert sich die fachliche Steueraufteilung (Zustand, Vorsteuerabzug), gilt eine
 * Bestätigung der Kontierung nicht mehr. Verglichen werden die wirksamen Zustände: Ein Altbeleg, der beim
 * Speichern nur das Kennzeichen „belegt“ erhält, ändert nichts.
 */
function isTaxSplitRelevantChange(before: Expense, after: Expense): boolean {
  return (
    resolveExpenseTaxSplitState(before) !== resolveExpenseTaxSplitState(after) ||
    resolveExpenseInputTaxDeduction(before) !== resolveExpenseInputTaxDeduction(after) ||
    amountChanged(after.deductibleTaxAmount ?? 0, before.deductibleTaxAmount ?? 0)
  );
}

/** A04-WEISS-R2 — liegt der alte oder neue Belegmonat in einem Abschluss der Fassung 1–5? */
function isClosedWithOlderFingerprintVersion(before: Expense, after: Expense): boolean {
  return [...new Set([before.issueDate.slice(0, 7), after.issueDate.slice(0, 7)])].some((monthKey) => {
    const closure = getActiveClosureForMonth(monthKey);
    return closure !== undefined && closureFingerprintVersion(closure) < 6;
  });
}

/** A-04 — der Geldstand einer Änderung: unberührt exakt der gespeicherte, sonst die eine Auflösung. */
function resolveExpenseMoneyForUpdate(
  current: Expense,
  changes: Partial<ExpenseInput>,
): { ok: true; touched: boolean; money: ResolvedExpenseMoney } | { ok: false; errorKey: string } {
  if (!touchesExpenseTaxSplit(current, changes)) {
    return {
      ok: true,
      touched: false,
      money: {
        netAmount: current.netAmount,
        taxAmount: current.taxAmount,
        grossAmount: current.grossAmount,
        taxStatus: current.taxStatus,
        ...(current.taxSplit ? { taxSplit: current.taxSplit } : {}),
        ...(current.inputTaxDeduction ? { inputTaxDeduction: current.inputTaxDeduction } : {}),
        ...(current.deductibleTaxAmount !== undefined ? { deductibleTaxAmount: current.deductibleTaxAmount } : {}),
      },
    };
  }
  const request = buildExpenseTaxSplitRequestForUpdate(current, changes);
  const plan = planExpenseTaxSplit(request);
  if (!plan.ok) return plan;
  /*
   * WEISS-A04-01 — derselbe Übergang wie der Server (`upsert_workspace_expense`, Regel (e)): Eine offene Aufteilung wird
   * nur mit belegter Steuer (≠ 0) oder einem Steuerstatus ohne Umsatzsteuer geklärt. „Belegt“ mit 0 € Steuer beim
   * Steuerstatus „unklar“ (für 19 %/7 % weist das schon `planExpenseTaxSplit` ab) würde der Server endgültig abweisen.
   */
  if (
    isExpenseTaxSplitOpen(current) &&
    !isZeroRateTaxStatus(request.taxStatus) &&
    plan.taxSplit !== 'offen' &&
    toCents(plan.taxAmount) === 0
  ) {
    return { ok: false, errorKey: 'expense.taxSplit.openNeedsTax' };
  }
  return { ok: true, touched: true, money: moneyFromPlan({ grossAmount: request.grossAmount }, request.taxStatus, plan) };
}

export function updateExpense(id: string, changes: Partial<ExpenseInput>): ExpenseMutationResult {
  const current = getExpenseFromStoreById(id);
  if (!current || !isEntitySyncActive(current)) return { success: false, errorKey: 'expense.notFound' };
  if (current.status === 'storniert') return { success: false, errorKey: 'expense.edit.cancelled' };
  /*
   * FINANZ-CORE-01A (Gesamtnacharbeit INV-09) — derselbe Vertrag wie `cancelExpense` und der Server
   * (`upsert_workspace_expense`), auch über diesen generischen Setter: Mit einer Zahlung sind Beträge,
   * Steuerstatus und Gutschriftkennzeichen gebunden, und die Ausgabe wird weder storniert noch in einen
   * Entwurf zurückgesetzt. Storniert wird nur eine gebuchte Ausgabe.
   */
  const nextStatus = changes.status ?? current.status;
  if (nextStatus === 'storniert' && current.status !== 'gebucht') {
    return { success: false, errorKey: 'expense.cancel.notBooked' };
  }
  if (hasBookedExpensePayments(current)) {
    if (nextStatus === 'storniert') return { success: false, errorKey: 'expense.cancel.hasPayments' };
    if (nextStatus === 'entwurf' && current.status !== 'entwurf') {
      return { success: false, errorKey: 'expense.edit.statusLockedAfterPayment' };
    }
    /*
     * P1 A-04 Produktregel A — die Zahlung bindet Brutto und Gutschriftkennzeichen. Netto, Steuer und Steuerstatus
     * bleiben bei offener Steueraufteilung für deren Klärung änderbar (Prüfung des Ergebnisses unten).
     */
    const offenNachZahlung = isExpenseTaxSplitOpen(current);
    if (
      amountChanged(changes.grossAmount, current.grossAmount) ||
      (!offenNachZahlung &&
        (amountChanged(changes.netAmount, current.netAmount) ||
          amountChanged(changes.taxAmount, current.taxAmount) ||
          (changes.taxStatus !== undefined && changes.taxStatus !== current.taxStatus))) ||
      (changes.isCreditNote !== undefined && Boolean(changes.isCreditNote) !== Boolean(current.isCreditNote))
    ) {
      return { success: false, errorKey: 'expense.edit.amountLockedAfterPayment' };
    }
  }
  /*
   * P1-KORREKTURBLOCK A-04 — Beträge und Steueraufteilung. Berührt die Änderung sie nicht (Titel, Ablage,
   * Beschreibung …), bleibt der gespeicherte Stand **exakt** — auch ein Altbestand wird dabei weder umgerechnet
   * noch neu bewertet (dieselbe Regel wie serverseitig „Geld unverändert“). Sonst gilt die eine Auflösung.
   */
  const money = resolveExpenseMoneyForUpdate(current, changes);
  if (!money.ok) return { success: false, errorKey: money.errorKey };
  if (hasBookedExpensePayments(current)) {
    const splitGeaendert =
      amountChanged(money.money.netAmount, current.netAmount) ||
      amountChanged(money.money.taxAmount, current.taxAmount) ||
      money.money.taxStatus !== current.taxStatus;
    /*
     * P1 A-04 Produktregel A (Server: upsert_workspace_expense) — nach einer Zahlung ist eine Netto/Steuer/Status-
     * Änderung nur die Klärung einer offenen Aufteilung: vorher „offen“, danach belegt, gemischt oder steuerfrei. Ein
     * Wechsel innerhalb von „offen“ oder eine Neuaufteilung eines schon geklärten Belegs bleibt gesperrt.
     */
    const klaerungNachZahlung =
      isExpenseTaxSplitOpen(current) && resolveExpenseTaxSplitState({ ...current, ...money.money }) !== 'offen';
    if (amountChanged(money.money.grossAmount, current.grossAmount) || (splitGeaendert && !klaerungNachZahlung)) {
      // Auch eine aus der Steueraufteilung abgeleitete Betragsänderung ist nach einer Zahlung gesperrt (Server ebenso).
      return { success: false, errorKey: 'expense.edit.amountLockedAfterPayment' };
    }
  }

  /*
   * ORDER-COST-ALLOCATION-01B — ein kleinerer Nettobetrag darf vorhandene
   * Zuordnungen nicht ungültig machen. Statt sie still zu kürzen, lehnt der
   * Dienst die Änderung ab; der Nutzer entscheidet, welche Zuordnung weicht.
   */
  const allocatedCents = allocationCents(current.allocations ?? []);
  if (allocatedCents > 0 && money.touched) {
    // A-04 — eine offene Aufteilung hat kein belegtes Netto, auf das sich Zuordnungen stützen könnten.
    if (money.money.taxSplit === 'offen') return { success: false, errorKey: 'expense.taxSplit.openWithAllocations' };
    const nextNetCents = toCents(money.money.netAmount);
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

  const baseError = validateBaseInput(merged);
  if (baseError) return { success: false, errorKey: baseError };
  const moneyError = validateMoney(money.money);
  if (moneyError) return { success: false, errorKey: moneyError };

  const duplicate = isDuplicateExpense(merged.supplierName, merged.invoiceNumber ?? '', {
    excludeExpenseId: id,
  });
  if (duplicate) return { success: false, errorKey: 'expense.duplicate' };

  const now = new Date().toISOString();
  const updated = withConfirmedExpenseSync(
    buildExpenseFromInput(merged, money.money, current.id, current.createdAt, now),
    current,
  );
  /*
   * P1-KORREKTUR A04-WEISS-R2 — Aufteilungsart, Vorsteuerabzug und abziehbarer Betrag bindet erst Abschlussfassung 6.
   * Ist der Belegmonat mit einer älteren Fassung (1–5) abgeschlossen, könnte eine Änderung daran den Export ändern,
   * ohne dass die Revision es bemerkt. Deshalb ist sie dort gesperrt; der Korrekturweg ist das Wiederöffnen des Monats
   * (neue Revision). Der Server prüft dasselbe (`upsert_workspace_expense`, expense_tax_split_closed_period).
   */
  if (expenseTaxSplitClosureAttributesChanged(current, updated) && isClosedWithOlderFingerprintVersion(current, updated)) {
    return { success: false, errorKey: 'expense.taxSplit.closedPeriod' };
  }
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
      // FINANZ-CORE-01A (END18-R3, Bericht 19) — Nachweise abgewiesener Aktionen überstehen jede Bearbeitung.
      ...(current.rejectedPayments ? { rejectedPayments: current.rejectedPayments } : {}),
      ...(current.rejectedChanges ? { rejectedChanges: current.rejectedChanges } : {}),
      ...(current.reconciledRejections ? { reconciledRejections: current.reconciledRejections } : {}),
      cancelledAt,
      cancelReason: becomesCancelled ? current.cancelReason : undefined,
    }),
  );
  /*
   * FINANZ-CORE-01A (WEISS-Nacharbeit N06) — die Kontierung folgt dem Beleg: Sie übernimmt
   * seinen Steuerstatus, und eine Bestätigung galt dem alten Stand, wenn sich Fachliches
   * geändert hat. Auch ohne fachliche Änderung gleicht das Speichern einen Altbestand an,
   * dessen Kontierung eine andere Steuer trägt als der Beleg.
   */
  requireAccountingReviewAfterSourceChange('expense', id, {
    taxTreatment: updated.taxStatus,
    changed: isAccountingRelevantExpenseChange(current, merged) || isTaxSplitRelevantChange(current, updated),
    // A-04 — eine offene Steueraufteilung geht in die Klärung; eine nachgetragene zurück in die Prüfung.
    taxSplitOpen: isExpenseTaxSplitOpen(updated),
  });
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
  const cancelled = withConfirmedExpenseSync(
    normalizeExpensePaymentFields({
      ...current,
      status: 'storniert',
      cancelledAt: now,
      cancelReason: trimmedReason,
      updatedAt: now,
    }),
    current,
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
  // A-04 — Zuordnungen verteilen das Netto; bei offener Steueraufteilung ist es nicht belegt (nur ein Platzhalter).
  if (isExpenseTaxSplitOpen(current)) return { success: false, errorKey: 'expense.allocation.taxSplitOpen' };

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
  if (existing?.rebilledOrderPositionId) {
    /*
     * BEREICH-7-V1 — der Weiterberechnungsmarker überlebt eine Betragsänderung.
     *
     * Ohne diese Zeile würde ein blosses Korrigieren des zugeordneten Betrags
     * den Marker stillschweigend fallen lassen und die Zuordnung ein zweites
     * Mal weiterberechenbar machen — der Doppelberechnungsschutz hinge dann an
     * einer Reihenfolge von Nutzerklicks. Fail-closed: der Marker bleibt, bis
     * die erzeugte Position tatsächlich verschwindet.
     */
    allocation.rebilledOrderPositionId = existing.rebilledOrderPositionId;
  }

  const now = new Date().toISOString();
  const updated = withConfirmedExpenseSync({ ...current, allocations: [...others, allocation], updatedAt: now }, current);
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
  const updated = withConfirmedExpenseSync({ ...current, allocations: remaining, updatedAt: now }, current);
  replaceExpenseInStore(expenseId, updated);
  persistAll();
  return { success: true, expense: getExpenseById(expenseId)! };
}

/* ------------------------------------------------------------------------ */
/* BEREICH-7-V1 — Herkunftsmarker der Weiterberechnung                        */
/* ------------------------------------------------------------------------ */

/**
 * Setzt den Bezug auf die weiterberechnete Auftragsposition.
 *
 * Bewusst klein und ohne Fachlogik: Ob weiterberechnet werden **darf**,
 * entscheidet `orderCostRebillingService`; hier wird nur geschrieben. Ein
 * bereits gesetzter Marker wird **nicht** überschrieben — das wäre genau die
 * stille zweite Weiterberechnung, die der Schutz verhindern soll.
 */
export function setAllocationRebilledPosition(
  expenseId: string,
  vorgangId: string,
  orderPositionId: string,
): ExpenseMutationResult {
  const current = getExpenseFromStoreById(expenseId);
  if (!current || !isEntitySyncActive(current)) return { success: false, errorKey: 'expense.notFound' };
  if (current.status === 'storniert') return { success: false, errorKey: 'expense.allocation.cancelled' };

  const positionId = orderPositionId.trim();
  if (!positionId) return { success: false, errorKey: 'expense.rebill.positionMissing' };

  const allocations = current.allocations ?? [];
  const existing = allocations.find((entry) => entry.vorgangId === vorgangId);
  if (!existing) return { success: false, errorKey: 'expense.allocation.notFound' };
  if (existing.rebilledOrderPositionId) return { success: false, errorKey: 'expense.rebill.alreadyRebilled' };

  const now = new Date().toISOString();
  const updated = withConfirmedExpenseSync(
    {
      ...current,
      allocations: allocations.map((entry) =>
        entry.vorgangId === vorgangId ? { ...entry, rebilledOrderPositionId: positionId } : entry,
      ),
      updatedAt: now,
    },
    current,
  );
  replaceExpenseInStore(expenseId, updated);
  if (!persistAll().success) {
    /*
     * Kein halber Zustand: Ohne diesen Rücksetzer trüge der Beleg den Marker
     * im Arbeitsspeicher weiter, während der Aufrufer einen Fehlschlag sieht
     * und die erzeugte Position zurücknimmt — die Zuordnung wäre dann als
     * „bereits weiterberechnet" markiert, ohne dass es eine Position gäbe.
     * Dieselbe Zusicherung, die `commitVorgangMutation` auf der Auftragsseite
     * bereits gibt.
     */
    replaceExpenseInStore(expenseId, current);
    return { success: false, errorKey: 'expense.rebill.persistFailed' };
  }
  return { success: true, expense: getExpenseById(expenseId)! };
}

/**
 * Entfernt den Bezug wieder — wenn die erzeugte Position regulär gelöscht
 * wurde, und als Rücknahme, wenn das Markieren selbst fehlgeschlagen ist.
 *
 * Anders als beim Setzen ist eine **stornierte** Ausgabe hier kein Hindernis:
 * Geräumt wird nur ein Verweis auf etwas, das es nicht mehr gibt; kein Betrag,
 * keine Kategorie, keine Buchung ändert sich. Ein hängengebliebener Marker auf
 * einem stornierten Beleg wäre dagegen dauerhaft.
 */
export function clearAllocationRebilledPosition(
  expenseId: string,
  vorgangId: string,
): ExpenseMutationResult {
  const current = getExpenseFromStoreById(expenseId);
  if (!current || !isEntitySyncActive(current)) return { success: false, errorKey: 'expense.notFound' };

  const allocations = current.allocations ?? [];
  const existing = allocations.find((entry) => entry.vorgangId === vorgangId);
  if (!existing) return { success: false, errorKey: 'expense.allocation.notFound' };
  if (!existing.rebilledOrderPositionId) {
    /* Nichts zu räumen ist kein Fehler — der gewünschte Zustand liegt bereits vor. */
    return { success: true, expense: getExpenseById(expenseId)! };
  }

  const now = new Date().toISOString();
  const updated = withConfirmedExpenseSync(
    {
      ...current,
      allocations: allocations.map((entry) => {
        if (entry.vorgangId !== vorgangId) return entry;
        const { rebilledOrderPositionId: _marker, ...rest } = entry;
        return rest;
      }),
      updatedAt: now,
    },
    current,
  );
  replaceExpenseInStore(expenseId, updated);
  if (!persistAll().success) {
    /* Wie beim Setzen: entweder dauerhaft geräumt oder gar nicht. */
    replaceExpenseInStore(expenseId, current);
    return { success: false, errorKey: 'expense.rebill.persistFailed' };
  }
  return { success: true, expense: getExpenseById(expenseId)! };
}

export function deleteExpense(id: string): ExpenseMutationResult {
  const current = getExpenseFromStoreById(id);
  if (!current || !isEntitySyncActive(current)) return { success: false, errorKey: 'expense.notFound' };
  // 01C — dieselbe Regel wie in der Cloud: gebuchte Zahlungen halten den Beleg.
  if ((current.payments ?? []).length > 0) return { success: false, errorKey: 'expense.delete.hasPayments' };
  // P1 EXPENSE-SYNC-VERSIONSVERTRAG — der Grabstein erwartet die bestätigte Serverversion, kein lokales +1.
  const tombstoned = withTombstonedCloudEntityPreservingRemoteVersion(current, 'expense');
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
