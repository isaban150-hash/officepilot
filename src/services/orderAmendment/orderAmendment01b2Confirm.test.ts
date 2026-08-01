import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAbschlagInvoice, createOrderPosition, createTestVorgang, testSetup } from '../../test/fixtures';
import * as supabaseLib from '../../lib/supabase';
import * as persistenceService from '../persistenceService';
import {
  addOrderAmendmentDraftPosition,
  createOrderAmendmentDraft,
  deleteOrderAmendmentDraft,
  removeOrderAmendmentDraftPosition,
  updateOrderAmendmentDraft,
  updateOrderAmendmentDraftPosition,
} from '../orderAmendmentService';
import { buildSchlussrechnungDraft } from '../invoiceService';
import {
  composeOrderPositionsFromAuthoritativePlan,
  ORDER_AMENDMENT_POSITION_ID_CONFLICT,
} from '../orderPlanCompositionService';
import { repairContractPlanFromSnapshot } from '../orderPlanIntegrityService';
import {
  getVorgangById,
  hydrateVorgangStore,
} from '../vorgangService';
import {
  mergeCloudVorgangIntoLocal,
  stripVorgangForCloud,
} from '../vorgang/vorgangCloudService';
import {
  applyConfirmedOrderAmendmentLocally,
} from './orderAmendmentLocalApplyService';
import {
  confirmOrderAmendmentWithCloud,
} from './orderAmendmentCloudConfirmOrchestrator';
import {
  getOrderAmendmentConfirmIntent,
  resetOrderAmendmentConfirmIntentsForTests,
  seedOrderAmendmentConfirmIntentForTests,
} from './orderAmendmentConfirmIntentService';
import {
  buildOrderAmendmentConfirmContentFingerprint,
  buildOrderAmendmentConfirmRpcInput,
} from './orderAmendmentConfirmPayload';
import * as workspaceCloud from './workspaceOrderAmendmentCloudService';
import {
  parseConfirmWorkspaceOrderAmendmentResponse,
  WorkspaceOrderAmendmentCloudError,
  type ConfirmWorkspaceOrderAmendmentInput,
} from './workspaceOrderAmendmentCloudService';
import type {
  ConfirmedOrderAmendment,
  ContractConfirmationSnapshot,
  Vorgang,
} from '../../types/models';

const VORGANG_ID = 'v-test-1';

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

function seedVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  const vorgang = createTestVorgang({
    id: VORGANG_ID,
    status: 'beauftragt',
    contractConfirmation: confirmedSnapshot(),
    orderPositions: [createOrderPosition({ id: 'op-test-1' })],
    ...overrides,
  });
  hydrateVorgangStore([vorgang]);
  return getVorgangById(VORGANG_ID)!;
}

function createDraftWithPosition() {
  const created = createOrderAmendmentDraft(VORGANG_ID, { title: 'Zusatzleistung' });
  expect(created.success).toBe(true);
  if (!created.success) throw new Error('Draft could not be created');
  const added = addOrderAmendmentDraftPosition(VORGANG_ID, created.amendment.id, {
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
    contentFingerprint: 'server-fingerprint-1',
    confirmedAt: '2026-07-24T12:00:00.000Z',
    confirmedBy: 'user-1',
    rowVersion: 1,
    createdAt: '2026-07-24T12:00:00.000Z',
    updatedAt: '2026-07-24T12:00:00.000Z',
    ...overrides,
  };
}

function validRpcResponse(input: ConfirmWorkspaceOrderAmendmentInput) {
  const confirmed = buildConfirmed(input.clientAmendmentId, {
    title: input.amendment.title,
    reason: input.amendment.reason,
    positions: input.amendment.positions,
  });
  const payload = {
    ...input.amendment,
    clientAmendmentId: input.clientAmendmentId,
    vorgangId: input.vorgangId,
    sequenceNo: 1,
  };
  return {
    row: {
      id: confirmed.cloudId,
      workspace_id: input.workspaceId,
      vorgang_id: input.vorgangId,
      client_amendment_id: input.clientAmendmentId,
      sequence_no: 1,
      status: 'bestaetigt',
      content_fingerprint: confirmed.contentFingerprint,
      confirmed_at: confirmed.confirmedAt,
      confirmed_by: confirmed.confirmedBy,
      row_version: 1,
      created_at: confirmed.createdAt,
      updated_at: confirmed.updatedAt,
      payload,
    },
    amendment: payload,
    idempotent_replay: false,
  };
}

function mockCloudReady() {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    auth: { getSession: async () => ({ data: { session: { access_token: 'token' } }, error: null }) },
  } as never);
  vi.spyOn(persistenceService, 'buildPersistedStateSnapshot').mockReturnValue({
    syncClient: { serverWorkspaceId: 'ws-1', workspaceId: 'ws-1', deviceId: 'device-1' },
    workspace: { id: 'ws-1' },
  } as never);
}

