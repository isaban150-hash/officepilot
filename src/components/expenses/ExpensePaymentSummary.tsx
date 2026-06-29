import {
  calculateExpensePaymentSummary,
  formatPaymentCurrency,
  getOverdueDays,
  isExpenseCancelled,
} from '../../services/expensePaymentService';
import { ExpensePaymentBadge } from './ExpensePaymentBadge';
import type { Expense } from '../../types/expense';
import type { TranslationKey } from '../../i18n';

interface Props {
  expense: Expense;
  translate: (key: TranslationKey) => string;
}

export function ExpensePaymentSummary({ expense, translate }: Props) {
  const summary = calculateExpensePaymentSummary(expense);
  const overdueDays = getOverdueDays(expense);

  return (
    <section className="invoice-payment-summary">
      <div className="invoice-payment-summary__header">
        <h3 className="invoice-payment-summary__title">{translate('payment.summaryTitle')}</h3>
        <ExpensePaymentBadge status={summary.status} translate={translate} />
      </div>

      {isExpenseCancelled(expense) && (
        <p className="invoice-payment-summary__notice invoice-payment-summary__notice--muted">
          {translate('expense.payment.cancelledNotice')}
        </p>
      )}

      {summary.status === 'ueberfaellig' && !isExpenseCancelled(expense) && (
        <p className="invoice-payment-summary__notice invoice-payment-summary__notice--danger">
          {translate('expense.payment.overdueNotice')}
        </p>
      )}

      <dl className="invoice-payment-summary__rows">
        <div className="invoice-payment-summary__row">
          <dt>{translate('payment.totalDue')}</dt>
          <dd>{formatPaymentCurrency(summary.totalDue)}</dd>
        </div>
        <div className="invoice-payment-summary__row">
          <dt>{translate('payment.paidAmount')}</dt>
          <dd>{formatPaymentCurrency(summary.paidAmount)}</dd>
        </div>
        <div className="invoice-payment-summary__row">
          <dt>{translate('payment.openAmount')}</dt>
          <dd>{formatPaymentCurrency(summary.openAmount)}</dd>
        </div>
        {summary.overpaidAmount > 0 && (
          <div className="invoice-payment-summary__row invoice-payment-summary__row--overpaid">
            <dt>{translate('payment.overpaidAmount')}</dt>
            <dd>{formatPaymentCurrency(summary.overpaidAmount)}</dd>
          </div>
        )}
      </dl>

      {overdueDays > 0 && (
        <p className="invoice-payment-summary__overdue-days">
          {translate('payment.overdueDays').replace('{days}', String(overdueDays))}
        </p>
      )}
    </section>
  );
}

export function getExpensePaymentSavedToastKey(expense: Expense): TranslationKey {
  const summary = calculateExpensePaymentSummary(expense);
  if (summary.status === 'bezahlt') return 'expense.payment.savedFullyPaid';
  return 'expense.payment.savedSuccess';
}
