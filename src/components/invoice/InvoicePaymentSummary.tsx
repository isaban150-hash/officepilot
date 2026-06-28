import {
  calculatePaymentSummary,
  formatPaymentCurrency,
  getOverdueDays,
  isInvoiceCancelled,
} from '../../services/invoicePaymentService';
import { InvoicePaymentBadge } from './InvoicePaymentBadge';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  invoice: VorgangInvoice;
  translate: (key: TranslationKey) => string;
}

export function InvoicePaymentSummary({ invoice, translate }: Props) {
  const summary = calculatePaymentSummary(invoice);
  const overdueDays = getOverdueDays(invoice);

  return (
    <section className="invoice-payment-summary">
      <div className="invoice-payment-summary__header">
        <h3 className="invoice-payment-summary__title">{translate('payment.summaryTitle')}</h3>
        <InvoicePaymentBadge status={summary.status} translate={translate} />
      </div>

      {isInvoiceCancelled(invoice) && (
        <p className="invoice-payment-summary__notice invoice-payment-summary__notice--muted">
          {translate('payment.invoiceCancelledNotice')}
        </p>
      )}

      {summary.status === 'ueberfaellig' && !isInvoiceCancelled(invoice) && (
        <p className="invoice-payment-summary__notice invoice-payment-summary__notice--danger">
          {translate('payment.invoiceOverdueNotice')}
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
