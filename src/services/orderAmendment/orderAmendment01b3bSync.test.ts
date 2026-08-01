import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import * as supabaseLib from '../../lib/supabase';
import type { AppPersistedState, ConfirmedOrderAmendment, ContractConfirmationSnapshot, Vorgang } from '../../types/models';
import * as persistenceService from '../persistenceService';
import * as workspaceCloud from '../workspace/workspaceCloudService';
import * as invoiceOrchestrator from '../invoice/invoiceCloudPullOrchestrator';
import {
  createVorgangFromCloudRow,
  mergeCloudVorgangIntoLocal,
  mergeVorgaengeFromPull,
  shouldDeferContractPlanRepair,
  stripVorgangForCloud,
} from '../vorgang/vorgangCloudService';
import { STORAGE_VERSION } from '../sync/syncMigrationService';
import { createSyncClient, hydrateSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import { SupabaseSyncAdapter, appendMissingInvoicePositionRefsToReport } from '../sync/supabaseSyncAdapter';
import {
  SyncCoordinator,
  getSyncCoordinator,
  resetSyncCoordinatorForTests,
} from '../sync/syncCoordinator';
import { createEmptySyncSimulationReport } from '../sync/syncSimulationReportService';
import type { SyncCoordinatorReport } from '../../types/sync';
import { runSyncFromUi } from '../sync/syncUiService';
import { applySyncPullCandidateSafely } from '../sync/syncPullPersistService';
import {
  bootstrapWorkspaceCloudSyncIfNeeded,
  isWorkspaceCloudBootstrapCompleted,
  resetWorkspaceCloudBootstrapForTests,
} from '../workspace/workspaceCloudBootstrapService';
import * as workspaceProvisioning from '../workspace/workspaceProvisioningService';
import { hydrateVorgangStore, getAllVorgaenge, getVorgangById } from '../vorgangService';
import * as orderAmendmentOrchestrator from './orderAmendmentCloudPullOrchestrator';
import * as orderAmendmentConfirmIntentService from './orderAmendmentConfirmIntentService';
import {
  getOrderAmendmentConfirmIntent,
  resetOrderAmendmentConfirmIntentsForTests,
  seedOrderAmendmentConfirmIntentForTests,
} from './orderAmendmentConfirmIntentService';
import { buildOrderAmendmentConfirmRpcInput } from './orderAmendmentConfirmPayload';
import {
  addOrderAmendmentDraftPosition,
  createOrderAmendmentDraft,
} from '../orderAmendmentService';
import * as workspaceAmendmentCloud from './workspaceOrderAmendmentCloudService';
import { WorkspaceOrderAmendmentCloudError } from './workspaceOrderAmendmentCloudService';
import * as invoiceClearModule from '../invoice/invoiceCloudPullMergeService';

function coordinatorReport(
  partial: Partial<SyncCoordinatorReport> = {},
): SyncCoordinatorReport {
  const base = createEmptySyncSimulationReport(new Date().toISOString());
  return {
    ...base,
    retryAttempts: 0,
    uploadCount: 0,
    downloadCount: 0,
    ...partial,
  };
}

const WORKSPACE_ID = 'ws-1';
const VORGANG_ID = 'v-test-1';
const DEVICE_ID = 'device-1';

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

function buildConfirmed(
  clientAmendmentId = 'oam-client-1',
  overrides: Partial<ConfirmedOrderAmendment> = {},
): ConfirmedOrderAmendment {
  return {
    cloudId: `cloud-${clientAmendmentId}`,
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
    contentFingerprint: `fp-${clientAmendmentId}`,
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

function cloudPlanWithAmendmentExecuted(): Vorgang['orderPositions'] {
  return [
    createOrderPosition({ id: 'op-test-1', executedQuantity: 4 }),
    createOrderPosition({
      id: 'op-amendment-1',
      description: 'Zusatzposition',
      plannedQuantity: 2,
      unit: 'Stück',
      unitPrice: 25,
      category: 'material',
      executedQuantity: 1,
      sourceAmendmentId: 'oam-client-1',
      sourceAmendmentSequence: 1,
      amendmentChangeType: 'add',
    }),
  ];
}

function seedLocalVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return createTestVorgang({
    id: VORGANG_ID,
    status: 'beauftragt',
    contractConfirmation: confirmedSnapshot(),
    orderPositions: [createOrderPosition({ id: 'op-test-1', executedQuantity: 4 })],
    sync: {
      updatedAt: '2026-07-24T10:00:00.000Z',
      version: 1,
      deleted: false,
      deviceId: DEVICE_ID,
      workspaceId: WORKSPACE_ID,
    },
    ...overrides,
  });
}

function buildPullState(vorgaenge: Vorgang[] = []): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: {
      ...client,
      serverWorkspaceId: WORKSPACE_ID,
      workspaceId: WORKSPACE_ID,
      deviceId: DEVICE_ID,
      syncPolicy: 'cloud_ready',
    },
    syncOutbox: [],
    setup: DEFAULT_SETUP,
    vorgaenge,
    inboxItems: [],
    tasks: [],
    documents: [],
    savedAt: '2026-07-24T10:00:00.000Z',
  };
}