function mockSuccessfulRpc() {
  return vi.spyOn(workspaceCloud, 'rpcConfirmWorkspaceOrderAmendment').mockImplementation(
    async (input) => {
      const parsed = parseConfirmWorkspaceOrderAmendmentResponse(validRpcResponse(input), input);
      if (!parsed) throw new Error('Test response must parse');
      return parsed;
    },
  );
}

beforeEach(() => {  resetOrderAmendmentConfirmIntentsForTests();
  vi.restoreAllMocks();
  seedVorgang();
});

describe('ORDER-AMENDMENT-01B2 confirm intent', () => {
  it('creates intent before RPC, reuses it for unchanged content, and fingerprints position order', async () => {
    const draftId = createDraftWithPosition();
    mockCloudReady();
    const rpc = vi.spyOn(workspaceCloud, 'rpcConfirmWorkspaceOrderAmendment').mockRejectedValue(
      new WorkspaceOrderAmendmentCloudError('Network unavailable', 'network', true),
    );

    await confirmOrderAmendmentWithCloud(VORGANG_ID, draftId);
    const first = getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)!;
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({
      clientAmendmentId: first.clientAmendmentId,
    }));

    await confirmOrderAmendmentWithCloud(VORGANG_ID, draftId);
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)!.clientAmendmentId)
      .toBe(first.clientAmendmentId);

    const draft = getVorgangById(VORGANG_ID)!.orderAmendments![0]!;
    const input = buildOrderAmendmentConfirmRpcInput(draft);
    const twoPositions = {
      ...input,
      positions: [
        ...input.positions,
        { ...input.positions[0]!, id: 'op-amendment-2', description: 'Zweite Position' },
      ],
    };
    expect(buildOrderAmendmentConfirmContentFingerprint(VORGANG_ID, twoPositions)).not.toBe(
      buildOrderAmendmentConfirmContentFingerprint(VORGANG_ID, {
        ...twoPositions,
        positions: [...twoPositions.positions].reverse(),
      }),
    );
  });

  it('creates distinct intent keys for distinct drafts and only clears after successful apply', async () => {
    const firstDraft = createDraftWithPosition();
    const second = createOrderAmendmentDraft(VORGANG_ID, { title: 'Zweiter Nachtrag' });
    expect(second.success).toBe(true);
    if (!second.success) return;
    addOrderAmendmentDraftPosition(VORGANG_ID, second.amendment.id, {
      changeType: 'add', description: 'Zweite Position', quantity: 1, unit: 'Stück', unitPrice: 1,
    });
    mockCloudReady();
    vi.spyOn(workspaceCloud, 'rpcConfirmWorkspaceOrderAmendment').mockRejectedValue(
      new WorkspaceOrderAmendmentCloudError('Network', 'network', true),
    );

    await confirmOrderAmendmentWithCloud(VORGANG_ID, firstDraft);
    await confirmOrderAmendmentWithCloud(VORGANG_ID, second.amendment.id);
    const firstIntent = getOrderAmendmentConfirmIntent(VORGANG_ID, firstDraft)!;
    const secondIntent = getOrderAmendmentConfirmIntent(VORGANG_ID, second.amendment.id)!;
    expect(secondIntent.clientAmendmentId).not.toBe(firstIntent.clientAmendmentId);

    mockSuccessfulRpc();
    const firstResult = await confirmOrderAmendmentWithCloud(VORGANG_ID, firstDraft);
    expect(firstResult.ok).toBe(true);
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, firstDraft)).toBeNull();
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, second.amendment.id)).toEqual(secondIntent);
  });

  it('rolls back the full in-memory vorgang when persist fails after successful RPC', async () => {
    const draftId = createDraftWithPosition();
    const before = getVorgangById(VORGANG_ID)!;
    const beforeSnapshot = {
      orderAmendments: structuredClone(before.orderAmendments),
      confirmedOrderAmendments: structuredClone(before.confirmedOrderAmendments ?? []),
      orderPositions: structuredClone(before.orderPositions),
      executedQuantities: before.orderPositions.map((p) => ({
        id: p.id,
        executedQuantity: p.executedQuantity,
      })),
    };

    mockCloudReady();
    mockSuccessfulRpc();
    vi.spyOn(persistenceService, 'persistAll')
      .mockReturnValueOnce({ success: false } as ReturnType<typeof persistenceService.persistAll>);

    const persisted = await confirmOrderAmendmentWithCloud(VORGANG_ID, draftId);
    expect(persisted).toMatchObject({
      ok: false,
      reason: 'local_persist_failed',
      intentRetained: true,
      draftLocked: true,
    });

    const after = getVorgangById(VORGANG_ID)!;
    expect(after.orderAmendments).toEqual(beforeSnapshot.orderAmendments);
    expect(after.confirmedOrderAmendments ?? []).toEqual(beforeSnapshot.confirmedOrderAmendments);
    expect(after.orderPositions).toEqual(beforeSnapshot.orderPositions);
    expect(after.orderPositions.map((p) => ({
      id: p.id,
      executedQuantity: p.executedQuantity,
    }))).toEqual(beforeSnapshot.executedQuantities);
    expect(after.orderPositions.some((p) => p.id === 'op-amendment-1')).toBe(false);

    const intent = getOrderAmendmentConfirmIntent(VORGANG_ID, draftId);
    expect(intent).not.toBeNull();
    expect(intent!.state).toBe('local_apply_pending');
  });
});

