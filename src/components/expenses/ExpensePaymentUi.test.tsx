import { describe, expect, it, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  getExpensePaymentBadgeClass,
  ExpensePaymentBadge,
} from './ExpensePaymentBadge';
import { ExpensePaymentSummary } from './ExpensePaymentSummary';
import { ExpensePaymentHistory } from './ExpensePaymentHistory';
import { willExpensePaymentOverpay } from './ExpensePaymentForm';
import { ExpenseOverviewCard } from './ExpenseOverviewCard';
import {
  calculateExpensePaymentSummary,
  recordExpensePayment,
  removeExpensePayment,
} from '../../services/expensePaymentService';
import { hydrateExpenseStore, getExpenseFromStoreById } from '../../services/expenseStore';
import type { ExpenseOverviewItem } from '../../types/expense';
import type { Expense } from '../../types/expense';
import type { TranslationKey } from '../../i18n';

function translate(key: TranslationKey): string {
  return key;
}

function createTestExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-ui-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Lieferant GmbH',
    invoiceNumber: 'RE-UI-1',
    title: 'UI Test Ausgabe',
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

describe('ExpensePaymentBadge', () => {
  it('renders status labels with tone classes', () => {
    const html = renderToStaticMarkup(
      <ExpensePaymentBadge status="teilbezahlt" translate={translate} />,
    );
    expect(html).toContain('payment.status.teilbezahlt');
    expect(html).toContain(getExpensePaymentBadgeClass('teilbezahlt'));
  });
});

describe('ExpensePaymentSummary', () => {
  it('shows paid, open and overpaid amounts', () => {
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

    const html = renderToStaticMarkup(
      <ExpensePaymentSummary expense={expense} translate={translate} />,
    );

    expect(html).toContain('payment.totalDue');
    expect(html).toContain('payment.overpaidAmount');
    expect(html).toContain('payment.status.bezahlt');
  });

  it('shows overdue notice for overdue expenses', () => {
    const expense = createTestExpense({ paymentDueDate: '2020-01-01' });
    const html = renderToStaticMarkup(
      <ExpensePaymentSummary expense={expense} translate={translate} />,
    );

    expect(html).toContain('expense.payment.overdueNotice');
    expect(calculateExpensePaymentSummary(expense, '2026-06-27').status).toBe('ueberfaellig');
  });
});

describe('ExpensePaymentHistory', () => {
  it('renders chronological payment entries', () => {
    const expense = createTestExpense({
      payments: [
        {
          id: 'pay-1',
          date: '2026-06-01',
          amount: 50,
          reference: 'RE-UI-1',
          note: 'Anzahlung',
          createdAt: '2026-06-01T10:00:00.000Z',
        },
      ],
    });

    const html = renderToStaticMarkup(
      <ExpensePaymentHistory expense={expense} translate={translate} allowRemove={false} />,
    );

    expect(html).toContain('RE-UI-1');
    expect(html).toContain('Anzahlung');
    expect(html).toContain('50,00');
  });
});

describe('ExpensePaymentForm helpers', () => {
  it('detects overpayment', () => {
    expect(willExpensePaymentOverpay(119, 130)).toBe(true);
    expect(willExpensePaymentOverpay(119, 119)).toBe(false);
  });
});

describe('ExpenseOverviewCard', () => {
  it('shows booking and payment status in markup', () => {
    const item: ExpenseOverviewItem = {
      expense: createTestExpense(),
      paymentSummary: calculateExpensePaymentSummary(createTestExpense()),
    };

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ExpenseOverviewCard item={item} translate={translate} />
      </MemoryRouter>,
    );

    expect(html).toContain('expense.fieldBookingStatus');
    expect(html).toContain('payment.paymentStatus');
    expect(html).toContain('payment.recordShort');
  });
});

describe('expense payment UI integration', () => {
  beforeEach(() => {
    hydrateExpenseStore([createTestExpense()]);
  });

  it('updates status after partial and full payment', () => {
    const partial = recordExpensePayment('exp-ui-1', { date: '2026-06-08', amount: 50 });
    expect(partial.success).toBe(true);
    if (!partial.success) return;
    expect(partial.expense.paymentStatus).toBe('teilbezahlt');

    const full = recordExpensePayment('exp-ui-1', { date: '2026-06-09', amount: 69 });
    expect(full.success).toBe(true);
    if (!full.success) return;
    expect(full.expense.paymentStatus).toBe('bezahlt');
  });

  it('supports payment removal with status change', () => {
    recordExpensePayment('exp-ui-1', { date: '2026-06-08', amount: 119 });
    let expense = getExpenseFromStoreById('exp-ui-1')!;
    const paymentId = expense.payments![0].id;

    const removed = removeExpensePayment('exp-ui-1', paymentId);
    expect(removed.success).toBe(true);
    if (!removed.success) return;

    expense = removed.expense;
    expect(expense.paymentStatus).toBe('offen');
    expect(expense.payments).toHaveLength(0);
  });
});
