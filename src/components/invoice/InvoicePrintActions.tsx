import { Button } from '../ui/Button';
import { exportInvoiceAsPdf } from '../../services/invoicePdfService';
import { buildPrintTitle } from '../../services/invoiceArchiveService';
import { printInvoice } from '../../services/invoicePrintService';
import type { InvoicePrintModel } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  model: InvoicePrintModel;
  translate: (key: TranslationKey) => string;
  layout?: 'stack' | 'inline';
}

export function InvoicePrintActions({ model, translate, layout = 'stack' }: Props) {
  const title = buildPrintTitle(model);

  const handlePrint = () => {
    printInvoice({ title });
  };

  const handlePdf = () => {
    exportInvoiceAsPdf({ title });
  };

  return (
    <div className={`invoice-print-actions invoice-print-actions--${layout}`}>
      <Button type="button" onClick={handlePrint}>
        {translate('invoice.print')}
      </Button>
      <Button type="button" variant="outline" onClick={handlePdf}>
        {translate('invoice.savePdf')}
      </Button>
    </div>
  );
}
