import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { buildPrintTitle } from '../../services/invoiceArchiveService';
import {
  downloadInvoicePdfBytes,
  generateApprovedInvoicePdf,
  type GenerateApprovedInvoicePdfResult,
} from '../../services/invoicePdfService';
import * as invoicePrintService from '../../services/invoicePrintService';
import { validateFinalizedInvoiceForPdf } from '../../services/invoiceValidationService';
import type { InvoicePrintModel, VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  invoice: VorgangInvoice;
  model: InvoicePrintModel;
  translate: (key: TranslationKey) => string;
  layout?: 'stack' | 'inline';
  /** When true, start PDF download once after mount (e.g. ?auto=pdf). */
  autoDownloadPdf?: boolean;
  /**
   * NORMAL-INVOICE-CANCELLATION-01B — der PDF-Erzeuger für dieses Modell.
   * Standard: die freigegebene Rechnung. Der Korrekturbeleg reicht
   * `generateInvoiceCorrectionPdf` herein — dieselbe Engine, anderes Modell.
   */
  generatePdf?: (invoice: VorgangInvoice) => Promise<GenerateApprovedInvoicePdfResult>;
}

export function InvoicePrintActions({
  invoice,
  model,
  translate,
  layout = 'stack',
  autoDownloadPdf = false,
  generatePdf = generateApprovedInvoicePdf,
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
      const result = await generatePdf(current);
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

  /**
   * LEGACY-INVOICE-SERVICE-PERIOD-RECOVERY-01B — Druck und PDF an derselben Grenze.
   *
   * Bisher rief „Drucken" unmittelbar `window.print()` auf und umging damit
   * jede Prüfung. Eine Rechnung, für die der PDF-Pfad `service_period_unconfirmed`
   * meldete, liess sich über den Druckdialog trotzdem als Beleg ausgeben — und
   * in Safari sogar als PDF sichern. Der Gate war damit eine Empfehlung.
   *
   * Bewusst **keine** eigene Prüfung und keine Abfrage auf einen einzelnen
   * Fehlercode: Es gilt derselbe zentrale Validator wie für das PDF, mit allen
   * seinen Blockern. Was der eine Weg verweigert, verweigert auch der andere.
   */
  const runPrint = (): void => {
    setPdfError(null);
    const validation = validateFinalizedInvoiceForPdf(invoiceRef.current);
    if (validation.blockingErrors.length > 0) {
      setPdfError(translate('invoice.pdf.error'));
      return;
    }
    invoicePrintService.printInvoice({ title });
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
        onClick={runPrint}
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
