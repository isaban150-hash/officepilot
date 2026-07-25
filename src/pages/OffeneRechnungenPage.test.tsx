import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { AppProvider } from '../context/AppContext';
import { OffeneRechnungenPage } from '../pages/OffeneRechnungenPage';
import { InvoiceOverviewCard } from '../components/invoice/InvoiceOverviewCard';
import { createTestVorgang, testSetup } from '../test/fixtures';
import { getAllInvoiceOverview } from '../services/invoiceOverviewService';
import { hydrateVorgangStore } from '../services/vorgangService';
import type { VorgangInvoice } from '../types/models';
import type { TranslationKey } from '../i18n';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster GmbH',
};

function translate(key: TranslationKey): string {
  return key;
}

function createFinalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-page-1',
    number: '2026-0500',
    type: 'abschlag',
    abschlagNumber: 1,
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-test-1',
        description: 'Testleistung',
        quantity: 5,
        unit: 'Stunden',
        unitPrice: 65,
        lineTotal: 325,
      },
    ],
    subtotal: 325,
    taxStatus: 'standard_19',
    amount: 386.75,
    status: 'vorbereitet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    paymentDueDate: '2026-01-01',
    customerSnapshot: {
      name: 'Seiten Kunde',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    },
    companySnapshot,
    legalNotices: [],
    previousAbschlagDeductions: [],
    baustelle: 'Seiten Baustelle',
    vorgangTitle: 'Seiten Vorgang',
    archiveDocumentId: 'doc-archive-1',
    ...overrides,
  };
}

function renderPage() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/rechnungen/offen']}>
      <AppProvider initialSetup={testSetup}>
        <OffeneRechnungenPage />
      </AppProvider>
    </MemoryRouter>,
  );
}

describe('OffeneRechnungenPage', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-page',
        title: 'Seiten Vorgang',
        customer: 'Seiten Kunde',
        baustelle: 'Seiten Baustelle',
        invoices: [
          createFinalizedInvoice({ id: 'inv-overdue-page', status: 'versendet' }),
          createFinalizedInvoice({
            id: 'inv-paid-page',
            number: '2026-0501',
            paymentDueDate: '2099-12-31',
            payments: [
              {
                id: 'pay-page',
                amount: 386.75,
                date: '2026-06-01',
                createdAt: '2026-06-01T10:00:00.000Z',
              },
            ],
            paymentStatus: 'bezahlt',
          }),
        ],
      }),
    ]);
  });

  it('renders KPI cards and totals', () => {
    const html = renderPage();
    expect(html).toContain('Offene Rechnungen');
    expect(html).toContain('Offene Forderungen');
    expect(html).toContain('Überfällige Forderungen');
    expect(html).toContain('Bereits bezahlt');
    expect(html).toContain('Anzahl offener Rechnungen');
    expect(html).toContain('Gesamtzahl Rechnungen');
  });

  it('shows overdue warning when invoices are overdue', () => {
    const html = renderPage();
    expect(html).toContain('Rechnungen sind überfällig');
  });

  it('renders filter chips and search field', () => {
    const html = renderPage();
    expect(html).toContain('Alle');
    expect(html).toContain('Teilbezahlt');
    expect(html).toContain('Überfällig');
    expect(html).toContain('Storniert');
    expect(html).toContain('Rechnungsnummer, Kunde, Vorgang oder Baustelle');
  });

  it('links back to vorgänge', () => {
    const html = renderPage();
    expect(html).toContain('href="/vorgaenge"');
    expect(html).toContain('Zurück zu Vorgängen');
  });
});

describe('InvoiceOverviewCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-card',
        title: 'Karten Vorgang',
        customer: 'Karten Kunde',
        baustelle: 'Karten Baustelle',
        invoices: [createFinalizedInvoice({ id: 'inv-card' })],
      }),
    ]);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
  });

  it('renders invoice details and navigation targets', () => {
    const item = getAllInvoiceOverview('2026-06-27')[0];
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InvoiceOverviewCard item={item} translate={translate} />
      </MemoryRouter>,
    );

    expect(html).toContain('2026-0500');
    expect(html).toContain('Seiten Kunde');
    expect(html).toContain('href="/vorgaenge/v-card"');
    expect(html).toContain('payment.totalDue');
    expect(html).toContain('payment.openAmount');
    expect(html).toContain('invoice.open');
    expect(html).toContain('payment.recordShort');
    expect(html).toContain('invoice.moreActions');
    expect(html).not.toContain('invoice.savePdf');
    expect(html).not.toContain('invoice.print');
    expect(html).toContain('href="/dokumente/doc-archive-1"');
    expect(html).toContain('overview.archive');
  });

  it('zeigt Öffnen als Primary, Zahlung sichtbar und Druck/PDF im Dropdown', () => {
    const item = getAllInvoiceOverview('2026-06-27')[0];
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(InvoiceOverviewCard, {
            item,
            translate,
          }),
        ),
      );
    });

    const actions = container.querySelector('[data-testid="invoice-overview-card-actions"]');
    expect(actions).not.toBeNull();

    const openButton = container.querySelector(
      '[data-testid="invoice-overview-card-open"]',
    ) as HTMLButtonElement;
    expect(openButton).not.toBeNull();
    expect(openButton.className).toContain('btn--primary');
    expect(openButton.textContent).toContain('invoice.open');

    const paymentButton = container.querySelector(
      '[data-testid="invoice-overview-card-payment"]',
    ) as HTMLButtonElement;
    expect(paymentButton).not.toBeNull();
    expect(paymentButton.className).toContain('btn--outline');
    expect(paymentButton.textContent).toContain('payment.recordShort');

    expect(actions!.querySelector('[data-testid="invoice-overview-card-print"]')).toBeNull();
    expect(actions!.querySelector('[data-testid="invoice-overview-card-pdf"]')).toBeNull();

    act(() => {
      (
        container.querySelector(
          '[data-testid="invoice-overview-card-more-trigger"]',
        ) as HTMLButtonElement
      ).click();
    });

    const printItem = container.querySelector('[data-testid="invoice-overview-card-print"]');
    const pdfItem = container.querySelector('[data-testid="invoice-overview-card-pdf"]');
    expect(printItem).not.toBeNull();
    expect(pdfItem).not.toBeNull();
    expect(printItem!.textContent).toContain('invoice.print');
    expect(pdfItem!.textContent).toContain('invoice.savePdf');
  });
});
