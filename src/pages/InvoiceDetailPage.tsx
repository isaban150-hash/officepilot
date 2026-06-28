import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { InvoiceDocumentView } from '../components/invoice/InvoiceDocumentView';
import { InvoicePrintActions } from '../components/invoice/InvoicePrintActions';
import {
  getPaymentSavedToastKey,
  InvoicePaymentForm,
} from '../components/invoice/InvoicePaymentForm';
import { InvoicePaymentHistory } from '../components/invoice/InvoicePaymentHistory';
import { InvoicePaymentSummary } from '../components/invoice/InvoicePaymentSummary';
import { Button } from '../components/ui/Button';
import { Card, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { isFinalizedInvoice, buildPrintTitle } from '../services/invoiceArchiveService';
import { buildInvoicePrintModelFromInvoice } from '../services/invoicePrintModel';
import { exportInvoiceAsPdf } from '../services/invoicePdfService';
import { isInvoiceCancelled, removePayment } from '../services/invoicePaymentService';
import { printInvoice } from '../services/invoicePrintService';
import { getVorgangById, getVorgangInvoice } from '../services/vorgangService';
import type { VorgangInvoice } from '../types/models';

export function InvoiceDetailPage() {
  const { id: vorgangId, invoiceId } = useParams<{ id: string; invoiceId: string }>();
  const [searchParams] = useSearchParams();
  const fromOverview = searchParams.get('from') === 'overview';
  const { translate, showToast } = useApp();
  const navigate = useNavigate();

  const [invoice, setInvoice] = useState<VorgangInvoice | undefined>(() =>
    vorgangId && invoiceId ? getVorgangInvoice(vorgangId, invoiceId) : undefined,
  );
  const [showPaymentForm, setShowPaymentForm] = useState(false);

  const vorgang = vorgangId ? getVorgangById(vorgangId) : undefined;

  useEffect(() => {
    if (vorgangId && invoiceId) {
      setInvoice(getVorgangInvoice(vorgangId, invoiceId));
    }
  }, [vorgangId, invoiceId]);

  const printModel = useMemo(() => {
    if (!invoice || !isFinalizedInvoice(invoice)) return null;
    try {
      return buildInvoicePrintModelFromInvoice(invoice);
    } catch {
      return null;
    }
  }, [invoice]);

  useEffect(() => {
    if (!printModel) return;
    const auto = searchParams.get('auto');
    const title = buildPrintTitle(printModel);
    if (auto === 'print') {
      printInvoice({ title });
    } else if (auto === 'pdf') {
      exportInvoiceAsPdf({ title });
    }
  }, [printModel, searchParams]);

  const handlePaymentSaved = (updated: VorgangInvoice) => {
    setInvoice(updated);
    showToast(translate(getPaymentSavedToastKey(updated)));
  };

  const handleRemovePayment = (paymentId: string) => {
    if (!vorgangId || !invoiceId) return;
    const result = removePayment(vorgangId, invoiceId, paymentId);
    if (!result.success) {
      showToast(translate(result.errorKey as never));
      return;
    }
    setInvoice(result.invoice);
    showToast(translate('payment.removedSuccess'));
  };

  if (!vorgangId || !invoiceId || !vorgang || !invoice) {
    return (
      <div className="page">
        <p className="empty-state">{translate('invoice.notFound')}</p>
        <Button variant="outline" onClick={() => navigate(`/vorgaenge/${vorgangId ?? ''}`)}>
          {translate('common.back')}
        </Button>
      </div>
    );
  }

  if (!isFinalizedInvoice(invoice) || !printModel) {
    return (
      <div className="page">
        <p className="empty-state">{translate('invoice.readOnlyMissingSnapshots')}</p>
        <Button variant="outline" onClick={() => navigate(`/vorgaenge/${vorgangId}`)}>
          {translate('common.back')}
        </Button>
      </div>
    );
  }

  return (
    <div className="page page--invoice-detail">
      <div className="invoice-detail__toolbar no-print">
        <button
          type="button"
          className="back-link"
          onClick={() => navigate(fromOverview ? '/rechnungen/offen' : `/vorgaenge/${vorgangId}`)}
        >
          ← {fromOverview ? translate('overview.backToOverview') : translate('common.back')}
        </button>
        <PageHeader
          title={printModel.documentTitle}
          subtitle={`${printModel.invoiceNumber} · ${vorgang.title}`}
        />
        <div className="invoice-detail__actions">
          <InvoicePrintActions model={printModel} translate={translate} layout="inline" />
          {!isInvoiceCancelled(invoice) && (
            <Button type="button" onClick={() => setShowPaymentForm(true)}>
              {translate('payment.record')}
            </Button>
          )}
        </div>
        {(fromOverview || invoice.archiveDocumentId) && (
          <p className="invoice-detail__archive-link">
            {fromOverview && (
              <>
                <Link to="/rechnungen/offen">{translate('overview.backToOverview')}</Link>
                {invoice.archiveDocumentId && ' · '}
              </>
            )}
            {invoice.archiveDocumentId && (
              <Link to={`/dokumente/${invoice.archiveDocumentId}`}>
                {translate('invoice.openArchiveDocument')}
              </Link>
            )}
          </p>
        )}
        <p className="hint-text">{translate('invoice.readOnlyHint')}</p>
      </div>

      <Card className="invoice-detail__payment no-print">
        <InvoicePaymentSummary invoice={invoice} translate={translate} />
        <InvoicePaymentHistory
          invoice={invoice}
          translate={translate}
          onRemovePayment={handleRemovePayment}
        />
      </Card>

      <div className="invoice-detail__document">
        <InvoiceDocumentView model={printModel} />
      </div>

      <InvoicePaymentForm
        vorgangId={vorgangId}
        invoice={invoice}
        open={showPaymentForm}
        onClose={() => setShowPaymentForm(false)}
        onSaved={handlePaymentSaved}
        translate={translate}
      />
    </div>
  );
}
