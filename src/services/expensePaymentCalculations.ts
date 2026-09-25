import {
  calculateOverpaidAmount,
  resolveSettlementStatus,
} from './payment/paymentSemantics';
import type {
  Expense,
  ExpensePayment,
  ExpensePaymentStatus,
  ExpensePaymentSummary,
} from '../types/expense';

function toDateOnly(value: Date | string): string {
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  return value.toISOString().slice(0, 10);
}

export function getExpensePayments(expense: Expense): ExpensePayment[] {
  return (expense.payments ?? []).map((payment) => ({ ...payment }));
}

export function getExpensePaidAmount(expense: Expense): number {
  return getExpensePayments(expense).reduce((sum, payment) => sum + payment.amount, 0);
}

/**
 * FINANZCORE-05B-FIX2 — ist dieser Beleg eine Gutschrift?
 *
 * Dieselbe Regel, nach der `normalizeExpense` `isCreditNote` setzt: ein
 * negativer Bruttobetrag. Bewusst die Regel und nicht das gespeicherte Feld,
 * damit auch ein Altbeleg ohne gesetztes Kennzeichen richtig behandelt wird —
 * der Betrag lügt nicht.
 */
export function isCreditNoteExpense(expense: Expense): boolean {
  return expense.grossAmount < 0;
}

/**
 * Der noch offene Betrag.
 *
 * FINANZCORE-05B-FIX2 — eine Gutschrift hat keinen.
 *
 * Bis hierher stand hier ausschliesslich `Math.max(0, brutto − bezahlt)`. Die
 * Klammer setzt stillschweigend voraus, dass `brutto` positiv ist; bei −119
 * lieferte sie 0 und liess damit die Rechenkette darauf schliessen, der Beleg
 * sei vollständig beglichen. Das Ergebnis ist zufällig richtig, die Begründung
 * war es nie — und an der Nachbarstelle kippte dieselbe Klammer ins Falsche
 * (siehe `calculateExpensePaymentSummary`).
 *
 * Jetzt steht es ausdrücklich da: Eine Gutschrift ist keine Verbindlichkeit,
 * also gibt es nichts zu begleichen.
 */
export function getExpenseOpenAmount(expense: Expense): number {
  if (isCreditNoteExpense(expense)) return 0;
  const totalDue = expense.grossAmount;
  return Math.max(0, totalDue - getExpensePaidAmount(expense));
}

export function isExpenseCancelled(expense: Expense): boolean {
  return (
    expense.paymentStatus === 'storniert' ||
    expense.status === 'storniert' ||
    Boolean(expense.cancelledAt)
  );
}

/**
 * Darf auf diesen Beleg eine Zahlung gebucht werden?
 *
 * FINANZCORE-05B-FIX2 — auf eine Gutschrift nicht.
 *
 * Das Zahlungsmodell der Ausgaben kennt ausschliesslich positive Beträge:
 * `recordExpensePayment` lehnt alles `<= 0` ab, und die Cloud-Tabelle trägt
 * `check (amount > 0)`. Eine Rückzahlung des Lieferanten, eine Verrechnung mit
 * einer anderen Eingangsrechnung oder ein Lieferantensaldo sind heute nicht
 * modelliert.
 *
 * Eine positive Auszahlung gegen einen negativen Beleg zu buchen wäre deshalb
 * keine Erfassung, sondern eine Erfindung. Die Aktion wird nicht angeboten —
 * und dieser Dienst weist sie auch dann ab, wenn sie jemand anders aufruft.
 */
export function isExpensePayable(expense: Expense): boolean {
  if (isCreditNoteExpense(expense)) return false;
  return expense.status === 'gebucht' && !isExpenseCancelled(expense);
}

export function isExpenseOverdue(
  expense: Expense,
  today: Date | string = new Date(),
): boolean {
  if (!expense.paymentDueDate || getExpenseOpenAmount(expense) <= 0 || isExpenseCancelled(expense)) {
    return false;
  }

  return toDateOnly(today) > toDateOnly(expense.paymentDueDate);
}

