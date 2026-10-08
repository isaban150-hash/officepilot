/**
 * P1 MITARBEITERZAHLUNGEN — Mitarbeiterzahlungen erfassen, stornieren, belegen.
 *
 * Confirm-first: Das Formular erzeugt nichts. Erst die Zusammenfassung baut
 * einen Bestätigungsvorgang mit eigener Kennung; „Zahlung jetzt erfassen"
 * legt genau diese Zahlung an. Wiederholt man denselben Vorgang, entsteht
 * keine zweite Zahlung (Replay); dieselbe Kennung mit anderen Geldwerten ist
 * ein Konflikt.
 *
 * Die Zahlung ist die einzige Wahrheit. Sie erzeugt keine Ausgabe, keine
 * Ausgabenzahlung, keine Buchung, keine Verbindlichkeit und keine
 * Bankzuordnung. Geldfelder bleiben nach der Bestätigung unverändert;
 * korrigiert wird über Storno und Neuerfassung.
 */
import type {
  EmployeePayment,
  EmployeePaymentConfirmationIntent,
  EmployeePaymentDraft,
  EmployeePaymentKind,
  EmployeePaymentMethod,
} from '../../types/employee';
import { EMPLOYEE_PAYMENT_KINDS, EMPLOYEE_PAYMENT_METHODS } from '../../types/employee';
import type { Expense } from '../../types/expense';
import { getSyncClient } from '../sync/syncClientService';
import { generateUuid } from '../sync/syncMetaService';
import { enqueueSyncOutbox } from '../sync/syncOutboxService';
import { persistAll } from '../persistenceService';
import { getDocumentById } from '../documentService';
import { getExpenseStoreSnapshot } from '../expenseStore';
import { getInboxItemById } from '../inboxService';
import { isPayrollDocumentKind } from '../payrollDocumentKind';
import { buildPayoutReceiptDocumentId, isPayoutReceiptDocumentId } from './payoutReceiptDocumentId';
import { buildEmployeePaymentReference } from './employeePaymentReference';
import {
  getEmployeeFromStore,
  getEmployeePaymentFromStore,
  getEmployeePaymentStoreSnapshot,
  putEmployeePaymentInStore,
} from './employeeStore';

export const EMPLOYEE_PAYMENT_MAX_AMOUNT = 9_999_999.99;
export const EMPLOYEE_PAYMENT_TEXT_MAX_LENGTH = 500;
export const EMPLOYEE_PAYMENT_REVERSAL_REASON_MIN = 3;
export const EMPLOYEE_PAYMENT_REVERSAL_REASON_MAX = 300;

export type EmployeePaymentField =
  | 'employee'
  | 'kind'
  | 'amount'
  | 'paymentDate'
  | 'paymentMethod'
  | 'wageMonth'
  | 'purpose'
  | 'note'
  | 'paidByName'
  | 'proof';

export type EmployeePaymentPrepareResult =
  | { ok: true; intent: EmployeePaymentConfirmationIntent }
  | { ok: false; errorKey: string; field: EmployeePaymentField };

export type EmployeePaymentMutationResult =
  | { success: true; payment: EmployeePayment; replayed: boolean }
  | { success: false; errorKey: string };

export interface EmployeePaymentActor {
  userId?: string;
}

/* ------------------------------------------------------------------ */
/* Lesen                                                               */
/* ------------------------------------------------------------------ */

export function listEmployeePayments(): EmployeePayment[] {
  return getEmployeePaymentStoreSnapshot().sort(
    (a, b) => b.paymentDate.localeCompare(a.paymentDate) || b.createdAt.localeCompare(a.createdAt),
  );
}

export function getEmployeePaymentById(id: string): EmployeePayment | undefined {
  return getEmployeePaymentFromStore(id);
}

/**
 * P1MA WEISS — mögliche Doppelzahlung: eine gültige Zahlung an denselben
 * Mitarbeiter mit demselben Zahlungsgrund, demselben Betrag, demselben
 * Auszahlungsdatum und demselben Zahlungsweg.
 *
 * Nur ein Hinweis, nie eine Sperre: Zwei bewusst geleistete, gleiche Zahlungen
 * bleiben erfassbar. Eine technische Doppelübermittlung erreicht diese Prüfung
 * gar nicht — sie trägt dieselbe Kennung und wird beim Bestätigen und auf dem
 * Server als Wiederholung erkannt. Stornierte Zahlungen zählen nicht: Die
 * Korrektur einer stornierten Zahlung ist gerade die neue, gleiche Zahlung.
 */
