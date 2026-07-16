import { describe, expect, it } from 'vitest';
import { hydrateVorgangStore, getVorgangById } from './vorgangService';
import {
  buildAbschlagDraft,
  buildSchlussrechnungDraft,
  canDeleteOrderPosition,
  canEditOrderPositionField,
  finalizeInvoiceDraft,
  getBilledQuantity,
  getNextAbschlagNumber,
  getOpenQuantity,
  getOverbillingWarnings,
  getPositionBillingStatus,
  getPreviousAbschlagDeductions,
  hasFinalSchlussrechnung,
  isPositionBillable,
} from './invoiceService';
import {
  hydrateCompanyProfileStore,
  updateCompanyProfile,
} from './companyProfileService';
import { INVOICE_DRAFT_LABEL } from './invoiceNumberService';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
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

    const result = finalizeInvoiceDraft('v-test-1', draft, testSetup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.positions).toHaveLength(1);
    expect(result.invoice.positions[0]).toMatchObject({
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

describe('buildAbschlagDraft metadata', () => {
  it('includes ENTWURF preview and company snapshot', () => {
    hydrateVorgangStore([createTestVorgang()]);
    hydrateCompanyProfileStore({
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Mustermann GmbH',
      street: 'Musterstraße 1',
      city: 'Berlin',
    });

    const draft = buildAbschlagDraft('v-test-1', testSetup);
    expect(draft).not.toBeNull();
    expect(draft!.invoiceNumberPreview).toBe(INVOICE_DRAFT_LABEL);
    expect(draft!.companySnapshot.companyName).toBe('Mustermann GmbH');
    expect(draft!.customerBilling.name).toBe('Test Kunde');
    expect(draft!.legalNotices).toEqual([]);
  });
});

describe('getPreviousAbschlagDeductions', () => {
  it('collects finalized abschlag invoices', () => {
    const vorgang = createTestVorgang({
      invoices: [
        createAbschlagInvoice('op-test-1', 2, {
          id: 'inv-a1',
          number: '2026-0001',
          amount: 238,
          subtotal: 200,
        }),
      ],
    });
    const deductions = getPreviousAbschlagDeductions(vorgang);
    expect(deductions).toHaveLength(1);
    expect(deductions[0].invoiceNumber).toBe('2026-0001');
    expect(deductions[0].amount).toBe(238);
  });
});

describe('buildSchlussrechnungDraft', () => {
  it('includes previous abschlag deductions', () => {
    hydrateVorgangStore([
      createTestVorgang({
        invoices: [createAbschlagInvoice('op-test-1', 2, { number: '2026-0001', amount: 100 })],
      }),
    ]);

    const draft = buildSchlussrechnungDraft('v-test-1', testSetup);
    expect(draft).not.toBeNull();
    expect(draft!.previousAbschlagDeductions).toHaveLength(1);
  });
});

describe('finalizeInvoiceDraft', () => {
  it('assigns global invoice number and snapshots', () => {
    hydrateVorgangStore([createTestVorgang()]);
    hydrateCompanyProfileStore({
      companyName: 'Snapshot GmbH',
      legalForm: 'GmbH',
      street: 'Test 1',
      zip: '10115',
      city: 'Berlin',
      country: 'Deutschland',
      contactPerson: 'Max',
      phone: '',
      email: '',
      website: '',
      taxNumber: '12/345',
      vatId: 'DE123',
      bankName: 'Sparkasse',
      iban: 'DE00',
      bic: 'BELADEBE',
      defaultPaymentDays: 14,
      defaultPaymentTerms: '14 Tage netto',
      defaultSkonto: '',
      invoiceFooterNotes: '',
    });

    const draft = buildAbschlagDraft('v-test-1', testSetup);
    expect(draft).not.toBeNull();

    const result = finalizeInvoiceDraft('v-test-1', {
      ...draft!,
      positions: draft!.positions.map((p) => ({ ...p, quantity: 1 })),
    }, testSetup);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.number).toMatch(/^\d{4}-\d{4}$/);
    expect(result.invoice.invoiceSequenceNumber).toBe(1);
    expect(result.invoice.companySnapshot?.companyName).toBe('Snapshot GmbH');
    expect(result.invoice.customerSnapshot?.name).toBe('Test Kunde');
    expect(result.invoice.issueDate).toBeTruthy();
  });

  it('keeps invoice snapshot when company profile changes afterwards', () => {
    hydrateVorgangStore([createTestVorgang()]);
    hydrateCompanyProfileStore({
      companyName: 'Alt GmbH',
      legalForm: '',
      street: 'Altstr. 1',
      zip: '10115',
      city: 'Berlin',
      country: 'Deutschland',
      contactPerson: '',
      phone: '',
      email: '',
      website: '',
      taxNumber: '',
      vatId: '',
      bankName: '',
      iban: '',
      bic: '',
      defaultPaymentDays: 14,
      defaultPaymentTerms: '',
      defaultSkonto: '',
      invoiceFooterNotes: '',
    });

    const draft = buildAbschlagDraft('v-test-1', testSetup);
    const result = finalizeInvoiceDraft('v-test-1', {
      ...draft!,
      positions: draft!.positions.map((p) => ({ ...p, quantity: 1 })),
    }, testSetup);

    updateCompanyProfile({ companyName: 'Neu GmbH' });
    const saved = getVorgangById('v-test-1')?.invoices[0];
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(saved?.companySnapshot?.companyName).toBe('Alt GmbH');
    expect(result.invoice.number).toBe(saved?.number);
  });

  it('keeps legacy invoices compatible without snapshots', () => {
    hydrateVorgangStore([
      createTestVorgang({
        invoices: [createAbschlagInvoice('op-test-1', 1, { number: 'AR-2026-01' })],
      }),
    ]);

    const vorgang = getVorgangById('v-test-1');
    expect(vorgang?.invoices[0].number).toBe('AR-2026-01');
    expect(vorgang?.invoices[0].companySnapshot).toBeUndefined();
  });
});
