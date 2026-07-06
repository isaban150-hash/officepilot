import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle, DataRow } from '../ui/Card';
import {
  getPaymentSavedToastKey,
  InvoicePaymentForm,
} from './InvoicePaymentForm';
import { InvoicePaymentBadge } from './InvoicePaymentBadge';
import {
  formatPaymentCurrency,
  isInvoiceCancelled,
} from '../../services/invoicePaymentService';
import { formatInvoiceDate } from '../../services/invoicePrintModel';
import type { InvoiceOverviewItem } from '../../services/invoiceOverviewService';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  item: InvoiceOverviewItem;
  translate: (key: TranslationKey) => string;
  onInvoiceUpdated?: (item: InvoiceOverviewItem) => void;
  onPaymentToast?: (message: string) => void;
}

function invoiceTypeLabel(invoice: VorgangInvoice, translate: (key: TranslationKey) => string): string {
  const key = `invoice.type.${invoice.type}` as TranslationKey;
  const label = translate(key);
  if (invoice.type === 'abschlag' && invoice.abschlagNumber) {
    return `${label} ${invoice.abschlagNumber}`;
  }
  return label;
}

function workflowStatusLabel(
  status: VorgangInvoice['status'],
  translate: (key: TranslationKey) => string,
): string {
  return translate(`invoice.status.${status}` as TranslationKey);
}

export function InvoiceOverviewCard({
  item,
  translate,
  onInvoiceUpdated,
  onPaymentToast,
}: Props) {
  const navigate = useNavigate();
  const [currentItem, setCurrentItem] = useState(item);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const { invoice, paymentSummary } = currentItem;

  useEffect(() => {
    setCurrentItem(item);
  }, [item]);

  const openInvoice = () => {
    navigate(`/vorgaenge/${currentItem.vorgangId}/rechnungen/${invoice.id}?from=overview`);
  };

  const triggerPrint = () => {
    navigate(`/vorgaenge/${currentItem.vorgangId}/rechnungen/${invoice.id}?auto=print`);
  };

  const triggerPdf = () => {
    navigate(`/vorgaenge/${currentItem.vorgangId}/rechnungen/${invoice.id}?auto=pdf`);
  };

  const handlePaymentSaved = (updated: VorgangInvoice) => {
    const nextItem = {
      ...currentItem,
      invoice: updated,
    };
    setCurrentItem(nextItem);
    onInvoiceUpdated?.(nextItem);
    onPaymentToast?.(translate(getPaymentSavedToastKey(updated)));
  };

  return (
    <>
      <Card className="invoice-overview-card">
        <CardTitle>
          {invoice.number} · {invoiceTypeLabel(invoice, translate)}
        </CardTitle>
        <CardMeta>
          <Link to={`/vorgaenge/${currentItem.vorgangId}`}>{currentItem.vorgangTitle}</Link>
          {' · '}
          {currentItem.customer}
        </CardMeta>
        {currentItem.baustelle && (
          <CardMeta>{currentItem.baustelle}</CardMeta>
        )}

        <DataRow
          label={translate('invoice.issueDate')}
          value={formatInvoiceDate(invoice.issueDate ?? invoice.date)}
        />
        <DataRow
          label={translate('invoice.paymentDueDate')}
          value={formatInvoiceDate(invoice.paymentDueDate ?? '')}
        />
        <DataRow label={translate('payment.totalDue')} value={formatPaymentCurrency(paymentSummary.totalDue)} />
        <DataRow label={translate('payment.paidAmount')} value={formatPaymentCurrency(paymentSummary.paidAmount)} />
        <DataRow label={translate('payment.openAmount')} value={formatPaymentCurrency(paymentSummary.openAmount)} />
        <DataRow
          label={translate('payment.workflowStatus')}
          value={workflowStatusLabel(invoice.status, translate)}
        />
        <DataRow
          label={translate('payment.paymentStatus')}
          value={<InvoicePaymentBadge status={paymentSummary.status} translate={translate} />}
        />

        <div className="invoice-overview-card__actions">
          <Button type="button" onClick={openInvoice}>
            {translate('invoice.open')}
          </Button>
          {!isInvoiceCancelled(invoice) && (
            <Button type="button" variant="outline" onClick={() => setShowPaymentForm(true)}>
              {translate('payment.recordShort')}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={triggerPdf}>
            {translate('invoice.savePdf')}
          </Button>
          <Button type="button" variant="outline" onClick={triggerPrint}>
            {translate('invoice.print')}
          </Button>
          {invoice.archiveDocumentId && (
            <Link to={`/dokumente/${invoice.archiveDocumentId}`}>
              <Button type="button" variant="outline">
                {translate('overview.archive')}
              </Button>
            </Link>
          )}
        </div>
      </Card>

      <InvoicePaymentForm
        vorgangId={currentItem.vorgangId}
        invoice={invoice}
        open={showPaymentForm}
        onClose={() => setShowPaymentForm(false)}
        onSaved={handlePaymentSaved}
        translate={translate}
      />
    </>
  );
}