type WorkspaceVorgangRowLike = {
  workspace_id: string;
  vorgang_id: string;
  payload: ReturnType<typeof stripVorgangForCloud> & {
    orderPositions: Vorgang['orderPositions'];
  };
  row_version: number;
  deleted: boolean;
  deleted_at: string | null;
  updated_at: string;
  updated_by: string | null;
};

function emptyWorkspacePull(vorgangRows: WorkspaceVorgangRowLike[] = []) {
  return {
    workspace: null,
    members: [],
    settings: null,
    setupPayload: null,
    setupRowVersion: 0,
    setupUpdatedAt: null,
    companyProfilePayload: null,
    companyProfileRowVersion: 0,
    companyProfileUpdatedAt: null,
    vorgaenge: vorgangRows,
  };
}

function remoteVorgangRow(vorgang: Vorgang): WorkspaceVorgangRowLike {
  const payload = {
    ...stripVorgangForCloud({
      ...vorgang,
      confirmedOrderAmendments: vorgang.confirmedOrderAmendments,
    }),
    orderPositions: vorgang.orderPositions,
  };
  return {
    workspace_id: WORKSPACE_ID,
    vorgang_id: vorgang.id,
    payload,
    row_version: vorgang.sync?.version ?? 1,
    deleted: false,
    deleted_at: null,
    updated_at: vorgang.sync?.updatedAt ?? '2026-07-24T12:00:00.000Z',
    updated_by: null,
  };
}

beforeEach(() => {  resetOrderAmendmentConfirmIntentsForTests();
  resetSyncClientForTests();
  resetSyncCoordinatorForTests();
  resetWorkspaceCloudBootstrapForTests();
  vi.restoreAllMocks();
});

