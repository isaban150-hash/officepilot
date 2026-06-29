import { describe, expect, it } from 'vitest';
import {
  EXPENSE_CATEGORIES,
  mapClassifiedKindToExpenseCategory,
} from './expenseCategoryMapping';

describe('mapClassifiedKindToExpenseCategory', () => {
  it('maps eingangsrechnung to material', () => {
    expect(mapClassifiedKindToExpenseCategory('eingangsrechnung')).toBe('material');
  });

  it('maps tankbeleg to fahrzeug', () => {
    expect(mapClassifiedKindToExpenseCategory('tankbeleg')).toBe('fahrzeug');
  });

  it('maps gutschrift to gutschrift', () => {
    expect(mapClassifiedKindToExpenseCategory('gutschrift')).toBe('gutschrift');
  });

  it('maps lohnabrechnung to personal', () => {
    expect(mapClassifiedKindToExpenseCategory('lohnabrechnung')).toBe('personal');
  });

  it('falls back to sonstiges for unknown kinds', () => {
    expect(mapClassifiedKindToExpenseCategory('angebot')).toBe('sonstiges');
  });

  it('falls back to sonstiges when kind is null', () => {
    expect(mapClassifiedKindToExpenseCategory(null)).toBe('sonstiges');
  });
});

describe('EXPENSE_CATEGORIES', () => {
  it('includes all MVP categories', () => {
    expect(EXPENSE_CATEGORIES).toContain('material');
    expect(EXPENSE_CATEGORIES).toContain('sonstiges');
    expect(EXPENSE_CATEGORIES.length).toBe(12);
  });
});
