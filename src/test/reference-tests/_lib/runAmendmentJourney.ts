/**
 * NT-01 — Amendment Journey Runner.
 * Wiederverwendet Production-Services + Confirm-Cloud-Mock wie orderAmendment01b2Confirm.
 */
import { vi } from 'vitest';
import * as supabaseLib from '../../../lib/supabase';
import {
  addOrderAmendmentDraftPosition,
  createOrderAmendmentDraft } from '../../../services/orderAmendmentService';
import { confirmOrderAmendmentWithCloud } from '../../../services/orderAmendment/orderAmendmentCloudConfirmOrchestrator';
import { resetOrderAmendmentConfirmIntentsForTests } from '../../../services/orderAmendment/orderAmendmentConfirmIntentService';
import {
  parseConfirmWorkspaceOrderAmendmentResponse,
  type ConfirmWorkspaceOrderAmendmentInput } from '../../../services/orderAmendment/workspaceOrderAmendmentCloudService';
import * as workspaceCloud from '../../../services/orderAmendment/workspaceOrderAmendmentCloudService';
import * as persistenceService from '../../../services/persistenceService';
import {
  ORDER_PLAN_AMENDMENT_REQUIRED,
  assertContractPlanMutable } from '../../../services/orderPlanIntegrityService';
import { getVorgangById, hydrateVorgangStore } from '../../../services/vorgangService';
import { createOrderPosition, createTestVorgang } from '../../fixtures';
import type {
  ConfirmedOrderAmendment,
  ContractConfirmationSnapshot,
  OrderPosition,
  Vorgang } from '../../../types/models';
import type { OrderAmendmentReferenceCase } from './types';

export interface AmendmentJourneyObservation {
  reference: OrderAmendmentReferenceCase;
  vorgangBeforeDraft: Vorgang;
  originalPositionsSnapshot: Array<Pick<OrderPosition, 'id' | 'description' | 'plannedQuantity' | 'unitPrice'>>;
  draftId: string;
  positionsAfterDraftBeforeConfirm: OrderPosition[];
  planMutableBeforeConfirm: boolean;
  confirmOk: boolean;
  vorgang: Vorgang;
  confirmed: ConfirmedOrderAmendment;
}

function confirmedSnapshot(reference: OrderAmendmentReferenceCase): ContractConfirmationSnapshot {
  const exp = reference.amendmentJourney;
  return {
    id: 'snapshot-nt-01',
    confirmedAt: '2026-07-24T10:00:00.000Z',
    customer: 'NT-01 Kunde GmbH',
    auftraggeber: 'NT-01 Kunde GmbH',
    baustelle: 'Nachtragstraße 1',
    title: 'NT-01 Bestätigter Auftrag',
    positions: [
      {
        id: exp.originalPositionId,
        description: exp.originalPositionDescription,
        plannedQuantity: exp.originalPlannedQuantity,
        unit: 'Stunden',
        unitPrice: 65,
        category: 'arbeit',
        billable: true },
    ],
    negotiation: {
      conducted: true,
      notes: [],
      generalHints: [],
      priceProposals: [],
      positionProposals: [],
      drafts: [] },
    immutable: true };
}

function seedConfirmedOrder(reference: OrderAmendmentReferenceCase): Vorgang {
  const exp = reference.amendmentJourney;
  const vorgang = createTestVorgang({
    id: exp.vorgangId,
    status: 'beauftragt',
    customer: 'NT-01 Kunde GmbH',
    title: 'NT-01 Bestätigter Auftrag',
    baustelle: 'Nachtragstraße 1',
    contractConfirmation: confirmedSnapshot(reference),
    orderPositions: [
      createOrderPosition({
        id: exp.originalPositionId,
        description: exp.originalPositionDescription,
        plannedQuantity: exp.originalPlannedQuantity,
        unit: 'Stunden',
        unitPrice: 65,
        category: 'arbeit',
        billable: true }),
    ] });
  hydrateVorgangStore([vorgang]);
  return getVorgangById(exp.vorgangId)!;
}

function buildConfirmedFromRpc(
  input: ConfirmWorkspaceOrderAmendmentInput,
): ConfirmedOrderAmendment {
  return {
    cloudId: 'cloud-nt-01-1',
    clientAmendmentId: input.clientAmendmentId,
    vorgangId: input.vorgangId,
    sequenceNo: 1,
    status: 'bestaetigt',
    title: input.amendment.title,
    reason: input.amendment.reason,
    positions: input.amendment.positions,
    contentFingerprint: 'nt-01-fingerprint',
    confirmedAt: '2026-07-31T12:00:00.000Z',
    confirmedBy: 'user-nt-01',
    rowVersion: 1,
    createdAt: '2026-07-31T12:00:00.000Z',
    updatedAt: '2026-07-31T12:00:00.000Z' };
}