describe('ORDER-AMENDMENT-01B3B repair hazard', () => {
  it('defers repair when amendment sources are missing from confirmed list', () => {
    expect(
      shouldDeferContractPlanRepair({
        orderPositions: cloudPlanWithAmendmentExecuted(),
        confirmedOrderAmendments: undefined,
      }),
    ).toBe(true);

    expect(
      shouldDeferContractPlanRepair({
        orderPositions: cloudPlanWithAmendmentExecuted(),
        confirmedOrderAmendments: [buildConfirmed()],
      }),
    ).toBe(false);

    expect(
      shouldDeferContractPlanRepair({
        orderPositions: [createOrderPosition({ id: 'op-test-1', executedQuantity: 3 })],
        confirmedOrderAmendments: undefined,
      }),
    ).toBe(false);
  });

  it('keeps cloud amendment position and executedQuantity on new-device merge', () => {
    const cloudPayload = {
      ...stripVorgangForCloud(
        seedLocalVorgang({
          orderPositions: cloudPlanWithAmendmentExecuted(),
          confirmedOrderAmendments: [buildConfirmed()],
        }),
      ),
      orderPositions: cloudPlanWithAmendmentExecuted(),
    };

    const created = createVorgangFromCloudRow(
      cloudPayload,
      1,
      '2026-07-24T12:00:00.000Z',
      false,
      DEVICE_ID,
      WORKSPACE_ID,
    );

    expect(created.confirmedOrderAmendments).toBeUndefined();
    expect(created.orderPositions.map((p) => p.id).sort()).toEqual([
      'op-amendment-1',
      'op-test-1',
    ]);
    expect(created.orderPositions.find((p) => p.id === 'op-amendment-1')?.executedQuantity).toBe(1);
    expect(created.orderPositions.find((p) => p.id === 'op-test-1')?.executedQuantity).toBe(4);
  });

  it('defers repair when only a newer amendment source is missing locally', () => {
    const first = buildConfirmed('oam-client-1', { sequenceNo: 1 });
    const cloudPositions = [
      createOrderPosition({ id: 'op-test-1', executedQuantity: 4 }),
      createOrderPosition({
        id: 'op-amendment-1',
        description: 'Zusatzposition',
        plannedQuantity: 2,
        unit: 'Stück',
        unitPrice: 25,
        category: 'material',
        executedQuantity: 1,
        sourceAmendmentId: 'oam-client-1',
        sourceAmendmentSequence: 1,
        amendmentChangeType: 'add',
      }),
      createOrderPosition({
        id: 'op-amendment-2',
        description: 'Weitere Zusatzposition',
        plannedQuantity: 1,
        unit: 'Stück',
        unitPrice: 10,
        category: 'material',
        executedQuantity: 3,
        sourceAmendmentId: 'oam-client-2',
        sourceAmendmentSequence: 2,
        amendmentChangeType: 'add',
      }),
    ];

    expect(
      shouldDeferContractPlanRepair({
        orderPositions: cloudPositions,
        confirmedOrderAmendments: [first],
      }),
    ).toBe(true);

    // Local sync.version 0 → merge engine takes remote shell (cloud plan).
    const local = seedLocalVorgang({
      confirmedOrderAmendments: [first],
      orderPositions: cloudPositions.slice(0, 2),
      sync: {
        updatedAt: '2026-07-24T10:00:00.000Z',
        version: 0,
        deleted: false,
        deviceId: DEVICE_ID,
        workspaceId: WORKSPACE_ID,
      },
    });

    const { vorgang, conflict } = mergeCloudVorgangIntoLocal(
      local,
      {
        ...stripVorgangForCloud({
          ...local,
          confirmedOrderAmendments: [first],
          orderPositions: cloudPositions,
        }),
        orderPositions: cloudPositions,
      },
      1,
      '2026-07-24T13:00:00.000Z',
      false,
      DEVICE_ID,
      WORKSPACE_ID,
    );

    expect(conflict).toBe(false);
    expect(vorgang?.orderPositions.find((p) => p.id === 'op-amendment-2')?.executedQuantity).toBe(3);
    expect(vorgang?.confirmedOrderAmendments).toEqual([first]);
  });

  it('still repairs when confirmed list covers all amendment sources', () => {
    const confirmed = buildConfirmed();
    const local = seedLocalVorgang({
      confirmedOrderAmendments: [confirmed],
      orderPositions: [
        createOrderPosition({ id: 'op-test-1', executedQuantity: 4 }),
        // Drift: wrong description on main position commercial fields still match? force drift via extra junk id removed by repair
        createOrderPosition({
          id: 'op-stale',
          description: 'Stale',
          plannedQuantity: 1,
          unit: 'Stück',
          unitPrice: 1,
        }),
        createOrderPosition({
          id: 'op-amendment-1',
          description: 'Zusatzposition',
          plannedQuantity: 2,
          unit: 'Stück',
          unitPrice: 25,
          category: 'material',
          executedQuantity: 1,
          sourceAmendmentId: 'oam-client-1',
          sourceAmendmentSequence: 1,
          amendmentChangeType: 'add',
        }),
      ],
    });

    const { vorgang } = mergeCloudVorgangIntoLocal(
      local,
      {
        ...stripVorgangForCloud(local),
        orderPositions: local.orderPositions,
      },
      1,
      '2026-07-24T13:00:00.000Z',
      false,
      DEVICE_ID,
      WORKSPACE_ID,
    );

    expect(vorgang?.orderPositions.map((p) => p.id).sort()).toEqual([
      'op-amendment-1',
      'op-test-1',
    ]);
    expect(vorgang?.orderPositions.find((p) => p.id === 'op-amendment-1')?.executedQuantity).toBe(1);
  });
});

