import { describe, expect, it } from 'vitest';
import { hydrateVorgangStore, getVorgangById } from './vorgangService';
import {
  addOrderPosition,
  removeOrderPosition,
  updateOrderPosition,
} from './vorgangService';
import {
  createAbschlagInvoice,
  createOrderPosition,
  createTestVorgang,
} from '../test/fixtures';

describe('addOrderPosition', () => {
  it('adds a position to the vorgang store', () => {
    hydrateVorgangStore([createTestVorgang({ orderPositions: [] })]);

    const result = addOrderPosition('v-test-1', {
      description: 'Neue Leistung',
      plannedQuantity: 5,
      unit: 'Stück',
      unitPrice: 120,
      category: 'arbeit',
    });

    expect(result.success).toBe(true);
    expect(result.success && result.vorgang.orderPositions).toHaveLength(1);
    expect(result.success && result.vorgang.orderPositions[0].description).toBe('Neue Leistung');
  });

  it('uses fallback description for empty input', () => {
    hydrateVorgangStore([createTestVorgang({ orderPositions: [] })]);

    const result = addOrderPosition('v-test-1', {
      description: '   ',
      plannedQuantity: 1,
      unit: 'Pauschal',
      unitPrice: 500,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.vorgang.orderPositions[0].description).toBe('Neue Position');
    }
  });

  it('blocks add when schlussrechnung exists', () => {
    const vorgang = createTestVorgang({
      invoices: [
        createAbschlagInvoice('op-test-1', 1, {
          id: 'inv-schluss',
          type: 'schluss',
          abschlagNumber: undefined,
        }),
      ],
    });
    hydrateVorgangStore([vorgang]);

    const result = addOrderPosition('v-test-1', {
      description: 'X',
      plannedQuantity: 1,
      unit: 'Pauschal',
      unitPrice: 1,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKey).toBe('position.schlussLocked');
  });
});

describe('updateOrderPosition', () => {
  it('updates unitPrice when not billed', () => {
    hydrateVorgangStore([createTestVorgang()]);

    const result = updateOrderPosition('v-test-1', 'op-test-1', { unitPrice: 99 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.vorgang.orderPositions[0].unitPrice).toBe(99);
    }
  });

  it('blocks unitPrice change after billing', () => {
    const vorgang = createTestVorgang({
      invoices: [createAbschlagInvoice('op-test-1', 2)],
    });
    hydrateVorgangStore([vorgang]);

    const result = updateOrderPosition('v-test-1', 'op-test-1', { unitPrice: 99 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKey).toBe('position.fieldLocked');
  });

  it('allows description change after billing', () => {
    const vorgang = createTestVorgang({
      invoices: [createAbschlagInvoice('op-test-1', 2)],
    });
    hydrateVorgangStore([vorgang]);

    const result = updateOrderPosition('v-test-1', 'op-test-1', {
      description: 'Umbenannt',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.vorgang.orderPositions[0].description).toBe('Umbenannt');
    }
  });

  it('blocks plannedQuantity below billed amount', () => {
    const vorgang = createTestVorgang({
      invoices: [createAbschlagInvoice('op-test-1', 5)],
    });
    hydrateVorgangStore([vorgang]);

    const result = updateOrderPosition('v-test-1', 'op-test-1', { plannedQuantity: 3 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKey).toBe('position.plannedBelowBilled');
  });

  it('does not modify stored invoices', () => {
    const invoice = createAbschlagInvoice('op-test-1', 2);
    const vorgang = createTestVorgang({ invoices: [invoice] });
    hydrateVorgangStore([vorgang]);

    updateOrderPosition('v-test-1', 'op-test-1', { description: 'Geändert' });

    const stored = getVorgangById('v-test-1')!;
    expect(stored.invoices[0].positions[0].unitPrice).toBe(65);
    expect(stored.invoices[0].positions[0].quantity).toBe(2);
  });
});

describe('removeOrderPosition', () => {
  it('removes unbilled position', () => {
    hydrateVorgangStore([
      createTestVorgang({
        orderPositions: [
          createOrderPosition({ id: 'op-a' }),
          createOrderPosition({ id: 'op-b', description: 'Zweite' }),
        ],
      }),
    ]);

    const result = removeOrderPosition('v-test-1', 'op-b');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.vorgang.orderPositions).toHaveLength(1);
      expect(result.vorgang.orderPositions[0].id).toBe('op-a');
    }
  });

  it('blocks delete when position was billed', () => {
    const vorgang = createTestVorgang({
      invoices: [createAbschlagInvoice('op-test-1', 1)],
    });
    hydrateVorgangStore([vorgang]);

    const result = removeOrderPosition('v-test-1', 'op-test-1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKey).toBe('position.deleteBlocked');
  });
});