function validRpcResponse(input: ConfirmWorkspaceOrderAmendmentInput) {
  const confirmed = buildConfirmedFromRpc(input);
  const payload = {
    ...input.amendment,
    clientAmendmentId: input.clientAmendmentId,
    vorgangId: input.vorgangId,
    sequenceNo: 1 };
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
      payload },
    amendment: payload,
    idempotent_replay: false };
}

function mockCloudReady(): void {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: 'token-nt-01' } },
        error: null }) } } as never);
  vi.spyOn(persistenceService, 'buildPersistedStateSnapshot').mockReturnValue({
    syncClient: { serverWorkspaceId: 'ws-nt-01', workspaceId: 'ws-nt-01', deviceId: 'device-nt-01' },
    workspace: { id: 'ws-nt-01' } } as never);
}

function mockSuccessfulRpc(): void {
  vi.spyOn(workspaceCloud, 'rpcConfirmWorkspaceOrderAmendment').mockImplementation(
    async (input) => {
      const parsed = parseConfirmWorkspaceOrderAmendmentResponse(validRpcResponse(input), input);
      if (!parsed) throw new Error('NT-01: RPC-Testantwort muss parsen');
      return parsed;
    },
  );
}

/**
 * Happy Path: bestätigter Auftrag → Draft → Position → Confirm-first → Plan aktualisiert.
 */
export async function runAmendmentJourney(
  reference: OrderAmendmentReferenceCase,
): Promise<AmendmentJourneyObservation> {
  if (reference.kind !== 'order-amendment') {
    throw new Error(`runAmendmentJourney erwartet kind=order-amendment, got ${reference.kind}`);
  }
  resetOrderAmendmentConfirmIntentsForTests();

  const exp = reference.amendmentJourney;
  const vorgangBeforeDraft = seedConfirmedOrder(reference);
  const originalPositionsSnapshot = (vorgangBeforeDraft.orderPositions ?? []).map((p) => ({
    id: p.id,
    description: p.description,
    plannedQuantity: p.plannedQuantity,
    unitPrice: p.unitPrice }));

  const created = createOrderAmendmentDraft(exp.vorgangId, {
    title: exp.draftTitle,
    reason: exp.draftReason });
  if (!created.success) {
    throw new Error(`NT-01: Draft fehlgeschlagen: ${created.errorKey}`);
  }

  const added = addOrderAmendmentDraftPosition(exp.vorgangId, created.amendment.id, {
    changeType: 'add',
    description: exp.newPositionDescription,
    quantity: exp.newPositionQuantity,
    unit: exp.newPositionUnit,
    unitPrice: exp.newPositionUnitPrice,
    category: 'material',
    billable: true });
  if (!added.success) {
    throw new Error(`NT-01: Position im Draft fehlgeschlagen: ${added.errorKey}`);
  }

  const afterDraft = getVorgangById(exp.vorgangId)!;
  const positionsAfterDraftBeforeConfirm = [...(afterDraft.orderPositions ?? [])];
  const planMutableBeforeConfirm = assertContractPlanMutable(afterDraft).ok;

  mockCloudReady();
  mockSuccessfulRpc();

  const confirm = await confirmOrderAmendmentWithCloud(exp.vorgangId, created.amendment.id);
  if (!confirm.ok) {
    throw new Error(`NT-01: Confirm fehlgeschlagen: ${confirm.errorKey}`);
  }

  const vorgang = getVorgangById(exp.vorgangId)!;
  const confirmed = (vorgang.confirmedOrderAmendments ?? [])[0];
  if (!confirmed) {
    throw new Error('NT-01: Kein confirmedOrderAmendment nach Confirm');
  }

  // Sanity: plan remains locked for direct edits after confirmation path.
  if (reference.amendmentJourney.requirePlanLockedAfterConfirm) {
    const mutable = assertContractPlanMutable(vorgang);
    if (mutable.ok || mutable.errorKey !== ORDER_PLAN_AMENDMENT_REQUIRED) {
      throw new Error(
        `NT-01: Plan sollte gesperrt bleiben (${ORDER_PLAN_AMENDMENT_REQUIRED}), got ${JSON.stringify(mutable)}`,
      );
    }
  }

  return {
    reference,
    vorgangBeforeDraft,
    originalPositionsSnapshot,
    draftId: created.amendment.id,
    positionsAfterDraftBeforeConfirm,
    planMutableBeforeConfirm,
    confirmOk: true,
    vorgang,
    confirmed };
}
