import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAbschlagInvoice, createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import {
  addNegotiationPriceProposal,
  prepareNegotiationDraft,
  startContractNegotiation,
} from './services/contractNegotiationService';
import { confirmContractOrder } from './services/contractConfirmationService';
import {
  buildContractPositionKey,
  confirmImportContractPositions,
} from './services/contractPositionImportService';
import { importSuggestedPositionsToVorgang } from './services/intakeWorkflowService';
import {
  getBillableOpenQuantity,
  getBilledQuantity,
} from './services/orderBillingRules';
import * as orderPlanIntegrityService from './services/orderPlanIntegrityService';
import {
  ORDER_PLAN_AMENDMENT_REQUIRED,
  assertContractPlanMutable,
  contractPlanMatchesSnapshot,
  isContractPlanLocked,
  repairContractPlanFromSnapshot,
} from './services/orderPlanIntegrityService';
import { orderPositionsMatchSnapshot } from './services/contractPositionAlignService';
import { startOrderExecution } from './services/orderExecutionStartService';
import * as vorgangService from './services/vorgangService';
import {
  addOrderPosition,
  appendOrderPositionsBulk,
  getVorgangById,
  hydrateVorgangStore,
  removeOrderPosition,
  updateOrderPosition,
  updateOrderPositionExecutedQuantity,
} from './services/vorgangService';
import {
  mergeCloudVorgangIntoLocal,
  stripVorgangForCloud,
} from './services/vorgang/vorgangCloudService';
import type { ContractConfirmationSnapshot, DetectedOrderPosition } from './types/models';

function confirmedSnapshot(
  overrides: Partial<ContractConfirmationSnapshot> = {},
): ContractConfirmationSnapshot {
  return {
    id: 'snap-integrity-1',
    confirmedAt: '2026-07-24T10:00:00.000Z',
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
    ...overrides,
  };
}

function seedConfirmed(id = 'v-test-1', extras: Parameters<typeof createTestVorgang>[0] = {}) {
  hydrateVorgangStore([
    createTestVorgang({
      id,
      status: 'beauftragt',
      contractConfirmation: confirmedSnapshot(),
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          description: 'Testleistung',
          plannedQuantity: 10,
          unit: 'Stunden',
          unitPrice: 65,
          category: 'arbeit',
          billable: true,
        }),
      ],
      ...extras,
    }),
  ]);
  return getVorgangById(id)!;
}

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

