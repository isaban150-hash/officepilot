import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import * as supabaseLib from '../../lib/supabase';
import * as persistenceService from '../persistenceService';
import {
  addOrderAmendmentDraftPosition,
  createOrderAmendmentDraft,
} from '../orderAmendmentService';
import {
  getAllVorgaenge,
  getVorgangById,
  hydrateVorgangStore,
} from '../vorgangService';
import {
  mapAmendmentPullRowsIsolated,
  mergeCloudAmendmentsIntoVorgaenge,
  sortConfirmedOrderAmendmentsForPull,
} from './orderAmendmentCloudPullMergeService';
import {
  pullAndApplyWorkspaceOrderAmendmentsStandalone,
  pullAndMergeWorkspaceOrderAmendmentsInMemory,
} from './orderAmendmentCloudPullOrchestrator';
import {
  buildOrderAmendmentConfirmRpcInput,
} from './orderAmendmentConfirmPayload';
import * as orderAmendmentConfirmIntentService from './orderAmendmentConfirmIntentService';
import {
  getOrderAmendmentConfirmIntent,
  listOrderAmendmentConfirmIntents,
  resetOrderAmendmentConfirmIntentsForTests,
  seedOrderAmendmentConfirmIntentForTests,
} from './orderAmendmentConfirmIntentService';
import * as workspaceCloud from './workspaceOrderAmendmentCloudService';
import {
  parseWorkspaceOrderAmendmentPullRow,
  WorkspaceOrderAmendmentCloudError,
} from './workspaceOrderAmendmentCloudService';
import type {
  ConfirmedOrderAmendment,
  ContractConfirmationSnapshot,
  Vorgang,
} from '../../types/models';
import { shortenSyncId } from '../sync/syncUiService';

const VORGANG_ID = 'v-test-1';
const VORGANG_B = 'v-test-2';
const WORKSPACE_ID = 'ws-1';

function confirmedSnapshot(): ContractConfirmationSnapshot {
  return {
    id: 'snapshot-1',
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
  };
}

function seedVorgang(overrides: Partial<Vorgang> = {}, id = VORGANG_ID): Vorgang {
  const vorgang = createTestVorgang({
    id,
    status: 'beauftragt',
    contractConfirmation: confirmedSnapshot(),
    orderPositions: [createOrderPosition({ id: 'op-test-1', executedQuantity: 4 })],
    ...overrides,
  });
  return vorgang;
}

function buildConfirmed(
  clientAmendmentId = 'oam-client-1',
  overrides: Partial<ConfirmedOrderAmendment> = {},
): ConfirmedOrderAmendment {
  return {
    cloudId: 'cloud-amendment-1',
    clientAmendmentId,
    vorgangId: VORGANG_ID,
    sequenceNo: 1,
    status: 'bestaetigt',
    title: 'Zusatzleistung',
    positions: [
      {
        id: 'op-amendment-1',
        changeType: 'add',
        description: 'Zusatzposition',
        plannedQuantity: 2,
        unit: 'Stück',
        unitPrice: 25,
        category: 'material',
        billable: true,
      },
    ],
    contentFingerprint: 'server-md5-fingerprint-1',
    confirmedAt: '2026-07-24T12:00:00.000Z',
    confirmedBy: 'user-1',
    rowVersion: 1,
    createdAt: '2026-07-24T12:00:00.000Z',
    updatedAt: '2026-07-24T12:00:00.000Z',
    ...overrides,
  };
}

function pullRowFromConfirmed(confirmed: ConfirmedOrderAmendment) {
  return {
    id: confirmed.cloudId,
    workspace_id: WORKSPACE_ID,
    vorgang_id: confirmed.vorgangId,
    client_amendment_id: confirmed.clientAmendmentId,
    sequence_no: confirmed.sequenceNo,
    status: 'bestaetigt',
    content_fingerprint: confirmed.contentFingerprint,
    payload: {
      title: confirmed.title,
      reason: confirmed.reason,
      clientAmendmentId: confirmed.clientAmendmentId,
      vorgangId: confirmed.vorgangId,
      sequenceNo: confirmed.sequenceNo,
      positions: confirmed.positions,
    },
    confirmed_at: confirmed.confirmedAt,
    confirmed_by: confirmed.confirmedBy,
    row_version: confirmed.rowVersion,
    created_at: confirmed.createdAt,
    updated_at: confirmed.updatedAt,
  };
}

function mockCloudReady() {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: 'token' } },
        error: null,
      }),
    },
  } as never);
  vi.spyOn(persistenceService, 'buildPersistedStateSnapshot').mockReturnValue({
    syncClient: { serverWorkspaceId: WORKSPACE_ID, workspaceId: WORKSPACE_ID, deviceId: 'device-1' },
    workspace: { id: WORKSPACE_ID },
  } as never);
}

