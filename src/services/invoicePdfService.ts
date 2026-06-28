import { printInvoice, type PrintInvoiceOptions } from './invoicePrintService';

/**
 * MVP: Uses the browser print dialog with "Save as PDF".
 * InvoiceDocumentView remains the single rendering source.
 */
export function exportInvoiceAsPdf(options?: PrintInvoiceOptions): void {
  printInvoice(options);
}
