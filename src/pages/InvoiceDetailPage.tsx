import { useEffect, useMemo } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { InvoiceDocumentView } from '../components/invoice/InvoiceDocumentView';
import { InvoicePrintActions } from '../components/invoice/InvoicePrintActions';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { isFinalizedInvoice, buildPrintTitle } from '../services/invoiceArchiveService';
import { buildInvoicePrintModelFromInvoice } from '../services/invoicePrintModel';
import { exportInvoiceAsPdf } from '../services/invoicePdfService';
import { printInvoice } from '../services/invoicePrintService';
import { getVorgangById, getVorgangInvoice } from '../services/vorgangService';

export function InvoiceDetailPage() {
  const { id: vorgangId, invoiceId } = useParams<{ id: string; invoiceId: string }>();
  const [searchParams] = useSearchParams();
  const { translate } = useApp();
  const navigate = useNavigate();

  const vorgang = vorgangId ? getVorgangById(vorgangId) : undefined;
  const invoice = vorgangId && invoiceId ? getVorgangInvoice(vorgangId, invoiceId) : undefined;

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
          onClick={() => navigate(`/vorgaenge/${vorgangId}`)}
        >
          ← {translate('common.back')}
        </button>
        <PageHeader
          title={printModel.documentTitle}
          subtitle={`${printModel.invoiceNumber} · ${vorgang.title}`}
        />
        <InvoicePrintActions model={printModel} translate={translate} />
        {invoice.archiveDocumentId && (
          <p className="invoice-detail__archive-link">
            <Link to={`/dokumente/${invoice.archiveDocumentId}`}>
              {translate('invoice.openArchiveDocument')}
            </Link>
          </p>
        )}
        <p className="hint-text">{translate('invoice.readOnlyHint')}</p>
      </div>

      <div className="invoice-detail__document">
        <InvoiceDocumentView model={printModel} />
      </div>
    </div>
  );
}
