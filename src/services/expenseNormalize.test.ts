import { describe, expect, it } from 'vitest';
import {
  buildExpenseDedupeKey,
  normalizeExpense,
  normalizeDedupePart,
} from './expenseNormalize';

describe('buildExpenseDedupeKey', () => {
  it('normalizes supplier and invoice number', () => {
    expect(buildExpenseDedupeKey('  Bauzentrum Nord GmbH ', 'RE-2026-8842')).toBe(
      'bauzentrum nord gmbh|re-2026-8842',
    );
  });

  it('returns empty string when both parts are blank', () => {
    expect(buildExpenseDedupeKey('  ', '')).toBe('');
  });
});

describe('normalizeDedupePart', () => {
  it('collapses whitespace and lowercases', () => {
    expect(normalizeDedupePart('  Shell   Tankstelle ')).toBe('shell tankstelle');
  });
});

describe('normalizeExpense', () => {
  it('maps legacy amount field to grossAmount', () => {
    const expense = normalizeExpense({
      id: 'exp-legacy-1',
      amount: 119.5,
      supplierName: 'Legacy GmbH',
    } as Parameters<typeof normalizeExpense>[0]);

    expect(expense.grossAmount).toBe(119.5);
    expect(expense.netAmount).toBe(119.5);
  });

  it('defaults missing status to gebucht', () => {
    const expense = normalizeExpense({
      id: 'exp-legacy-2',
      supplierName: 'Test',
      grossAmount: 50,
    });

    expect(expense.status).toBe('gebucht');
    expect(expense.paymentStatus).toBe('offen');
  });

  it('derives storniert from cancelledAt', () => {
    const expense = normalizeExpense({
      id: 'exp-legacy-3',
      supplierName: 'Test',
      grossAmount: 50,
      cancelledAt: '2026-03-01T00:00:00.000Z',
    });

    expect(expense.status).toBe('storniert');
    expect(expense.paymentStatus).toBe('storniert');
  });

  it('builds dedupeKey when missing', () => {
    const expense = normalizeExpense({
      id: 'exp-legacy-4',
      supplierName: 'Muster AG',
      invoiceNumber: 'INV-99',
      grossAmount: 10,
    });

    expect(expense.dedupeKey).toBe('muster ag|inv-99');
  });

  it('parses string amounts with German formatting', () => {
    const expense = normalizeExpense({
      id: 'exp-legacy-5',
      supplierName: 'Test',
      amount: '1.234,56',
    } as Parameters<typeof normalizeExpense>[0]);

    expect(expense.grossAmount).toBe(1234.56);
  });
});