describe('ORDER-AMENDMENT-01B2 cloud response parsing', () => {
  it('maps a valid snake_case RPC response', () => {
    const input: ConfirmWorkspaceOrderAmendmentInput = {
      workspaceId: 'ws-1', vorgangId: VORGANG_ID, clientAmendmentId: 'oam-1',
      amendment: {
        title: 'Nachtrag',
        positions: [{
          id: 'op-amendment-1', changeType: 'add', description: 'Zusatz',
          plannedQuantity: 1, unit: 'Stück', unitPrice: 10,
        }],
      },
    };
    const result = parseConfirmWorkspaceOrderAmendmentResponse(validRpcResponse(input), input);
    expect(result).toMatchObject({
      idempotentReplay: false,
      confirmed: { clientAmendmentId: 'oam-1', sequenceNo: 1, status: 'bestaetigt' },
    });
  });

  it('rejects mismatched payload/row and invalid responses', () => {
    const input: ConfirmWorkspaceOrderAmendmentInput = {
      workspaceId: 'ws-1', vorgangId: VORGANG_ID, clientAmendmentId: 'oam-1',
      amendment: {
        title: 'Nachtrag',
        positions: [{
          id: 'op-amendment-1', changeType: 'add', description: 'Zusatz',
          plannedQuantity: 1, unit: 'Stück', unitPrice: 10,
        }],
      },
    };
    const mismatch = validRpcResponse(input);
    (mismatch.row.payload as { sequenceNo: number }).sequenceNo = 2;
    expect(parseConfirmWorkspaceOrderAmendmentResponse(mismatch, input)).toBeNull();
    expect(parseConfirmWorkspaceOrderAmendmentResponse({ row: {} }, input)).toBeNull();
  });
});

