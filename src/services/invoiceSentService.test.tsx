import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { InvoiceSentPanel } from '../components/invoice/InvoiceSentPanel';
import { createTestVorgang } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import {
  calculatePaymentSummary,
  isInvoiceOverdue,
} from './invoicePaymentService';
import { generateApprovedInvoicePdf } from './invoicePdfService';
import {
  markInvoiceAsSent,
  updateInvoiceSentDetails,
} from './invoiceSentService';
import { isExpectingPayment } from './brain/financeIntelligenceService';
import { hydrateVorgangStore, getVorgangInvoice } from './vorgangService';
import type { VorgangInvoice } from '../types/models';
import * as persistenceService from './persistenceService';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster GmbH',
  street: 'Hauptstraße 1',
  zip: '80331',
  city: 'München',
  iban: 'DE00 0000 0000 0000 0000 00',
};

function createPreparedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-sent-1',
    number: '2026-0500',
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
    paymentDueDate: '2026-06-10',
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

beforeEach(() => {
  resetTestStores();
  hydrateVorgangStore([createTestVorgang({ invoices: [createPreparedInvoice()] })]);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('INVOICE-PILOT-MARK-SENT-01 — service', () => {
  it('vorbereitet → versendet mit Datum und Versandweg', () => {
    const result = markInvoiceAsSent('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-05',
      sentVia: 'email',
      sentNote: 'per Outlook',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.status).toBe('versendet');
    expect(result.invoice.sentAt).toBe('2026-06-05');
    expect(result.invoice.sentVia).toBe('email');
    expect(result.invoice.sentNote).toBe('per Outlook');
    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.status).toBe('versendet');
  });

  it('Entwurf und fehlende Angaben werden abgelehnt; kein erneutes Markieren', () => {
    hydrateVorgangStore([
      createTestVorgang({
        invoices: [createPreparedInvoice({ status: 'entwurf', number: 'ENTWURF' })],
      }),
    ]);
    expect(
      markInvoiceAsSent('v-test-1', 'inv-sent-1', {
        sentAt: '2026-06-05',
        sentVia: 'post',
      }).ok,
    ).toBe(false);

    hydrateVorgangStore([createTestVorgang({ invoices: [createPreparedInvoice()] })]);
    expect(
      markInvoiceAsSent('v-test-1', 'inv-sent-1', {
        sentAt: '',
        sentVia: 'email',
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_date' });
    expect(
      markInvoiceAsSent('v-test-1', 'inv-sent-1', {
        sentAt: '2026-06-05',
        sentVia: 'fax' as never,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_via' });

    const first = markInvoiceAsSent('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-05',
      sentVia: 'portal',
    });
    expect(first.ok).toBe(true);
    expect(
      markInvoiceAsSent('v-test-1', 'inv-sent-1', {
        sentAt: '2026-06-06',
        sentVia: 'email',
      }),
    ).toMatchObject({ ok: false, reason: 'already_sent' });
  });

  it('Versandangaben können korrigiert werden ohne zweiten Versandstatuswechsel', () => {
    markInvoiceAsSent('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-05',
      sentVia: 'email',
    });
    const corrected = updateInvoiceSentDetails('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-04',
      sentVia: 'post',
      sentNote: 'Einschreiben',
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(corrected.invoice.status).toBe('versendet');
    expect(corrected.invoice.sentAt).toBe('2026-06-04');
    expect(corrected.invoice.sentVia).toBe('post');
    expect(corrected.invoice.sentNote).toBe('Einschreiben');
  });

  it('PDF-Download verändert den Versandstatus nicht', async () => {
    const invoice = getVorgangInvoice('v-test-1', 'inv-sent-1')!;
    const before = invoice.status;
    const pdf = await generateApprovedInvoicePdf(invoice);
    expect(pdf.ok).toBe(true);
    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.status).toBe(before);
    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.sentAt).toBeUndefined();
  });

  it('vorbereitete Rechnung ist nicht überfällig/mahnfähig; versendete nutzt Fälligkeitslogik', () => {
    const prepared = getVorgangInvoice('v-test-1', 'inv-sent-1')!;
    expect(isExpectingPayment(prepared)).toBe(false);
    expect(isInvoiceOverdue(prepared, '2026-06-20')).toBe(false);
    expect(calculatePaymentSummary(prepared, '2026-06-20').status).toBe('offen');

    markInvoiceAsSent('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-01',
      sentVia: 'email',
    });
    const sent = getVorgangInvoice('v-test-1', 'inv-sent-1')!;
    expect(isExpectingPayment(sent)).toBe(true);
    expect(isInvoiceOverdue(sent, '2026-06-20')).toBe(true);
    expect(calculatePaymentSummary(sent, '2026-06-20').status).toBe('ueberfaellig');
  });

  it('alte Rechnungen ohne Versandfelder bleiben kompatibel', () => {
    const legacy = createPreparedInvoice({
      status: 'versendet',
      // no sentAt / sentVia
    });
    delete legacy.sentAt;
    delete legacy.sentVia;
    delete legacy.sentNote;
    hydrateVorgangStore([createTestVorgang({ invoices: [legacy] })]);

    expect(isExpectingPayment(legacy)).toBe(true);
    expect(isInvoiceOverdue(legacy, '2026-06-20')).toBe(true);
    const corrected = updateInvoiceSentDetails('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-02',
      sentVia: 'persoenlich',
    });
    expect(corrected.ok).toBe(true);
  });
});

describe('INVOICE-PILOT-MARK-SENT-01 — UI', () => {
  it('kein Statuswechsel ohne Bestätigung; Anzeige und Korrektur funktionieren', async () => {
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let current = getVorgangInvoice('v-test-1', 'inv-sent-1')!;

    const renderPanel = async () => {
      await act(async () => {
        root.render(
          createElement(
            MemoryRouter,
            null,
            createElement(
              AppProvider,
              { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
              createElement(InvoiceSentPanel, {
                vorgangId: 'v-test-1',
                invoice: current,
                translate: (key: string) => key,
                onUpdated: (next) => {
                  current = next;
                },
              }),
            ),
          ),
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
    };

    await renderPanel();
    expect(container.querySelector('[data-testid="invoice-sent-mark"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="invoice-sent-confirm"]')).toBeNull();

    await act(async () => {
      (container.querySelector('[data-testid="invoice-sent-mark"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="invoice-sent-form"]')).not.toBeNull();
    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.status).toBe('vorbereitet');

    await act(async () => {
      (
        container.querySelector('[data-testid="invoice-sent-continue"]') as HTMLButtonElement
      ).click();
    });
    expect(container.querySelector('[data-testid="invoice-sent-confirm"]')).not.toBeNull();
    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.status).toBe('vorbereitet');

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="invoice-sent-confirm-submit"]',
        ) as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.status).toBe('versendet');
    expect(current.status).toBe('versendet');
    expect(current.sentVia).toBe('email');
    expect(current.sentAt).toBeTruthy();

    current = getVorgangInvoice('v-test-1', 'inv-sent-1')!;
    await renderPanel();
    expect(container.querySelector('[data-testid="invoice-sent-at"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="invoice-sent-correct"]')).not.toBeNull();

    await act(async () => {
      (
        container.querySelector('[data-testid="invoice-sent-correct"]') as HTMLButtonElement
      ).click();
    });
    const via = container.querySelector(
      '[data-testid="invoice-sent-via-input"]',
    ) as HTMLSelectElement;
    await act(async () => {
      via.value = 'post';
      via.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      (
        container.querySelector('[data-testid="invoice-sent-continue"]') as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="invoice-sent-confirm-submit"]',
        ) as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.sentVia).toBe('post');
    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.status).toBe('versendet');
    expect(persistSpy).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });
});