describe('ORDER-AMENDMENT-01B3B sync adapter order and global failure', () => {
  it('pulls amendments after vorgänge and before invoices, reusing B3A in-memory merge', async () => {
    const cloudVorgang = seedLocalVorgang({
      orderPositions: cloudPlanWithAmendmentExecuted(),
    });
    const callOrder: string[] = [];

    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(workspaceCloud, 'rpcPullWorkspaceSyncState').mockImplementation(async () => {
      callOrder.push('vorgang-workspace');
      return emptyWorkspacePull([remoteVorgangRow(cloudVorgang)]) as never;
    });

    const amendmentSpy = vi
      .spyOn(orderAmendmentOrchestrator, 'pullAndMergeWorkspaceOrderAmendmentsInMemory')
      .mockImplementation(async (input) => {
        callOrder.push('amendment');
        expect(input.workspaceId).toBe(WORKSPACE_ID);
        expect(input.vorgaenge.some((v) => v.id === VORGANG_ID)).toBe(true);
        expect(input.vorgaenge[0]!.orderPositions.find((p) => p.id === 'op-amendment-1')?.executedQuantity)
          .toBe(1);
        return {
          ok: true,
          merge: {
            vorgaenge: input.vorgaenge.map((v) => ({
              ...v,
              confirmedOrderAmendments: [buildConfirmed()],
              orderPositions: cloudPlanWithAmendmentExecuted(),
            })),
            remoteRowsReceived: 1,
            validRows: 1,
            invalidRows: 0,
            appliedCount: 1,
            noopCount: 0,
            orphanCount: 0,
            conflictCount: 0,
            sequenceConflictCount: 0,
            positionConflictCount: 0,
            duplicateContentWarningCount: 0,
            reconciledIntentCount: 0,
            pendingIntentClearCount: 0,
            affectedVorgangIds: [VORGANG_ID],
            issues: [],
            orphanReferences: [],
            pendingIntentClears: [],
            changed: true,
          },
        };
      });

    const invoiceSpy = vi
      .spyOn(invoiceOrchestrator, 'applyInvoicePullAfterVorgangMerge')
      .mockImplementation(async (input) => {
        callOrder.push('invoice');
        expect(input.vorgaenge[0]!.confirmedOrderAmendments?.[0]?.clientAmendmentId).toBe(
          'oam-client-1',
        );
        return {
          vorgaenge: input.vorgaenge,
          invoiceRpcFailed: false,
          merge: null,
          pendingIntentClears: [],
        };
      });

    const adapter = new SupabaseSyncAdapter({} as never);
    const inputState = buildPullState([]);
    const result = await adapter.pullChanges({
      deviceId: DEVICE_ID,
      workspaceId: WORKSPACE_ID,
      state: inputState,
    });

    expect(callOrder).toEqual(['vorgang-workspace', 'amendment', 'invoice']);
    expect(amendmentSpy).toHaveBeenCalledTimes(1);
    expect(invoiceSpy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.skipPersist).toBeUndefined();
    expect(result.state.vorgaenge[0]!.confirmedOrderAmendments).toHaveLength(1);
    expect(result.state.vorgaenge[0]!.orderPositions.find((p) => p.id === 'op-amendment-1')?.executedQuantity)
      .toBe(1);
  });

  it('on global amendment failure returns input state, skips invoice pull and persist', async () => {
    const cloudVorgang = seedLocalVorgang({
      orderPositions: cloudPlanWithAmendmentExecuted(),
    });

    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(workspaceCloud, 'rpcPullWorkspaceSyncState').mockResolvedValue(
      emptyWorkspacePull([remoteVorgangRow(cloudVorgang)]) as never,
    );
    vi.spyOn(orderAmendmentOrchestrator, 'pullAndMergeWorkspaceOrderAmendmentsInMemory')
      .mockResolvedValue({
        ok: false,
        reason: 'rpc_failed',
        message: 'RPC down',
      });
    const invoiceSpy = vi.spyOn(invoiceOrchestrator, 'applyInvoicePullAfterVorgangMerge');

    const adapter = new SupabaseSyncAdapter({} as never);
    const inputState = buildPullState([]);
    const result = await adapter.pullChanges({
      deviceId: DEVICE_ID,
      workspaceId: WORKSPACE_ID,
      state: inputState,
    });

    expect(invoiceSpy).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.skipPersist).toBe(true);
    expect(result.state).toBe(inputState);
    expect(result.pendingAmendmentIntentClears).toBeUndefined();
    expect(result.pendingInvoiceIntentClears).toBeUndefined();
    expect(result.report.errors.some((e) => e.outboxId === 'amendment-pull')).toBe(true);
    expect(adapter.getSyncStatus().syncState).toBe('error');
  });

  it('invalid amendment response format is a global failure without invoice pull', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(workspaceCloud, 'rpcPullWorkspaceSyncState').mockResolvedValue(
      emptyWorkspacePull([remoteVorgangRow(seedLocalVorgang())]) as never,
    );
    vi.spyOn(workspaceAmendmentCloud, 'rpcPullWorkspaceOrderAmendmentRows').mockRejectedValue(
      new WorkspaceOrderAmendmentCloudError('invalid', 'invalid_response', false),
    );
    const invoiceSpy = vi.spyOn(invoiceOrchestrator, 'applyInvoicePullAfterVorgangMerge');

    const adapter = new SupabaseSyncAdapter({} as never);
    const inputState = buildPullState([]);
    const result = await adapter.pullChanges({
      deviceId: DEVICE_ID,
      workspaceId: WORKSPACE_ID,
      state: inputState,
    });

    expect(invoiceSpy).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.skipPersist).toBe(true);
    expect(result.state).toBe(inputState);
  });

  it('end-to-end in-memory amendment compose preserves executedQuantity after deferred repair', async () => {
    const cloudVorgang = seedLocalVorgang({
      orderPositions: cloudPlanWithAmendmentExecuted(),
    });
    const confirmed = buildConfirmed();

    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(workspaceCloud, 'rpcPullWorkspaceSyncState').mockResolvedValue(
      emptyWorkspacePull([remoteVorgangRow(cloudVorgang)]) as never,
    );
    vi.spyOn(workspaceAmendmentCloud, 'rpcPullWorkspaceOrderAmendmentRows').mockResolvedValue([
      pullRowFromConfirmed(confirmed),
    ] as never);
    vi.spyOn(invoiceOrchestrator, 'applyInvoicePullAfterVorgangMerge').mockImplementation(
      async (input) => ({
        vorgaenge: input.vorgaenge,
        invoiceRpcFailed: false,
        merge: null,
        pendingIntentClears: [],
      }),
    );

    const adapter = new SupabaseSyncAdapter({} as never);
    const result = await adapter.pullChanges({
      deviceId: DEVICE_ID,
      workspaceId: WORKSPACE_ID,
      state: buildPullState([]),
    });

    expect(result.success).toBe(true);
    const merged = result.state.vorgaenge[0]!;
    expect(merged.confirmedOrderAmendments).toHaveLength(1);
    expect(merged.orderPositions.map((p) => p.id).sort()).toEqual([
      'op-amendment-1',
      'op-test-1',
    ]);
    expect(merged.orderPositions.find((p) => p.id === 'op-test-1')?.executedQuantity).toBe(4);
    expect(merged.orderPositions.find((p) => p.id === 'op-amendment-1')?.executedQuantity).toBe(1);
  });
});