function createDraftWithPosition(vorgangId = VORGANG_ID) {
  const created = createOrderAmendmentDraft(vorgangId, { title: 'Zusatzleistung' });
  expect(created.success).toBe(true);
  if (!created.success) throw new Error('draft');
  const added = addOrderAmendmentDraftPosition(vorgangId, created.amendment.id, {
    changeType: 'add',
    description: 'Zusatzposition',
    quantity: 2,
    unit: 'Stück',
    unitPrice: 25,
    category: 'material',
    billable: true,
  });
  expect(added.success).toBe(true);
  return created.amendment.id;
}

beforeEach(() => {
  resetTestStores();
  resetOrderAmendmentConfirmIntentsForTests();
  vi.restoreAllMocks();
  hydrateVorgangStore([seedVorgang()]);
});

describe('ORDER-AMENDMENT-01B3A pull row parsing', () => {
  it('maps a valid pull row and rejects malformed or wrong-workspace rows', () => {
    const confirmed = buildConfirmed();
    const row = pullRowFromConfirmed(confirmed);
    expect(parseWorkspaceOrderAmendmentPullRow(row, WORKSPACE_ID)).toMatchObject({
      clientAmendmentId: 'oam-client-1',
      sequenceNo: 1,
      status: 'bestaetigt',
    });
    expect(parseWorkspaceOrderAmendmentPullRow(row, 'other-ws')).toBeNull();
    expect(parseWorkspaceOrderAmendmentPullRow({ ...row, payload: null }, WORKSPACE_ID)).toBeNull();
    expect(
      parseWorkspaceOrderAmendmentPullRow(
        {
          ...row,
          payload: {
            ...row.payload,
            positions: [
              ...row.payload.positions,
              { ...row.payload.positions[0], description: 'Dup' },
            ],
          },
        },
        WORKSPACE_ID,
      ),
    ).toBeNull();
  });

  it('isolates invalid rows without dropping valid ones', () => {
    const valid = pullRowFromConfirmed(buildConfirmed());
    const { mapped, invalidCount, issues } = mapAmendmentPullRowsIsolated(
      [valid, { broken: true }, null],
      WORKSPACE_ID,
    );
    expect(mapped).toHaveLength(1);
    expect(invalidCount).toBe(2);
    expect(issues.filter((item) => item.reason === 'invalid_row')).toHaveLength(2);
  });
});

