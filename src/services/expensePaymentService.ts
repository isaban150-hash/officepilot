import { normalizePaymentMethod } from '../types/models';
import {
  addPaymentToExpense as addPaymentToExpenseStore,
  getAllExpensesFromStore,
  getExpenseFromStoreById,
  removePaymentFromExpense as removePaymentFromExpenseStore,
  replaceExpensePayment as replaceExpensePaymentInStore,
} from './expenseStore';
import { persistAll } from './persistenceService';
import { getDocumentById } from './documentService';
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
  const method = normalizePaymentMethod(input.method);

  /*
   * BLOCK 1 — ein Nachweis muss ein echtes Dokument sein.
   *
   * Die Pruefung hier ist Bequemlichkeit, keine Sicherheit: Verbindlich
   * prueft der Server im selben Workspace. Lokal soll der Nutzer den
   * Fehler nur sofort sehen statt erst nach dem naechsten Abgleich.
   */
  const proofDocumentId = input.proofDocumentId?.trim() || undefined;
  if (proofDocumentId && !getDocumentById(proofDocumentId)) {
    return { success: false, errorKey: 'payment.proofNotFound' };
  }

  const payment: ExpensePayment = {
    id: generateUuid(),
    date: input.date.slice(0, 10),
    amount: input.amount,
    reference: input.reference?.trim() || undefined,
    note: input.note?.trim() || undefined,
    // 02B — optional; ohne Angabe bleibt sie nicht erfasst.
    ...(method ? { method } : {}),
    // BLOCK 1 — optional; ohne Angabe ist kein Nachweis verknüpft.
    ...(proofDocumentId ? { proofDocumentId } : {}),
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

export type SetExpensePaymentProofResult =
  | { success: true; expense: Expense; payment: ExpensePayment }
  | { success: false; errorKey: string };

/**
 * BARZAHLUNG-V1 BLOCK 1 — den Zahlungsnachweis nachtraeglich setzen,
 * austauschen oder loesen (`null`).
 *
 * Ohne diesen Weg muesste man eine Zahlung stornieren und neu buchen, nur
 * weil die Quittung erst am naechsten Tag fotografiert wurde — eine
 * Geldbewegung rueckgaengig machen fuer eine Belegfrage. Das waere falsch.
 *
 * Bewegt kein Geld: Betrag, Datum, Zahlungsart und Zahlungsstatus bleiben
 * unberuehrt. Eine stornierte Zahlung ist lokal nicht mehr vorhanden und
 * damit auch nicht mehr aenderbar; in der Cloud bleibt ihre Zeile mitsamt
 * Nachweis als Pruefspur stehen.
 */
export function setExpensePaymentProof(
  expenseId: string,
  paymentId: string,
  proofDocumentId: string | null,
): SetExpensePaymentProofResult {
  const expense = getExpenseFromStoreById(expenseId);
  if (!expense) {
    return { success: false, errorKey: 'expense.payment.notFound' };
  }

  const payments = getExpensePayments(expense);
  const vorhanden = payments.find((payment) => payment.id === paymentId);
  if (!vorhanden) {
    return { success: false, errorKey: 'payment.notFound' };
  }

  const ziel = proofDocumentId?.trim() || null;
  if (ziel && !getDocumentById(ziel)) {
    return { success: false, errorKey: 'payment.proofNotFound' };
  }

  const aktualisiert: ExpensePayment = { ...vorhanden };
  if (ziel) aktualisiert.proofDocumentId = ziel;
  else delete aktualisiert.proofDocumentId;

  const updated = replaceExpensePaymentInStore(expenseId, aktualisiert);
  if (!updated) {
    return { success: false, errorKey: 'expense.payment.notFound' };
  }

  /*
   * Derselbe Auftrag wie beim Erfassen: Der Push schickt die Zahlung
   * (serverseitig ein Replay ohne Wirkung) und danach den Nachweis. Kein
   * eigener Entitaetstyp — die Zahlung ist und bleibt die Einheit, die
   * reist.
   */
  enqueueSyncOutbox({ entityType: 'expense_payment', entityId: buildExpensePaymentEntityId(expenseId, paymentId), operation: 'create', version: 1 });
  persistAll();
  return { success: true, expense: updated, payment: aktualisiert };
}

/** Welche Zahlungen berufen sich auf dieses Dokument? Die Rueckrichtung. */
export function findExpensePaymentsByProofDocument(
  documentId: string,
): Array<{ expenseId: string; payment: ExpensePayment }> {
  const treffer: Array<{ expenseId: string; payment: ExpensePayment }> = [];
  if (!documentId) return treffer;
  for (const expense of getAllExpensesFromStore()) {
    for (const payment of getExpensePayments(expense)) {
      if (payment.proofDocumentId === documentId) treffer.push({ expenseId: expense.id, payment });
    }
  }
  return treffer;
}

export { formatPaymentCurrency } from './invoicePaymentService';