describe('ORDER-AMENDMENT-01B2 confirmation orchestrator', () => {
  it('rejects missing drafts, confirmations, and final invoices locally', async () => {
    expect(await confirmOrderAmendmentWithCloud(VORGANG_ID, 'missing')).toMatchObject({
      ok: false, reason: 'draft_not_found',
    });

    hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID })]);
    expect(await confirmOrderAmendmentWithCloud(VORGANG_ID, 'missing')).toMatchObject({
      ok: false, reason: 'contract_confirmation_missing',
    });

    seedVorgang({ invoices: [{ ...createAbschlagInvoice('op-test-1', 1), type: 'schluss' }] });
    expect(await confirmOrderAmendmentWithCloud(VORGANG_ID, 'missing')).toMatchObject({
      ok: false, reason: 'final_invoice_exists',
    });
  });

  it('applies cloud success once, expands positions, and maps idempotency conflicts', async () => {
    const draftId = createDraftWithPosition();
    const draftPositionId = getVorgangById(VORGANG_ID)!.orderAmendments![0]!.positions[0]!.id;
    mockCloudReady();
    mockSuccessfulRpc();
    const success = await confirmOrderAmendmentWithCloud(VORGANG_ID, draftId);
    expect(success.ok).toBe(true);
    expect(getVorgangById(VORGANG_ID)!).toMatchObject({
      orderAmendments: undefined,
      confirmedOrderAmendments: [expect.objectContaining({ localSourceDraftId: draftId })],
    });
    expect(getVorgangById(VORGANG_ID)!.orderPositions.map((p) => p.id)).toContain(draftPositionId);

    const nextDraft = createDraftWithPosition();
    vi.spyOn(workspaceCloud, 'rpcConfirmWorkspaceOrderAmendment').mockRejectedValueOnce(
      new WorkspaceOrderAmendmentCloudError('order_amendment_idempotency_conflict', 'idempotency_conflict', false),
    );
    const conflict = await confirmOrderAmendmentWithCloud(VORGANG_ID, nextDraft);
    expect(conflict).toMatchObject({ ok: false, reason: 'idempotency_conflict' });
  });
});

describe('ORDER-AMENDMENT-01B2 local composition and cloud isolation', () => {
  it('locally applies idempotently, detects conflicts, and composes additive positions once', () => {
    const draftId = createDraftWithPosition();
    const confirmed = buildConfirmed();
    expect(applyConfirmedOrderAmendmentLocally({ vorgangId: VORGANG_ID, draftId, confirmed }))
      .toMatchObject({ ok: true, action: 'inserted' });
    expect(applyConfirmedOrderAmendmentLocally({ vorgangId: VORGANG_ID, draftId, confirmed }))
      .toMatchObject({ ok: true, action: 'noop' });
    expect(getVorgangById(VORGANG_ID)!.orderPositions.filter((p) => p.id === 'op-amendment-1')).toHaveLength(1);

    expect(applyConfirmedOrderAmendmentLocally({
      vorgangId: VORGANG_ID, draftId, confirmed: { ...confirmed, contentFingerprint: 'different' },
    })).toMatchObject({ ok: false, errorKey: 'order_amendment_local_confirmation_conflict' });
  });

  it('ignores drafts, retains the main position, preserves executed quantities, and repairs amendments', () => {
    const draftId = createDraftWithPosition();
    const confirmed = buildConfirmed('oam-2', {
      positions: [{
        id: 'op-increase-1',
        changeType: 'quantity_increase',
        parentPositionId: 'op-test-1',
        description: 'Testleistung',
        plannedQuantity: 3,
        unit: 'Stunden',
        unitPrice: 65,
      }],
    });
    const source = {
      ...getVorgangById(VORGANG_ID)!,
      orderPositions: [
        createOrderPosition({ id: 'op-test-1', executedQuantity: 4 }),
        createOrderPosition({ id: 'op-increase-1', executedQuantity: 1 }),
      ],
      confirmedOrderAmendments: [confirmed],
    };
    const composed = composeOrderPositionsFromAuthoritativePlan(source);
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.positions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'op-test-1', plannedQuantity: 10, executedQuantity: 4 }),
      expect.objectContaining({
        id: 'op-increase-1',
        plannedQuantity: 3,
        parentPositionId: 'op-test-1',
        amendmentChangeType: 'quantity_increase',
        executedQuantity: 1,
      }),
    ]));
    expect(composed.positions.some((p) => p.id === draftId)).toBe(false);
    expect(repairContractPlanFromSnapshot({ ...source, orderPositions: [] }).vorgang.orderPositions)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'op-increase-1' })]));
  });

  it('keeps confirmed amendments local across cloud serialization and merge', () => {
    const local = {
      ...getVorgangById(VORGANG_ID)!,
      confirmedOrderAmendments: [buildConfirmed()],
    };
    const payload = stripVorgangForCloud(local);
    expect(payload).not.toHaveProperty('confirmedOrderAmendments');
    const merged = mergeCloudVorgangIntoLocal(
      local, payload, 0, '2026-07-24T12:00:00.000Z', false, 'device-2', 'ws-1',
    );
    expect(merged.vorgang?.confirmedOrderAmendments).toHaveLength(1);
  });
});

