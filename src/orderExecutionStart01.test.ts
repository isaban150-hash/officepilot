import { beforeEach, describe, expect, it } from 'vitest';
import { createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import { startOrderExecution } from './services/orderExecutionStartService';
import { orderPositionsMatchSnapshot } from './services/contractPositionAlignService';
import { getVorgangById, hydrateVorgangStore } from './services/vorgangService';
import type { ContractConfirmationSnapshot } from './types/models';

describe('ORDER-EXECUTION-START-01', () => {
  beforeEach(() => {
    resetTestStores();
  });

  const snapshot: ContractConfirmationSnapshot = {
    id: 'snap-exec-1',
    confirmedAt: '2026-07-23T12:00:00.000Z',
    customer: 'Test Kunde',
    auftraggeber: 'Test Kunde',
    baustelle: 'Teststraße 1',
    title: 'Testvorgang',
    positions: [
      {
        id: 'op-exec-1',
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

  function seedBeauftragt(id: string, withSnapshot = true) {
    hydrateVorgangStore([
      createTestVorgang({
        id,
        status: 'beauftragt',
        orderPositions: [
          createOrderPosition({
            id: 'op-exec-1',
            description: 'Position 1',
            plannedQuantity: 10,
            unit: 'm²',
            unitPrice: 25,
            category: 'arbeit',
            billable: true,
          }),
        ],
        contractConfirmation: withSnapshot ? structuredClone(snapshot) : undefined,
        negotiation: {
          closed: true,
          completedAt: '2026-07-23T12:00:00.000Z',
          notes: [],
          generalHints: [],
          priceProposals: [],
          positionProposals: [],
          draft: null,
          draftHistory: [],
        },
      }),
    ]);
  }

  it('Start nur bei Status beauftragt', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-exec-status',
        status: 'in_verhandlung',
        contractConfirmation: structuredClone(snapshot),
        orderPositions: [createOrderPosition({ id: 'op-exec-1', unitPrice: 25 })],
      }),
    ]);

    const result = startOrderExecution('v-exec-status');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKey).toBe('execution.notBeauftragt');
    }
    expect(getVorgangById('v-exec-status')?.status).toBe('in_verhandlung');
    expect(getVorgangById('v-exec-status')?.executionStartedAt).toBeUndefined();
  });

  it('Start nur mit vorhandenem Snapshot', () => {
    seedBeauftragt('v-exec-nosnap', false);
    const result = startOrderExecution('v-exec-nosnap');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKey).toBe('execution.snapshotRequired');
    }
    expect(getVorgangById('v-exec-nosnap')?.status).toBe('beauftragt');
    expect(getVorgangById('v-exec-nosnap')?.executionStartedAt).toBeUndefined();
  });

  it('Statuswechsel nach in_bearbeitung', () => {
    seedBeauftragt('v-exec-run');
    const result = startOrderExecution('v-exec-run');
    expect(result.success).toBe(true);
    expect(getVorgangById('v-exec-run')?.status).toBe('in_bearbeitung');
  });

  it('executionStartedAt wird gesetzt', () => {
    seedBeauftragt('v-exec-ts');
    const before = Date.now();
    const result = startOrderExecution('v-exec-ts');
    const after = Date.now();
    expect(result.success).toBe(true);
    const startedAt = getVorgangById('v-exec-ts')?.executionStartedAt;
    expect(startedAt).toBeTruthy();
    const parsed = Date.parse(startedAt!);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(after + 1000);
  });

  it('Snapshot bleibt unverändert', () => {
    seedBeauftragt('v-exec-snap');
    const beforeSnap = structuredClone(getVorgangById('v-exec-snap')!.contractConfirmation!);
    startOrderExecution('v-exec-snap');
    expect(getVorgangById('v-exec-snap')?.contractConfirmation).toEqual(beforeSnap);
  });

  it('orderPositions bleiben unverändert', () => {
    seedBeauftragt('v-exec-pos');
    const beforePositions = structuredClone(getVorgangById('v-exec-pos')!.orderPositions);
    startOrderExecution('v-exec-pos');
    const after = getVorgangById('v-exec-pos')!;
    expect(after.orderPositions).toEqual(beforePositions);
    expect(orderPositionsMatchSnapshot(after.orderPositions, after.contractConfirmation!)).toBe(
      true,
    );
  });

  it('Fehler erzeugt keine Teiländerung', () => {
    seedBeauftragt('v-exec-partial', false);
    const before = structuredClone(getVorgangById('v-exec-partial')!);
    const failed = startOrderExecution('v-exec-partial');
    expect(failed.success).toBe(false);

    const after = getVorgangById('v-exec-partial')!;
    expect(after.status).toBe(before.status);
    expect(after.executionStartedAt).toBeUndefined();
    expect(after.orderPositions).toEqual(before.orderPositions);
    expect(after.contractConfirmation).toEqual(before.contractConfirmation);
  });
});