describe('ORDER-AMENDMENT-01B3A write-once merge', () => {
  it('applies a new remote amendment, composes the plan, and keeps executedQuantity', () => {
    const remote = buildConfirmed();
    const merge = mergeCloudAmendmentsIntoVorgaenge(getAllVorgaenge(), [remote], {
      workspaceId: WORKSPACE_ID,
    });
    expect(merge.appliedCount).toBe(1);
    const vorgang = merge.vorgaenge[0]!;
    expect(vorgang.confirmedOrderAmendments).toHaveLength(1);
    expect(vorgang.orderPositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'op-test-1', executedQuantity: 4 }),
        expect.objectContaining({ id: 'op-amendment-1', plannedQuantity: 2 }),
      ]),
    );
  });

  it('is an idempotent no-op for fully matching identity without metadata overwrite', () => {
    const local = buildConfirmed('oam-client-1', {
      localSourceDraftId: 'draft-keep',
      rowVersion: 1,
      updatedAt: '2026-07-24T12:00:00.000Z',
    });
    const remote = buildConfirmed('oam-client-1', {
      rowVersion: 9,
      updatedAt: '2026-07-24T18:00:00.000Z',
    });
    hydrateVorgangStore([
      seedVorgang({
        confirmedOrderAmendments: [local],
        orderPositions: [
          createOrderPosition({ id: 'op-test-1', executedQuantity: 4 }),
          createOrderPosition({ id: 'op-amendment-1', plannedQuantity: 2 }),
        ],
      }),
    ]);
    const merge = mergeCloudAmendmentsIntoVorgaenge(getAllVorgaenge(), [remote], {
      workspaceId: WORKSPACE_ID,
    });
    expect(merge.appliedCount).toBe(0);
    expect(merge.noopCount).toBe(1);
    const kept = merge.vorgaenge[0]!.confirmedOrderAmendments![0]!;
    expect(kept.localSourceDraftId).toBe('draft-keep');
    expect(kept.rowVersion).toBe(1);
    expect(kept.updatedAt).toBe('2026-07-24T12:00:00.000Z');
  });

  it('rejects same fingerprint when cloudId or sequenceNo diverge', () => {
    const local = buildConfirmed('oam-client-1', {
      cloudId: 'cloud-1',
      sequenceNo: 1,
      contentFingerprint: 'same-fp',
    });
    hydrateVorgangStore([seedVorgang({ confirmedOrderAmendments: [local] })]);
    const before = structuredClone(getVorgangById(VORGANG_ID)!);

    const cloudConflict = mergeCloudAmendmentsIntoVorgaenge(
      getAllVorgaenge(),
      [buildConfirmed('oam-client-1', {
        cloudId: 'cloud-2',
        sequenceNo: 1,
        contentFingerprint: 'same-fp',
      })],
      { workspaceId: WORKSPACE_ID },
    );
    expect(cloudConflict.issues[0]?.reason).toBe('cloud_id_conflict');
    expect(cloudConflict.issues[0]?.errorKey).toBe('order_amendment_cloud_id_conflict');
    expect(cloudConflict.appliedCount).toBe(0);
    expect(cloudConflict.vorgaenge[0]!.confirmedOrderAmendments).toEqual(before.confirmedOrderAmendments);

    hydrateVorgangStore([seedVorgang({ confirmedOrderAmendments: [local] })]);
    const sequenceConflict = mergeCloudAmendmentsIntoVorgaenge(
      getAllVorgaenge(),
      [buildConfirmed('oam-client-1', {
        cloudId: 'cloud-1',
        sequenceNo: 2,
        contentFingerprint: 'same-fp',
      })],
      { workspaceId: WORKSPACE_ID },
    );
    expect(sequenceConflict.issues[0]?.reason).toBe('sequence_conflict');
    expect(sequenceConflict.issues[0]?.errorKey).toBe('order_amendment_sequence_conflict');
    expect(sequenceConflict.sequenceConflictCount).toBe(1);
    expect(sequenceConflict.vorgaenge[0]!.confirmedOrderAmendments).toEqual(
      before.confirmedOrderAmendments,
    );
  });

  it('keeps the local vorgang unchanged on fingerprint conflict', () => {
    const local = buildConfirmed('oam-client-1', { contentFingerprint: 'local-fp' });
    hydrateVorgangStore([seedVorgang({ confirmedOrderAmendments: [local] })]);
    const before = structuredClone(getVorgangById(VORGANG_ID)!);
    const merge = mergeCloudAmendmentsIntoVorgaenge(
      getAllVorgaenge(),
      [buildConfirmed('oam-client-1', { contentFingerprint: 'remote-fp' })],
      { workspaceId: WORKSPACE_ID },
    );
    expect(merge.conflictCount).toBe(1);
    expect(merge.issues[0]?.reason).toBe('fingerprint_conflict');
    expect(merge.vorgaenge[0]).toEqual(expect.objectContaining({
      confirmedOrderAmendments: before.confirmedOrderAmendments,
      orderPositions: before.orderPositions,
    }));
  });

  it('reports cloud-id and sequence conflicts without mutating the vorgang', () => {
    const local = buildConfirmed('oam-a', { cloudId: 'cloud-shared', sequenceNo: 1 });
    hydrateVorgangStore([seedVorgang({ confirmedOrderAmendments: [local] })]);
    const cloudConflict = mergeCloudAmendmentsIntoVorgaenge(
      getAllVorgaenge(),
      [buildConfirmed('oam-b', { cloudId: 'cloud-shared', sequenceNo: 2 })],
      { workspaceId: WORKSPACE_ID },
    );
    expect(cloudConflict.issues[0]?.reason).toBe('cloud_id_conflict');

    hydrateVorgangStore([seedVorgang({ confirmedOrderAmendments: [local] })]);
    const sequenceConflict = mergeCloudAmendmentsIntoVorgaenge(
      getAllVorgaenge(),
      [buildConfirmed('oam-b', { cloudId: 'cloud-2', sequenceNo: 1 })],
      { workspaceId: WORKSPACE_ID },
    );
    expect(sequenceConflict.issues[0]?.reason).toBe('sequence_conflict');
  });

  it('reports position-id conflicts and leaves the plan untouched', () => {
    const colliding = buildConfirmed('oam-collide', {
      positions: [{
        id: 'op-test-1',
        changeType: 'add',
        description: 'Kollision',
        plannedQuantity: 1,
        unit: 'Stück',
        unitPrice: 1,
      }],
    });
    const before = structuredClone(getVorgangById(VORGANG_ID)!);
    const merge = mergeCloudAmendmentsIntoVorgaenge(getAllVorgaenge(), [colliding], {
      workspaceId: WORKSPACE_ID,
    });
    expect(merge.issues[0]?.reason).toBe('position_id_conflict');
    expect(merge.vorgaenge[0]!.orderPositions).toEqual(before.orderPositions);
    expect(merge.vorgaenge[0]!.confirmedOrderAmendments ?? []).toEqual([]);
  });

  it('processes another vorgang when one vorgang conflicts', () => {
    hydrateVorgangStore([
      seedVorgang({
        confirmedOrderAmendments: [buildConfirmed('oam-a', { contentFingerprint: 'local' })],
      }),
      seedVorgang({
        id: VORGANG_B,
        orderPositions: [createOrderPosition({ id: 'op-test-1', executedQuantity: 1 })],
      }, VORGANG_B),
    ]);
    const merge = mergeCloudAmendmentsIntoVorgaenge(
      getAllVorgaenge(),
      [
        buildConfirmed('oam-a', { contentFingerprint: 'remote' }),
        buildConfirmed('oam-b', {
          cloudId: 'cloud-b',
          vorgangId: VORGANG_B,
          positions: [{
            id: 'op-amendment-b',
            changeType: 'add',
            description: 'B',
            plannedQuantity: 1,
            unit: 'Stück',
            unitPrice: 5,
          }],
        }),
      ],
      { workspaceId: WORKSPACE_ID },
    );
    expect(merge.conflictCount).toBe(1);
    expect(merge.appliedCount).toBe(1);
    expect(merge.vorgaenge.find((item) => item.id === VORGANG_B)!.confirmedOrderAmendments)
      .toHaveLength(1);
  });

  it('reports orphans without blocking other merges', () => {
    const merge = mergeCloudAmendmentsIntoVorgaenge(
      getAllVorgaenge(),
      [
        buildConfirmed(),
        buildConfirmed('oam-orphan', { vorgangId: 'missing-vorgang', cloudId: 'cloud-orphan' }),
      ],
      { workspaceId: WORKSPACE_ID },
    );
    expect(merge.orphanCount).toBe(1);
    expect(merge.appliedCount).toBe(1);
  });
});

