import { beforeEach, describe, expect, it } from 'vitest';
import { createAbschlagInvoice, createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import {
  addOrderAmendmentDraftPosition,
  createOrderAmendmentDraft,
  deleteOrderAmendmentDraft,
  listOrderAmendments,
  removeOrderAmendmentDraftPosition,
  updateOrderAmendmentDraft,
  updateOrderAmendmentDraftPosition,
} from './services/orderAmendmentService';
import { getBillableOpenQuantity } from './services/orderBillingRules';
import {
  ORDER_PLAN_AMENDMENT_REQUIRED,
  assertContractPlanMutable,
} from './services/orderPlanIntegrityService';
import {
  addOrderPosition,
  getVorgangById,
  getVorgangStoreSnapshot,
  hydrateVorgangStore,
  saveVorgangOrderAmendments,
} from './services/vorgangService';
import type { OrderAmendment } from './types/models';
import {
  buildVorgangCloudContentKey,
  mergeCloudVorgangIntoLocal,
  stripVorgangForCloud,
} from './services/vorgang/vorgangCloudService';
import {
  resetSyncChangeTrackerForTests,
  resetSyncChangeTrackerFromState,
  trackPersistedChanges,
} from './services/sync/syncChangeTrackerService';
import { createSyncClient, resetSyncClientForTests } from './services/sync/syncClientService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from './services/sync/syncOutboxService';
import { STORAGE_VERSION } from './services/sync/syncMigrationService';
import { DEFAULT_SETUP } from './data/mockData';
import type { AppPersistedState, ContractConfirmationSnapshot, Vorgang } from './types/models';

function confirmedSnapshot(
  overrides: Partial<ContractConfirmationSnapshot> = {},
): ContractConfirmationSnapshot {
  return {
    id: 'snap-amend-1',
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

function seedConfirmed(id = 'v-amend-1', extras: Partial<Vorgang> = {}): Vorgang {
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
          executedQuantity: 3,
        }),
      ],
      sync: {
        updatedAt: '2026-07-24T10:00:00.000Z',
        version: 1,
        deleted: false,
        deviceId: 'dev-1',
        workspaceId: 'ws-1',
      },
      ...extras,
    }),
  ]);
  return getVorgangById(id)!;
}

function buildState(vorgaenge: Vorgang[]): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, serverWorkspaceId: 'ws-1', workspaceId: 'ws-1' },
    syncOutbox: [],
    setup: DEFAULT_SETUP,
    vorgaenge,
    inboxItems: [],
    tasks: [],
    documents: [],
    savedAt: '2026-07-24T10:00:00.000Z',
  };
}

function integrityFingerprint(vorgang: Vorgang) {
  return {
    confirmation: structuredClone(vorgang.contractConfirmation),
    positions: structuredClone(vorgang.orderPositions),
    invoices: structuredClone(vorgang.invoices),
    status: vorgang.status,
    executionStartedAt: vorgang.executionStartedAt,
    billableOpen: getBillableOpenQuantity(vorgang, 'op-test-1'),
  };
}

function sampleDraftAmendment(vorgangId: string): OrderAmendment {
  return {
    id: 'oa-direct-1',
    vorgangId,
    status: 'entwurf',
    title: 'Direkt gespeichert',
    positions: [],
    createdAt: '2026-07-24T11:00:00.000Z',
    updatedAt: '2026-07-24T11:00:00.000Z',
  };
}