describe('ORDER-PLAN-INTEGRITY-01 domain locks', () => {
  beforeEach(() => {
    resetTestStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('addOrderPosition nach Confirmation wird abgelehnt', () => {
    seedConfirmed();
    const result = addOrderPosition('v-test-1', {
      description: 'Neu',
      plannedQuantity: 1,
      unit: 'Stück',
      unitPrice: 10,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKey).toBe(ORDER_PLAN_AMENDMENT_REQUIRED);
  });

  it('appendOrderPositionsBulk nach Confirmation wird abgelehnt', () => {
    seedConfirmed();
    const result = appendOrderPositionsBulk('v-test-1', [
      {
        description: 'Bulk',
        plannedQuantity: 1,
        unit: 'Stück',
        unitPrice: 5,
      },
    ]);
    expect(result.success).toBe(false);
    expect(result.errorKey).toBe(ORDER_PLAN_AMENDMENT_REQUIRED);
  });

  it('updateOrderPosition nach Confirmation wird für jedes vertragsrelevante Feld abgelehnt', () => {
    seedConfirmed();
    const fields = [
      { description: 'Geändert' },
      { plannedQuantity: 99 },
      { unit: 'm²' as const },
      { unitPrice: 1 },
      { category: 'material' as const },
      { billable: false },
    ];
    for (const changes of fields) {
      const result = updateOrderPosition('v-test-1', 'op-test-1', changes);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.errorKey).toBe(ORDER_PLAN_AMENDMENT_REQUIRED);
    }
  });

  it('removeOrderPosition nach Confirmation wird auch bei unbilled Position abgelehnt', () => {
    seedConfirmed();
    expect(getBilledQuantity(getVorgangById('v-test-1')!, 'op-test-1')).toBe(0);
    const result = removeOrderPosition('v-test-1', 'op-test-1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKey).toBe(ORDER_PLAN_AMENDMENT_REQUIRED);
  });

  it('Import nach Confirmation wird abgelehnt', () => {
    seedConfirmed();
    const detected: DetectedOrderPosition[] = [
      {
        description: 'Importiert',
        quantity: 2,
        unit: 'm²',
        unitPrice: 40,
        lineTotal: 80,
      },
    ];
    const importResult = importSuggestedPositionsToVorgang('v-test-1', detected);
    expect(importResult.success).toBe(false);
    expect(importResult.errorKey).toBe(ORDER_PLAN_AMENDMENT_REQUIRED);

    const key = buildContractPositionKey(detected[0]!);
    const confirmImport = confirmImportContractPositions('v-test-1', detected, {
      [key]: 'selected',
    });
    expect(confirmImport.success).toBe(false);
    expect(confirmImport.errorKey).toBe(ORDER_PLAN_AMENDMENT_REQUIRED);
  });

  it('Domain-Guard blockiert Import auch bei veraltetem UI-State (ohne Early-UX-Check)', () => {
    seedConfirmed();
    let assertCalls = 0;
    const earlySpy = vi
      .spyOn(orderPlanIntegrityService, 'assertContractPlanMutable')
      .mockImplementation((vorgang) => {
        assertCalls += 1;
        // First call simulates a stale UI that skipped the early UX gate.
        if (assertCalls === 1) return { ok: true };
        return vorgang.contractConfirmation
          ? { ok: false, errorKey: ORDER_PLAN_AMENDMENT_REQUIRED }
          : { ok: true };
      });

    const detected: DetectedOrderPosition[] = [
      {
        description: 'Stale UI Import',
        quantity: 1,
        unit: 'm²',
        unitPrice: 10,
        lineTotal: 10,
      },
    ];
    const importResult = importSuggestedPositionsToVorgang('v-test-1', detected);
    expect(importResult.success).toBe(false);
    expect(importResult.added).toBe(0);
    expect(importResult.errorKey).toBe(ORDER_PLAN_AMENDMENT_REQUIRED);
    expect(earlySpy).toHaveBeenCalled();
    expect(assertCalls).toBeGreaterThan(1);

    earlySpy.mockClear();
    assertCalls = 0;
    const key = buildContractPositionKey(detected[0]!);
    const confirmImport = confirmImportContractPositions('v-test-1', detected, {
      [key]: 'selected',
    });
    expect(confirmImport.success).toBe(false);
    expect(confirmImport.errorKey).toBe(ORDER_PLAN_AMENDMENT_REQUIRED);
  });

  it('fehlgeschlagener Bulk-Import reicht errorKey über importSuggestedPositionsToVorgang durch', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-bulk-err', status: 'eingegangen' })]);
    vi.spyOn(vorgangService, 'appendOrderPositionsBulk').mockReturnValue({
      success: false,
      added: 0,
      skipped: 0,
      errorKey: ORDER_PLAN_AMENDMENT_REQUIRED,
    });

    const detected: DetectedOrderPosition[] = [
      {
        description: 'Bulk Fail Pos',
        quantity: 2,
        unit: 'm²',
        unitPrice: 40,
        lineTotal: 80,
      },
    ];
    const result = importSuggestedPositionsToVorgang('v-bulk-err', detected);
    expect(result.success).toBe(false);
    expect(result.added).toBe(0);
    expect(result.errorKey).toBe(ORDER_PLAN_AMENDMENT_REQUIRED);
  });

  it('confirmImportContractPositions reicht Bulk-errorKey bis zur UI-Schicht durch', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-confirm-err', status: 'eingegangen' })]);
    vi.spyOn(vorgangService, 'appendOrderPositionsBulk').mockReturnValue({
      success: false,
      added: 0,
      skipped: 0,
      errorKey: ORDER_PLAN_AMENDMENT_REQUIRED,
    });

    const detected: DetectedOrderPosition[] = [
      {
        description: 'Confirm Fail Pos',
        quantity: 2,
        unit: 'm²',
        unitPrice: 40,
        lineTotal: 80,
      },
    ];
    const key = buildContractPositionKey(detected[0]!);
    const result = confirmImportContractPositions('v-confirm-err', detected, {
      [key]: 'selected',
    });
    expect(result.success).toBe(false);
    expect(result.added).toBe(0);
    expect(result.errorKey).toBe(ORDER_PLAN_AMENDMENT_REQUIRED);
  });

  it('dieselben Mutationen bleiben vor Confirmation erlaubt', () => {
    hydrateVorgangStore([createTestVorgang({ status: 'eingegangen' })]);
    expect(assertContractPlanMutable(getVorgangById('v-test-1')!).ok).toBe(true);

    const added = addOrderPosition('v-test-1', {
      description: 'Vor Confirm',
      plannedQuantity: 2,
      unit: 'Stück',
      unitPrice: 12,
    });
    expect(added.success).toBe(true);
    if (!added.success) return;

    const newId = added.vorgang.orderPositions.find((p) => p.description === 'Vor Confirm')!.id;
    expect(updateOrderPosition('v-test-1', newId, { unitPrice: 15 }).success).toBe(true);
    expect(removeOrderPosition('v-test-1', newId).success).toBe(true);
  });
});

describe('ORDER-PLAN-INTEGRITY-01 confirmation still works', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('Contract Confirmation kann weiterhin atomar Snapshot und orderPositions angleichen', () => {
    seedReadyToConfirm('v-confirm-ok');
    const result = confirmContractOrder('v-confirm-ok');
    expect(result.success).toBe(true);
    const vorgang = getVorgangById('v-confirm-ok')!;
    expect(isContractPlanLocked(vorgang)).toBe(true);
    expect(orderPositionsMatchSnapshot(vorgang.orderPositions, vorgang.contractConfirmation!)).toBe(
      true,
    );
    expect(vorgang.orderPositions[0]?.unitPrice).toBe(25);
  });

  it('erneute Confirmation bleibt weiterhin blockiert', () => {
    seedReadyToConfirm('v-confirm-twice');
    expect(confirmContractOrder('v-confirm-twice').success).toBe(true);
    const again = confirmContractOrder('v-confirm-twice');
    expect(again.success).toBe(false);
  });
});

