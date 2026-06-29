import { beforeEach, describe, expect, it } from 'vitest';
import { hydrateExpenseStore } from './expenseStore';
import {
  applyExpenseOverviewFilters,
  getAllExpenseOverview,
  getOpenExpenses,
  getOverdueExpenses,
  summarizeExpenseOverview,
} from './expenseOverviewService';
import type { Expense } from '../types/expense';

function createTestExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: overrides.id ?? `exp-ov-${Math.random()}`,
    status: 'gebucht',
    category: 'material',
    supplierName: 'Lieferant GmbH',
    invoiceNumber: 'RE-100',
    title: 'Test Ausgabe',
    description: '',
    issueDate: '2026-06-01',
    paymentDueDate: '2099-06-15',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    currency: 'EUR',
    paymentStatus: 'offen',
    payments: [],
    positions: [],
    allocations: [],
    isCreditNote: false,
    dedupeKey: 'test',
    tags: [],
    digitalFolder: { id: 'dig-1', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'folder-1', register: 'A', label: 'Test' },
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('expenseOverviewService', () => {
  beforeEach(() => {
    hydrateExpenseStore([
      createTestExpense({ id: 'exp-open', title: 'Offene Rechnung', paymentStatus: 'offen' }),
      createTestExpense({
        id: 'exp-overdue',
        title: 'Überfällige Rechnung',
        paymentDueDate: '2020-01-01',
        paymentStatus: 'offen',
      }),
      createTestExpense({
        id: 'exp-paid',
        title: 'Bezahlte Rechnung',
        paymentStatus: 'bezahlt',
        payments: [
          {
            id: 'pay-1',
            date: '2026-06-01',
            amount: 119,
            createdAt: '2026-06-01T10:00:00.000Z',
          },
        ],
      }),
      createTestExpense({ id: 'exp-draft', status: 'entwurf', title: 'Entwurf' }),
    ]);
  });

  it('includes only gebuchte Ausgaben in overview', () => {
    const items = getAllExpenseOverview('2026-06-27');
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.expense.status === 'gebucht')).toBe(true);
  });

  it('lists open expenses', () => {
    const open = getOpenExpenses('2026-06-10');
    expect(open.some((item) => item.expense.id === 'exp-open')).toBe(true);
  });

  it('lists overdue expenses', () => {
    const overdue = getOverdueExpenses('2026-06-27');
    expect(overdue.some((item) => item.expense.id === 'exp-overdue')).toBe(true);
  });

  it('summarizes open liabilities', () => {
    const totals = summarizeExpenseOverview(getAllExpenseOverview('2026-06-27'));
    expect(totals.openExpenseCount).toBeGreaterThan(0);
    expect(totals.openLiabilities).toBeGreaterThan(0);
    expect(totals.paidTotal).toBeGreaterThan(0);
  });

  it('filters and searches overview items', () => {
    const items = getAllExpenseOverview('2026-06-27');
    const filtered = applyExpenseOverviewFilters(items, 'bezahlt', '');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].expense.id).toBe('exp-paid');

    const searched = applyExpenseOverviewFilters(items, 'all', 'überfällige');
    expect(searched).toHaveLength(1);
    expect(searched[0].expense.id).toBe('exp-overdue');
  });
});