describe('ORDER-AMENDMENT-01B3A intent reconciliation', () => {
  it('heals outcome_unknown after matching remote content and clears intent only after persist', async () => {
    const draftId = createDraftWithPosition();
    const draft = getVorgangById(VORGANG_ID)!.orderAmendments![0]!;
    const rpcInput = buildOrderAmendmentConfirmRpcInput(draft);
    const confirmed = buildConfirmed('oam-intent-1', {
      title: rpcInput.title,
      positions: rpcInput.positions.map((position) => ({
        id: position.id,
        changeType: position.changeType,
        description: position.description,
        plannedQuantity: position.plannedQuantity,
        unit: position.unit,
        unitPrice: position.unitPrice,
        category: position.category,
        billable: position.billable,
        parentPositionId: position.parentPositionId,
      })),
    });
    seedOrderAmendmentConfirmIntentForTests({
      workspaceId: WORKSPACE_ID,
      vorgangId: VORGANG_ID,
      draftId,
      clientAmendmentId: confirmed.clientAmendmentId,
      contentFingerprint: 'client-sha-different-from-server-md5',
      rpcInput,
      state: 'outcome_unknown',
      createdAt: '2026-07-24T12:00:00.000Z',
      updatedAt: '2026-07-24T12:00:00.000Z',
    });

    mockCloudReady();
    vi.spyOn(workspaceCloud, 'rpcPullWorkspaceOrderAmendmentRows').mockResolvedValue([
      pullRowFromConfirmed(confirmed),
    ]);

    const inMemory = await pullAndMergeWorkspaceOrderAmendmentsInMemory({
      workspaceId: WORKSPACE_ID,
      vorgaenge: getAllVorgaenge(),
      intents: listOrderAmendmentConfirmIntents(),
    });
    expect(inMemory.ok).toBe(true);
    if (!inMemory.ok) return;
    expect(inMemory.merge.pendingIntentClears).toEqual([{ vorgangId: VORGANG_ID, draftId }]);
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)?.state).toBe('outcome_unknown');

    const applied = await pullAndApplyWorkspaceOrderAmendmentsStandalone();
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)).toBeNull();
    expect(getVorgangById(VORGANG_ID)!.orderAmendments ?? []).toEqual([]);
    expect(getVorgangById(VORGANG_ID)!.confirmedOrderAmendments).toHaveLength(1);
    expect(applied.report.pendingIntentClearCount).toBe(1);
    expect(applied.report.intentClearFailureCount).toBe(0);
  });

  it('heals local_apply_pending and does not clear intent when persist fails', async () => {
    const draftId = createDraftWithPosition();
    const draft = getVorgangById(VORGANG_ID)!.orderAmendments![0]!;
    const rpcInput = buildOrderAmendmentConfirmRpcInput(draft);
    const confirmed = buildConfirmed('oam-pending-1', {
      title: rpcInput.title,
      positions: rpcInput.positions.map((position) => ({
        id: position.id,
        changeType: position.changeType,
        description: position.description,
        plannedQuantity: position.plannedQuantity,
        unit: position.unit,
        unitPrice: position.unitPrice,
        category: position.category,
        billable: position.billable,
        parentPositionId: position.parentPositionId,
      })),
    });

    seedOrderAmendmentConfirmIntentForTests({
      workspaceId: WORKSPACE_ID,
      vorgangId: VORGANG_ID,
      draftId,
      clientAmendmentId: confirmed.clientAmendmentId,
      contentFingerprint: 'client-fp',
      rpcInput,
      state: 'local_apply_pending',
      createdAt: '2026-07-24T12:00:00.000Z',
      updatedAt: '2026-07-24T12:00:00.000Z',
    });

    mockCloudReady();
    vi.spyOn(workspaceCloud, 'rpcPullWorkspaceOrderAmendmentRows').mockResolvedValue([
      pullRowFromConfirmed(confirmed),
    ]);
    vi.spyOn(persistenceService, 'persistAll').mockReturnValueOnce({
      success: false,
    } as ReturnType<typeof persistenceService.persistAll>);

    const before = structuredClone(getVorgangById(VORGANG_ID)!);
    const result = await pullAndApplyWorkspaceOrderAmendmentsStandalone();
    expect(result).toMatchObject({ ok: false, reason: 'local_persist_failed' });
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)?.state).toBe('local_apply_pending');
    expect(getVorgangById(VORGANG_ID)!.orderAmendments).toEqual(before.orderAmendments);
    expect(getVorgangById(VORGANG_ID)!.confirmedOrderAmendments ?? []).toEqual([]);
  });

  it('does not clear intent on content mismatch and leaves local state unchanged', () => {
    const draftId = createDraftWithPosition();
    const draft = getVorgangById(VORGANG_ID)!.orderAmendments![0]!;
    const rpcInput = buildOrderAmendmentConfirmRpcInput(draft);
    seedOrderAmendmentConfirmIntentForTests({
      workspaceId: WORKSPACE_ID,
      vorgangId: VORGANG_ID,
      draftId,
      clientAmendmentId: 'oam-mismatch',
      contentFingerprint: 'client-fp',
      rpcInput,
      state: 'outcome_unknown',
      createdAt: '2026-07-24T12:00:00.000Z',
      updatedAt: '2026-07-24T12:00:00.000Z',
    });
    const remote = buildConfirmed('oam-mismatch', {
      title: 'Anderer Titel',
      positions: [{
        id: 'op-other',
        changeType: 'add',
        description: 'Anders',
        plannedQuantity: 9,
        unit: 'Stück',
        unitPrice: 9,
      }],
    });
    const before = structuredClone(getVorgangById(VORGANG_ID)!);
    const merge = mergeCloudAmendmentsIntoVorgaenge(getAllVorgaenge(), [remote], {
      workspaceId: WORKSPACE_ID,
      intents: listOrderAmendmentConfirmIntents(),
    });
    expect(merge.issues[0]?.reason).toBe('intent_content_conflict');
    expect(merge.pendingIntentClears).toEqual([]);
    expect(merge.vorgaenge[0]!.orderAmendments).toEqual(before.orderAmendments);
    expect(merge.vorgaenge[0]!.confirmedOrderAmendments ?? []).toEqual([]);
  });
});

