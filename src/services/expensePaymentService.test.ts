import { beforeEach, describe, expect, it } from 'vitest';
import { hydrateExpenseStore } from './expenseStore';
import {
  calculateExpensePaymentSummary,
  getExpenseOpenAmount,
  getExpensePaidAmount,
  isExpenseOverdue,
  recordExpensePayment,
  removeExpensePayment,
  resolveExpensePaymentStatus,
} from './expensePaymentService';
import { STORAGE_KEY, persistAll } from './persistenceService';
import type { Expense } from '../types/expense';

function createTestExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-pay-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Lieferant GmbH',
    invoiceNumber: 'RE-900',
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
    dedupeKey: 'lieferant gmbh|re-900',
    tags: [],
    digitalFolder: { id: 'dig-1', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'folder-1', register: 'A', label: 'Test' },
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('calculateExpensePaymentSummary', () => {
  it('treats expense without payments as offen', () => {
    const expense = createTestExpense();
    const summary = calculateExpensePaymentSummary(expense, '2026-06-10');

    expect(summary.totalDue).toBe(119);
    expect(summary.paidAmount).toBe(0);
    expect(summary.openAmount).toBe(119);
    expect(summary.overpaidAmount).toBe(0);
    expect(summary.status).toBe('offen');
  });

  it('detects teilbezahlt after partial payment', () => {
    const expense = createTestExpense({
      payments: [
        {
          id: 'pay-1',
          date: '2026-06-05',
          amount: 50,
          createdAt: '2026-06-05T10:00:00.000Z',
        },
      ],
    });

    const summary = calculateExpensePaymentSummary(expense, '2026-06-10');
    expect(summary.status).toBe('teilbezahlt');
    expect(summary.openAmount).toBe(69);
  });

  it('detects bezahlt after full payment', () => {
    const expense = createTestExpense({
      payments: [
        {
          id: 'pay-1',
          date: '2026-06-05',
          amount: 119,
          createdAt: '2026-06-05T10:00:00.000Z',
        },
      ],
    });

    const summary = calculateExpensePaymentSummary(expense, '2026-06-10');
    expect(summary.status).toBe('bezahlt');
    expect(summary.openAmount).toBe(0);
  });

  it('detects overpaidAmount on overpayment while status stays bezahlt', () => {
    const expense = createTestExpense({
      payments: [
        {
          id: 'pay-1',
          date: '2026-06-05',
          amount: 130,
          createdAt: '2026-06-05T10:00:00.000Z',
        },
      ],
    });

    const summary = calculateExpensePaymentSummary(expense, '2026-06-10');
    expect(summary.status).toBe('bezahlt');
    expect(summary.overpaidAmount).toBe(11);
  });

  it('marks expense as ueberfaellig when due date passed', () => {
    const expense = createTestExpense({ paymentDueDate: '2026-06-10' });
    const summary = calculateExpensePaymentSummary(expense, '2026-06-11');

    expect(summary.status).toBe('ueberfaellig');
    expect(isExpenseOverdue(expense, '2026-06-11')).toBe(true);
  });

  it('is not overdue before paymentDueDate', () => {
    const expense = createTestExpense({ paymentDueDate: '2026-06-15' });
    expect(calculateExpensePaymentSummary(expense, '2026-06-15').status).toBe('offen');
    expect(isExpenseOverdue(expense, '2026-06-15')).toBe(false);
  });

  it('keeps stornierte Ausgabe storniert', () => {
    const expense = createTestExpense({
      status: 'storniert',
      paymentStatus: 'storniert',
      cancelledAt: '2026-06-01T12:00:00.000Z',
      payments: [
        {
          id: 'pay-old',
          date: '2026-05-30',
          amount: 50,
          createdAt: '2026-05-30T10:00:00.000Z',
        },
      ],
    });

    expect(resolveExpensePaymentStatus(expense, '2026-06-20')).toBe('storniert');
  });
});

describe('recordExpensePayment', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateExpenseStore([createTestExpense()]);
  });

  it('adds payment and updates status', () => {
    const result = recordExpensePayment('exp-pay-1', {
      date: '2026-06-08',
      amount: 50,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.expense.paymentStatus).toBe('teilbezahlt');
    expect(getExpensePaidAmount(result.expense)).toBe(50);
    expect(getExpenseOpenAmount(result.expense)).toBe(69);
  });

  it('persists payments to localStorage', () => {
    recordExpensePayment('exp-pay-1', { date: '2026-06-08', amount: 50 });
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.expenses[0].payments).toHaveLength(1);
  });

  it('blocks payment on stornierte Ausgabe', () => {
    hydrateExpenseStore([
      createTestExpense({
        status: 'storniert',
        paymentStatus: 'storniert',
        cancelledAt: '2026-06-01T00:00:00.000Z',
      }),
    ]);

    const result = recordExpensePayment('exp-pay-1', { date: '2026-06-08', amount: 50 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('expense.payment.notPayable');
  });

  it('rejects invalid amount', () => {
    const result = recordExpensePayment('exp-pay-1', { date: '2026-06-08', amount: 0 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKey).toBe('payment.amountInvalid');
  });
});

describe('removeExpensePayment', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateExpenseStore([
      createTestExpense({
        payments: [
          {
            id: 'pay-remove-1',
            date: '2026-06-05',
            amount: 119,
            createdAt: '2026-06-05T10:00:00.000Z',
          },
        ],
        paymentStatus: 'bezahlt',
      }),
    ]);
    persistAll();
  });

  it('removes payment and resets status to offen', () => {
    const result = removeExpensePayment('exp-pay-1', 'pay-remove-1');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.expense.paymentStatus).toBe('offen');
    expect(result.expense.payments).toHaveLength(0);
  });
});
