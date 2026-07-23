import { beforeEach, describe, expect, it } from 'vitest';
import { createAbschlagInvoice, createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import {
  getBilledQuantity,
  getOpenQuantity,
  getPositionBillingStatus,
} from './services/orderBillingRules';
import {
  getVorgangById,
  hydrateVorgangStore,
  updateOrderPositionExecutedQuantity,
} from './services/vorgangService';
import type { ContractConfirmationSnapshot } from './types/models';

describe('ORDER-EXECUTION-QTY-01', () => {
  beforeEach(() => {
    resetTestStores();
  });

  const snapshot: ContractConfirmationSnapshot = {
    id: 'snap-qty-1',
    confirmedAt: '2026-07-23T12:00:00.000Z',
    customer: 'Test Kunde',
    auftraggeber: 'Test Kunde',
    baustelle: 'Teststraße 1',
    title: 'Testvorgang',
    positions: [
      {
        id: 'op-qty-1',
        description: 'Position 1',
        plannedQuantity: 10,
        unit: 'm²',
        unitPrice: 25,
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

  function seedRunning(id: string, overrides: { status?: 'beauftragt' | 'in_bearbeitung'; started?: boolean } = {}) {
    const status = overrides.status ?? 'in_bearbeitung';
    const started = overrides.started ?? status === 'in_bearbeitung';
    hydrateVorgangStore([
      createTestVorgang({
        id,
        status,
        executionStartedAt: started ? '2026-07-23T14:00:00.000Z' : undefined,
        orderPositions: [
          createOrderPosition({
            id: 'op-qty-1',
            description: 'Position 1',
            plannedQuantity: 10,
            unit: 'm²',
            unitPrice: 25,
            category: 'arbeit',
            billable: true,
          }),
        ],
        contractConfirmation: structuredClone(snapshot),
        invoices: [
          createAbschlagInvoice('op-qty-1', 2, {
            id: 'inv-qty-1',
            status: 'versendet',
          }),
        ],
      }),
    ]);
  }

  it('executedQuantity speichern', () => {
    seedRunning('v-qty-save');
    const result = updateOrderPositionExecutedQuantity('v-qty-save', 'op-qty-1', 4);
    expect(result.success).toBe(true);
    expect(getVorgangById('v-qty-save')?.orderPositions[0]?.executedQuantity).toBe(4);
  });

  it('Änderung nur bei in_bearbeitung', () => {
    seedRunning('v-qty-status', { status: 'beauftragt', started: false });
    // Force beauftragt with snapshot but also set a fake startedAt to isolate status rule:
    hydrateVorgangStore([
      {
        ...getVorgangById('v-qty-status')!,
        status: 'beauftragt',
        executionStartedAt: '2026-07-23T14:00:00.000Z',
      },
    ]);
    const result = updateOrderPositionExecutedQuantity('v-qty-status', 'op-qty-1', 3);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKey).toBe('execution.qty.notAllowed');
    }
    expect(getVorgangById('v-qty-status')?.orderPositions[0]?.executedQuantity).toBeUndefined();
  });

  it('Änderung nur mit executionStartedAt', () => {
    seedRunning('v-qty-nostart');
    hydrateVorgangStore([
      {
        ...getVorgangById('v-qty-nostart')!,
        status: 'in_bearbeitung',
        executionStartedAt: undefined,
      },
    ]);
    const result = updateOrderPositionExecutedQuantity('v-qty-nostart', 'op-qty-1', 3);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKey).toBe('execution.qty.notAllowed');
    }
    expect(getVorgangById('v-qty-nostart')?.orderPositions[0]?.executedQuantity).toBeUndefined();
  });

  it('negative Werte werden abgelehnt', () => {
    seedRunning('v-qty-neg');
    const result = updateOrderPositionExecutedQuantity('v-qty-neg', 'op-qty-1', -1);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKey).toBe('execution.qty.invalid');
    }
    expect(getVorgangById('v-qty-neg')?.orderPositions[0]?.executedQuantity).toBeUndefined();
  });

  it('plannedQuantity bleibt unverändert', () => {
    seedRunning('v-qty-plan');
    updateOrderPositionExecutedQuantity('v-qty-plan', 'op-qty-1', 7);
    expect(getVorgangById('v-qty-plan')?.orderPositions[0]?.plannedQuantity).toBe(10);
  });

  it('Snapshot bleibt unverändert', () => {
    seedRunning('v-qty-snap');
    const before = structuredClone(getVorgangById('v-qty-snap')!.contractConfirmation!);
    updateOrderPositionExecutedQuantity('v-qty-snap', 'op-qty-1', 6);
    expect(getVorgangById('v-qty-snap')?.contractConfirmation).toEqual(before);
  });

  it('Rechnungsdaten bleiben unverändert', () => {
    seedRunning('v-qty-inv');
    const before = getVorgangById('v-qty-inv')!;
    const billedBefore = getBilledQuantity(before, 'op-qty-1');
    const openBefore = getOpenQuantity(before, 'op-qty-1');
    const billingBefore = getPositionBillingStatus(before, 'op-qty-1');
    const invoicesBefore = structuredClone(before.invoices);

    updateOrderPositionExecutedQuantity('v-qty-inv', 'op-qty-1', 8);

    const after = getVorgangById('v-qty-inv')!;
    expect(after.invoices).toEqual(invoicesBefore);
    expect(getBilledQuantity(after, 'op-qty-1')).toBe(billedBefore);
    expect(getOpenQuantity(after, 'op-qty-1')).toBe(openBefore);
    expect(getPositionBillingStatus(after, 'op-qty-1')).toEqual(billingBefore);
    expect(after.orderPositions[0]?.executedQuantity).toBe(8);
  });

  it('kein Teilupdate bei Fehler', () => {
    seedRunning('v-qty-partial');
    const before = structuredClone(getVorgangById('v-qty-partial')!);
    const failed = updateOrderPositionExecutedQuantity('v-qty-partial', 'missing-op', 2);
    expect(failed.success).toBe(false);

    const after = getVorgangById('v-qty-partial')!;
    expect(after.orderPositions).toEqual(before.orderPositions);
    expect(after.contractConfirmation).toEqual(before.contractConfirmation);
    expect(after.invoices).toEqual(before.invoices);
    expect(after.status).toBe(before.status);
  });
});
