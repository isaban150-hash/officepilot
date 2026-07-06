import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle, DataRow } from '../ui/Card';
import {
  getPaymentSavedToastKey,
  InvoicePaymentForm,
} from './InvoicePaymentForm';
import { InvoicePaymentBadge } from './InvoicePaymentBadge';
import { isFinalizedInvoice } from '../../services/invoiceArchiveService';
import {
  calculatePaymentSummary,
  formatPaymentCurrency,
  getPaidAmount,
  isInvoiceCancelled,
} from '../../services/invoicePaymentService';
import { formatInvoiceDate } from '../../services/invoicePrintModel';
import { getVorgangInvoice } from '../../services/vorgangService';
import { getInvoiceDocumentTitle } from '../../services/invoiceTypeService';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  vorgangId: string;
  invoice: VorgangInvoice;
  translate: (key: TranslationKey) => string;
  onInvoiceUpdated?: (invoice: VorgangInvoice) => void;
  onPaymentToast?: (message: string) => void;
}

function invoiceLabel(inv: VorgangInvoice, translate: (key: TranslationKey) => string): string {
  const key = `invoice.type.${inv.type}` as TranslationKey;
  const translated = translate(key);
  if (inv.type === 'abschlag' && inv.abschlagNumber) {
    return `${translated} ${inv.abschlagNumber}`;
  }
  return translated || getInvoiceDocumentTitle(inv.type, inv.abschlagNumber);
}

function workflowStatusLabel(
  status: VorgangInvoice['status'],
  translate: (key: TranslationKey) => string,
): string {
  const key = `invoice.status.${status}` as TranslationKey;
  return translate(key);
}

export function InvoiceListCard({
  vorgangId,
  invoice,
  translate,
  onInvoiceUpdated,
  onPaymentToast,
}: Props) {
  const navigate = useNavigate();
  const [currentInvoice, setCurrentInvoice] = useState(invoice);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const readOnly = isFinalizedInvoice(currentInvoice);
  const summary = calculatePaymentSummary(currentInvoice);

  useEffect(() => {
    setCurrentInvoice(invoice);
  }, [invoice]);

  const openInvoice = () => {
    navigate(`/vorgaenge/${vorgangId}/rechnungen/${currentInvoice.id}`);
  };

  const triggerPrint = () => {
    if (!readOnly) return;
    navigate(`/vorgaenge/${vorgangId}/rechnungen/${currentInvoice.id}?auto=print`);
  };

  const triggerPdf = () => {
    if (!readOnly) return;
    navigate(`/vorgaenge/${vorgangId}/rechnungen/${currentInvoice.id}?auto=pdf`);
  };

  const handlePaymentSaved = (updated: VorgangInvoice) => {
    setCurrentInvoice(updated);
    onInvoiceUpdated?.(updated);
    onPaymentToast?.(translate(getPaymentSavedToastKey(updated)));
  };

  return (
    <>
      <Card className="invoice-list-card">
        <CardTitle>{invoiceLabel(currentInvoice, translate)}</CardTitle>
        <CardMeta>
          {currentInvoice.number} · {formatInvoiceDate(currentInvoice.issueDate ?? currentInvoice.date)}
        </CardMeta>

        {readOnly && (
          <>
            <DataRow
              label={translate('payment.workflowStatus')}
              value={workflowStatusLabel(currentInvoice.status, translate)}
            />
            <DataRow
              label={translate('payment.paymentStatus')}
              value={<InvoicePaymentBadge status={summary.status} translate={translate} />}
            />
            <DataRow
              label={translate('payment.paidAmount')}
              value={formatPaymentCurrency(getPaidAmount(currentInvoice))}
            />
            <DataRow
              label={translate('payment.openAmount')}
              value={formatPaymentCurrency(summary.openAmount)}
            />
            <DataRow
              label={translate('invoice.paymentDueDate')}
              value={formatInvoiceDate(currentInvoice.paymentDueDate ?? '')}
            />
          </>
        )}

        {!readOnly && (
          <DataRow
            label={translate('payment.workflowStatus')}
            value={workflowStatusLabel(currentInvoice.status, translate)}
          />
        )}

        {currentInvoice.archiveDocumentId && (
          <p className="invoice-list-card__archive">
            <Link to={`/dokumente/${currentInvoice.archiveDocumentId}`}>
              {translate('invoice.openArchiveDocument')}
            </Link>
          </p>
        )}

        {readOnly ? (
          <div className="invoice-list-card__actions">
            <Button type="button" onClick={openInvoice}>
              {translate('invoice.open')}
            </Button>
            {!isInvoiceCancelled(currentInvoice) && (
              <Button type="button" variant="outline" onClick={() => setShowPaymentForm(true)}>
                {translate('payment.recordShort')}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={triggerPrint}>
              {translate('invoice.print')}
            </Button>
            <Button type="button" variant="outline" onClick={triggerPdf}>
              {translate('invoice.savePdf')}
            </Button>
          </div>
        ) : (
          <InvoicePaymentBadge status="offen" translate={translate} />
        )}
      </Card>

      <InvoicePaymentForm
        vorgangId={vorgangId}
        invoice={currentInvoice}
        open={showPaymentForm}
        onClose={() => setShowPaymentForm(false)}
        onSaved={handlePaymentSaved}
        translate={translate}
      />
    </>
  );
}

export function refreshInvoiceFromStore(vorgangId: string, invoiceId: string): VorgangInvoice | undefined {
  return getVorgangInvoice(vorgangId, invoiceId);
}
