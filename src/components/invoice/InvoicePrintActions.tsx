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
import type { InvoiceOutputHold } from '../../services/invoice/invoiceOutputClearance';
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
  /**
   * GO-LIVE-SECURITY-01 — die Ausgabe wartet auf den Nachweis, dass die Cloud
   * die Bestätigung des Leistungszeitraums trägt (siehe
   * `invoiceOutputClearance`). Solange er fehlt, gibt es weder Druck noch PDF,
   * auch nicht über `?auto=pdf`.
   */
  outputHold?: InvoiceOutputHold | null;
  /** Fragt die Cloud erneut, wenn es keinen Nachweis gab. */
  onRetryOutputCheck?: () => void;
}

export function InvoicePrintActions({
  invoice,
  model,
  translate,
  layout = 'stack',
  autoDownloadPdf = false,
  generatePdf = generateApprovedInvoicePdf,
  outputHold = null,
  onRetryOutputCheck,
}: Props) {
  const title = buildPrintTitle(model);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const revokeRef = useRef<(() => void) | null>(null);
  const autoStartedRef = useRef(false);
  const invoiceRef = useRef(invoice);
  invoiceRef.current = invoice;
  const holdRef = useRef(outputHold);
  holdRef.current = outputHold;

  useEffect(() => {
    return () => {
      revokeRef.current?.();
      revokeRef.current = null;
    };
  }, []);

  /*
   * FINANZ-CORE-01A (AUS-14) — der konkrete Grund statt „PDF konnte nicht erzeugt werden": Der
   * Validator nennt ihn, die Meldung verwarf ihn bisher.
   */
  const pdfFehlerText = (result: GenerateApprovedInvoicePdfResult): string => {
    if (!result.ok && result.reason === 'validation_failed') {
      const grund = result.validation?.blockingErrors[0]?.messageKey;
      if (grund) return `${translate('invoice.pdf.errorPrefix')} ${translate(grund)}`;
    }
    return translate('invoice.pdf.error');
  };

  const runPdfDownload = async (): Promise<void> => {
    if (pdfLoading || holdRef.current) return;
    setPdfLoading(true);
    setPdfError(null);
    const current = invoiceRef.current;
    try {
      const result = await generatePdf(current);
      if (!result.ok) {
        setPdfError(pdfFehlerText(result));
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
    if (holdRef.current) return;
    setPdfError(null);
    const validation = validateFinalizedInvoiceForPdf(invoiceRef.current);
    if (validation.blockingErrors.length > 0) {
      // FINANZ-CORE-01A (AUS-14) — Drucken ist kein PDF: eigene Meldung mit dem konkreten Grund.
      setPdfError(`${translate('invoice.print.error')} ${translate(validation.blockingErrors[0]!.messageKey)}`);
      return;
    }
    invoicePrintService.printInvoice({ title });
  };

  useEffect(() => {
    // GO-LIVE-SECURITY-01 — der Direktaufruf wartet auf den Nachweis, er umgeht ihn nicht.
    if (!autoDownloadPdf || autoStartedRef.current || outputHold) return;
    autoStartedRef.current = true;
    void runPdfDownload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot auto download
  }, [autoDownloadPdf, outputHold]);

  return (
    <div className={`invoice-print-actions invoice-print-actions--${layout}`}>
      <Button
        type="button"
        onClick={runPrint}
        disabled={Boolean(outputHold)}
        data-testid="invoice-print"
      >
        {translate('invoice.print')}
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={() => void runPdfDownload()}
        disabled={pdfLoading || Boolean(outputHold)}
        data-testid="invoice-download-pdf"
      >
        {pdfLoading ? translate('invoice.pdf.loading') : translate('invoice.downloadPdf')}
      </Button>
      {outputHold ? (
        <div className="invoice-hint" role="status" data-testid={`invoice-output-hold-${outputHold}`}>
          <p>
            {translate(outputHold === 'verifying' ? 'invoice.output.verifying' : 'invoice.output.unverified')}
          </p>
          {outputHold === 'unverified' && onRetryOutputCheck ? (
            <Button
              type="button"
              variant="outline"
              onClick={onRetryOutputCheck}
              data-testid="invoice-output-hold-retry"
            >
              {translate('invoice.output.retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {pdfError ? (
        <p className="invoice-print-actions__error" data-testid="invoice-pdf-error">
          {pdfError}
        </p>
      ) : null}
    </div>
  );
}
