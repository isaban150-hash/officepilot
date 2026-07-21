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
import { DetailExperienceCard } from '../components/detail/DetailExperienceCard';
import { CommunicationIntegrationPanel } from '../components/communication/CommunicationIntegrationPanel';
import { INVOICE_COMMUNICATION_BUTTON_KEYS } from '../components/communication/communicationNavigation';
import { Button } from '../components/ui/Button';
import { ShowMoreSection } from '../components/ui/ShowMoreSection';
import { useApp } from '../context/AppContext';
import { isFinalizedInvoice, buildPrintTitle } from '../services/invoiceArchiveService';
import { buildInvoicePrintModelFromInvoice } from '../services/invoicePrintModel';
import {
  calculatePaymentSummary,
  formatPaymentCurrency,
  isInvoiceCancelled,
  removePayment,
} from '../services/invoicePaymentService';
import { printInvoice } from '../services/invoicePrintService';
import { getVorgangById, getVorgangInvoice } from '../services/vorgangService';
import { InvoiceSentPanel } from '../components/invoice/InvoiceSentPanel';
import type { VorgangInvoice } from '../types/models';
import type { TranslationKey } from '../i18n';

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
  const [showDetails, setShowDetails] = useState(false);

  const vorgang = vorgangId ? getVorgangById(vorgangId) : undefined;

  useEffect(() => {
    if (vorgangId && invoiceId) {
      setInvoice(getVorgangInvoice(vorgangId, invoiceId));
      setShowDetails(false);
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
    if (auto === 'print') {
      printInvoice({ title: buildPrintTitle(printModel) });
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

  const paymentSummary = calculatePaymentSummary(invoice);
  const statusKey = `payment.status.${paymentSummary.status}` as TranslationKey;

  const autoDownloadPdf = searchParams.get('auto') === 'pdf';

  const primaryActions = (
    <>
      <InvoicePrintActions
        invoice={invoice}
        model={printModel}
        translate={translate}
        layout="stack"
        autoDownloadPdf={autoDownloadPdf}
      />
      <InvoiceSentPanel
        vorgangId={vorgangId}
        invoice={invoice}
        translate={translate}
        onUpdated={setInvoice}
      />
      {!isInvoiceCancelled(invoice) && (
        <Button type="button" fullWidth onClick={() => setShowPaymentForm(true)}>
          {translate('detail.action.recordPayment')}
        </Button>
      )}
      <Button
        variant="outline"
        fullWidth
        onClick={() =>
          navigate(`/kommunikation?context=invoice&id=${invoice.id}&vorgangId=${vorgangId}`)
        }
      >
        {translate('detail.action.writeMessage')}
      </Button>
    </>
  );

  const technicalPanels = (
    <>
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

      <InvoicePaymentSummary invoice={invoice} translate={translate} />
      <InvoicePaymentHistory
        invoice={invoice}
        translate={translate}
        onRemovePayment={handleRemovePayment}
      />

      <CommunicationIntegrationPanel
        contextRef={{
          type: 'invoice',
          id: invoice.id,
          vorgangId: vorgangId ?? '',
        }}
        buttonKeys={INVOICE_COMMUNICATION_BUTTON_KEYS}
        testIdPrefix="invoice"
      />

      <div className="invoice-detail__document">
        <InvoiceDocumentView model={printModel} />
      </div>

      <p className="hint-text">{translate('invoice.readOnlyHint')}</p>
    </>
  );

  return (
    <div className="page page--invoice-detail" data-testid="invoice-detail-page">
      <div className="invoice-detail__toolbar no-print">
        <button
          type="button"
          className="back-link"
          onClick={() => navigate(fromOverview ? '/rechnungen/offen' : `/vorgaenge/${vorgangId}`)}
        >
          ← {fromOverview ? translate('overview.backToOverview') : translate('common.back')}
        </button>

        <DetailExperienceCard
          recognizedTitle={printModel.documentTitle}
          recognizedSummary={`${printModel.invoiceNumber} · ${vorgang.customer}`}
          assistantMessage={translate('invoice.experience.finalized').replace(
            '{amount}',
            formatPaymentCurrency(paymentSummary.totalDue),
          )}
          highlights={
            paymentSummary.openAmount > 0
              ? [
                  translate('invoice.highlight.openAmount').replace(
                    '{amount}',
                    formatPaymentCurrency(paymentSummary.openAmount),
                  ),
                  translate(statusKey),
                ]
              : [translate(statusKey)]
          }
          actions={primaryActions}
          testId="invoice-detail-experience"
        />

        <ShowMoreSection
          expanded={showDetails}
          onToggle={() => setShowDetails((open) => !open)}
          showLabel={translate('common.showMore')}
          hideLabel={translate('common.showLess')}
          testId="invoice-detail-show-more"
        >
          {technicalPanels}
        </ShowMoreSection>
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
