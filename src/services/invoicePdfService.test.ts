import { describe, expect, it, vi } from 'vitest';
import { exportInvoiceAsPdf } from './invoicePdfService';
import * as invoicePrintService from './invoicePrintService';

describe('exportInvoiceAsPdf', () => {
  it('delegates to printInvoice for browser Save as PDF flow', () => {
    const printMock = vi.spyOn(invoicePrintService, 'printInvoice').mockImplementation(() => {});

    exportInvoiceAsPdf({ title: '2026-0002 – Schlussrechnung' });

    expect(printMock).toHaveBeenCalledWith({ title: '2026-0002 – Schlussrechnung' });
  });
});