describe('ORDER-AMENDMENT-01B3A pull service gates', () => {
  it('rejects non-array RPC payloads as invalid_response', async () => {
    mockCloudReady();
    const rpc = vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
      auth: {
        getSession: async () => ({
          data: { session: { access_token: 'token' } },
          error: null,
        }),
      },
      rpc: async () => ({ data: { rows: [] }, error: null }),
    } as never);

    await expect(workspaceCloud.rpcPullWorkspaceOrderAmendmentRows(WORKSPACE_ID))
      .rejects.toMatchObject({ code: 'invalid_response' });

    vi.mocked(rpc).mockReturnValue({
      auth: {
        getSession: async () => ({
          data: { session: { access_token: 'token' } },
          error: null,
        }),
      },
      rpc: async () => ({ data: null, error: null }),
    } as never);
    await expect(workspaceCloud.rpcPullWorkspaceOrderAmendmentRows(WORKSPACE_ID))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('always sends p_since null and fails closed when supabase is missing', async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({ rpc } as never);
    await workspaceCloud.rpcPullWorkspaceOrderAmendmentRows(WORKSPACE_ID);
    expect(rpc).toHaveBeenCalledWith('pull_workspace_order_amendments', {
      p_workspace_id: WORKSPACE_ID,
      p_since: null,
    });

    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(null);
    const standalone = await pullAndApplyWorkspaceOrderAmendmentsStandalone();
    expect(standalone).toMatchObject({ ok: false, reason: 'cloud_unavailable' });
  });

  it('persists at most once for a successful standalone pull', async () => {
    mockCloudReady();
    vi.spyOn(workspaceCloud, 'rpcPullWorkspaceOrderAmendmentRows').mockResolvedValue([
      pullRowFromConfirmed(buildConfirmed()),
    ]);
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const result = await pullAndApplyWorkspaceOrderAmendmentsStandalone();
    expect(result.ok).toBe(true);
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  it('maps network failures without mutating local state', async () => {
    mockCloudReady();
    vi.spyOn(workspaceCloud, 'rpcPullWorkspaceOrderAmendmentRows').mockRejectedValue(
      new WorkspaceOrderAmendmentCloudError('Network', 'network', true),
    );
    const before = structuredClone(getVorgangById(VORGANG_ID)!);
    const result = await pullAndApplyWorkspaceOrderAmendmentsStandalone();
    expect(result).toMatchObject({ ok: false, reason: 'network_or_unknown' });
    expect(getVorgangById(VORGANG_ID)).toEqual(before);
  });

  it('counts remote/valid/invalid rows without double-counting', async () => {
    mockCloudReady();
    const valid = pullRowFromConfirmed(buildConfirmed());
    vi.spyOn(workspaceCloud, 'rpcPullWorkspaceOrderAmendmentRows').mockResolvedValue([
      valid,
      { broken: true },
      null,
    ]);
    const pulled = await pullAndMergeWorkspaceOrderAmendmentsInMemory({
      workspaceId: WORKSPACE_ID,
      vorgaenge: getAllVorgaenge(),
    });
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.merge.remoteRowsReceived).toBe(3);
    expect(pulled.merge.validRows).toBe(1);
    expect(pulled.merge.invalidRows).toBe(2);
  });
});

