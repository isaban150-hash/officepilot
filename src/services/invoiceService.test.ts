import { describe, expect, it } from 'vitest';
import { hydrateVorgangStore, getVorgangById } from './vorgangService';
import {
  buildSchlussrechnungDraft,
  canDeleteOrderPosition,
  canEditOrderPositionField,
  finalizeInvoiceDraft,
  getBilledQuantity,
  getNextAbschlagNumber,
  getOpenQuantity,
  getOverbillingWarnings,
  getPositionBillingStatus,
  hasFinalSchlussrechnung,
  isPositionBillable,
} from './invoiceService';
import {
  createAbschlagInvoice,
  createOrderPosition,
  createTestVorgang,
  testSetup,
} from '../test/fixtures';
import type { OrderPosition } from '../types/models';

describe('getBilledQuantity / getOpenQuantity', () => {
  it('returns 0 billed and full open when no invoices exist', () => {
    const vorgang = createTestVorgang();
    expect(getBilledQuantity(vorgang, 'op-test-1')).toBe(0);
    expect(getOpenQuantity(vorgang, 'op-test-1')).toBe(10);
  });

  it('sums quantities from finalized invoices only', () => {
    const vorgang = createTestVorgang({
      invoices: [createAbschlagInvoice('op-test-1', 3)],
    });
    expect(getBilledQuantity(vorgang, 'op-test-1')).toBe(3);
    expect(getOpenQuantity(vorgang, 'op-test-1')).toBe(7);
  });

  it('ignores entwurf invoices', () => {
    const vorgang = createTestVorgang({
      invoices: [createAbschlagInvoice('op-test-1', 5, { status: 'entwurf' })],
    });
    expect(getBilledQuantity(vorgang, 'op-test-1')).toBe(0);
  });
});

describe('getNextAbschlagNumber', () => {
  it('returns 1 when no abschlag exists', () => {
    expect(getNextAbschlagNumber(createTestVorgang())).toBe(1);
  });

  it('returns next number after existing abschlag', () => {
    const vorgang = createTestVorgang({
      invoices: [createAbschlagInvoice('op-test-1', 2, { abschlagNumber: 1 })],
    });
    expect(getNextAbschlagNumber(vorgang)).toBe(2);
  });
});

describe('isPositionBillable', () => {
  const materialPosition: OrderPosition = createOrderPosition({
    id: 'op-mat',
    category: 'material',
    billable: true,
  });

  it('blocks material for auftraggeber', () => {
    expect(isPositionBillable(materialPosition, 'auftraggeber')).toBe(false);
  });

  it('allows material for betrieb', () => {
    expect(isPositionBillable(materialPosition, 'betrieb')).toBe(true);
  });

  it('respects billable flag for gemischt', () => {
    expect(isPositionBillable(materialPosition, 'gemischt')).toBe(true);
    expect(
      isPositionBillable({ ...materialPosition, billable: false }, 'gemischt'),
    ).toBe(false);
  });

  it('allows material for unclear by default', () => {
    expect(isPositionBillable(materialPosition, 'unclear')).toBe(true);
  });

  it('always allows arbeit positions', () => {
    const arbeit = createOrderPosition({ category: 'arbeit' });
    expect(isPositionBillable(arbeit, 'auftraggeber')).toBe(true);
  });
});

describe('buildSchlussrechnungDraft', () => {
  it('prefills open quantities', () => {
    const vorgang = createTestVorgang({
      invoices: [createAbschlagInvoice('op-test-1', 4)],
    });
    hydrateVorgangStore([vorgang]);

    const draft = buildSchlussrechnungDraft('v-test-1', testSetup);
    expect(draft).not.toBeNull();
    expect(draft!.positions[0].quantity).toBe(6);
    expect(draft!.positions[0].openQuantity).toBe(6);
    expect(draft!.positions[0].billedQuantity).toBe(4);
  });
});

