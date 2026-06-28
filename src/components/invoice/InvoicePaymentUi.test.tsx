import { describe, expect, it, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createTestVorgang } from '../../test/fixtures';
import { getPaymentBadgeClass, InvoicePaymentBadge } from './InvoicePaymentBadge';
import { InvoicePaymentSummary } from './InvoicePaymentSummary';
import { InvoicePaymentHistory } from './InvoicePaymentHistory';
import { willPaymentOverpay } from './InvoicePaymentForm';
import { InvoiceListCard } from './InvoiceListCard';
import {
  calculatePaymentSummary,
  recordPayment,
  removePayment,
} from '../../services/invoicePaymentService';
import { hydrateVorgangStore, getVorgangById } from '../../services/vorgangService';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster GmbH',
};

function translate(key: TranslationKey): string {
  return key;
}

function createFinalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-ui-1',
    number: '2026-0200',
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
    paymentDueDate: '2099-06-15',
    customerSnapshot: {
      name: 'Test Kunde',
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
    ...overrides,
  };
}

describe('InvoicePaymentBadge', () => {
  it('renders status labels with tone classes', () => {
    const html = renderToStaticMarkup(
      <InvoicePaymentBadge status="teilbezahlt" translate={translate} />,
    );
    expect(html).toContain('payment.status.teilbezahlt');
    expect(html).toContain(getPaymentBadgeClass('teilbezahlt'));
  });
});

describe('InvoicePaymentSummary', () => {
  it('shows paid, open and overpaid amounts', () => {
    const invoice = createFinalizedInvoice({
      payments: [
        {
          id: 'pay-1',
          date: '2026-06-05',
          amount: 400,
          createdAt: '2026-06-05T10:00:00.000Z',
        },
      ],
      paymentStatus: 'bezahlt',
    });

    const html = renderToStaticMarkup(
      <InvoicePaymentSummary invoice={invoice} translate={translate} />,
    );

    expect(html).toContain('payment.totalDue');
    expect(html).toContain('payment.paidAmount');
    expect(html).toContain('payment.openAmount');
    expect(html).toContain('payment.overpaidAmount');
    expect(html).toContain('payment.status.bezahlt');
  });

  it('shows overdue notice for overdue invoices', () => {
    const invoice = createFinalizedInvoice({
      paymentDueDate: '2020-01-01',
    });

    const html = renderToStaticMarkup(
      <InvoicePaymentSummary invoice={invoice} translate={translate} />,
    );

    expect(html).toContain('payment.invoiceOverdueNotice');
    expect(calculatePaymentSummary(invoice, '2026-06-27').status).toBe('ueberfaellig');
  });
});

describe('InvoicePaymentHistory', () => {
  it('renders chronological payment entries', () => {
    const invoice = createFinalizedInvoice({
      payments: [
        {
          id: 'pay-1',
          date: '2026-06-01',
          amount: 100,
          reference: 'RE 2026-0200',
          note: 'Anzahlung',
          createdAt: '2026-06-01T10:00:00.000Z',
        },
        {
          id: 'pay-2',
          date: '2026-06-10',
          amount: 50,
          createdAt: '2026-06-10T10:00:00.000Z',
        },
      ],
    });

    const html = renderToStaticMarkup(
      <InvoicePaymentHistory invoice={invoice} translate={translate} allowRemove={false} />,
    );

    expect(html).toContain('RE 2026-0200');
    expect(html).toContain('Anzahlung');
    expect(html).toContain('100,00');
    expect(html).toContain('50,00');
  });
});

describe('InvoicePaymentForm helpers', () => {
  it('detects overpayment', () => {
    expect(willPaymentOverpay(200, 250)).toBe(true);
    expect(willPaymentOverpay(200, 200)).toBe(false);
  });
});

describe('InvoiceListCard', () => {
  it('separates workflow and payment status in markup', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InvoiceListCard
          vorgangId="v-test-1"
          invoice={createFinalizedInvoice()}
          translate={translate}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('payment.workflowStatus');
    expect(html).toContain('payment.paymentStatus');
    expect(html).toContain('payment.recordShort');
    expect(html).toContain('invoice.status.vorbereitet');
  });
});

describe('payment UI integration', () => {
  beforeEach(() => {
    hydrateVorgangStore([createTestVorgang({ invoices: [createFinalizedInvoice()] })]);
  });

  it('updates status after partial and full payment', () => {
    const partial = recordPayment('v-test-1', 'inv-ui-1', {
      date: '2026-06-08',
      amount: 100,
    });
    expect(partial.success).toBe(true);
    if (!partial.success) return;
    expect(partial.invoice.paymentStatus).toBe('teilbezahlt');

    const full = recordPayment('v-test-1', 'inv-ui-1', {
      date: '2026-06-09',
      amount: 286.75,
    });
    expect(full.success).toBe(true);
    if (!full.success) return;
    expect(full.invoice.paymentStatus).toBe('bezahlt');
    expect(calculatePaymentSummary(full.invoice).openAmount).toBe(0);
  });

  it('supports overpayment and payment removal with status change', () => {
    recordPayment('v-test-1', 'inv-ui-1', { date: '2026-06-08', amount: 400 });
    let invoice = getVorgangById('v-test-1')!.invoices.find((item) => item.id === 'inv-ui-1')!;
    expect(calculatePaymentSummary(invoice).overpaidAmount).toBeGreaterThan(0);

    const paymentId = invoice.payments![0].id;
    const removed = removePayment('v-test-1', 'inv-ui-1', paymentId);
    expect(removed.success).toBe(true);
    if (!removed.success) return;

    invoice = removed.invoice;
    expect(invoice.paymentStatus).toBe('offen');
    expect(invoice.payments).toHaveLength(0);
    expect(invoice.customerSnapshot?.name).toBe('Test Kunde');
  });
});