describe('ORDER-AMENDMENT-01A service', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('erstellt Entwurf nur mit contractConfirmation', () => {
    seedConfirmed();
    const created = createOrderAmendmentDraft('v-amend-1', { title: 'Zusatz Steckdosen' });
    expect(created.success).toBe(true);
    if (!created.success) return;
    expect(created.amendment.status).toBe('entwurf');
    expect(created.amendment.title).toBe('Zusatz Steckdosen');
    expect(listOrderAmendments('v-amend-1')).toHaveLength(1);

    hydrateVorgangStore([createTestVorgang({ id: 'v-open', status: 'eingegangen' })]);
    const rejected = createOrderAmendmentDraft('v-open');
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      expect(rejected.errorKey).toBe('order_amendment_requires_confirmation');
    }
  });

  it('nimmt Zusatzleistung und Mengenmehrung an und validiert Eltern/Menge', () => {
    seedConfirmed();
    const draft = createOrderAmendmentDraft('v-amend-1');
    expect(draft.success).toBe(true);
    if (!draft.success) return;

    const add = addOrderAmendmentDraftPosition('v-amend-1', draft.amendment.id, {
      changeType: 'add',
      description: 'Drei Steckdosen',
      quantity: 3,
      unit: 'Stück',
      unitPrice: 40,
      category: 'arbeit',
      billable: true,
    });
    expect(add.success).toBe(true);

    const increase = addOrderAmendmentDraftPosition('v-amend-1', draft.amendment.id, {
      changeType: 'quantity_increase',
      description: 'Mehr Fläche',
      quantity: 20,
      unit: 'Stunden',
      unitPrice: 65,
      parentPositionId: 'op-test-1',
    });
    expect(increase.success).toBe(true);

    const missingParent = addOrderAmendmentDraftPosition('v-amend-1', draft.amendment.id, {
      changeType: 'quantity_increase',
      description: 'Ohne Parent',
      quantity: 1,
      unit: 'Stück',
      unitPrice: 1,
    });
    expect(missingParent.success).toBe(false);
    if (!missingParent.success) {
      expect(missingParent.errorKey).toBe('order_amendment_parent_position_not_found');
    }

    const unknownParent = addOrderAmendmentDraftPosition('v-amend-1', draft.amendment.id, {
      changeType: 'quantity_increase',
      description: 'Unbekannt',
      quantity: 1,
      unit: 'Stück',
      unitPrice: 1,
      parentPositionId: 'op-missing',
    });
    expect(unknownParent.success).toBe(false);

    const zeroQty = addOrderAmendmentDraftPosition('v-amend-1', draft.amendment.id, {
      changeType: 'add',
      description: 'Null',
      quantity: 0,
      unit: 'Stück',
      unitPrice: 1,
    });
    expect(zeroQty.success).toBe(false);
    if (!zeroQty.success) {
      expect(zeroQty.errorKey).toBe('order_amendment_invalid_position');
    }
  });

  it('bearbeitet und entfernt Draft-Positionen und löscht Entwurf; updatedAt ändert sich', async () => {
    seedConfirmed();
    const created = createOrderAmendmentDraft('v-amend-1');
    expect(created.success).toBe(true);
    if (!created.success) return;
    const createdAt = created.amendment.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 2));
    const withPos = addOrderAmendmentDraftPosition('v-amend-1', created.amendment.id, {
      changeType: 'add',
      description: 'Kabel',
      quantity: 2,
      unit: 'Meter',
      unitPrice: 5,
    });
    expect(withPos.success).toBe(true);
    if (!withPos.success) return;
    expect(withPos.amendment.updatedAt >= createdAt).toBe(true);

    const positionId = withPos.amendment.positions[0]!.id;
    const updated = updateOrderAmendmentDraftPosition(
      'v-amend-1',
      created.amendment.id,
      positionId,
      { quantity: 4 },
    );
    expect(updated.success).toBe(true);
    if (!updated.success) return;
    expect(updated.amendment.positions[0]!.quantity).toBe(4);

    const removed = removeOrderAmendmentDraftPosition(
      'v-amend-1',
      created.amendment.id,
      positionId,
    );
    expect(removed.success).toBe(true);
    if (!removed.success) return;
    expect(removed.amendment.positions).toHaveLength(0);

    const meta = updateOrderAmendmentDraft('v-amend-1', created.amendment.id, {
      title: 'Neuer Titel',
      reason: 'Kunde wünscht Zusatz',
    });
    expect(meta.success).toBe(true);

    const deleted = deleteOrderAmendmentDraft('v-amend-1', created.amendment.id);
    expect(deleted.success).toBe(true);
    expect(listOrderAmendments('v-amend-1')).toHaveLength(0);
  });
});

