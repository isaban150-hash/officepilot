import { useState } from 'react';
import { Button } from '../ui/Button';
import { SimpleConfirmDialog } from '../ui/SimpleConfirmDialog';
import { formatDisplayDate, formatEuroAmount } from '../../utils/displayFormat';
import { DateDisplay, MoneyDisplay } from '../ui/Display';
import { BusinessList, BusinessListItem } from '../ui/Lists';
import { getExpensePayments } from '../../services/expensePaymentService';
import type { Expense } from '../../types/expense';
import type { TranslationKey } from '../../i18n';

interface Props {
  expense: Expense;
  translate: (key: TranslationKey) => string;
  onRemovePayment?: (paymentId: string) => void;
  allowRemove?: boolean;
}

/**
 * UIUX-FOUNDATION-01F — Zahlungshistorie als Business-Liste (Datum, Betrag,
 * Referenz/Notiz, Entfernen). Confirm-first über den kanonischen Dialog
 * (UIUX-01G); die Reversal-Logik dahinter ist unverändert.
 */
export function ExpensePaymentHistory({
  expense,
  translate,
  onRemovePayment,
  allowRemove = true,
}: Props) {
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const payments = [...getExpensePayments(expense)].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  if (payments.length === 0) {
    return (
      <section className="invoice-payment-history">
        <h3 className="invoice-payment-history__title">{translate('payment.historyTitle')}</h3>
        <p className="detail-empty invoice-payment-history__empty">{translate('payment.historyEmpty')}</p>
      </section>
    );
  }

  return (
    <section className="invoice-payment-history">
      <h3 className="invoice-payment-history__title">{translate('payment.historyTitle')}</h3>
      <BusinessList className="invoice-payment-history__list">
        {payments.map((payment) => (
          <BusinessListItem
            key={payment.id}
            className="invoice-payment-history__item"
            title={<DateDisplay value={payment.date} />}
            amount={<MoneyDisplay value={payment.amount} />}
            subtitle={payment.reference ? `${translate('payment.reference')}: ${payment.reference}` : undefined}
            meta={payment.note || undefined}
            action={
              allowRemove && onRemovePayment ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPendingRemoveId(payment.id)}
                  data-testid={`payment-remove-${payment.id}`}
                >
                  {translate('payment.remove')}
                </Button>
              ) : undefined
            }
          />
        ))}
      </BusinessList>
      {(() => {
        const pending = payments.find((entry) => entry.id === pendingRemoveId);
        return (
          <SimpleConfirmDialog
            open={Boolean(pending)}
            title={translate('payment.remove')}
            message={pending ? `${translate('payment.removeConfirm')} ${formatDisplayDate(pending.date)} · ${formatEuroAmount(pending.amount)}` : translate('payment.removeConfirm')}
            confirmLabel={translate('payment.remove')}
            cancelLabel={translate('common.cancel')}
            dialogTestId="payment-remove-dialog"
            confirmTestId="payment-remove-confirm"
            cancelTestId="payment-remove-cancel"
            onConfirm={() => {
              if (pending && onRemovePayment) onRemovePayment(pending.id);
              setPendingRemoveId(null);
              return true;
            }}
            onCancel={() => setPendingRemoveId(null)}
          />
        );
      })()}
    </section>
  );
}