describe('ORDER-AMENDMENT-01B2 final invoice revision', () => {
  it('freezes the maximum confirmed sequence for Schluss only and sends it only there', async () => {
    seedVorgang({
      confirmedOrderAmendments: [
        buildConfirmed('oam-1', { sequenceNo: 2 }),
        buildConfirmed('oam-2', { cloudId: 'cloud-2', sequenceNo: 7 }),
      ],
    });
    const schluss = buildSchlussrechnungDraft(VORGANG_ID, testSetup)!;
    expect(schluss.expectedAmendmentSequence).toBe(7);
    const { buildWorkspaceInvoiceFinalizePayload } = await import('../invoice/workspaceInvoiceCloudService');
    expect(buildWorkspaceInvoiceFinalizePayload({ ...schluss, type: 'schluss' } as never))
      .toMatchObject({ expectedAmendmentSequence: 7 });
    expect(buildWorkspaceInvoiceFinalizePayload({ ...schluss, type: 'abschlag' } as never))
      .not.toHaveProperty('expectedAmendmentSequence');
  });

  it('keeps an existing Schluss frozen at 0 after a later confirmed amendment', async () => {
    expect(getVorgangById(VORGANG_ID)!.confirmedOrderAmendments ?? []).toHaveLength(0);
    const existingSchluss = buildSchlussrechnungDraft(VORGANG_ID, testSetup)!;
    expect(existingSchluss.expectedAmendmentSequence).toBe(0);

    const abschlag = createAbschlagInvoice('op-test-1', 2);
    expect(abschlag).not.toHaveProperty('expectedAmendmentSequence');

    const draftId = createDraftWithPosition();
    mockCloudReady();
    mockSuccessfulRpc();
    const confirmed = await confirmOrderAmendmentWithCloud(VORGANG_ID, draftId);
    expect(confirmed.ok).toBe(true);
    expect(getVorgangById(VORGANG_ID)!.confirmedOrderAmendments).toEqual(
      expect.arrayContaining([expect.objectContaining({ sequenceNo: 1 })]),
    );

    expect(existingSchluss.expectedAmendmentSequence).toBe(0);
    const { buildWorkspaceInvoiceFinalizePayload } = await import('../invoice/workspaceInvoiceCloudService');
    expect(buildWorkspaceInvoiceFinalizePayload({ ...existingSchluss, type: 'schluss' } as never))
      .toMatchObject({ expectedAmendmentSequence: 0 });
    expect(buildWorkspaceInvoiceFinalizePayload({ ...abschlag } as never))
      .not.toHaveProperty('expectedAmendmentSequence');

    const newSchluss = buildSchlussrechnungDraft(VORGANG_ID, testSetup)!;
    expect(newSchluss.expectedAmendmentSequence).toBe(1);
  });
});