describe('ORDER-PLAN-INTEGRITY-01 execution', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('executedQuantity bleibt nach Confirmation und Execution-Start editierbar', () => {
    seedConfirmed('v-exec', { status: 'beauftragt' });
    const started = startOrderExecution('v-exec');
    expect(started.success).toBe(true);
    const qty = updateOrderPositionExecutedQuantity('v-exec', 'op-test-1', 4);
    expect(qty.success).toBe(true);
    if (!qty.success) return;
    expect(qty.vorgang.orderPositions[0]?.executedQuantity).toBe(4);
    expect(qty.vorgang.orderPositions[0]?.plannedQuantity).toBe(10);
    expect(qty.vorgang.orderPositions[0]?.unitPrice).toBe(65);
  });

  it('Contract-Plan-Lock schwächt die bestehenden Execution-Gates nicht ab', () => {
    seedConfirmed('v-no-exec', { status: 'beauftragt', executionStartedAt: undefined });
    const qty = updateOrderPositionExecutedQuantity('v-no-exec', 'op-test-1', 3);
    expect(qty.success).toBe(false);
    if (!qty.success) expect(qty.errorKey).toBe('execution.qty.notAllowed');
  });
});

describe('ORDER-PLAN-INTEGRITY-01 hydrate / legacy repair', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('kommerzieller Drift wird aus dem Snapshot repariert; executedQuantity bleibt', () => {
    const snapshot = confirmedSnapshot({
      positions: [
        {
          id: 'op-legacy',
          description: 'Snapshot Text',
          plannedQuantity: 3,
          unit: 'm²',
          unitPrice: 25,
          category: 'arbeit',
          billable: true,
        },
      ],
    });

    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-drift',
        status: 'beauftragt',
        contractConfirmation: snapshot,
        orderPositions: [
          createOrderPosition({
            id: 'op-legacy',
            description: 'Drift Text',
            plannedQuantity: 99,
            unit: 'm²',
            unitPrice: 1,
            category: 'material',
            billable: false,
            executedQuantity: 2,
          }),
          createOrderPosition({
            id: 'op-extra',
            description: 'Extra Legacy',
            plannedQuantity: 1,
            unit: 'Stück',
            unitPrice: 9,
          }),
        ],
      }),
    ]);

    const migrated = getVorgangById('v-drift')!;
    expect(migrated.orderPositions).toHaveLength(1);
    expect(migrated.orderPositions[0]?.description).toBe('Snapshot Text');
    expect(migrated.orderPositions[0]?.plannedQuantity).toBe(3);
    expect(migrated.orderPositions[0]?.unitPrice).toBe(25);
    expect(migrated.orderPositions[0]?.category).toBe('arbeit');
    expect(migrated.orderPositions[0]?.billable).toBe(true);
    expect(migrated.orderPositions[0]?.executedQuantity).toBe(2);
    expect(contractPlanMatchesSnapshot(migrated)).toBe(true);

    const again = repairContractPlanFromSnapshot(migrated);
    expect(again.repaired).toBe(false);
  });

  it('Reihenfolge und Positionsmenge werden aus dem Snapshot wiederhergestellt', () => {
    const snapshot = confirmedSnapshot({
      positions: [
        {
          id: 'op-b',
          description: 'B',
          plannedQuantity: 2,
          unit: 'Stück',
          unitPrice: 10,
        },
        {
          id: 'op-a',
          description: 'A',
          plannedQuantity: 1,
          unit: 'Stück',
          unitPrice: 5,
        },
      ],
    });
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-order',
        status: 'beauftragt',
        contractConfirmation: snapshot,
        orderPositions: [
          createOrderPosition({ id: 'op-a', description: 'A', plannedQuantity: 1, unitPrice: 5 }),
          createOrderPosition({ id: 'op-b', description: 'B', plannedQuantity: 2, unitPrice: 10 }),
        ],
      }),
    ]);
    expect(getVorgangById('v-order')!.orderPositions.map((p) => p.id)).toEqual(['op-b', 'op-a']);
  });
});