describe('ORDER-AMENDMENT-01B3B coordinator / UI persist and clears', () => {
  function seedDraftIntent(): string {
    hydrateVorgangStore([seedLocalVorgang()]);
    const draftCreated = createOrderAmendmentDraft(VORGANG_ID, { title: 'Zusatzleistung' });
    expect(draftCreated.success).toBe(true);
    if (!draftCreated.success) throw new Error('draft');
    addOrderAmendmentDraftPosition(VORGANG_ID, draftCreated.amendment.id, {
      changeType: 'add',
      description: 'Zusatzposition',
      quantity: 2,
      unit: 'Stück',
      unitPrice: 25,
      category: 'material',
      billable: true,
    });
    const draft = getAllVorgaenge()[0]!.orderAmendments![0]!;
    const rpcInput = buildOrderAmendmentConfirmRpcInput(draft);
    seedOrderAmendmentConfirmIntentForTests({
      workspaceId: WORKSPACE_ID,
      vorgangId: VORGANG_ID,
      draftId: draft.id,
      clientAmendmentId: 'oam-client-1',
      contentFingerprint: 'client-fp',
      rpcInput,
      state: 'outcome_unknown',
      createdAt: '2026-07-24T12:00:00.000Z',
      updatedAt: '2026-07-24T12:00:00.000Z',
    });
    return draft.id;
  }

  function wireSuccessfulPullWithAmendmentClear(draftId: string): void {
    getSyncCoordinator().setAdapter({
      providerKind: 'supabase',
      pushChanges: vi.fn(async (input: { state: AppPersistedState }) => ({
        success: true,
        state: input.state,
        completedOutboxIds: [],
        failedOutbox: [],
        report: createEmptySyncSimulationReport(new Date().toISOString()),
      })),
      pullChanges: vi.fn(async (input: { state: AppPersistedState }) => ({
        success: true,
        state: {
          ...input.state,
          vorgaenge: [
            {
              ...seedLocalVorgang(),
              confirmedOrderAmendments: [buildConfirmed()],
              orderAmendments: undefined,
              orderPositions: cloudPlanWithAmendmentExecuted(),
            },
          ],
        },
        report: {
          ...createEmptySyncSimulationReport(new Date().toISOString()),
          pullCount: 1,
          mergedEntityCount: 1,
        },
        pendingAmendmentIntentClears: [{ vorgangId: VORGANG_ID, draftId }],
        pendingInvoiceIntentClears: [],
      })),
      acknowledgeChanges: vi.fn(),
      reserveInvoiceNumber: vi.fn(),
      uploadBlob: vi.fn(),
      downloadBlob: vi.fn(),
      getSyncStatus: () => ({ syncState: 'synced', pendingChanges: 0 }),
    } as never);
  }

  it('does not mark synced and skips persist on amendment global failure', async () => {
    const stubPull = vi.fn(async (input: { state: AppPersistedState }) => ({
      success: false as const,
      state: input.state,
      skipPersist: true,
      report: {
        ...createEmptySyncSimulationReport(new Date().toISOString()),
        errorCount: 1,
        errors: [{ outboxId: 'amendment-pull', message: 'RPC down' }],
        pullCount: 1,
      },
    }));

    const coordinator = new SyncCoordinator({
      providerKind: 'supabase',
      pushChanges: vi.fn(),
      pullChanges: stubPull,
      acknowledgeChanges: vi.fn(),
      reserveInvoiceNumber: vi.fn(),
      uploadBlob: vi.fn(),
      downloadBlob: vi.fn(),
      getSyncStatus: () => ({ syncState: 'error', pendingChanges: 0 }),
    } as never);

    const state = buildPullState([]);
    const result = await coordinator.runSync(state);

    expect(result.success).toBe(false);
    expect(result.skipPersist).toBe(true);
    expect(result.state).toEqual(state);
    expect(coordinator.getStatus().syncState).toBe('error');
    expect(result.pendingAmendmentIntentClears).toEqual([]);
  });

  it('runSyncFromUi persists once and clears amendment intents after persist', async () => {
    const draftId = seedDraftIntent();
    wireSuccessfulPullWithAmendmentClear(draftId);

    const saveSpy = vi.spyOn(persistenceService, 'savePersistedState');
    const applyStoresSpy = vi.spyOn(persistenceService, 'applyStateToStores');

    vi.spyOn(persistenceService, 'buildPersistedStateSnapshot').mockReturnValue(
      buildPullState(getAllVorgaenge()),
    );

    const report = await runSyncFromUi();

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(applyStoresSpy).toHaveBeenCalled();
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)).toBeNull();
    expect(getVorgangById(VORGANG_ID)?.confirmedOrderAmendments).toHaveLength(1);
    expect(report.errors.some((item) => item.outboxId === 'local-persist')).toBe(false);
  });

  it('runSyncFromUi skips persist and clears on skipPersist', async () => {
    seedDraftIntent();
    const draftId = getAllVorgaenge()[0]!.orderAmendments![0]!.id;

    getSyncCoordinator().setAdapter({
      providerKind: 'supabase',
      pushChanges: vi.fn(async (input: { state: AppPersistedState }) => ({
        success: true,
        state: input.state,
        completedOutboxIds: [],
        failedOutbox: [],
        report: createEmptySyncSimulationReport(new Date().toISOString()),
      })),
      pullChanges: vi.fn(async (input: { state: AppPersistedState }) => ({
        success: false,
        skipPersist: true,
        state: input.state,
        report: {
          ...createEmptySyncSimulationReport(new Date().toISOString()),
          errorCount: 1,
          errors: [{ outboxId: 'amendment-pull', message: 'fail' }],
          pullCount: 1,
        },
        pendingAmendmentIntentClears: [{ vorgangId: VORGANG_ID, draftId }],
      })),
      acknowledgeChanges: vi.fn(),
      reserveInvoiceNumber: vi.fn(),
      uploadBlob: vi.fn(),
      downloadBlob: vi.fn(),
      getSyncStatus: () => ({ syncState: 'error', pendingChanges: 0 }),
    } as never);

    vi.spyOn(persistenceService, 'buildPersistedStateSnapshot').mockReturnValue(
      buildPullState(getAllVorgaenge()),
    );
    const saveSpy = vi.spyOn(persistenceService, 'savePersistedState');
    const clearSpy = vi.spyOn(orderAmendmentConfirmIntentService, 'clearOrderAmendmentConfirmIntents');

    const report = await runSyncFromUi();

    expect(saveSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)).not.toBeNull();
    expect(report.errors.some((item) => item.outboxId === 'amendment-pull')).toBe(true);
    expect(getSyncCoordinator().getStatus().syncState).toBe('error');
  });

  it('persist failure restores stores and skips all intent clears', () => {
    const draftId = seedDraftIntent();
    const beforeTitle = getVorgangById(VORGANG_ID)!.title;

    vi.spyOn(persistenceService, 'savePersistedState').mockReturnValue(false);
    const clearInvoiceSpy = vi.spyOn(invoiceClearModule, 'clearMatchedInvoiceFinalizeIntents');
    const clearAmendmentSpy = vi.spyOn(
      orderAmendmentConfirmIntentService,
      'clearOrderAmendmentConfirmIntents',
    );

    const candidate = {
      ...buildPullState(getAllVorgaenge()),
      vorgaenge: [
        {
          ...seedLocalVorgang({ title: 'SHOULD-NOT-STICK' }),
          confirmedOrderAmendments: [buildConfirmed()],
        },
      ],
    };

    const applied = applySyncPullCandidateSafely({
      state: candidate,
      report: coordinatorReport({ pullCount: 1 }),
      pendingInvoiceIntentClears: [VORGANG_ID],
      pendingAmendmentIntentClears: [{ vorgangId: VORGANG_ID, draftId }],
    });

    expect(applied.persisted).toBe(false);
    expect(getVorgangById(VORGANG_ID)?.title).toBe(beforeTitle);
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)).not.toBeNull();
    expect(clearInvoiceSpy).not.toHaveBeenCalled();
    expect(clearAmendmentSpy).not.toHaveBeenCalled();
    expect(applied.report.errors.some((item) => item.outboxId === 'local-persist')).toBe(true);
    expect(getSyncCoordinator().getStatus().syncState).toBe('error');
  });

  it('clear failures after persist stay non-fatal and independent', () => {
    const draftId = seedDraftIntent();
    vi.spyOn(invoiceClearModule, 'clearMatchedInvoiceFinalizeIntents').mockImplementation(() => {
      throw new Error('invoice clear boom');
    });
    const amendmentClearSpy = vi.spyOn(
      orderAmendmentConfirmIntentService,
      'clearOrderAmendmentConfirmIntents',
    );

    const applied = applySyncPullCandidateSafely({
      state: {
        ...buildPullState(getAllVorgaenge()),
        vorgaenge: [
          {
            ...seedLocalVorgang(),
            confirmedOrderAmendments: [buildConfirmed()],
            orderAmendments: undefined,
            orderPositions: cloudPlanWithAmendmentExecuted(),
          },
        ],
      },
      report: coordinatorReport({ pullCount: 1 }),
      pendingInvoiceIntentClears: [VORGANG_ID],
      pendingAmendmentIntentClears: [{ vorgangId: VORGANG_ID, draftId }],
    });

    expect(applied.persisted).toBe(true);
    expect(amendmentClearSpy).toHaveBeenCalled();
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)).toBeNull();
    expect(getVorgangById(VORGANG_ID)?.confirmedOrderAmendments).toHaveLength(1);
    expect(
      applied.report.errors.some((item) => item.outboxId === 'invoice-intent-clear-warning'),
    ).toBe(true);
    expect(applied.report.errorCount).toBe(0);
  });

  it('bootstrap respects skipPersist and does not clear intents', async () => {
    const draftId = seedDraftIntent();
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);

    const provisionedClient = {
      ...createSyncClient(),
      serverWorkspaceId: WORKSPACE_ID,
      workspaceId: WORKSPACE_ID,
      deviceId: DEVICE_ID,
      syncPolicy: 'cloud_ready' as const,
      cloudProvisionedAt: '2026-07-24T10:00:00.000Z',
    };
    hydrateSyncClient(provisionedClient);

    const baseState: AppPersistedState = {
      ...buildPullState(getAllVorgaenge()),
      syncClient: provisionedClient,
      workspace: {
        id: WORKSPACE_ID,
        name: 'Test Workspace',
        ownerUserId: 'user-1',
        createdAt: '2026-07-24T10:00:00.000Z',
        updatedAt: '2026-07-24T10:00:00.000Z',
        version: 1,
      },
    };
    vi.spyOn(persistenceService, 'buildPersistedStateSnapshot').mockReturnValue(baseState);
    vi.spyOn(workspaceProvisioning, 'runInitialWorkspaceCloudMigration').mockResolvedValue({
      state: baseState,
      conflicts: [],
      uploaded: [],
      downloaded: [],
    });

    getSyncCoordinator().setAdapter({
      providerKind: 'supabase',
      pushChanges: vi.fn(async (input: { state: AppPersistedState }) => ({
        success: true,
        state: input.state,
        completedOutboxIds: [],
        failedOutbox: [],
        report: createEmptySyncSimulationReport(new Date().toISOString()),
      })),
      pullChanges: vi.fn(async (input: { state: AppPersistedState }) => ({
        success: false,
        skipPersist: true,
        state: input.state,
        report: {
          ...createEmptySyncSimulationReport(new Date().toISOString()),
          errorCount: 1,
          errors: [{ outboxId: 'amendment-pull', message: 'bootstrap fail' }],
          pullCount: 1,
        },
        pendingAmendmentIntentClears: [{ vorgangId: VORGANG_ID, draftId }],
      })),
      acknowledgeChanges: vi.fn(),
      reserveInvoiceNumber: vi.fn(),
      uploadBlob: vi.fn(),
      downloadBlob: vi.fn(),
      getSyncStatus: () => ({ syncState: 'error', pendingChanges: 0 }),
    } as never);

    const clearSpy = vi.spyOn(orderAmendmentConfirmIntentService, 'clearOrderAmendmentConfirmIntents');

    await bootstrapWorkspaceCloudSyncIfNeeded();

    expect(isWorkspaceCloudBootstrapCompleted()).toBe(false);
    expect(clearSpy).not.toHaveBeenCalled();
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)).not.toBeNull();
  });
});