export function findPossibleDuplicateEmployeePayments(
  intent: Pick<EmployeePaymentConfirmationIntent, 'paymentId' | 'employeeId' | 'kind' | 'amount' | 'paymentDate' | 'paymentMethod'>,
): EmployeePayment[] {
  const cent = (value: number) => Math.round(value * 100);
  return listEmployeePayments().filter(
    (payment) =>
      payment.id !== intent.paymentId &&
      !payment.reversedAt &&
      payment.employeeId === intent.employeeId &&
      payment.kind === intent.kind &&
      cent(payment.amount) === cent(intent.amount) &&
      payment.paymentDate === intent.paymentDate &&
      payment.paymentMethod === intent.paymentMethod,
  );
}

/** Zahlungen, die dieses Dokument als Quittung oder Nachweis tragen — auch stornierte. */
export function findEmployeePaymentsByDocument(documentId: string): EmployeePayment[] {
  const id = documentId.trim();
  if (!id) return [];
  return getEmployeePaymentStoreSnapshot().filter(
    (payment) => payment.receiptDocumentId === id || payment.proofDocumentId === id,
  );
}

export function employeePaymentMonth(payment: Pick<EmployeePayment, 'paymentDate'>): string {
  return payment.paymentDate.slice(0, 7);
}

/* ------------------------------------------------------------------ */
/* Prüfen                                                              */
/* ------------------------------------------------------------------ */

function clean(value: string | undefined | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** `1.234,56` und `1234.56` → Zahl; alles Unklare → `null`. */
export function parseEmployeePaymentAmount(raw: string | number | undefined | null): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const text = clean(raw);
  if (!text) return null;
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function isValidIsoDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}