describe('ORDER-AMENDMENT-01B2 position id conflicts', () => {
  it('fails composition when a confirmed amendment reuses a main-contract position id', () => {
    const source = {
      ...getVorgangById(VORGANG_ID)!,
      orderPositions: [createOrderPosition({ id: 'op-test-1', executedQuantity: 3 })],
      confirmedOrderAmendments: [
        buildConfirmed('oam-conflict-main', {
          positions: [{
            id: 'op-test-1',
            changeType: 'add',
            description: 'Kollision',
            plannedQuantity: 1,
            unit: 'Stück',
            unitPrice: 10,
          }],
        }),
      ],
    };
    const beforePositions = structuredClone(source.orderPositions);
    const composed = composeOrderPositionsFromAuthoritativePlan(source);
    expect(composed).toEqual({
      ok: false,
      errorKey: ORDER_AMENDMENT_POSITION_ID_CONFLICT,
    });
    expect(source.orderPositions).toEqual(beforePositions);

    const repaired = repairContractPlanFromSnapshot(source);
    expect(repaired).toMatchObject({
      repaired: false,
      errorKey: ORDER_AMENDMENT_POSITION_ID_CONFLICT,
    });
    expect(repaired.vorgang.orderPositions).toEqual(beforePositions);
  });

  it('fails composition when two confirmed amendments share a position id', () => {
    const source = {
      ...getVorgangById(VORGANG_ID)!,
      confirmedOrderAmendments: [
        buildConfirmed('oam-a', {
          positions: [{
            id: 'amend-pos-1',
            changeType: 'add',
            description: 'A',
            plannedQuantity: 1,
            unit: 'Stück',
            unitPrice: 10,
          }],
        }),
        buildConfirmed('oam-b', {
          cloudId: 'cloud-2',
          sequenceNo: 2,
          positions: [{
            id: 'amend-pos-1',
            changeType: 'add',
            description: 'B',
            plannedQuantity: 2,
            unit: 'Stück',
            unitPrice: 20,
          }],
        }),
      ],
    };
    expect(composeOrderPositionsFromAuthoritativePlan(source)).toEqual({
      ok: false,
      errorKey: ORDER_AMENDMENT_POSITION_ID_CONFLICT,
    });
  });

  it('fails composition when one confirmed amendment contains the same position id twice', () => {
    const source = {
      ...getVorgangById(VORGANG_ID)!,
      confirmedOrderAmendments: [
        buildConfirmed('oam-dup', {
          positions: [
            {
              id: 'dup-pos',
              changeType: 'add',
              description: 'Erste',
              plannedQuantity: 1,
              unit: 'Stück',
              unitPrice: 10,
            },
            {
              id: 'dup-pos',
              changeType: 'add',
              description: 'Zweite',
              plannedQuantity: 2,
              unit: 'Stück',
              unitPrice: 20,
            },
          ],
        }),
      ],
    };
    expect(composeOrderPositionsFromAuthoritativePlan(source)).toEqual({
      ok: false,
      errorKey: ORDER_AMENDMENT_POSITION_ID_CONFLICT,
    });
  });

  it('composes unique ids idempotently without dropping amendment positions', () => {
    const confirmed = buildConfirmed();
    const source = {
      ...getVorgangById(VORGANG_ID)!,
      confirmedOrderAmendments: [confirmed],
    };
    const first = composeOrderPositionsFromAuthoritativePlan(source);
    const second = composeOrderPositionsFromAuthoritativePlan(source);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.positions.map((p) => p.id)).toEqual(['op-test-1', 'op-amendment-1']);
    expect(second.positions).toEqual(first.positions);
  });

  it('rejects local apply on colliding cloud confirmation without mutating state', async () => {
    const draftId = createDraftWithPosition();
    const before = getVorgangById(VORGANG_ID)!;
    const beforeSnapshot = {
      orderAmendments: structuredClone(before.orderAmendments),
      confirmedOrderAmendments: structuredClone(before.confirmedOrderAmendments ?? []),
      orderPositions: structuredClone(before.orderPositions),
      executedQuantities: before.orderPositions.map((p) => ({
        id: p.id,
        executedQuantity: p.executedQuantity,
      })),
    };

    mockCloudReady();
    vi.spyOn(workspaceCloud, 'rpcConfirmWorkspaceOrderAmendment').mockImplementation(async (input) => ({
      confirmed: buildConfirmed(input.clientAmendmentId, {
        positions: [{
          id: 'op-test-1',
          changeType: 'add',
          description: 'Kollision',
          plannedQuantity: 1,
          unit: 'Stück',
          unitPrice: 10,
        }],
      }),
      idempotentReplay: false,
    }));

    const result = await confirmOrderAmendmentWithCloud(VORGANG_ID, draftId);
    expect(result).toMatchObject({
      ok: false,
      reason: 'position_id_conflict',
      errorKey: ORDER_AMENDMENT_POSITION_ID_CONFLICT,
      intentRetained: true,
    });

    const after = getVorgangById(VORGANG_ID)!;
    expect(after.orderAmendments).toEqual(beforeSnapshot.orderAmendments);
    expect(after.confirmedOrderAmendments ?? []).toEqual(beforeSnapshot.confirmedOrderAmendments);
    expect(after.orderPositions).toEqual(beforeSnapshot.orderPositions);
    expect(after.orderPositions.map((p) => ({
      id: p.id,
      executedQuantity: p.executedQuantity,
    }))).toEqual(beforeSnapshot.executedQuantities);
    expect(getOrderAmendmentConfirmIntent(VORGANG_ID, draftId)?.state).toBe('local_apply_pending');
  });
});

