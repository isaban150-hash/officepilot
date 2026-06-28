import { Button } from '../ui/Button';
import { formatPaymentCurrency, getInvoicePayments } from '../../services/invoicePaymentService';
import { formatInvoiceDate } from '../../services/invoicePrintModel';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  invoice: VorgangInvoice;
  translate: (key: TranslationKey) => string;
  onRemovePayment?: (paymentId: string) => void;
  allowRemove?: boolean;
}

export function InvoicePaymentHistory({
  invoice,
  translate,
  onRemovePayment,
  allowRemove = true,
}: Props) {
  const payments = [...getInvoicePayments(invoice)].sort(
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
              <span className="invoice-payment-history__date">{formatInvoiceDate(payment.date)}</span>
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
