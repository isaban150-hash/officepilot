import { beforeEach, describe, expect, it } from 'vitest';
import {
  createAbschlagInvoice,
  createOrderPosition,
  createTestVorgang,
  testSetup,
} from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import {
  buildRechnungDraft,
  buildSchlussrechnungDraft,
  getBillableOpenQuantity,
  getBilledQuantity,
  getOpenQuantity,
  updateDraftPositionQuantity,
} from './services/invoiceService';
import { getVorgangById, hydrateVorgangStore } from './services/vorgangService';
import type { ContractConfirmationSnapshot } from './types/models';

describe('INVOICE-BILLING-BASE-01', () => {
  beforeEach(() => {
    resetTestStores();
  });

  const snapshot: ContractConfirmationSnapshot = {
    id: 'snap-bill-1',
    confirmedAt: '2026-07-23T12:00:00.000Z',
    customer: 'Test Kunde',
    auftraggeber: 'Test Kunde',
    baustelle: 'Teststraße 1',
    title: 'Testvorgang',
    positions: [
      {
        id: 'op-test-1',
        description: 'Testleistung',
        plannedQuantity: 10,
        unit: 'Stunden',
        unitPrice: 65,
        category: 'arbeit',
        billable: true,
      },
    ],
    negotiation: {
      notes: [],
      generalHints: [],
      priceProposals: [],
      positionProposals: [],
      drafts: [],
    },
    immutable: true,
  };

  function seed(overrides: Parameters<typeof createTestVorgang>[0] = {}) {
    const vorgang = createTestVorgang({
      status: 'in_bearbeitung',
      contractConfirmation: structuredClone(snapshot),
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          plannedQuantity: 10,
          unitPrice: 65,
        }),
      ],
      ...overrides,
    });
    hydrateVorgangStore([vorgang]);
    return getVorgangById(vorgang.id)!;
  }

  it('Draft ohne executedQuantity nutzt Fallback auf plannedQuantity', () => {
    seed();
    const draft = buildRechnungDraft('v-test-1', testSetup)!;
    expect(draft.positions[0].executedQuantity).toBeUndefined();
    expect(draft.positions[0].openQuantity).toBe(10);
    expect(draft.positions[0].quantity).toBe(10);
    expect(getBillableOpenQuantity(getVorgangById('v-test-1')!, 'op-test-1')).toBe(10);
  });

  it('Draft mit executedQuantity schlägt billableOpen vor', () => {
    seed({
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          plannedQuantity: 10,
          executedQuantity: 6,
          unitPrice: 65,
        }),
      ],
    });

    const draft = buildRechnungDraft('v-test-1', testSetup)!;
    expect(draft.positions[0].executedQuantity).toBe(6);
    expect(draft.positions[0].openQuantity).toBe(6);
    expect(draft.positions[0].quantity).toBe(6);
    expect(getOpenQuantity(getVorgangById('v-test-1')!, 'op-test-1')).toBe(6);
  });

  it('Teilabrechnung: billableOpen = min(planned, executed) − billed', () => {
    seed({
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          plannedQuantity: 10,
          executedQuantity: 8,
          unitPrice: 65,
        }),
      ],
      invoices: [createAbschlagInvoice('op-test-1', 3)],
    });

    expect(getBilledQuantity(getVorgangById('v-test-1')!, 'op-test-1')).toBe(3);
    expect(getBillableOpenQuantity(getVorgangById('v-test-1')!, 'op-test-1')).toBe(5);

    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;
    expect(draft.positions[0].billedQuantity).toBe(3);
    expect(draft.positions[0].openQuantity).toBe(5);
    expect(draft.positions[0].quantity).toBe(5);
  });

  it('billableOpen ist niemals negativ', () => {
    seed({
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          plannedQuantity: 10,
          executedQuantity: 2,
          unitPrice: 65,
        }),
      ],
      invoices: [createAbschlagInvoice('op-test-1', 5)],
    });

    expect(getBillableOpenQuantity(getVorgangById('v-test-1')!, 'op-test-1')).toBe(0);
  });

  it('executedQuantity über planned wird auf planned gekappt', () => {
    seed({
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          plannedQuantity: 10,
          executedQuantity: 15,
          unitPrice: 65,
        }),
      ],
    });

    expect(getBillableOpenQuantity(getVorgangById('v-test-1')!, 'op-test-1')).toBe(10);
  });

  it('quantity > billableOpen wird abgelehnt', () => {
    seed({
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          plannedQuantity: 10,
          executedQuantity: 4,
          unitPrice: 65,
        }),
      ],
    });

    const draft = buildRechnungDraft('v-test-1', testSetup)!;
    expect(draft.positions[0].quantity).toBe(4);

    const rejected = updateDraftPositionQuantity(draft, draft.positions[0].id, 5);
    expect(rejected.positions[0].quantity).toBe(4);

    const accepted = updateDraftPositionQuantity(draft, draft.positions[0].id, 2);
    expect(accepted.positions[0].quantity).toBe(2);

    const negativeRejected = updateDraftPositionQuantity(draft, draft.positions[0].id, -1);
    expect(negativeRejected.positions[0].quantity).toBe(4);
  });

  it('Snapshot und orderPositions bleiben beim Draft unverändert; keine Invoice Lines', () => {
    const before = seed({
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          plannedQuantity: 10,
          executedQuantity: 7,
          unitPrice: 65,
        }),
      ],
    });
    const snapBefore = structuredClone(before.contractConfirmation!);
    const positionsBefore = structuredClone(before.orderPositions);
    const invoicesBefore = structuredClone(before.invoices);

    const draft = buildRechnungDraft('v-test-1', testSetup)!;
    expect(draft.positions[0].quantity).toBe(7);

    // Confirm-first: user may lower quantity without writing invoices.
    updateDraftPositionQuantity(draft, draft.positions[0].id, 3);

    const after = getVorgangById('v-test-1')!;
    expect(after.contractConfirmation).toEqual(snapBefore);
    expect(after.orderPositions).toEqual(positionsBefore);
    expect(after.invoices).toEqual(invoicesBefore);
    expect(after.orderPositions[0].plannedQuantity).toBe(10);
    expect(after.orderPositions[0].executedQuantity).toBe(7);
  });
});
