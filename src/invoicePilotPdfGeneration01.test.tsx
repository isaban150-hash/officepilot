import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { InvoicePrintActions } from './components/invoice/InvoicePrintActions';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { buildInvoicePrintModelFromInvoice } from './services/invoicePrintModel';
import type { VorgangInvoice } from './types/models';
import * as invoicePdfService from './services/invoicePdfService';
import * as invoicePrintService from './services/invoicePrintService';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster Handwerk GmbH',
  street: 'Werkstraße 12',
  zip: '80331',
  city: 'München',
  iban: 'DE89 3704 0044 0532 0130 00',
};

function createFinalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-ui-pdf-1',
    number: '2026-0100',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Leistung',
        quantity: 2,
        unit: 'Stunden',
        unitPrice: 50,
        lineTotal: 100,
      },
    ],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'vorbereitet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    servicePeriodFrom: '2026-05-01',
    servicePeriodTo: '2026-05-31',
    paymentDueDate: '2026-06-15',
    paymentTermsText: '14 Tage',
    skontoText: '',
    customerSnapshot: {
      name: 'Kunde Test',
      contactPerson: '',
      street: 'Weg 1',
      zip: '80333',
      city: 'München',
      email: '',
      phone: '',
    },
    companySnapshot,
    legalNotices: [],
    previousAbschlagDeductions: [],
    introText: '',
    closingText: '',
    baustelle: 'Weg 1',
    vorgangTitle: 'Test',
    paymentStatus: 'offen',
    payments: [],
    ...overrides,
  };
}

/**
 * PDF-TEXT-RENDERING-01B — zwei Microtasks reichen nicht mehr.
 *
 * Seit die PDF-Erzeugung ihre Unicode-Schriften lädt, liegt zwischen Klick und
 * Download mindestens ein Makrotask. Gewartet wird deshalb über mehrere Runden
 * der Ereignisschleife statt über eine feste Zahl aufgelöster Promises. Die
 * Zusicherungen des Tests bleiben unverändert.
 */
async function flushUi(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('INVOICE-PILOT-PDF-GENERATION-01 — UI', () => {
  it('Download nur nach Klick; Freigabe-Vorschau-Aktionen bleiben; Status unverändert', async () => {
    const invoice = createFinalizedInvoice();
    const model = buildInvoicePrintModelFromInvoice(invoice);
    const generateSpy = vi.spyOn(invoicePdfService, 'generateApprovedInvoicePdf');
    const downloadSpy = vi
      .spyOn(invoicePdfService, 'downloadInvoicePdfBytes')
      .mockReturnValue({ objectUrl: 'blob:test', revoke: vi.fn() });
    const printSpy = vi.spyOn(invoicePrintService, 'printInvoice').mockImplementation(() => {});

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(
            AppProvider,
            { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
            createElement(InvoicePrintActions, {
              invoice,
              model,
              translate: (key: string) => key,
              layout: 'stack',
            }),
          ),
        ),
      );
    });
    await flushUi();

    expect(generateSpy).not.toHaveBeenCalled();
    expect(downloadSpy).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="invoice-download-pdf"]')?.textContent).toContain(
      'invoice.downloadPdf',
    );
    expect(container.querySelector('[data-testid="invoice-print"]')).not.toBeNull();

    await act(async () => {
      (
        container.querySelector('[data-testid="invoice-download-pdf"]') as HTMLButtonElement
      ).click();
    });
    await flushUi();

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(downloadSpy).toHaveBeenCalledTimes(1);
    expect(printSpy).not.toHaveBeenCalled();
    expect(invoice.status).toBe('vorbereitet');

    await act(async () => {
      (container.querySelector('[data-testid="invoice-print"]') as HTMLButtonElement).click();
    });
    expect(printSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });
});