describe('ORDER-AMENDMENT-01A persist gate', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('lehnt nicht-leeres Array ohne contractConfirmation ab und belässt Store/Sync', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-open',
        status: 'eingegangen',
        sync: {
          updatedAt: '2026-07-24T10:00:00.000Z',
          version: 4,
          deleted: false,
          deviceId: 'dev-1',
          workspaceId: 'ws-1',
        },
      }),
    ]);
    const before = getVorgangById('v-open')!;
    const beforeSync = structuredClone(before.sync);
    const beforeSnapshot = structuredClone(getVorgangStoreSnapshot());

    const rejected = saveVorgangOrderAmendments('v-open', [sampleDraftAmendment('v-open')]);
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      expect(rejected.errorKey).toBe('order_amendment_requires_confirmation');
    }

    const after = getVorgangById('v-open')!;
    expect(after.orderAmendments).toBeUndefined();
    expect(after.sync).toEqual(beforeSync);
    expect(after.sync?.version).toBe(4);
    expect(getVorgangStoreSnapshot()).toEqual(beforeSnapshot);
  });

  it('speichert nicht-leeres Array mit contractConfirmation', () => {
    seedConfirmed('v-gate-ok');
    const saved = saveVorgangOrderAmendments('v-gate-ok', [sampleDraftAmendment('v-gate-ok')]);
    expect(saved.success).toBe(true);
    if (!saved.success) return;
    expect(saved.vorgang.orderAmendments).toHaveLength(1);
    expect(saved.vorgang.orderAmendments?.[0]?.id).toBe('oa-direct-1');
    expect(listOrderAmendments('v-gate-ok')).toHaveLength(1);
  });

  it('erlaubt leeres Array zum Entfernen auch ohne Confirmation', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-legacy',
        status: 'eingegangen',
        orderAmendments: [sampleDraftAmendment('v-legacy')],
      }),
    ]);
    expect(listOrderAmendments('v-legacy')).toHaveLength(1);

    const cleared = saveVorgangOrderAmendments('v-legacy', []);
    expect(cleared.success).toBe(true);
    if (!cleared.success) return;
    expect(cleared.vorgang.orderAmendments).toBeUndefined();
    expect(listOrderAmendments('v-legacy')).toHaveLength(0);
  });

  it('Create-Pfad mit Confirmation bleibt erlaubt; ohne Confirmation blockiert', () => {
    seedConfirmed('v-create-ok');
    const ok = createOrderAmendmentDraft('v-create-ok', { title: 'OK' });
    expect(ok.success).toBe(true);

    hydrateVorgangStore([createTestVorgang({ id: 'v-create-blocked', status: 'eingegangen' })]);
    const blocked = createOrderAmendmentDraft('v-create-blocked');
    expect(blocked.success).toBe(false);
    if (!blocked.success) {
      expect(blocked.errorKey).toBe('order_amendment_requires_confirmation');
    }
  });
});

describe('ORDER-AMENDMENT-01A integrity', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('Entwurf verändert Plan, Billing und Confirmation nicht', () => {
    const invoice = createAbschlagInvoice('op-test-1', 2);
    seedConfirmed('v-amend-1', { invoices: [invoice] });
    const before = integrityFingerprint(getVorgangById('v-amend-1')!);

    const created = createOrderAmendmentDraft('v-amend-1');
    expect(created.success).toBe(true);
    if (!created.success) return;
    addOrderAmendmentDraftPosition('v-amend-1', created.amendment.id, {
      changeType: 'add',
      description: 'Zusatz',
      quantity: 1,
      unit: 'Stück',
      unitPrice: 10,
    });

    const after = getVorgangById('v-amend-1')!;
    const fingerprint = integrityFingerprint(after);
    expect(fingerprint.confirmation).toEqual(before.confirmation);
    expect(fingerprint.positions).toEqual(before.positions);
    expect(fingerprint.invoices).toEqual(before.invoices);
    expect(fingerprint.status).toBe(before.status);
    expect(fingerprint.executionStartedAt).toBe(before.executionStartedAt);
    expect(fingerprint.billableOpen).toBe(before.billableOpen);
    expect(after.orderPositions[0]?.executedQuantity).toBe(3);

    const blocked = addOrderPosition('v-amend-1', {
      description: 'Direkt',
      plannedQuantity: 1,
      unit: 'Stück',
      unitPrice: 1,
    });
    expect(blocked.success).toBe(false);
    if (!blocked.success) {
      expect(blocked.errorKey).toBe(ORDER_PLAN_AMENDMENT_REQUIRED);
    }
    expect(assertContractPlanMutable(after).ok).toBe(false);
  });
});