export function resolveExpensePaymentStatus(
  expense: Expense,
  today: Date | string = new Date(),
  amounts?: Pick<ExpensePaymentSummary, 'paidAmount' | 'openAmount' | 'overpaidAmount'>,
): ExpensePaymentStatus {
  if (isExpenseCancelled(expense)) {
    return 'storniert';
  }

  /*
   * FINANZCORE-05B-FIX2 — vor jeder Betragsrechnung.
   *
   * Eine Gutschrift ist weder offen noch teil-, voll- oder überbezahlt. Bis
   * hierher fiel sie durch `openAmount <= 0` auf „bezahlt" — ohne dass je eine
   * Zahlung existiert hätte. Der Storno steht darüber, weil ein stornierter
   * Beleg unabhängig von seinem Vorzeichen storniert bleibt.
   */
  if (isCreditNoteExpense(expense)) {
    return 'gutschrift';
  }

  const paidAmount = amounts?.paidAmount ?? getExpensePaidAmount(expense);
  const openAmount = amounts?.openAmount ?? getExpenseOpenAmount(expense);
  const overdue = isExpenseOverdue({ ...expense, payments: expense.payments ?? [] }, today);
  /*
   * FINANZCORE-05C — ab hier dieselbe Regel wie bei den Rechnungen.
   *
   * Die Gutschrift ist oben bereits abgebogen; was hier ankommt, ist ein
   * positiver Beleg. Neu ist allein, dass eine Ueberzahlung sichtbar wird,
   * statt unter „bezahlt" zu verschwinden.
   */
  const overpaidAmount =
    amounts?.overpaidAmount ?? calculateOverpaidAmount(expense.grossAmount, paidAmount);

  return resolveSettlementStatus({ paidAmount, openAmount, overpaidAmount, overdue });
}

export function calculateExpensePaymentSummary(
  expense: Expense,
  today: Date | string = new Date(),
): ExpensePaymentSummary {
  const totalDue = expense.grossAmount;
  const paidAmount = getExpensePaidAmount(expense);
  const creditNote = isCreditNoteExpense(expense);
  const openAmount = getExpenseOpenAmount(expense);
  /*
   * FINANZCORE-05B-FIX2 — die Stelle, an der die Gutschrift sichtbar falsch wurde.
   *
   * `Math.max(0, bezahlt − brutto)` ergab bei brutto −119 und null Zahlungen
   * genau 119. Die Oberfläche meldete daraufhin „Überzahlung 119,00 €" für
   * einen Beleg, auf den nie jemand etwas gezahlt hatte. Eine Überzahlung
   * entsteht ausschliesslich aus tatsächlich geflossenem Geld, nie aus einem
   * Vorzeichen.
   *
   * Bei einer Gutschrift gibt es deshalb keine — was an ihr aussteht, ist ein
   * Guthaben, und das ist der Bruttobetrag selbst.
   */
  const overpaidAmount = creditNote ? 0 : calculateOverpaidAmount(totalDue, paidAmount);
  const status = resolveExpensePaymentStatus(expense, today, {
    paidAmount,
    openAmount,
    overpaidAmount,
  });

  return {
    totalDue,
    paidAmount,
    openAmount,
    overpaidAmount,
    status,
  };
}

export function normalizeExpensePaymentFields(expense: Expense): Expense {
  const payments = getExpensePayments(expense);
  const summary = calculateExpensePaymentSummary({ ...expense, payments });

  return {
    ...expense,
    payments,
    paymentStatus: summary.status,
  };
}

export function getOverdueDays(expense: Expense, today: Date | string = new Date()): number {
  if (!expense.paymentDueDate || !isExpenseOverdue(expense, today)) {
    return 0;
  }

  const due = new Date(toDateOnly(expense.paymentDueDate));
  const now = new Date(toDateOnly(today));
  const diffMs = now.getTime() - due.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}