describe('ORDER-PLAN-INTEGRITY-01 cloud merge', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('nach Cloud-Merge gewinnen Snapshot-Vertragsfelder; executedQuantity des Merge-Stands bleibt', () => {
    const snapshot = confirmedSnapshot();
    const local = createTestVorgang({
      id: 'v-cloud',
      status: 'in_bearbeitung',
      executionStartedAt: '2026-07-24T09:00:00.000Z',
      contractConfirmation: snapshot,
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          description: 'Testleistung',
          plannedQuantity: 10,
          unitPrice: 65,
          executedQuantity: 7,
        }),
      ],
      sync: {
        updatedAt: '2026-07-24T09:00:00.000Z',
        version: 0,
        deleted: false,
        deviceId: 'd1',
        workspaceId: 'ws-1',
      },
    });

    const cloudPayload = {
      ...stripVorgangForCloud(local),
      // Remote commercial drift; snapshot remains canonical for repair.
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          description: 'REMOTE DRIFT',
          plannedQuantity: 50,
          unitPrice: 1,
          executedQuantity: 3,
        }),
      ],
      contractConfirmation: snapshot,
    };

    const merged = mergeCloudVorgangIntoLocal(
      local,
      cloudPayload,
      2,
      '2026-07-24T11:00:00.000Z',
      false,
      'd2',
      'ws-1',
    );

    expect(merged.conflict).toBe(false);
    expect(merged.vorgang?.orderPositions[0]?.description).toBe('Testleistung');
    expect(merged.vorgang?.orderPositions[0]?.plannedQuantity).toBe(10);
    expect(merged.vorgang?.orderPositions[0]?.unitPrice).toBe(65);
    // executedQuantity from merge-selected remote shell, preserved by id through repair
    expect(merged.vorgang?.orderPositions[0]?.executedQuantity).toBe(3);
    expect(contractPlanMatchesSnapshot(merged.vorgang!)).toBe(true);

    const repairedAgain = repairContractPlanFromSnapshot(merged.vorgang!);
    expect(repairedAgain.repaired).toBe(false);
  });

  it('stripVorgangForCloud pusht keinen reparierbaren Vertragsdrift', () => {
    const snapshot = confirmedSnapshot();
    const drifted = createTestVorgang({
      id: 'v-push',
      status: 'beauftragt',
      contractConfirmation: snapshot,
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          description: 'Drift',
          plannedQuantity: 99,
          unitPrice: 1,
          executedQuantity: 4,
        }),
      ],
    });
    const stripped = stripVorgangForCloud(drifted);
    expect(stripped.orderPositions[0]?.description).toBe('Testleistung');
    expect(stripped.orderPositions[0]?.plannedQuantity).toBe(10);
    expect(stripped.orderPositions[0]?.unitPrice).toBe(65);
    expect(stripped.orderPositions[0]?.executedQuantity).toBe(4);
  });
});