function todayIsoDay(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function isValidMonth(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

function hasMoreThanTwoDecimals(value: number): boolean {
  return Math.abs(Math.round(value * 100) - value * 100) > 1e-6;
}

/**
 * Ein Dokument mit Rechnungsbezug ist kein Beleg einer Mitarbeiterzahlung. Der
 * Server nimmt nur Archivdokumente an — nur sie schützt er als Personaldaten.
 */
function isInvoiceLinkedDocument(documentId: string): boolean {
  return Boolean(getDocumentById(documentId)?.linkedInvoiceId?.trim());
}

/**
 * Prüft den Entwurf und liefert die Bestätigungsabsicht für die Zusammenfassung.
 *
 * `options.paymentId` hält die Kennung über einen Bestätigungsdialog hinweg
 * stabil: Ein erneuter Versuch derselben Bestätigung trägt dieselbe Kennung und
 * wird als Wiederholung erkannt, nie als zweite Zahlung.
 */
export function prepareEmployeePaymentConfirmation(
  draft: EmployeePaymentDraft,
  options: { paymentId?: string } = {},
): EmployeePaymentPrepareResult {
  const employee = draft.employeeId ? getEmployeeFromStore(draft.employeeId) : undefined;
  if (!employee) return { ok: false, errorKey: 'employeePayment.error.employeeRequired', field: 'employee' };
  if (!employee.active) return { ok: false, errorKey: 'employeePayment.error.employeeInactive', field: 'employee' };

  const kind = draft.kind;
  if (!kind || !EMPLOYEE_PAYMENT_KINDS.includes(kind)) {
    return { ok: false, errorKey: 'employeePayment.error.kindRequired', field: 'kind' };
  }

  const amount = parseEmployeePaymentAmount(draft.amount);
  if (amount === null || amount <= 0) {
    return { ok: false, errorKey: 'employeePayment.error.amountInvalid', field: 'amount' };
  }
  if (hasMoreThanTwoDecimals(amount)) {
    return { ok: false, errorKey: 'employeePayment.error.amountPrecision', field: 'amount' };
  }
  if (amount > EMPLOYEE_PAYMENT_MAX_AMOUNT) {
    return { ok: false, errorKey: 'employeePayment.error.amountTooHigh', field: 'amount' };
  }

  const paymentDate = clean(draft.paymentDate);
  if (!isValidIsoDay(paymentDate)) {
    return { ok: false, errorKey: 'employeePayment.error.dateInvalid', field: 'paymentDate' };
  }
  if (paymentDate > todayIsoDay()) {
    return { ok: false, errorKey: 'employeePayment.error.dateInFuture', field: 'paymentDate' };
  }

  const method = draft.paymentMethod;
  if (!method || !EMPLOYEE_PAYMENT_METHODS.includes(method as EmployeePaymentMethod)) {
    return { ok: false, errorKey: 'employeePayment.error.methodRequired', field: 'paymentMethod' };
  }

  const wageMonth = clean(draft.wageMonth);
  if (wageMonth && kind !== 'wage') {
    return { ok: false, errorKey: 'employeePayment.error.wageMonthOnlyForWage', field: 'wageMonth' };
  }
  if (wageMonth && !isValidMonth(wageMonth)) {
    return { ok: false, errorKey: 'employeePayment.error.wageMonthInvalid', field: 'wageMonth' };
  }

  const purpose = clean(draft.purpose);
  const note = clean(draft.note);
  if (purpose.length > EMPLOYEE_PAYMENT_TEXT_MAX_LENGTH) {
    return { ok: false, errorKey: 'employeePayment.error.textTooLong', field: 'purpose' };
  }
  if (note.length > EMPLOYEE_PAYMENT_TEXT_MAX_LENGTH) {
    return { ok: false, errorKey: 'employeePayment.error.textTooLong', field: 'note' };
  }
  if (kind === 'other' && !note) {
    return { ok: false, errorKey: 'employeePayment.error.noteRequired', field: 'note' };
  }

  const paidByName = clean(draft.paidByName);
  if (paidByName.length > 120) {
    return { ok: false, errorKey: 'employeePayment.error.textTooLong', field: 'paidByName' };
  }

  const proofDocumentId = clean(draft.proofDocumentId);
  if (proofDocumentId && !getDocumentById(proofDocumentId)) {
    return { ok: false, errorKey: 'employeePayment.error.proofNotFound', field: 'proof' };
  }
  if (proofDocumentId && isPayoutReceiptDocumentId(proofDocumentId)) {
    return { ok: false, errorKey: 'employeePayment.error.proofIsReceipt', field: 'proof' };
  }
  if (proofDocumentId && isInvoiceLinkedDocument(proofDocumentId)) {
    return { ok: false, errorKey: 'employeePayment.error.proofNotAllowed', field: 'proof' };
  }

  return {
    ok: true,
    intent: {
      paymentId: options.paymentId?.trim() || generateUuid(),
      employeeId: employee.id,
      employeeName: employee.name,
      ...(employee.personnelNumber ? { personnelNumber: employee.personnelNumber } : {}),
      kind: kind as EmployeePaymentKind,
      amount: Math.round(amount * 100) / 100,
      paymentDate,
      paymentMethod: method as EmployeePaymentMethod,
      ...(wageMonth ? { wageMonth } : {}),
      ...(purpose ? { purpose } : {}),
      ...(note ? { note } : {}),
      ...(paidByName ? { paidByName } : {}),
      ...(proofDocumentId ? { proofDocumentId } : {}),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Bestätigen                                                          */
/* ------------------------------------------------------------------ */

/** Dieselbe Workspace-Kennung auf jedem Gerät: zuerst die Cloud-Kennung. */
export function resolveEmployeePaymentReferenceWorkspaceId(): string {
  const client = getSyncClient();
  return (client.serverWorkspaceId ?? client.workspaceId ?? '').trim();
}

function sameFinancials(existing: EmployeePayment, intent: EmployeePaymentConfirmationIntent): boolean {
  return (
    existing.employeeId === intent.employeeId &&
    existing.kind === intent.kind &&
    existing.amount === intent.amount &&
    existing.paymentDate === intent.paymentDate &&
    existing.paymentMethod === intent.paymentMethod &&
    (existing.wageMonth ?? '') === (intent.wageMonth ?? '') &&
    (existing.purpose ?? '') === (intent.purpose ?? '') &&
    (existing.note ?? '') === (intent.note ?? '')
  );
}

function enqueuePayment(payment: EmployeePayment, operation: 'create' | 'update'): void {
  enqueueSyncOutbox({ entityType: 'employee_payment', entityId: payment.id, operation, version: 1 });
}

export function confirmEmployeePayment(
  intent: EmployeePaymentConfirmationIntent,
  actor: EmployeePaymentActor = {},
): EmployeePaymentMutationResult {
  const existing = getEmployeePaymentFromStore(intent.paymentId);
  if (existing) {
    return sameFinancials(existing, intent)
      ? { success: true, payment: existing, replayed: true }
      : { success: false, errorKey: 'employeePayment.error.idConflict' };
  }

  const recheck = prepareEmployeePaymentConfirmation({
    employeeId: intent.employeeId,
    kind: intent.kind,
    amount: String(intent.amount),
    paymentDate: intent.paymentDate,
    paymentMethod: intent.paymentMethod,
    wageMonth: intent.wageMonth,
    purpose: intent.purpose,
    note: intent.note,
    paidByName: intent.paidByName,
    proofDocumentId: intent.proofDocumentId,
  });
  if (!recheck.ok) return { success: false, errorKey: recheck.errorKey };

  const workspaceId = resolveEmployeePaymentReferenceWorkspaceId();
  if (!workspaceId) return { success: false, errorKey: 'employeePayment.error.workspaceMissing' };
  const receiptReference = buildEmployeePaymentReference(workspaceId, intent.paymentId, intent.paymentDate);
  if (getEmployeePaymentStoreSnapshot().some((payment) => payment.receiptReference === receiptReference)) {
    return { success: false, errorKey: 'employeePayment.error.referenceConflict' };
  }

  const payment = putEmployeePaymentInStore({
    id: intent.paymentId,
    employeeId: intent.employeeId,
    employeeName: intent.employeeName,
    ...(intent.personnelNumber ? { personnelNumber: intent.personnelNumber } : {}),
    kind: intent.kind,
    amount: intent.amount,
    paymentDate: intent.paymentDate,
    paymentMethod: intent.paymentMethod,
    ...(intent.wageMonth ? { wageMonth: intent.wageMonth } : {}),
    ...(intent.purpose ? { purpose: intent.purpose } : {}),
    ...(intent.note ? { note: intent.note } : {}),
    receiptReference,
    ...(intent.paidByName ? { paidByName: intent.paidByName } : {}),
    ...(intent.proofDocumentId ? { proofDocumentId: intent.proofDocumentId } : {}),
    createdAt: new Date().toISOString(),
    ...(actor.userId ? { createdBy: actor.userId } : {}),
  });
  enqueuePayment(payment, 'create');
  persistAll();
  return { success: true, payment, replayed: false };
}

/* ------------------------------------------------------------------ */
/* Storno                                                              */
/* ------------------------------------------------------------------ */

export function reverseEmployeePayment(
  id: string,
  reason: string,
  actor: EmployeePaymentActor = {},
): EmployeePaymentMutationResult {
  const current = getEmployeePaymentFromStore(id);
  if (!current) return { success: false, errorKey: 'employeePayment.error.notFound' };
  const grund = clean(reason);
  if (grund.length < EMPLOYEE_PAYMENT_REVERSAL_REASON_MIN) {
    return { success: false, errorKey: 'employeePayment.error.reasonRequired' };
  }
  if (grund.length > EMPLOYEE_PAYMENT_REVERSAL_REASON_MAX) {
    return { success: false, errorKey: 'employeePayment.error.reasonTooLong' };
  }
  // Idempotent: ein zweiter Storno ändert nichts — auch nicht den ersten Grund.
  if (current.reversedAt) return { success: true, payment: current, replayed: true };

  const payment = putEmployeePaymentInStore({
    ...current,
    reversedAt: new Date().toISOString(),
    ...(actor.userId ? { reversedBy: actor.userId } : {}),
    reversalReason: grund,
  });
  enqueuePayment(payment, 'update');
  persistAll();
  return { success: true, payment, replayed: false };
}

/* ------------------------------------------------------------------ */
/* Nachweis und Quittung — geldfrei                                     */
/* ------------------------------------------------------------------ */

export function setEmployeePaymentProof(id: string, documentId: string | null): EmployeePaymentMutationResult {
  const current = getEmployeePaymentFromStore(id);
  if (!current) return { success: false, errorKey: 'employeePayment.error.notFound' };
  if (current.reversedAt) return { success: false, errorKey: 'employeePayment.error.reversed' };
  const target = clean(documentId);
  if (target && !getDocumentById(target)) return { success: false, errorKey: 'employeePayment.error.proofNotFound' };
  // Eine unterschriebene Quittung ist ein anderes Dokument als die erzeugte Vorlage —
  // auch die erzeugte Quittung einer anderen Zahlung ist kein Nachweis.
  if (target && (target === current.receiptDocumentId || isPayoutReceiptDocumentId(target))) {
    return { success: false, errorKey: 'employeePayment.error.proofIsReceipt' };
  }
  if (target && isInvoiceLinkedDocument(target)) {
    return { success: false, errorKey: 'employeePayment.error.proofNotAllowed' };
  }
  if ((current.proofDocumentId ?? '') === target) return { success: true, payment: current, replayed: true };

  const { proofDocumentId: _alt, ...ohneNachweis } = current;
  void _alt;
  const payment = putEmployeePaymentInStore({
    ...ohneNachweis,
    ...(target ? { proofDocumentId: target } : {}),
  });
  enqueuePayment(payment, 'update');
  persistAll();
  return { success: true, payment, replayed: false };
}

export function setEmployeePaymentReceipt(id: string, documentId: string): EmployeePaymentMutationResult {
  const current = getEmployeePaymentFromStore(id);
  if (!current) return { success: false, errorKey: 'employeePayment.error.notFound' };
  const target = clean(documentId);
  if (!target) return { success: false, errorKey: 'employeePayment.error.receiptNotFound' };
  if (current.receiptDocumentId) {
    return current.receiptDocumentId === target
      ? { success: true, payment: current, replayed: true }
      : { success: false, errorKey: 'employeePayment.error.receiptAlreadySet' };
  }
  if (current.reversedAt) return { success: false, errorKey: 'employeePayment.error.reversed' };
  if (current.paymentMethod !== 'cash') return { success: false, errorKey: 'employeePayment.error.receiptOnlyCash' };
  if (!getDocumentById(target)) return { success: false, errorKey: 'employeePayment.error.receiptNotFound' };
  // Die Quittung trägt die feste Kennung dieser Zahlung — daran schützt der Server sie ab der ersten Zeile.
  if (target !== buildPayoutReceiptDocumentId(current.id)) {
    return { success: false, errorKey: 'employeePayment.error.receiptInvalid' };
  }

  const payment = putEmployeePaymentInStore({ ...current, receiptDocumentId: target });
  enqueuePayment(payment, 'update');
  persistAll();
  return { success: true, payment, replayed: false };
}

/* ------------------------------------------------------------------ */
/* Lohnabrechnung als Ausgabe — Warnung vor doppelter Wahrheit          */
/* ------------------------------------------------------------------ */

function isPayrollExpense(expense: Expense): boolean {
  if (isPayrollDocumentKind(expense.classifiedKind)) return true;
  const inbox = expense.linkedInboxId ? getInboxItemById(expense.linkedInboxId) : undefined;
  return isPayrollDocumentKind(inbox?.classifiedKind);
}

/**
 * Nicht stornierte Ausgaben aus einer Lohnabrechnung im Monat `YYYY-MM`.
 * Grundlage der sichtbaren Warnung bei einer Lohn-/Gehaltszahlung; es wird
 * nichts gelöscht oder umgebucht.
 */
export function findPayrollExpensesForMonth(month: string): Expense[] {
  if (!isValidMonth(month)) return [];
  return getExpenseStoreSnapshot().filter(
    (expense) =>
      !expense.sync?.deleted &&
      expense.status !== 'storniert' &&
      (expense.issueDate ?? '').slice(0, 7) === month &&
      isPayrollExpense(expense),
  );
}
