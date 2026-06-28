export const INVOICE_PRINT_BODY_CLASS = 'invoice-print-active';

export interface PrintInvoiceOptions {
  title?: string;
}

export function printInvoice(options?: PrintInvoiceOptions): void {
  if (typeof window === 'undefined' || typeof window.print !== 'function') {
    return;
  }

  document.body.classList.add(INVOICE_PRINT_BODY_CLASS);
  const previousTitle = document.title;

  if (options?.title) {
    document.title = options.title;
  }

  const cleanup = () => {
    document.body.classList.remove(INVOICE_PRINT_BODY_CLASS);
    document.title = previousTitle;
    window.removeEventListener('afterprint', cleanup);
  };

  window.addEventListener('afterprint', cleanup);
  window.print();
}

export function clearInvoicePrintState(): void {
  document.body.classList.remove(INVOICE_PRINT_BODY_CLASS);
}
