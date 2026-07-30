/**
 * PAUSCHALER-ABSCHLAG-01 — fixed-amount Abschlag drafts, finalize, deductions, cloud map.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestVorgang, testSetup } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import {
  FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION,
} from './invoiceCalculationMode';
import {
  buildAbschlagDraft,
  buildInvoiceFinalizationCandidate,
  buildInvoiceFinalizationContentFingerprint,
  buildSchlussrechnungDraft,
  calculateInvoiceTotals,
  finalizeInvoiceDraft,
  getPreviousAbschlagDeductions,
  setAbschlagDraftCalculationMode,
  updateInvoiceDraftFixedAmountNet,
  updateInvoiceDraftMetadata,
  validateInvoiceDraftForApproval,
} from './invoiceService';
import { getBilledQuantity } from './orderBillingRules';
import { buildInvoicePrintModel, buildInvoicePrintModelFromInvoice } from './invoicePrintModel';
import {
  buildWorkspaceInvoiceFinalizePayload,
  mapCloudPayloadToVorgangInvoice,
} from './invoice/workspaceInvoiceCloudService';
import {
  getVorgangById,
  hydrateVorgangStore,
  upsertFinalizedInvoiceOnVorgang,
} from './vorgangService';
import { createCompanyProfileSnapshot } from './companyProfileService';
import { resolveInvoiceCalculationMode } from './invoiceCalculationMode';

function seedReadyVorgang() {
  const profile = createCompanyProfileSnapshot();
  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-pauschal-1',
      status: 'beauftragt',
      customerBilling: {
        name: 'Test Kunde',
        contactPerson: '',
        street: 'Kundenweg 1',
        zip: '10115',
        city: 'Berlin',
        email: '',
        phone: '',
      },
      orderPositions: [
        {
          id: 'op-test-1',
          description: 'Testleistung',
          plannedQuantity: 10,
          executedQuantity: 10,
          unit: 'Stunden',
          unitPrice: 65,
          category: 'arbeit',
        },
      ],
    }),
  ]);
  return profile;
}

function prepareFixedAbschlag(amount: number, periodFrom: string, periodTo: string) {
  const base = buildAbschlagDraft('v-pauschal-1', testSetup);
  expect(base).not.toBeNull();
  let draft = setAbschlagDraftCalculationMode(base!, 'fixed_amount', testSetup);
  draft = updateInvoiceDraftFixedAmountNet(draft, amount);
  draft = updateInvoiceDraftMetadata(draft, {
    issueDate: '2026-06-01',
    servicePeriodFrom: periodFrom,
    servicePeriodTo: periodTo,
    paymentDueDate: '2026-06-15',
  });
  draft = {
    ...draft,
    companySnapshot: {
      ...draft.companySnapshot,
      companyName: 'Muster Handwerk GmbH',
      street: 'Werkstraße 1',
      zip: '80331',
      city: 'München',
    },
  };
  return draft;
}

beforeEach(() => {
  resetTestStores();
  seedReadyVorgang();
});

describe('PAUSCHALER-ABSCHLAG-01', () => {
  it('1–5 — fixed draft: amount, empty positions, metadata, validate, finalize', () => {
    const draft = prepareFixedAbschlag(10000, '2026-05-01', '2026-05-31');
    expect(draft.calculationMode).toBe('fixed_amount');
    expect(draft.fixedAmountNet).toBe(10000);
    expect(draft.positions).toEqual([]);

    const validation = validateInvoiceDraftForApproval(
      draft,
      draft.companySnapshot,
      getVorgangById('v-pauschal-1'),
    );
    expect(validation.blockingErrors.map((e) => e.code)).not.toContain('no_positions');
    expect(validation.blockingErrors).toHaveLength(0);

    const result = finalizeInvoiceDraft('v-pauschal-1', draft, testSetup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.calculationMode).toBe('fixed_amount');
    expect(result.invoice.fixedAmountNet).toBe(10000);
    expect(result.invoice.positions).toEqual([]);
    expect(result.invoice.number).toMatch(/^\d{4}-\d{4}$/);
    expect(result.invoice.servicePeriodFrom).toBe('2026-05-01');
    expect(result.invoice.servicePeriodTo).toBe('2026-05-31');
  });

  it('8 — Netto/Steuer/Brutto from fixedAmountNet', () => {
    const draft = prepareFixedAbschlag(10000, '2026-05-01', '2026-05-31');
    const totals = calculateInvoiceTotals(draft, testSetup);
    expect(totals.subtotal).toBe(10000);
    expect(totals.taxRate).toBe(19);
    expect(totals.tax).toBeCloseTo(1900, 2);
    expect(totals.total).toBeCloseTo(11900, 2);
  });

  it('6–7,9 — number + period immutable after finalize; content fingerprint stable', () => {
    const draft = prepareFixedAbschlag(5000, '2026-04-01', '2026-04-30');
    const fp = buildInvoiceFinalizationContentFingerprint(draft, testSetup);
    const first = finalizeInvoiceDraft('v-pauschal-1', draft, testSetup);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const stored = getVorgangById('v-pauschal-1')!.invoices[0]!;
    expect(stored.number).toBe(first.invoice.number);
    expect(stored.fixedAmountNet).toBe(5000);
    expect(stored.servicePeriodFrom).toBe('2026-04-01');

    const candidate = buildInvoiceFinalizationCandidate(
      'v-pauschal-1',
      draft,
      testSetup,
      first.invoice.id,
    );
    expect(candidate.ok).toBe(true);
    expect(buildInvoiceFinalizationContentFingerprint(draft, testSetup)).toBe(fp);
  });

  it('10–12 — two fixed abschläge as separate Schluss deductions; billed qty unchanged', () => {
    const firstDraft = prepareFixedAbschlag(3000, '2026-01-01', '2026-01-31');
    const first = finalizeInvoiceDraft('v-pauschal-1', firstDraft, testSetup);
    expect(first.ok).toBe(true);

    const secondDraft = prepareFixedAbschlag(7000, '2026-02-01', '2026-02-28');
    const second = finalizeInvoiceDraft('v-pauschal-1', secondDraft, testSetup);
    expect(second.ok).toBe(true);

    const vorgang = getVorgangById('v-pauschal-1')!;
    expect(getBilledQuantity(vorgang, 'op-test-1')).toBe(0);
    expect(vorgang.orderPositions[0]!.plannedQuantity).toBe(10);

    const deductions = getPreviousAbschlagDeductions(vorgang);
    expect(deductions).toHaveLength(2);
    expect(deductions.map((d) => d.invoiceNumber).sort()).toEqual(
      [first.ok ? first.invoice.number : '', second.ok ? second.invoice.number : ''].sort(),
    );
    expect(deductions.map((d) => d.amount).sort((a, b) => a - b)).toEqual(
      [first.ok ? first.invoice.amount : 0, second.ok ? second.invoice.amount : 0].sort(
        (a, b) => a - b,
      ),
    );

    const schluss = buildSchlussrechnungDraft('v-pauschal-1', testSetup);
    expect(schluss).not.toBeNull();
    expect(schluss!.previousAbschlagDeductions).toHaveLength(2);
    expect(schluss!.positions.some((p) => p.quantity > 0 || p.openQuantity > 0)).toBe(true);
  });

  it('13 — finalize idempotent upsert keeps single invoice', () => {
    const draft = prepareFixedAbschlag(2500, '2026-03-01', '2026-03-15');
    const candidate = buildInvoiceFinalizationCandidate(
      'v-pauschal-1',
      draft,
      testSetup,
      'inv-fixed-idem',
    );
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    const numbered = { ...candidate.invoice, number: '2026-0099' };
    const a = upsertFinalizedInvoiceOnVorgang('v-pauschal-1', numbered);
    const b = upsertFinalizedInvoiceOnVorgang('v-pauschal-1', numbered);
    expect(a.ok && b.ok).toBe(true);
    expect(getVorgangById('v-pauschal-1')!.invoices).toHaveLength(1);
  });

  it('14–15 — cloud outbound/inbound preserves mode, amount, empty positions, metadata', () => {
    const draft = prepareFixedAbschlag(10000, '2026-05-01', '2026-05-31');
    const finalized = finalizeInvoiceDraft('v-pauschal-1', draft, testSetup);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;

    const payload = buildWorkspaceInvoiceFinalizePayload(finalized.invoice);
    expect(payload.calculationMode).toBe('fixed_amount');
    expect(payload.fixedAmountNet).toBe(10000);
    expect(payload.positions).toEqual([]);
    expect(payload.servicePeriodFrom).toBe('2026-05-01');
    expect(payload.baustelle).toBe('Teststraße 1');

    const mapped = mapCloudPayloadToVorgangInvoice({
      ...payload,
      id: finalized.invoice.id,
      number: finalized.invoice.number,
      status: 'vorbereitet',
      createdAt: finalized.invoice.createdAt,
      date: finalized.invoice.date,
    });
    expect(mapped.calculationMode).toBe('fixed_amount');
    expect(mapped.fixedAmountNet).toBe(10000);
    expect(mapped.positions).toEqual([]);
    expect(mapped.servicePeriodFrom).toBe('2026-05-01');
    expect(mapped.servicePeriodTo).toBe('2026-05-31');
    expect(mapped.paymentDueDate).toBe('2026-06-15');
    expect(mapped.baustelle).toBe('Teststraße 1');
  });

  it('16 — quantity-based Abschlag regression unchanged', () => {
    const draft = prepareFixedAbschlag(1, '2026-05-01', '2026-05-31');
    let qtyDraft = setAbschlagDraftCalculationMode(draft, 'quantity_based', testSetup);
    expect(resolveInvoiceCalculationMode(qtyDraft)).toBe('quantity_based');
    expect(qtyDraft.positions.length).toBeGreaterThan(0);
    qtyDraft = {
      ...qtyDraft,
      positions: qtyDraft.positions.map((p, index) =>
        index === 0 ? { ...p, quantity: 3 } : p,
      ),
    };
    const result = finalizeInvoiceDraft('v-pauschal-1', qtyDraft, testSetup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.calculationMode).toBe('quantity_based');
    expect(result.invoice.fixedAmountNet).toBeUndefined();
    expect(result.invoice.positions).toHaveLength(1);
    expect(getBilledQuantity(getVorgangById('v-pauschal-1')!, 'op-test-1')).toBe(3);
  });

  it('17–19 — reject mixed mode, zero/negative amount, no_positions for quantity', () => {
    const mixed = prepareFixedAbschlag(1000, '2026-05-01', '2026-05-31');
    mixed.positions = [
      {
        id: 'draft-pos-op-test-1',
        orderPositionId: 'op-test-1',
        description: 'leak',
        plannedQuantity: 10,
        billedQuantity: 0,
        openQuantity: 10,
        quantity: 1,
        unit: 'Stunden',
        unitPrice: 65,
        billable: true,
      },
    ];
    expect(
      validateInvoiceDraftForApproval(
        mixed,
        mixed.companySnapshot,
        getVorgangById('v-pauschal-1'),
      ).blockingErrors.some((e) => e.code === 'fixed_amount_with_positions'),
    ).toBe(true);

    const ready = prepareFixedAbschlag(1000, '2026-05-01', '2026-05-31');
    const zero = updateInvoiceDraftFixedAmountNet(ready, 0);
    expect(
      validateInvoiceDraftForApproval(
        zero,
        zero.companySnapshot,
        getVorgangById('v-pauschal-1'),
      ).blockingErrors.some((e) => e.code === 'fixed_amount_net'),
    ).toBe(true);

    const negative = updateInvoiceDraftFixedAmountNet(ready, -10);
    expect(
      validateInvoiceDraftForApproval(
        negative,
        negative.companySnapshot,
        getVorgangById('v-pauschal-1'),
      ).blockingErrors.some((e) => e.code === 'fixed_amount_net'),
    ).toBe(true);

    const qty = setAbschlagDraftCalculationMode(ready, 'quantity_based', testSetup);
    expect(
      validateInvoiceDraftForApproval(
        qty,
        qty.companySnapshot,
        getVorgangById('v-pauschal-1'),
      ).blockingErrors.some((e) => e.code === 'no_positions'),
    ).toBe(true);
  });

  it('20 — print has synthetic line; persisted invoice has empty positions', () => {
    const draft = prepareFixedAbschlag(10000, '2026-05-01', '2026-05-31');
    const print = buildInvoicePrintModel(draft, testSetup);
    expect(print.positions).toHaveLength(1);
    expect(print.positions[0]!.description).toBe(FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION);
    expect(print.positions[0]!.lineTotal).toBe(10000);

    const finalized = finalizeInvoiceDraft('v-pauschal-1', draft, testSetup);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;
    expect(finalized.invoice.positions).toEqual([]);
    const fromInvoice = buildInvoicePrintModelFromInvoice(finalized.invoice);
    expect(fromInvoice.positions).toHaveLength(1);
    expect(fromInvoice.positions[0]!.description).toBe(FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION);
  });

  it('mode switch clears inactive basis', () => {
    let draft = prepareFixedAbschlag(8000, '2026-05-01', '2026-05-31');
    draft = setAbschlagDraftCalculationMode(draft, 'quantity_based', testSetup);
    expect(draft.calculationMode).toBe('quantity_based');
    expect(draft.fixedAmountNet).toBeUndefined();
    expect(draft.positions.length).toBeGreaterThan(0);

    draft = setAbschlagDraftCalculationMode(draft, 'fixed_amount', testSetup);
    expect(draft.positions).toEqual([]);
    expect(draft.calculationMode).toBe('fixed_amount');
  });
});

