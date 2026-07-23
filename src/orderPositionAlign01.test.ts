import { beforeEach, describe, expect, it } from 'vitest';
import { createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import {
  addNegotiationPriceProposal,
  prepareNegotiationDraft,
  startContractNegotiation,
} from './services/contractNegotiationService';
import {
  confirmContractOrder,
  tryUpdateContractConfirmationSnapshot,
} from './services/contractConfirmationService';
import {
  orderPositionsMatchSnapshot,
} from './services/contractPositionAlignService';
import {
  getVorgangById,
  hydrateVorgangStore,
  saveVorgangContractConfirmation,
} from './services/vorgangService';
import type { ContractConfirmationSnapshot, ContractNegotiationState } from './types/models';

describe('ORDER-POSITION-ALIGN-01', () => {
  beforeEach(() => {
    resetTestStores();
  });

  function seedReadyToConfirm(id: string) {
    hydrateVorgangStore([
      createTestVorgang({
        id,
        status: 'in_pruefung',
        orderPositions: [
          createOrderPosition({
            id: 'op-a',
            description: 'Position A',
            unitPrice: 22,
            unit: 'm²',
            plannedQuantity: 10,
            category: 'arbeit',
            billable: true,
          }),
          createOrderPosition({
            id: 'op-b',
            description: 'Position B',
            unitPrice: 40,
            unit: 'Stunden',
            plannedQuantity: 5,
            category: 'material',
            billable: false,
          }),
        ],
      }),
    ]);
    startContractNegotiation(id);
    addNegotiationPriceProposal(id, {
      orderPositionId: 'op-a',
      proposedUnitPrice: 25,
    });
    prepareNegotiationDraft(id, 'price_change');
  }

  it('Snapshot und orderPositions identisch nach Confirmation', () => {
    seedReadyToConfirm('v-align-full');
    const result = confirmContractOrder('v-align-full');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const vorgang = getVorgangById('v-align-full')!;
    expect(orderPositionsMatchSnapshot(vorgang.orderPositions, vorgang.contractConfirmation!)).toBe(
      true,
    );
    expect(vorgang.orderPositions.map((p) => p.id)).toEqual(
      vorgang.contractConfirmation!.positions.map((p) => p.id),
    );
  });

  it('Preise identisch', () => {
    seedReadyToConfirm('v-align-price');
    confirmContractOrder('v-align-price');
    const vorgang = getVorgangById('v-align-price')!;
    expect(vorgang.orderPositions[0]?.unitPrice).toBe(25);
    expect(vorgang.contractConfirmation?.positions[0]?.unitPrice).toBe(25);
    expect(vorgang.orderPositions[1]?.unitPrice).toBe(40);
    expect(vorgang.contractConfirmation?.positions[1]?.unitPrice).toBe(40);
  });

  it('Mengen identisch', () => {
    seedReadyToConfirm('v-align-qty');
    confirmContractOrder('v-align-qty');
    const vorgang = getVorgangById('v-align-qty')!;
    expect(vorgang.orderPositions.map((p) => p.plannedQuantity)).toEqual(
      vorgang.contractConfirmation!.positions.map((p) => p.plannedQuantity),
    );
  });

  it('Reihenfolge identisch', () => {
    seedReadyToConfirm('v-align-order');
    confirmContractOrder('v-align-order');
    const vorgang = getVorgangById('v-align-order')!;
    expect(vorgang.orderPositions.map((p) => p.id)).toEqual(['op-a', 'op-b']);
    expect(vorgang.contractConfirmation!.positions.map((p) => p.id)).toEqual(['op-a', 'op-b']);
  });

  it('billable identisch', () => {
    seedReadyToConfirm('v-align-billable');
    confirmContractOrder('v-align-billable');
    const vorgang = getVorgangById('v-align-billable')!;
    expect(vorgang.orderPositions.map((p) => p.billable)).toEqual([true, false]);
    expect(vorgang.contractConfirmation!.positions.map((p) => p.billable)).toEqual([true, false]);
  });

  it('Snapshot bleibt unveränderlich', () => {
    seedReadyToConfirm('v-align-immutable');
    const confirmed = confirmContractOrder('v-align-immutable');
    expect(confirmed.success).toBe(true);
    if (!confirmed.success) return;

    const mutate = tryUpdateContractConfirmationSnapshot('v-align-immutable', {
      ...confirmed.snapshot,
      positions: confirmed.snapshot.positions.map((p) => ({ ...p, unitPrice: 999 })),
    });
    expect(mutate.success).toBe(false);

    const stored = getVorgangById('v-align-immutable')!;
    expect(stored.contractConfirmation?.positions[0]?.unitPrice).toBe(25);
    expect(stored.orderPositions[0]?.unitPrice).toBe(25);
  });

  it('Fehler während Alignment erzeugt keine Teilbestätigung', () => {
    seedReadyToConfirm('v-align-fail');
    const before = structuredClone(getVorgangById('v-align-fail')!);

    const badSnapshot: ContractConfirmationSnapshot = {
      id: 'bad-snap',
      confirmedAt: new Date().toISOString(),
      customer: before.customer,
      auftraggeber: before.customer,
      baustelle: before.baustelle,
      title: before.title,
      positions: [
        {
          id: 'op-a',
          description: 'Position A',
          plannedQuantity: 10,
          unit: 'm²',
          unitPrice: Number.NaN,
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

    const closedNegotiation: ContractNegotiationState = {
      startedAt: before.negotiation?.startedAt,
      closed: true,
      completedAt: new Date().toISOString(),
      notes: [],
      generalHints: [],
      priceProposals: [],
      positionProposals: [],
      draft: null,
      draftHistory: [],
    };

    const failed = saveVorgangContractConfirmation(
      'v-align-fail',
      badSnapshot,
      closedNegotiation,
    );
    expect(failed.success).toBe(false);
    if (!failed.success) {
      expect(failed.errorKey).toBe('confirmation.alignFailed');
    }

    const after = getVorgangById('v-align-fail')!;
    expect(after.status).toBe('in_verhandlung');
    expect(after.contractConfirmation).toBeUndefined();
    expect(after.orderPositions[0]?.unitPrice).toBe(22);
    expect(after.negotiation?.closed).not.toBe(true);
  });

  it('Legacy-Fall wird korrekt migriert', () => {
    const legacySnapshot: ContractConfirmationSnapshot = {
      id: 'legacy-snap',
      confirmedAt: '2026-07-01T10:00:00.000Z',
      customer: 'Legacy Kunde',
      auftraggeber: 'Legacy Kunde',
      baustelle: 'Altstraße 1',
      title: 'Legacy Auftrag',
      positions: [
        {
          id: 'op-legacy',
          description: 'Position Legacy',
          plannedQuantity: 3,
          unit: 'm²',
          unitPrice: 25,
          category: 'arbeit',
          billable: true,
        },
      ],
      negotiation: {
        notes: ['alt'],
        generalHints: [],
        priceProposals: [],
        positionProposals: [],
        drafts: [],
      },
      immutable: true,
    };

    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-align-legacy',
        status: 'beauftragt',
        customer: 'Legacy Kunde',
        baustelle: 'Altstraße 1',
        title: 'Legacy Auftrag',
        orderPositions: [
          createOrderPosition({
            id: 'op-legacy',
            description: 'Position Legacy',
            plannedQuantity: 3,
            unit: 'm²',
            unitPrice: 22, // diverged from snapshot
            category: 'arbeit',
            billable: true,
          }),
        ],
        contractConfirmation: legacySnapshot,
        negotiation: {
          closed: true,
          completedAt: '2026-07-01T10:00:00.000Z',
          notes: ['alt'],
          generalHints: [],
          priceProposals: [],
          positionProposals: [],
          draft: null,
          draftHistory: [],
        },
      }),
    ]);

    const migrated = getVorgangById('v-align-legacy')!;
    expect(migrated.contractConfirmation?.positions[0]?.unitPrice).toBe(25);
    expect(migrated.orderPositions[0]?.unitPrice).toBe(25);
    expect(orderPositionsMatchSnapshot(migrated.orderPositions, migrated.contractConfirmation!)).toBe(
      true,
    );
    // Snapshot itself unchanged
    expect(migrated.contractConfirmation?.id).toBe('legacy-snap');
    expect(migrated.contractConfirmation?.confirmedAt).toBe('2026-07-01T10:00:00.000Z');
  });
});
