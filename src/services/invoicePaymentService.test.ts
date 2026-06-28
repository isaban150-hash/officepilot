import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { createTestVorgang } from '../test/fixtures';
import {
  calculatePaymentSummary,
  getInvoicePayments,
  getOpenAmount,
  getPaidAmount,
  isInvoiceOverdue,
  normalizeInvoicePaymentFields,
  recordPayment,
  removePayment,
  resolvePaymentStatus,
} from './invoicePaymentService';
import {
  loadPersistedState,
  persistAll,
  STORAGE_KEY,
} from './persistenceService';
import { hydrateVorgangStore, getVorgangById } from './vorgangService';
import type { VorgangInvoice } from '../types/models';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster GmbH',
  street: 'Hauptstraße 1',
  zip: '80331',
  city: 'München',
};

function createFinalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-pay-1',
    number: '2026-0100',
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
    servicePeriodFrom: '2026-05-01',
    servicePeriodTo: '2026-05-31',
    paymentDueDate: '2099-06-15',
    paymentTermsText: 'Zahlbar in 14 Tagen',
    skontoText: '',
    customerSnapshot: {
      name: 'Test Kunde',
      contactPerson: 'Frau Test',
      street: 'Kundenweg 2',
      zip: '80333',
      city: 'München',
      email: '',
      phone: '',
    },
    companySnapshot,
    legalNotices: [],
    previousAbschlagDeductions: [],
    introText: 'Einleitung',
    closingText: 'Schluss',
    baustelle: 'Teststraße 1',
    vorgangTitle: 'Testvorgang',
    ...overrides,
  };
}

describe('calculatePaymentSummary', () => {
  it('treats invoice without payments as offen', () => {
    const invoice = createFinalizedInvoice();
    const summary = calculatePaymentSummary(invoice, '2026-06-10');

    expect(summary.totalDue).toBe(386.75);
    expect(summary.paidAmount).toBe(0);
    expect(summary.openAmount).toBe(386.75);
    expect(summary.overpaidAmount).toBe(0);
    expect(summary.status).toBe('offen');
  });

  it('detects teilbezahlt after partial payment', () => {
    const invoice = createFinalizedInvoice({
      payments: [
        {
          id: 'pay-1',
          date: '2026-06-05',
          amount: 100,
          createdAt: '2026-06-05T10:00:00.000Z',
        },
      ],
    });

    const summary = calculatePaymentSummary(invoice, '2026-06-10');
    expect(summary.status).toBe('teilbezahlt');
    expect(summary.openAmount).toBeCloseTo(286.75, 2);
  });

  it('detects bezahlt after full payment', () => {
    const invoice = createFinalizedInvoice({
      payments: [
        {
          id: 'pay-1',
          date: '2026-06-05',
          amount: 386.75,
          createdAt: '2026-06-05T10:00:00.000Z',
        },
      ],
    });

    const summary = calculatePaymentSummary(invoice, '2026-06-10');
    expect(summary.status).toBe('bezahlt');
    expect(summary.openAmount).toBe(0);
    expect(summary.overpaidAmount).toBe(0);
  });

  it('detects overpaidAmount on overpayment while status stays bezahlt', () => {
    const invoice = createFinalizedInvoice({
      payments: [
        {
          id: 'pay-1',
          date: '2026-06-05',
          amount: 400,
          createdAt: '2026-06-05T10:00:00.000Z',
        },
      ],
    });

    const summary = calculatePaymentSummary(invoice, '2026-06-10');
    expect(summary.status).toBe('bezahlt');
    expect(summary.openAmount).toBe(0);
    expect(summary.overpaidAmount).toBeCloseTo(13.25, 2);
  });

  it('marks invoice as ueberfaellig when due date passed and open amount remains', () => {
    const invoice = createFinalizedInvoice({ paymentDueDate: '2026-06-10' });
    const summary = calculatePaymentSummary(invoice, '2026-06-11');

    expect(summary.status).toBe('ueberfaellig');
    expect(isInvoiceOverdue(invoice, '2026-06-11')).toBe(true);
  });

  it('is not overdue before paymentDueDate', () => {
    const invoice = createFinalizedInvoice({ paymentDueDate: '2026-06-15' });
    expect(calculatePaymentSummary(invoice, '2026-06-15').status).toBe('offen');
    expect(isInvoiceOverdue(invoice, '2026-06-15')).toBe(false);
  });

  it('keeps stornierte Rechnung storniert', () => {
    const invoice = createFinalizedInvoice({
      paymentStatus: 'storniert',
      cancelledAt: '2026-06-01T12:00:00.000Z',
      cancelReason: 'Kundenreklamation',
      payments: [
        {
          id: 'pay-old',
          date: '2026-05-30',
          amount: 50,
          createdAt: '2026-05-30T10:00:00.000Z',
        },
      ],
    });

    expect(resolvePaymentStatus(invoice, '2026-06-20')).toBe('storniert');
    expect(calculatePaymentSummary(invoice, '2026-06-20').status).toBe('storniert');
  });

  it('does not crash for legacy invoices without payments array', () => {
    const invoice = createFinalizedInvoice();
    delete invoice.payments;
    delete invoice.paymentStatus;

    const summary = calculatePaymentSummary(invoice, '2099-01-01');
    expect(summary.status).toBe('offen');
    expect(getInvoicePayments(invoice)).toEqual([]);
    expect(getPaidAmount(invoice)).toBe(0);
    expect(getOpenAmount(invoice)).toBe(386.75);
    expect(normalizeInvoicePaymentFields(invoice).paymentStatus).toBe('offen');
  });
});