describe('ORDER-PLAN-INTEGRITY-01 UI lock helpers', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('Vertragsplan-Lock steuert Add/Delete/Edit; executedQuantity bleibt bei gestarteter Ausführung', () => {
    const confirmed = seedConfirmed('v-ui', {
      status: 'in_bearbeitung',
      executionStartedAt: '2026-07-24T09:00:00.000Z',
    });
    expect(isContractPlanLocked(confirmed)).toBe(true);
    expect(assertContractPlanMutable(confirmed).ok).toBe(false);

    const qty = updateOrderPositionExecutedQuantity('v-ui', 'op-test-1', 5);
    expect(qty.success).toBe(true);

    hydrateVorgangStore([createTestVorgang({ id: 'v-open', status: 'eingegangen' })]);
    expect(isContractPlanLocked(getVorgangById('v-open')!)).toBe(false);
  });
});

describe('ORDER-PLAN-INTEGRITY-01 billing', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('abgelehnte Planmutation verändert billableOpen nicht; Invoice Lines bleiben bei Repair', () => {
    const invoice = createAbschlagInvoice('op-test-1', 2);
    seedConfirmed('v-bill', {
      status: 'in_bearbeitung',
      executionStartedAt: '2026-07-24T09:00:00.000Z',
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          plannedQuantity: 10,
          executedQuantity: 6,
          unitPrice: 65,
        }),
      ],
      invoices: [invoice],
    });

    const before = getVorgangById('v-bill')!;
    const openBefore = getBillableOpenQuantity(before, 'op-test-1');
    const invoicesBefore = structuredClone(before.invoices);

    expect(updateOrderPosition('v-bill', 'op-test-1', { plannedQuantity: 1 }).success).toBe(false);
    expect(getBillableOpenQuantity(getVorgangById('v-bill')!, 'op-test-1')).toBe(openBefore);

    hydrateVorgangStore([
      {
        ...getVorgangById('v-bill')!,
        orderPositions: [
          createOrderPosition({
            id: 'op-test-1',
            description: 'Drift',
            plannedQuantity: 1,
            unitPrice: 1,
            executedQuantity: 6,
          }),
        ],
      },
    ]);
    const afterRepair = getVorgangById('v-bill')!;
    expect(afterRepair.orderPositions[0]?.plannedQuantity).toBe(10);
    expect(afterRepair.invoices).toEqual(invoicesBefore);
    expect(getBillableOpenQuantity(afterRepair, 'op-test-1')).toBe(openBefore);
  });
});
