import { Button } from '../ui/Button';
import {
  formatPaymentCurrency,
  getExpensePayments,
} from '../../services/expensePaymentService';
import type { Expense } from '../../types/expense';
import type { TranslationKey } from '../../i18n';

function formatPaymentDate(value: string): string {
  try {
    return new Date(value).toLocaleDateString('de-DE');
  } catch {
    return value;
  }
}

interface Props {
  expense: Expense;
  translate: (key: TranslationKey) => string;
  onRemovePayment?: (paymentId: string) => void;
  allowRemove?: boolean;
}

export function ExpensePaymentHistory({
  expense,
  translate,
  onRemovePayment,
  allowRemove = true,
}: Props) {
  const payments = [...getExpensePayments(expense)].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  if (payments.length === 0) {
    return (
      <section className="invoice-payment-history">
        <h3 className="invoice-payment-history__title">{translate('payment.historyTitle')}</h3>
        <p className="invoice-payment-history__empty">{translate('payment.historyEmpty')}</p>
      </section>
    );
  }

  return (
    <section className="invoice-payment-history">
      <h3 className="invoice-payment-history__title">{translate('payment.historyTitle')}</h3>
      <ul className="invoice-payment-history__list">
        {payments.map((payment) => (
          <li key={payment.id} className="invoice-payment-history__item">
            <div className="invoice-payment-history__main">
              <span className="invoice-payment-history__date">{formatPaymentDate(payment.date)}</span>
              <span className="invoice-payment-history__amount">
                {formatPaymentCurrency(payment.amount)}
              </span>
            </div>
            {payment.reference && (
              <p className="invoice-payment-history__reference">
                {translate('payment.reference')}: {payment.reference}
              </p>
            )}
            {payment.note && <p className="invoice-payment-history__note">{payment.note}</p>}
            {allowRemove && onRemovePayment && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  if (window.confirm(translate('payment.removeConfirm'))) {
                    onRemovePayment(payment.id);
                  }
                }}
              >
                {translate('payment.remove')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
