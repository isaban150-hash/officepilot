import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { buildPrintTitle } from '../../services/invoiceArchiveService';
import {
  downloadInvoicePdfBytes,
  generateApprovedInvoicePdf,
} from '../../services/invoicePdfService';
import { printInvoice } from '../../services/invoicePrintService';
import type { InvoicePrintModel, VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  invoice: VorgangInvoice;
  model: InvoicePrintModel;
  translate: (key: TranslationKey) => string;
  layout?: 'stack' | 'inline';
  /** When true, start PDF download once after mount (e.g. ?auto=pdf). */
  autoDownloadPdf?: boolean;
}

export function InvoicePrintActions({
  invoice,
  model,
  translate,
  layout = 'stack',
  autoDownloadPdf = false,
}: Props) {
  const title = buildPrintTitle(model);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const revokeRef = useRef<(() => void) | null>(null);
  const autoStartedRef = useRef(false);
  const invoiceRef = useRef(invoice);
  invoiceRef.current = invoice;

  useEffect(() => {
    return () => {
      revokeRef.current?.();
      revokeRef.current = null;
    };
  }, []);

  const runPdfDownload = async (): Promise<void> => {
    if (pdfLoading) return;
    setPdfLoading(true);
    setPdfError(null);
    const current = invoiceRef.current;
    try {
      const result = await generateApprovedInvoicePdf(current);
      if (!result.ok) {
        setPdfError(translate('invoice.pdf.error'));
        return;
      }
      if (result.statusUnchanged !== current.status) {
        setPdfError(translate('invoice.pdf.error'));
        return;
      }
      revokeRef.current?.();
      const handle = downloadInvoicePdfBytes(result.bytes, result.filename);
      revokeRef.current = handle.revoke;
    } catch {
      setPdfError(translate('invoice.pdf.error'));
    } finally {
      setPdfLoading(false);
    }
  };

  useEffect(() => {
    if (!autoDownloadPdf || autoStartedRef.current) return;
    autoStartedRef.current = true;
    void runPdfDownload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot auto download
  }, [autoDownloadPdf]);

  return (
    <div className={`invoice-print-actions invoice-print-actions--${layout}`}>
      <Button
        type="button"
        onClick={() => printInvoice({ title })}
        data-testid="invoice-print"
      >
        {translate('invoice.print')}
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={() => void runPdfDownload()}
        disabled={pdfLoading}
        data-testid="invoice-download-pdf"
      >
        {pdfLoading ? translate('invoice.pdf.loading') : translate('invoice.downloadPdf')}
      </Button>
      {pdfError ? (
        <p className="invoice-print-actions__error" data-testid="invoice-pdf-error">
          {pdfError}
        </p>
      ) : null}
    </div>
  );
}
