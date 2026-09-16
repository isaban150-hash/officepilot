import {
  calculatePaymentSummary,
  getOverdueDays,
  isInvoiceCancelled,
} from '../../services/invoicePaymentService';
import { InvoicePaymentBadge } from './InvoicePaymentBadge';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';
import { InlineNotice } from '../ui/States';
import { MoneyDisplay } from '../ui/Display';

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
        <InlineNotice tone="neutral">{translate('payment.invoiceCancelledNotice')}</InlineNotice>
      )}

      {summary.status === 'ueberfaellig' && !isInvoiceCancelled(invoice) && (
        <InlineNotice tone="critical">{translate('payment.invoiceOverdueNotice')}</InlineNotice>
      )}

      <dl className="invoice-payment-summary__rows summary-list summary-list--single">
        <div className="invoice-payment-summary__row">
          <dt>{translate('payment.totalDue')}</dt>
          <dd><MoneyDisplay value={summary.totalDue} /></dd>
        </div>
        <div className="invoice-payment-summary__row">
          <dt>{translate('payment.paidAmount')}</dt>
          <dd><MoneyDisplay value={summary.paidAmount} /></dd>
        </div>
        <div className="invoice-payment-summary__row">
          <dt>{translate('payment.openAmount')}</dt>
          <dd><MoneyDisplay value={summary.openAmount} /></dd>
        </div>
        {summary.overpaidAmount > 0 && (
          <div className="invoice-payment-summary__row invoice-payment-summary__row--overpaid">
            <dt>{translate('payment.overpaidAmount')}</dt>
            <dd><MoneyDisplay value={summary.overpaidAmount} /></dd>
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