describe('recordPayment / removePayment', () => {
  beforeEach(() => {
    localStorage.clear();
    const vorgang = createTestVorgang({ invoices: [createFinalizedInvoice()] });
    hydrateVorgangStore([vorgang]);
  });

  it('adds payment via recordPayment', () => {
    const result = recordPayment('v-test-1', 'inv-pay-1', {
      date: '2026-06-08',
      amount: 150,
      reference: 'RE 2026-0100',
      note: 'Teilzahlung',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.invoice.payments).toHaveLength(1);
    expect(result.invoice.paymentStatus).toBe('teilbezahlt');
    expect(getPaidAmount(result.invoice)).toBe(150);
  });

  it('rejects payment on cancelled invoice', () => {
    const vorgang = createTestVorgang({
      invoices: [
        createFinalizedInvoice({
          paymentStatus: 'storniert',
          cancelledAt: '2026-06-01T12:00:00.000Z',
        }),
      ],
    });
    hydrateVorgangStore([vorgang]);

    const result = recordPayment('v-test-1', 'inv-pay-1', {
      date: '2026-06-08',
      amount: 100,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('payment.invoiceCancelled');
  });

  it('rejects invalid payment amount', () => {
    const result = recordPayment('v-test-1', 'inv-pay-1', {
      date: '2026-06-08',
      amount: 0,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('payment.amountInvalid');
  });

  it('removePayment deletes payment and recalculates status', () => {
    recordPayment('v-test-1', 'inv-pay-1', { date: '2026-06-08', amount: 386.75 });
    const invoice = getVorgangById('v-test-1')!.invoices[0];
    const paymentId = invoice.payments![0].id;

    const removed = removePayment('v-test-1', 'inv-pay-1', paymentId);
    expect(removed.success).toBe(true);
    if (!removed.success) return;

    expect(removed.invoice.payments).toHaveLength(0);
    expect(removed.invoice.paymentStatus).toBe('offen');
  });

  it('does not mutate invoice snapshots when recording payment', () => {
    const before = getVorgangById('v-test-1')!.invoices[0];
    const snapshotBefore = JSON.stringify(before.customerSnapshot);
    const positionsBefore = JSON.stringify(before.positions);
    const amountBefore = before.amount;

    recordPayment('v-test-1', 'inv-pay-1', { date: '2026-06-08', amount: 100 });

    const after = getVorgangById('v-test-1')!.invoices[0];
    expect(JSON.stringify(after.customerSnapshot)).toBe(snapshotBefore);
    expect(JSON.stringify(after.positions)).toBe(positionsBefore);
    expect(after.amount).toBe(amountBefore);
    expect(after.subtotal).toBe(before.subtotal);
  });

  it('persists payments across persistAll/loadPersistedState', () => {
    recordPayment('v-test-1', 'inv-pay-1', {
      date: '2026-06-08',
      amount: 200,
      reference: 'Überweisung',
    });

    persistAll();
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();

    const parsed = JSON.parse(raw!);
    expect(parsed.vorgaenge[0].invoices[0].payments).toHaveLength(1);
    expect(parsed.vorgaenge[0].invoices[0].paymentStatus).toBe('teilbezahlt');

    localStorage.setItem(STORAGE_KEY, raw!);
    const reloaded = loadPersistedState();
    expect(reloaded?.vorgaenge[0].invoices[0].payments).toHaveLength(1);
    expect(reloaded?.vorgaenge[0].invoices[0].payments![0].amount).toBe(200);
  });
});