describe('ORDER-AMENDMENT-01A persistenz und cloud', () => {
  beforeEach(() => {
    resetTestStores();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests();
  });

  it('überlebt Hydrate ohne Duplikat', () => {
    seedConfirmed();
    const created = createOrderAmendmentDraft('v-amend-1', { title: 'Persist' });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const snapshot = getVorgangStoreSnapshot();
    hydrateVorgangStore(snapshot);
    hydrateVorgangStore(getVorgangStoreSnapshot());

    const list = listOrderAmendments('v-amend-1');
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(created.amendment.id);
    expect(list[0]!.title).toBe('Persist');
  });

  it('bleibt außerhalb Cloud-Payload/Content-Key und Outbox', () => {
    const vorgang = seedConfirmed();
    const state = buildState([vorgang]);
    hydrateVorgangStore(state.vorgaenge);
    resetSyncChangeTrackerFromState(state);

    const beforeKey = buildVorgangCloudContentKey(getVorgangById('v-amend-1')!);
    const created = createOrderAmendmentDraft('v-amend-1', { title: 'Lokal' });
    expect(created.success).toBe(true);
    if (!created.success) return;
    addOrderAmendmentDraftPosition('v-amend-1', created.amendment.id, {
      changeType: 'add',
      description: 'Zusatz',
      quantity: 1,
      unit: 'Stück',
      unitPrice: 12,
    });

    const after = getVorgangById('v-amend-1')!;
    const stripped = stripVorgangForCloud(after);
    expect('orderAmendments' in stripped).toBe(false);
    expect(JSON.stringify(stripped)).not.toContain('orderAmendments');
    expect(JSON.stringify(stripped)).not.toContain(created.amendment.id);
    expect(buildVorgangCloudContentKey(after)).toBe(beforeKey);

    trackPersistedChanges({
      ...state,
      vorgaenge: [after],
    });
    expect(getSyncOutboxSnapshot().some((entry) => entry.entityType === 'vorgang')).toBe(false);
  });

  it('Cloud-Pull/Merge ohne Entwurf entfernt lokalen Entwurf nicht', () => {
    seedConfirmed();
    const created = createOrderAmendmentDraft('v-amend-1', { title: 'Bleibt lokal' });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const local = {
      ...getVorgangById('v-amend-1')!,
      // version 0 allows remote shell merge (same pattern as cloudOrderChain01)
      sync: {
        updatedAt: '2026-07-24T10:00:00.000Z',
        version: 0,
        deleted: false,
        deviceId: 'dev-1',
        workspaceId: 'ws-1',
      },
    };
    const remotePayload = stripVorgangForCloud({
      ...local,
      title: 'Remote Titel',
      orderAmendments: undefined,
    });

    const { vorgang, conflict } = mergeCloudVorgangIntoLocal(
      local,
      remotePayload,
      2,
      '2026-07-24T12:00:00.000Z',
      false,
      'dev-1',
      'ws-1',
    );
    expect(conflict).toBe(false);

    expect(vorgang?.title).toBe('Remote Titel');
    expect(vorgang?.orderAmendments).toHaveLength(1);
    expect(vorgang?.orderAmendments?.[0]?.id).toBe(created.amendment.id);
    expect(vorgang?.orderAmendments?.[0]?.title).toBe('Bleibt lokal');
  });
});
