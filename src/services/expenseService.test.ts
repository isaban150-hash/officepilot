import { beforeEach, describe, expect, it } from 'vitest';
import { getActiveStorageKey } from './persistenceService';
import {
  addExpense,
  buildExpenseDedupeKey,
  deleteExpense,
  getAllExpenses,
  getExpenseById,
  isDuplicateExpense,
  searchExpenses,
  updateExpense,
} from './expenseService';
import { hydrateExpenseStore } from './expenseStore';

function validInput() {
  return {
    title: 'Test Ausgabe',
    category: 'material' as const,
    supplierName: 'Lieferant GmbH',
    invoiceNumber: 'RE-100',
    issueDate: '2026-03-20',
    grossAmount: 119,
    netAmount: 100,
    taxAmount: 19,
  };
}

describe('expense CRUD', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateExpenseStore([]);
  });

  it('adds an expense with required fields', () => {
    const result = addExpense(validInput());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.expense.title).toBe('Test Ausgabe');
      expect(result.expense.paymentStatus).toBe('offen');
      expect(result.expense.positions).toEqual([]);
      expect(result.expense.allocations).toEqual([]);
    }
  });

  it('updates an existing expense', () => {
    const created = addExpense(validInput());
    if (!created.success) throw new Error('setup failed');

    const updated = updateExpense(created.expense.id, { title: 'Geändert' });
    expect(updated.success).toBe(true);
    if (updated.success) {
      expect(updated.expense.title).toBe('Geändert');
      expect(getExpenseById(created.expense.id)?.title).toBe('Geändert');
    }
  });

  it('deletes an expense', () => {
    const created = addExpense(validInput());
    if (!created.success) throw new Error('setup failed');

    const removed = deleteExpense(created.expense.id);
    expect(removed.success).toBe(true);
    expect(getExpenseById(created.expense.id)).toBeUndefined();
    expect(getAllExpenses()).toHaveLength(0);
  });

  it('persists mutations to localStorage', () => {
    addExpense(validInput());
    const raw = localStorage.getItem(getActiveStorageKey());
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.expenses).toHaveLength(1);
    expect(parsed.expenses[0].supplierName).toBe('Lieferant GmbH');
  });
});

describe('searchExpenses', () => {
  beforeEach(() => {
    hydrateExpenseStore([]);
    addExpense(validInput());
    addExpense({
      ...validInput(),
      title: 'Tankbeleg',
      category: 'fahrzeug',
      supplierName: 'Shell',
      invoiceNumber: 'TNK-1',
    });
  });

  it('filters by query', () => {
    expect(searchExpenses('shell')).toHaveLength(1);
    expect(searchExpenses('shell')[0].supplierName).toBe('Shell');
  });

  it('filters by category', () => {
    expect(searchExpenses('', 'fahrzeug')).toHaveLength(1);
    expect(searchExpenses('', 'material')).toHaveLength(1);
  });
});

describe('deduplication', () => {
  beforeEach(() => {
    hydrateExpenseStore([]);
  });

  it('builds consistent dedupe keys', () => {
    expect(buildExpenseDedupeKey('Lieferant GmbH', 'RE-100')).toBe('lieferant gmbh|re-100');
  });

  it('rejects duplicate supplier + invoice number on add', () => {
    addExpense(validInput());
    const duplicate = addExpense(validInput());
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) expect(duplicate.errorKey).toBe('expense.duplicate');
  });

  it('detects duplicates case-insensitively', () => {
    addExpense(validInput());
    const match = isDuplicateExpense('  lieferant gmbh ', 're-100');
    expect(match).not.toBeNull();
  });

  it('allows update of same expense without duplicate error', () => {
    const created = addExpense(validInput());
    if (!created.success) throw new Error('setup failed');

    const updated = updateExpense(created.expense.id, { description: 'OK' });
    expect(updated.success).toBe(true);
  });
});

/*
 * EXPENSE-IDENTIFIER-COMPLETENESS-01 — Teil A.
 *
 * Ohne erkannte Nummer entstand der Schlüssel `<lieferant>|`. Die vorhandene
 * Tragfähigkeitsprüfung in `isDuplicateExpense` verwarf nur den vollständig
 * leeren Fall `'|'` und behandelte `<lieferant>|` als belastbar. Damit sperrte
 * der erste nummernlose Beleg jeden weiteren nummernlosen Beleg desselben
 * Lieferanten.
 */
describe('EXPENSE-IDENTIFIER-COMPLETENESS-01 — nummernlose Belege', () => {
  const TANKSTELLE = 'Testtankstelle Musterstadt';

  function receiptInput(overrides: Partial<ReturnType<typeof validInput>> = {}) {
    return {
      ...validInput(),
      title: 'Tankbeleg',
      supplierName: TANKSTELLE,
      invoiceNumber: '',
      grossAmount: 70.51,
      netAmount: 59.25,
      taxAmount: 11.26,
      ...overrides,
    };
  }

  beforeEach(() => {
    localStorage.clear();
    hydrateExpenseStore([]);
  });

  it('A: zwei nummernlose Belege desselben Lieferanten sind beide anlegbar', () => {
    const first = addExpense(receiptInput());
    const second = addExpense(receiptInput({ grossAmount: 42.1 }));

    expect(first.success, JSON.stringify(first)).toBe(true);
    expect(second.success, JSON.stringify(second)).toBe(true);
    expect(getAllExpenses()).toHaveLength(2);
  });

  it('A2: ohne Nummer trifft die Duplikatprüfung gar keine Entscheidung', () => {
    expect(addExpense(receiptInput()).success).toBe(true);
    expect(isDuplicateExpense(TANKSTELLE, '')).toBeNull();
    // Auch reiner Whitespace ist keine belastbare Nummer.
    expect(isDuplicateExpense(TANKSTELLE, '   ')).toBeNull();
  });

  it('B: ein echtes Duplikat MIT Nummer bleibt blockiert', () => {
    const first = addExpense(receiptInput({ invoiceNumber: '123' }));
    expect(first.success).toBe(true);

    const second = addExpense(receiptInput({ invoiceNumber: '123' }));
    expect(second.success).toBe(false);
    if (!second.success) expect(second.errorKey).toBe('expense.duplicate');
    expect(getAllExpenses()).toHaveLength(1);
    expect(isDuplicateExpense(TANKSTELLE, '123')).not.toBeNull();
  });

  it('C: unterschiedliche Nummern desselben Lieferanten bleiben erlaubt', () => {
    expect(addExpense(receiptInput({ invoiceNumber: '123' })).success).toBe(true);
    expect(addExpense(receiptInput({ invoiceNumber: '124' })).success).toBe(true);
    expect(getAllExpenses()).toHaveLength(2);
  });

  it('C2: das Schlüsselformat für Belege MIT Nummer bleibt unverändert', () => {
    const created = addExpense(receiptInput({ invoiceNumber: '123' }));
    expect(created.success).toBe(true);
    if (created.success) {
      expect(created.expense.dedupeKey).toBe('testtankstelle musterstadt|123');
    }
  });

  it('C3: ein nummernloser Beleg blockiert keinen nummerierten und umgekehrt', () => {
    expect(addExpense(receiptInput()).success).toBe(true);
    expect(addExpense(receiptInput({ invoiceNumber: '123' })).success).toBe(true);
    expect(addExpense(receiptInput()).success).toBe(true);
    expect(getAllExpenses()).toHaveLength(3);
  });
});
