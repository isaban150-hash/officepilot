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

export function getExpenseOpenAmount(expense: Expense): number {
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

export function isExpensePayable(expense: Expense): boolean {
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

  const paidAmount = amounts?.paidAmount ?? getExpensePaidAmount(expense);
  const openAmount = amounts?.openAmount ?? getExpenseOpenAmount(expense);
  const overdue = isExpenseOverdue({ ...expense, payments: expense.payments ?? [] }, today);

  if (openAmount <= 0) {
    return 'bezahlt';
  }

  if (paidAmount > 0) {
    return overdue ? 'ueberfaellig' : 'teilbezahlt';
  }

  return overdue ? 'ueberfaellig' : 'offen';
}

export function calculateExpensePaymentSummary(
  expense: Expense,
  today: Date | string = new Date(),
): ExpensePaymentSummary {
  const totalDue = expense.grossAmount;
  const paidAmount = getExpensePaidAmount(expense);
  const openAmount = Math.max(0, totalDue - paidAmount);
  const overpaidAmount = Math.max(0, paidAmount - totalDue);
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