describe('finalizeInvoiceDraft', () => {
  it('stores position snapshots on the vorgang', () => {
    const vorgang = createTestVorgang();
    hydrateVorgangStore([vorgang]);

    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;
    draft.positions[0].quantity = 5;

    const invoice = finalizeInvoiceDraft('v-test-1', draft, testSetup);
    expect(invoice).not.toBeNull();
    expect(invoice!.positions).toHaveLength(1);
    expect(invoice!.positions[0]).toMatchObject({
      orderPositionId: 'op-test-1',
      quantity: 5,
      unitPrice: 65,
      lineTotal: 325,
    });

    const stored = getVorgangById('v-test-1');
    expect(stored!.invoices).toHaveLength(1);
    expect(stored!.invoices[0].positions[0].description).toBe('Testleistung');
  });
});

describe('getOverbillingWarnings', () => {
  it('detects quantity above open amount', () => {
    const vorgang = createTestVorgang({
      invoices: [createAbschlagInvoice('op-test-1', 8)],
    });
    hydrateVorgangStore([vorgang]);

    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;
    draft.positions[0].quantity = 5;

    const warnings = getOverbillingWarnings(draft);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('Testleistung');
  });
});

describe('getPositionBillingStatus', () => {
  it('reports partial billing correctly', () => {
    const vorgang = createTestVorgang({
      invoices: [createAbschlagInvoice('op-test-1', 4)],
    });
    const status = getPositionBillingStatus(vorgang, 'op-test-1');

    expect(status).toMatchObject({
      billedQuantity: 4,
      openQuantity: 6,
      hasBilling: true,
      isFullyBilled: false,
    });
  });
});

describe('canEditOrderPositionField', () => {
  it('allows all fields when unbilled', () => {
    const vorgang = createTestVorgang();
    expect(canEditOrderPositionField(vorgang, 'op-test-1', 'unitPrice')).toBe(true);
    expect(canEditOrderPositionField(vorgang, 'op-test-1', 'unit')).toBe(true);
  });

  it('locks price and unit after billing', () => {
    const vorgang = createTestVorgang({
      invoices: [createAbschlagInvoice('op-test-1', 2)],
    });
    expect(canEditOrderPositionField(vorgang, 'op-test-1', 'unitPrice')).toBe(false);
    expect(canEditOrderPositionField(vorgang, 'op-test-1', 'unit')).toBe(false);
    expect(canEditOrderPositionField(vorgang, 'op-test-1', 'category')).toBe(false);
    expect(canEditOrderPositionField(vorgang, 'op-test-1', 'description')).toBe(true);
    expect(canEditOrderPositionField(vorgang, 'op-test-1', 'plannedQuantity')).toBe(true);
  });

  it('locks all fields when schlussrechnung exists', () => {
    const vorgang = createTestVorgang({
      invoices: [
        createAbschlagInvoice('op-test-1', 1, {
          id: 'inv-s',
          type: 'schluss',
          abschlagNumber: undefined,
        }),
      ],
    });
    expect(canEditOrderPositionField(vorgang, 'op-test-1', 'description')).toBe(false);
  });
});

describe('canDeleteOrderPosition', () => {
  it('allows delete when unbilled', () => {
    expect(canDeleteOrderPosition(createTestVorgang(), 'op-test-1')).toBe(true);
  });

  it('blocks delete when billed', () => {
    const vorgang = createTestVorgang({
      invoices: [createAbschlagInvoice('op-test-1', 1)],
    });
    expect(canDeleteOrderPosition(vorgang, 'op-test-1')).toBe(false);
  });
});

describe('hasFinalSchlussrechnung', () => {
  it('returns true for finalized schluss invoice', () => {
    const vorgang = createTestVorgang({
      invoices: [
        createAbschlagInvoice('op-test-1', 1, {
          id: 'inv-s',
          type: 'schluss',
          abschlagNumber: undefined,
        }),
      ],
    });
    expect(hasFinalSchlussrechnung(vorgang)).toBe(true);
  });

  it('returns false without schluss invoice', () => {
    expect(hasFinalSchlussrechnung(createTestVorgang())).toBe(false);
  });
});