describe('ORDER-AMENDMENT-01B3B invoice position ref warnings', () => {
  it('reports missing plan positions without mutating invoices', () => {
    const report = createEmptySyncSimulationReport(new Date().toISOString());
    const vorgang = seedLocalVorgang({
      orderPositions: [createOrderPosition({ id: 'op-test-1' })],
      invoices: [
        {
          id: 'inv-1',
          number: '2026-0001',
          type: 'abschlag',
          positions: [
            {
              id: 'line-1',
              orderPositionId: 'op-missing-amendment',
              description: 'Ghost',
              quantity: 1,
              unit: 'Stück',
              unitPrice: 10,
              lineTotal: 10,
            },
          ],
          subtotal: 10,
          taxStatus: 'standard_19',
          amount: 11.9,
          status: 'vorbereitet',
          date: '2026-07-24',
          createdAt: '2026-07-24T12:00:00.000Z',
        },
      ],
    });

    appendMissingInvoicePositionRefsToReport([vorgang], report);

    expect(report.conflictCount).toBe(1);
    expect(report.errors[0]?.outboxId).toBe('invoice-position-ref');
    expect(report.errors[0]?.message).toMatch(/op-missi/);
    expect(vorgang.invoices[0]!.positions).toHaveLength(1);
  });
});

describe('ORDER-AMENDMENT-01B3B merge pull preserves empty local then compose', () => {
  it('mergeVorgaengeFromPull on empty local keeps amendment executedQuantity', () => {
    const cloud = seedLocalVorgang({
      orderPositions: cloudPlanWithAmendmentExecuted(),
    });
    const { vorgaenge } = mergeVorgaengeFromPull(
      [],
      [remoteVorgangRow(cloud)],
      DEVICE_ID,
      WORKSPACE_ID,
    );
    expect(vorgaenge[0]!.orderPositions.find((p) => p.id === 'op-amendment-1')?.executedQuantity)
      .toBe(1);
  });
});