describe('ORDER-AMENDMENT-01B3A rest corrections', () => {
  function commercialTwin(
    clientAmendmentId: string,
    cloudId: string,
    sequenceNo: number,
    positionId: string,
  ): ConfirmedOrderAmendment {
    return buildConfirmed(clientAmendmentId, {
      cloudId,
      sequenceNo,
      contentFingerprint: `fp-${clientAmendmentId}`,
      title: 'Gleiche Leistung',
      reason: 'gleicher Grund',
      positions: [{
        id: positionId,
        changeType: 'add',
        description: 'Identische Beschreibung',
        plannedQuantity: 3,
        unit: 'Stück',
        unitPrice: 12.5,
        category: 'material',
        billable: true,
      }],
    });
  }

  it('sorts by sequenceNo, clientAmendmentId, then cloudId', () => {
    const sorted = sortConfirmedOrderAmendmentsForPull([
      buildConfirmed('oam-b', { cloudId: 'cloud-b', sequenceNo: 1 }),
      buildConfirmed('oam-a', { cloudId: 'cloud-a2', sequenceNo: 1 }),
      buildConfirmed('oam-a', { cloudId: 'cloud-a1', sequenceNo: 1 }),
      buildConfirmed('oam-z', { cloudId: 'cloud-z', sequenceNo: 2 }),
    ]);
    expect(sorted.map((item) => `${item.sequenceNo}:${item.clientAmendmentId}:${item.cloudId}`))
      .toEqual([
        '1:oam-a:cloud-a1',
        '1:oam-a:cloud-a2',
        '1:oam-b:cloud-b',
        '2:oam-z:cloud-z',
      ]);
  });

  it('keeps both server rows and warns on duplicate commercial content', () => {
    const first = commercialTwin('oam-dup-a', 'cloud-dup-a', 1, 'pos-dup-a');
    const second = commercialTwin('oam-dup-b', 'cloud-dup-b', 2, 'pos-dup-b');
    const merge = mergeCloudAmendmentsIntoVorgaenge(getAllVorgaenge(), [first, second], {
      workspaceId: WORKSPACE_ID,
    });
    expect(merge.appliedCount).toBe(2);
    expect(merge.vorgaenge[0]!.confirmedOrderAmendments).toHaveLength(2);
    expect(merge.duplicateContentWarningCount).toBe(1);
    expect(merge.issues.some((item) => item.reason === 'duplicate_content_warning')).toBe(true);
    const reportText = JSON.stringify(merge.issues);
    expect(reportText).not.toContain('Identische Beschreibung');
    expect(reportText).not.toContain('12.5');
    expect(reportText).not.toContain('gleicher Grund');
  });

  it('hard-conflicts duplicate commercial content when position ids collide', () => {
    const first = commercialTwin('oam-dup-a', 'cloud-dup-a', 1, 'pos-same');
    const second = commercialTwin('oam-dup-b', 'cloud-dup-b', 2, 'pos-same');
    const before = structuredClone(getVorgangById(VORGANG_ID)!);
    const merge = mergeCloudAmendmentsIntoVorgaenge(getAllVorgaenge(), [first, second], {
      workspaceId: WORKSPACE_ID,
    });
    expect(merge.positionConflictCount).toBe(1);
    expect(merge.appliedCount).toBe(0);
    expect(merge.vorgaenge[0]!.confirmedOrderAmendments ?? []).toEqual([]);
    expect(merge.vorgaenge[0]!.orderPositions).toEqual(before.orderPositions);
  });

  it('rolls back the whole vorgang when a later remote conflicts', () => {
    const draftId = createDraftWithPosition();
    const before = structuredClone(getVorgangById(VORGANG_ID)!);
    seedOrderAmendmentConfirmIntentForTests({
      workspaceId: WORKSPACE_ID,
      vorgangId: VORGANG_ID,
      draftId,
      clientAmendmentId: 'oam-unrelated',
      contentFingerprint: 'client-fp',
      rpcInput: buildOrderAmendmentConfirmRpcInput(before.orderAmendments![0]!),
      state: 'outcome_unknown',
      createdAt: '2026-07-24T12:00:00.000Z',
      updatedAt: '2026-07-24T12:00:00.000Z',
    });
    const early = buildConfirmed('oam-early', {
      cloudId: 'cloud-early',
      sequenceNo: 1,
      positions: [{
        id: 'op-early',
        changeType: 'add',
        description: 'Früh gültig',
        plannedQuantity: 1,
        unit: 'Stück',
        unitPrice: 1,
      }],
    });
    const late = buildConfirmed('oam-late', {
      cloudId: 'cloud-late',
      sequenceNo: 2,
      positions: [{
        id: 'op-test-1',
        changeType: 'add',
        description: 'Spät kollidiert',
        plannedQuantity: 1,
        unit: 'Stück',
        unitPrice: 1,
      }],
    });
    const merge = mergeCloudAmendmentsIntoVorgaenge(
      getAllVorgaenge(),
      [early, late],
      { workspaceId: WORKSPACE_ID, intents: listOrderAmendmentConfirmIntents() },
    );
    expect(merge.appliedCount).toBe(0);
    expect(merge.pendingIntentClears).toEqual([]);
    expect(merge.positionConflictCount).toBe(1);
    expect(merge.vorgaenge[0]!.confirmedOrderAmendments ?? []).toEqual([]);
    expect(merge.vorgaenge[0]!.orderAmendments).toEqual(before.orderAmendments);
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)).not.toBeNull();
  });

  it('restores a narrowed plan and keeps main executedQuantity', () => {
    hydrateVorgangStore([
      seedVorgang({
        orderPositions: [createOrderPosition({ id: 'op-test-1', executedQuantity: 7 })],
      }),
    ]);
    const merge = mergeCloudAmendmentsIntoVorgaenge(
      getAllVorgaenge(),
      [buildConfirmed()],
      { workspaceId: WORKSPACE_ID },
    );
    expect(merge.vorgaenge[0]!.orderPositions.map((p) => p.id).sort()).toEqual([
      'op-amendment-1',
      'op-test-1',
    ]);
    expect(merge.vorgaenge[0]!.orderPositions.find((p) => p.id === 'op-test-1')?.executedQuantity)
      .toBe(7);
  });

  it('reconciles pending intents and clears only after persist', async () => {
    const draftId = createDraftWithPosition();
    const draft = getVorgangById(VORGANG_ID)!.orderAmendments![0]!;
    const rpcInput = buildOrderAmendmentConfirmRpcInput(draft);
    const confirmed = buildConfirmed('oam-pending-state', {
      title: rpcInput.title,
      positions: rpcInput.positions.map((position) => ({
        id: position.id,
        changeType: position.changeType,
        description: position.description,
        plannedQuantity: position.plannedQuantity,
        unit: position.unit,
        unitPrice: position.unitPrice,
        category: position.category,
        billable: position.billable,
        parentPositionId: position.parentPositionId,
      })),
    });
    seedOrderAmendmentConfirmIntentForTests({
      workspaceId: WORKSPACE_ID,
      vorgangId: VORGANG_ID,
      draftId,
      clientAmendmentId: confirmed.clientAmendmentId,
      contentFingerprint: 'client-sha',
      rpcInput,
      state: 'pending',
      createdAt: '2026-07-24T12:00:00.000Z',
      updatedAt: '2026-07-24T12:00:00.000Z',
    });
    mockCloudReady();
    vi.spyOn(workspaceCloud, 'rpcPullWorkspaceOrderAmendmentRows').mockResolvedValue([
      pullRowFromConfirmed(confirmed),
    ]);
    const beforePersist = await pullAndMergeWorkspaceOrderAmendmentsInMemory({
      workspaceId: WORKSPACE_ID,
      vorgaenge: getAllVorgaenge(),
      intents: listOrderAmendmentConfirmIntents(),
    });
    expect(beforePersist.ok).toBe(true);
    if (!beforePersist.ok) return;
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)?.state).toBe('pending');
    const applied = await pullAndApplyWorkspaceOrderAmendmentsStandalone();
    expect(applied.ok).toBe(true);
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)).toBeNull();
    expect(getVorgangById(VORGANG_ID)!.orderAmendments ?? []).toEqual([]);
    expect(getVorgangById(VORGANG_ID)!.confirmedOrderAmendments).toHaveLength(1);
  });

  it('accepts a matching intent when the local draft is already missing', async () => {
    const draftId = createDraftWithPosition();
    const draft = getVorgangById(VORGANG_ID)!.orderAmendments![0]!;
    const rpcInput = buildOrderAmendmentConfirmRpcInput(draft);
    const confirmed = buildConfirmed('oam-missing-draft', {
      title: rpcInput.title,
      positions: rpcInput.positions.map((position) => ({
        id: position.id,
        changeType: position.changeType,
        description: position.description,
        plannedQuantity: position.plannedQuantity,
        unit: position.unit,
        unitPrice: position.unitPrice,
        category: position.category,
        billable: position.billable,
        parentPositionId: position.parentPositionId,
      })),
    });
    seedOrderAmendmentConfirmIntentForTests({
      workspaceId: WORKSPACE_ID,
      vorgangId: VORGANG_ID,
      draftId,
      clientAmendmentId: confirmed.clientAmendmentId,
      contentFingerprint: 'client-sha',
      rpcInput,
      state: 'outcome_unknown',
      createdAt: '2026-07-24T12:00:00.000Z',
      updatedAt: '2026-07-24T12:00:00.000Z',
    });
    hydrateVorgangStore([{
      ...getVorgangById(VORGANG_ID)!,
      orderAmendments: undefined,
    }]);
    mockCloudReady();
    vi.spyOn(workspaceCloud, 'rpcPullWorkspaceOrderAmendmentRows').mockResolvedValue([
      pullRowFromConfirmed(confirmed),
    ]);
    const applied = await pullAndApplyWorkspaceOrderAmendmentsStandalone();
    expect(applied.ok).toBe(true);
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)).toBeNull();
    expect(getVorgangById(VORGANG_ID)!.confirmedOrderAmendments).toHaveLength(1);
    expect(getVorgangById(VORGANG_ID)!.orderPositions.some((p) => p.id === confirmed.positions[0]!.id))
      .toBe(true);
  });

  it('keeps persisted data when intent clear fails and allows idempotent retry', async () => {
    const draftId = createDraftWithPosition();
    const draft = getVorgangById(VORGANG_ID)!.orderAmendments![0]!;
    const rpcInput = buildOrderAmendmentConfirmRpcInput(draft);
    const confirmed = buildConfirmed('oam-clear-fail', {
      title: rpcInput.title,
      positions: rpcInput.positions.map((position) => ({
        id: position.id,
        changeType: position.changeType,
        description: position.description,
        plannedQuantity: position.plannedQuantity,
        unit: position.unit,
        unitPrice: position.unitPrice,
        category: position.category,
        billable: position.billable,
        parentPositionId: position.parentPositionId,
      })),
    });
    seedOrderAmendmentConfirmIntentForTests({
      workspaceId: WORKSPACE_ID,
      vorgangId: VORGANG_ID,
      draftId,
      clientAmendmentId: confirmed.clientAmendmentId,
      contentFingerprint: 'client-sha',
      rpcInput,
      state: 'local_apply_pending',
      createdAt: '2026-07-24T12:00:00.000Z',
      updatedAt: '2026-07-24T12:00:00.000Z',
    });
    mockCloudReady();
    vi.spyOn(workspaceCloud, 'rpcPullWorkspaceOrderAmendmentRows').mockResolvedValue([
      pullRowFromConfirmed(confirmed),
    ]);
    const clearSpy = vi.spyOn(
      orderAmendmentConfirmIntentService,
      'clearOrderAmendmentConfirmIntents',
    ).mockImplementationOnce(() => {
      throw new Error('clear failed');
    });

    const first = await pullAndApplyWorkspaceOrderAmendmentsStandalone();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.report.persisted).toBe(true);
    expect(first.report.intentClearFailureCount).toBe(1);
    expect(first.report.warnings.some((item) => item.reason === 'intent_clear_failure')).toBe(true);
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)).not.toBeNull();
    expect(getVorgangById(VORGANG_ID)!.confirmedOrderAmendments).toHaveLength(1);

    clearSpy.mockRestore();
    const second = await pullAndApplyWorkspaceOrderAmendmentsStandalone();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.merge.noopCount).toBeGreaterThanOrEqual(1);
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)).toBeNull();
  });

  it('shortens report references and omits confidential payload text', async () => {
    mockCloudReady();
    const longVorgangId = 'vorgang-with-a-very-long-identifier-001';
    hydrateVorgangStore([seedVorgang({ id: longVorgangId }, longVorgangId)]);
    const confirmed = buildConfirmed('oam-secret-client-id-xyz', {
      cloudId: 'cloud-secret-identifier-abc',
      vorgangId: longVorgangId,
      title: 'Geheimtitel mit Preis',
      reason: 'Geheimgrund',
      positions: [{
        id: 'pos-secret',
        changeType: 'add',
        description: 'Geheime Beschreibung 99.99 Euro',
        plannedQuantity: 99.99,
        unit: 'Stück',
        unitPrice: 99.99,
      }],
    });
    vi.spyOn(workspaceCloud, 'rpcPullWorkspaceOrderAmendmentRows').mockResolvedValue([
      pullRowFromConfirmed(confirmed),
      {
        id: 'orphan-cloud-very-long-id-999',
        workspace_id: WORKSPACE_ID,
        vorgang_id: 'missing-vorgang-with-long-name',
        client_amendment_id: 'oam-orphan-long-client-id',
        sequence_no: 1,
        status: 'bestaetigt',
        content_fingerprint: 'fp',
        payload: {
          title: 'Orphan Geheim',
          clientAmendmentId: 'oam-orphan-long-client-id',
          vorgangId: 'missing-vorgang-with-long-name',
          sequenceNo: 1,
          positions: confirmed.positions,
        },
        confirmed_at: confirmed.confirmedAt,
        confirmed_by: confirmed.confirmedBy,
        row_version: 1,
        created_at: confirmed.createdAt,
        updated_at: confirmed.updatedAt,
      },
    ]);
    const applied = await pullAndApplyWorkspaceOrderAmendmentsStandalone();
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const blob = JSON.stringify(applied.report);
    expect(blob).not.toContain('Geheimtitel');
    expect(blob).not.toContain('Geheimgrund');
    expect(blob).not.toContain('Geheime Beschreibung');
    expect(blob).not.toContain('99.99');
    expect(blob).not.toContain(longVorgangId);
    expect(blob).not.toContain('oam-secret-client-id-xyz');
    expect(blob).toContain(shortenSyncId('missing-vorgang-with-long-name'));
  });
});
