import { describe, expect, it } from 'vitest';
import { addExpense } from '../expenseService';
import { hydrateCustomerStore } from '../customerStoreService';
import { buildUiSessionSnapshot } from './uiSessionCapture';
import type { Customer } from '../../types/models';

/**
 * PRODUCT-ACCEPTANCE-FIX-01B (F-01) — der Wiederaufnahme-Hinweis nennt nie
 * einen internen Pfad oder eine ID: Ausgaben und Kunden tragen ihre Stammdaten,
 * Bereichsseiten ihren Bereichsnamen.
 */
describe('F-01 — Resume-Label ohne Rohpfade', () => {
  it('Ausgabendetail: Titel und Lieferant statt /ausgaben/exp-…', () => {
    const result = addExpense({
      title: 'Material Heizungspumpe',
      category: 'material',
      supplierName: 'Baustoff Nord GmbH',
      issueDate: '2026-09-10',
      grossAmount: 238,
    });
    expect(result.success).toBe(true);
    const id = result.expense!.id;
    const snapshot = buildUiSessionSnapshot({ pathname: `/ausgaben/${id}` });
    expect(snapshot.entityType).toBe('expense');
    expect(snapshot.resumeLabel.titleText).toBe('Material Heizungspumpe');
    expect(snapshot.resumeLabel.subtitleText).toBe('Baustoff Nord GmbH');
    expect(snapshot.resumeLabel.titleText).not.toMatch(/^\/|exp-/);
  });

  it('Ausgabendetail ohne ladbare Ausgabe: Bereichsname, kein Pfad', () => {
    const snapshot = buildUiSessionSnapshot({ pathname: '/ausgaben/exp-unbekannt' });
    expect(snapshot.resumeLabel.titleText).toBe('Ausgaben');
    expect(snapshot.resumeLabel.titleText).not.toContain('/');
  });

  it('Kundendetail: Kundenname statt ID', () => {
    hydrateCustomerStore([
      { id: 'cust-1', name: 'Müller Bau GmbH', street: 'Industrieweg 3', zip: '45356', city: 'Essen' } as unknown as Customer,
    ]);
    const snapshot = buildUiSessionSnapshot({ pathname: '/kunden/customer/cust-1' });
    expect(snapshot.resumeLabel.titleText).toBe('Müller Bau GmbH');
    expect(snapshot.resumeLabel.subtitleText).not.toContain('cust-1');
  });

  it('Bereichsseiten: menschenlesbarer Fallback', () => {
    expect(buildUiSessionSnapshot({ pathname: '/' }).resumeLabel.titleText).toBe('Heute');
    expect(buildUiSessionSnapshot({ pathname: '/finanzen' }).resumeLabel.titleText).toBe('Finanzen');
    expect(buildUiSessionSnapshot({ pathname: '/dokumente' }).resumeLabel.titleText).toBe('Dokumente');
    expect(buildUiSessionSnapshot({ pathname: '/irgendwas/unbekannt' }).resumeLabel.titleText).not.toContain('/');
  });
});