describe('ORDER-AMENDMENT-01B2 service draft lock', () => {
  function seedLockedIntent(
    draftId: string,
    state: 'outcome_unknown' | 'local_apply_pending' | 'pending',
  ) {
    const draft = getVorgangById(VORGANG_ID)!.orderAmendments!.find((item) => item.id === draftId)!;
    const rpcInput = buildOrderAmendmentConfirmRpcInput(draft);
    seedOrderAmendmentConfirmIntentForTests({
      workspaceId: 'ws-1',
      vorgangId: VORGANG_ID,
      draftId,
      clientAmendmentId: 'oam-lock-1',
      contentFingerprint: 'fp-lock',
      rpcInput,
      state,
      createdAt: '2026-07-24T12:00:00.000Z',
      updatedAt: '2026-07-24T12:00:00.000Z',
    });
  }

  function expectDraftMutationsRejected(draftId: string) {
    const positionId = getVorgangById(VORGANG_ID)!.orderAmendments!
      .find((item) => item.id === draftId)!.positions[0]!.id;

    expect(updateOrderAmendmentDraft(VORGANG_ID, draftId, { title: 'Geändert' }))
      .toMatchObject({ success: false, errorKey: 'order_amendment_confirmation_outcome_unknown' });
    expect(deleteOrderAmendmentDraft(VORGANG_ID, draftId))
      .toMatchObject({ success: false, errorKey: 'order_amendment_confirmation_outcome_unknown' });
    expect(addOrderAmendmentDraftPosition(VORGANG_ID, draftId, {
      changeType: 'add',
      description: 'Neue Position',
      quantity: 1,
      unit: 'Stück',
      unitPrice: 1,
    })).toMatchObject({ success: false, errorKey: 'order_amendment_confirmation_outcome_unknown' });
    expect(updateOrderAmendmentDraftPosition(VORGANG_ID, draftId, positionId, {
      description: 'Geänderte Position',
    })).toMatchObject({ success: false, errorKey: 'order_amendment_confirmation_outcome_unknown' });
    expect(removeOrderAmendmentDraftPosition(VORGANG_ID, draftId, positionId))
      .toMatchObject({ success: false, errorKey: 'order_amendment_confirmation_outcome_unknown' });
  }

  it('rejects draft mutations while intent is outcome_unknown', () => {
    const draftId = createDraftWithPosition();
    seedLockedIntent(draftId, 'outcome_unknown');
    expectDraftMutationsRejected(draftId);
    expect(getVorgangById(VORGANG_ID)!.orderAmendments).toHaveLength(1);
  });

  it('rejects draft mutations while intent is local_apply_pending', () => {
    const draftId = createDraftWithPosition();
    seedLockedIntent(draftId, 'local_apply_pending');
    expectDraftMutationsRejected(draftId);
    expect(getVorgangById(VORGANG_ID)!.orderAmendments).toHaveLength(1);
  });

  it('does not service-lock draft mutations while intent is only pending', () => {
    const draftId = createDraftWithPosition();
    seedLockedIntent(draftId, 'pending');
    expect(updateOrderAmendmentDraft(VORGANG_ID, draftId, { title: 'Noch änderbar' }))
      .toMatchObject({ success: true });
    expect(getVorgangById(VORGANG_ID)!.orderAmendments![0]!.title).toBe('Noch änderbar');
  });
});
