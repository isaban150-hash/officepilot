import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  INVOICE_PRINT_BODY_CLASS,
  clearInvoicePrintState,
  printInvoice,
} from './invoicePrintService';

describe('printInvoice', () => {
  beforeEach(() => {
    document.body.className = '';
    document.title = 'OfficePilot Test';
  });

  afterEach(() => {
    clearInvoicePrintState();
    vi.restoreAllMocks();
  });

  it('adds print body class and calls window.print', () => {
    const printMock = vi.spyOn(window, 'print').mockImplementation(() => {});

    printInvoice({ title: '2026-0001 – Abschlagsrechnung 1' });

    expect(document.body.classList.contains(INVOICE_PRINT_BODY_CLASS)).toBe(true);
    expect(document.title).toBe('2026-0001 – Abschlagsrechnung 1');
    expect(printMock).toHaveBeenCalledTimes(1);
  });

  it('cleans up after afterprint event', () => {
    vi.spyOn(window, 'print').mockImplementation(() => {
      window.dispatchEvent(new Event('afterprint'));
    });

    printInvoice({ title: 'Test' });

    expect(document.body.classList.contains(INVOICE_PRINT_BODY_CLASS)).toBe(false);
    expect(document.title).toBe('OfficePilot Test');
  });
});

describe('clearInvoicePrintState', () => {
  it('removes print body class', () => {
    document.body.classList.add(INVOICE_PRINT_BODY_CLASS);
    clearInvoicePrintState();
    expect(document.body.classList.contains(INVOICE_PRINT_BODY_CLASS)).toBe(false);
  });
});

describe('print CSS integration', () => {
  it('uses stable body class name for @media print rules in index.css', () => {
    expect(INVOICE_PRINT_BODY_CLASS).toBe('invoice-print-active');
  });
});
