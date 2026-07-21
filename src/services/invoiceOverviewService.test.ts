import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { createTestVorgang } from '../test/fixtures';
import {
  applyInvoiceOverviewFilters,
  filterInvoiceOverview,
  getAllInvoiceOverview,
  getOpenInvoices,
  getOverdueInvoices,
  getPaidInvoices,
  getPartialInvoices,
  searchInvoiceOverview,
  sortInvoiceOverviewItems,
  summarizeInvoiceOverview,
} from './invoiceOverviewService';
import { recordPayment } from './invoicePaymentService';
import { hydrateVorgangStore } from './vorgangService';
import type { VorgangInvoice } from '../types/models';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster GmbH',
};

function createFinalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-overview-1',
    number: '2026-0300',
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
    paymentDueDate: '2026-06-15',
    customerSnapshot: {
      name: 'Müller GmbH',
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
    baustelle: 'Baustelle Nord',
    vorgangTitle: 'Sanierung Müller',
    ...overrides,
  };
}

describe('invoiceOverviewService', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-1',
        title: 'Sanierung Müller',
        customer: 'Müller GmbH',
        baustelle: 'Baustelle Nord',
        invoices: [
          createFinalizedInvoice({
            id: 'inv-open',
            number: '2026-0301',
            paymentDueDate: '2099-06-15',
          }),
          createFinalizedInvoice({
            id: 'inv-overdue',
            number: '2026-0302',
            status: 'versendet',
            sentAt: '2026-01-01',
            sentVia: 'post',
            paymentDueDate: '2026-01-01',
          }),
          createFinalizedInvoice({
            id: 'inv-paid',
            number: '2026-0303',
            paymentDueDate: '2026-01-01',
            payments: [
              {
                id: 'pay-1',
                amount: 386.75,
                date: '2026-02-01',
                createdAt: '2026-02-01T10:00:00.000Z',
              },
            ],
            paymentStatus: 'bezahlt',
          }),
        ],
      }),
      createTestVorgang({
        id: 'v-2',
        title: 'Dach Schmidt',
        customer: 'Schmidt AG',
        baustelle: 'Dach Süd',
        invoices: [
          createFinalizedInvoice({
            id: 'inv-partial',
            number: '2026-0401',
            paymentDueDate: '2099-12-31',
            baustelle: 'Dach Süd',
            vorgangTitle: 'Dach Schmidt',
            customerSnapshot: {
              name: 'Schmidt AG',
              contactPerson: '',
              street: '',
              zip: '',
              city: '',
              email: '',
              phone: '',
            },
            payments: [
              {
                id: 'pay-2',
                amount: 100,
                date: '2026-03-01',
                createdAt: '2026-03-01T10:00:00.000Z',
              },
            ],
            paymentStatus: 'teilbezahlt',
          }),
          createFinalizedInvoice({
            id: 'inv-legacy',
            number: '2026-0402',
            status: 'versendet',
            paymentDueDate: '2099-12-31',
            baustelle: 'Dach Süd',
            vorgangTitle: 'Dach Schmidt',
            customerSnapshot: {
              name: 'Schmidt AG',
              contactPerson: '',
              street: '',
              zip: '',
              city: '',
              email: '',
              phone: '',
            },
          }),
        ],
      }),
    ]);
  });

  it('aggregates finalized invoices from all vorgänge', () => {
    const items = getAllInvoiceOverview('2026-06-27');
    expect(items).toHaveLength(5);
    expect(items.map((item) => item.invoice.number)).toContain('2026-0301');
    expect(items.map((item) => item.vorgangTitle)).toContain('Dach Schmidt');
  });

  it('excludes draft invoices', () => {
    hydrateVorgangStore([
      createTestVorgang({
        invoices: [
          createFinalizedInvoice({ id: 'inv-draft', status: 'entwurf' }),
          createFinalizedInvoice({ id: 'inv-final', status: 'vorbereitet' }),
        ],
      }),
    ]);
    expect(getAllInvoiceOverview()).toHaveLength(1);
  });

  it('returns filtered invoice groups', () => {
    const today = '2026-06-27';
    expect(getOpenInvoices(today)).toHaveLength(2);
    expect(getOverdueInvoices(today)).toHaveLength(1);
    expect(getPaidInvoices(today)).toHaveLength(1);
    expect(getPartialInvoices(today)).toHaveLength(1);
  });

  it('summarizes open, overdue and paid totals', () => {
    const totals = summarizeInvoiceOverview(getAllInvoiceOverview('2026-06-27'));
    expect(totals.totalInvoiceCount).toBe(5);
    expect(totals.openInvoiceCount).toBe(4);
    expect(totals.overdueInvoiceCount).toBe(1);
    expect(totals.paidTotal).toBeCloseTo(486.75, 2);
    expect(totals.openReceivables).toBeCloseTo(1447, 2);
    expect(totals.overdueReceivables).toBeCloseTo(386.75, 2);
  });

  it('sorts by payment status then oldest due date', () => {
    const items = getAllInvoiceOverview('2026-06-27');
    const statuses = items.map((item) => item.paymentSummary.status);
    expect(statuses[0]).toBe('ueberfaellig');
    expect(statuses.filter((s) => s === 'offen').length).toBeGreaterThan(0);

    const openItems = items.filter((item) => item.paymentSummary.status === 'offen');
    const dueDates = openItems.map((item) => item.invoice.paymentDueDate ?? '');
    expect(dueDates).toEqual([...dueDates].sort());
  });

  it('filters by payment status chip', () => {
    const all = getAllInvoiceOverview('2026-06-27');
    expect(filterInvoiceOverview(all, 'bezahlt')).toHaveLength(1);
    expect(filterInvoiceOverview(all, 'teilbezahlt')).toHaveLength(1);
    expect(filterInvoiceOverview(all, 'all')).toHaveLength(5);
  });

  it('searches by number, customer, vorgang and baustelle', () => {
    const all = getAllInvoiceOverview('2026-06-27');
    expect(searchInvoiceOverview(all, '2026-0401')).toHaveLength(1);
    expect(searchInvoiceOverview(all, 'schmidt')).toHaveLength(2);
    expect(searchInvoiceOverview(all, 'dach süd')).toHaveLength(2);
    expect(searchInvoiceOverview(all, 'müller')).toHaveLength(3);
  });

  it('applies filter and search together', () => {
    const all = getAllInvoiceOverview('2026-06-27');
    const openMüller = applyInvoiceOverviewFilters(all, 'offen', 'müller');
    expect(openMüller).toHaveLength(1);
    expect(openMüller.every((item) => item.paymentSummary.status === 'offen')).toBe(true);

    const overdueMüller = applyInvoiceOverviewFilters(all, 'ueberfaellig', 'müller');
    expect(overdueMüller).toHaveLength(1);
  });

  it('handles legacy invoices without payments as open', () => {
    const legacy = getAllInvoiceOverview('2026-06-27').find(
      (item) => item.invoice.id === 'inv-legacy',
    );
    expect(legacy?.paymentSummary.status).toBe('offen');
    expect(legacy?.paymentSummary.openAmount).toBe(386.75);
    expect(legacy?.paymentSummary.paidAmount).toBe(0);
  });

  it('updates overview after recording payment', () => {
    recordPayment('v-1', 'inv-overdue', {
      amount: 386.75,
      date: '2026-06-27',
    });
    const totals = summarizeInvoiceOverview(getAllInvoiceOverview('2026-06-27'));
    expect(totals.overdueInvoiceCount).toBe(0);
    expect(totals.openInvoiceCount).toBe(3);
  });

  it('sorts items with explicit helper', () => {
    const items = getAllInvoiceOverview('2026-06-27');
    const reversed = sortInvoiceOverviewItems([...items].reverse());
    expect(reversed.map((item) => item.paymentSummary.status)).toEqual(
      items.map((item) => item.paymentSummary.status),
    );
  });
});
