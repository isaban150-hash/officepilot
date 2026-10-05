/**
 * WEISS-NACHARBEIT O1 — die bestätigte Bankzahlung sofort lokal spiegeln.
 *
 * DER BEFUND
 *
 * Nach einer bestätigten Bankzuordnung entstand die Zahlung serverseitig,
 * der lokale Beleg wusste davon aber nichts. Der Zahlungsstand blieb bis zum
 * nächsten Abzug stehen. Beim Bestätigen einer **zweiten** Bewegung zeigte
 * der Dialog deshalb den alten offenen Betrag und nannte eine Zahlung
 * „Teilzahlung", die den Rest längst vollständig deckte. Gebucht wurde
 * trotzdem richtig — der Server rechnet selbst nach. Falsch war nur das,
 * was der Nutzer vor seiner Entscheidung las.
 *
 * WARUM DAS KEINE ZWEITE ZAHLUNGSENGINE IST
 *
 * Hier wird nichts gebucht und nichts entschieden. Der Server hat die
 * Zahlung bereits angelegt und nennt in seiner Antwort ihre Kennung, ihren
 * Betrag, ihr Datum und ihr Ziel. Genau diese vier Angaben werden
 * übernommen. `Expense.payments[]` ist ohnehin ausdrücklich „lokal nur noch
 * Projektion" (siehe 20260917120000); dieselbe Projektion stellen wir hier
 * sofort her, statt auf den nächsten Pull zu warten.
 *
 * Die Zuordnung selbst bleibt dort, wo sie hingehört: Angelegt wird sie
 * ausschliesslich serverseitig, und `bankReconciliationService` importiert
 * weiterhin keinen Zahlungsdienst.
 */
import { fromCents } from '../invoiceMoney';
import {
  addPaymentToExpense,
  getExpenseFromStoreById,
} from '../expenseStore';
import {
  calculateExpensePaymentSummary,
  getExpensePayments,
} from '../expensePaymentCalculations';
import { addPaymentToInvoice, getAllVorgaenge } from '../vorgangService';
/*
 * Nur die **rechnenden** Helfer, nie `recordPayment`: Hier wird eine
 * Serverantwort gespiegelt, nicht gebucht.
 */
import { calculatePaymentSummary, getInvoicePayments } from '../invoicePaymentService';
import type { BankReconciliation } from '../../types/bankReconciliation';
import type { VorgangInvoice } from '../../types/models';

/** Wurde die Zahlung lokal tatsächlich ergänzt? `false` heisst: war schon da. */
export interface BankPaymentProjectionResult {
  applied: boolean;
  reason?: 'already_present' | 'target_missing';
}

function projiziereAusgabe(reconciliation: BankReconciliation): BankPaymentProjectionResult {
  const expense = getExpenseFromStoreById(reconciliation.targetId);
  if (!expense) return { applied: false, reason: 'target_missing' };

  /* Idempotent: ein zweiter Aufruf derselben Zuordnung ändert nichts. */
  if (getExpensePayments(expense).some((payment) => payment.id === reconciliation.paymentId)) {
    return { applied: false, reason: 'already_present' };
  }

  const payment = {
    id: reconciliation.paymentId,
    date: reconciliation.paidOn,
    amount: fromCents(reconciliation.amountCents),
    /* Die RPC bucht fest mit `method = 'bank'`; nichts erfunden. */
    method: 'bank' as const,
    createdAt: reconciliation.confirmedAt,
  };
  const summary = calculateExpensePaymentSummary({
    ...expense,
    payments: [...getExpensePayments(expense), payment],
  });
  return { applied: Boolean(addPaymentToExpense(expense.id, payment, summary.status)) };
}

function findeRechnung(invoiceId: string): { vorgangId: string; invoice: VorgangInvoice } | null {
  for (const vorgang of getAllVorgaenge()) {
    const invoice = (vorgang.invoices ?? []).find((entry) => entry.id === invoiceId);
    if (invoice) return { vorgangId: vorgang.id, invoice };
  }
  return null;
}

function projiziereRechnung(reconciliation: BankReconciliation): BankPaymentProjectionResult {
  const treffer = findeRechnung(reconciliation.targetId);
  if (!treffer) return { applied: false, reason: 'target_missing' };

  if (getInvoicePayments(treffer.invoice).some((payment) => payment.id === reconciliation.paymentId)) {
    return { applied: false, reason: 'already_present' };
  }

  const payment = {
    id: reconciliation.paymentId,
    date: reconciliation.paidOn,
    amount: fromCents(reconciliation.amountCents),
    method: 'bank' as const,
    createdAt: reconciliation.confirmedAt,
  };
  const summary = calculatePaymentSummary({
    ...treffer.invoice,
    payments: [...getInvoicePayments(treffer.invoice), payment],
  });
  return {
    applied: Boolean(addPaymentToInvoice(treffer.vorgangId, treffer.invoice.id, payment, summary.status)),
  };
}

/**
 * Die vom Server bestätigte Zahlung in den lokalen Beleg übernehmen.
 *
 * Idempotent und ohne Geldentscheidung: Ist die Zahlung schon da — etwa weil
 * der nächste Abzug schneller war —, geschieht nichts.
 */
export function projectBankReconciliationPayment(
  reconciliation: BankReconciliation,
): BankPaymentProjectionResult {
  return reconciliation.targetType === 'expense'
    ? projiziereAusgabe(reconciliation)
    : projiziereRechnung(reconciliation);
}
