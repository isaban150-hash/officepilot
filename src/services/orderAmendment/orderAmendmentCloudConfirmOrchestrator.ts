import type { ConfirmedOrderAmendment, OrderAmendment, Vorgang } from '../../types/models';
import { isSupabaseConfigured, getSupabaseClient } from '../../lib/supabase';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { getVorgangById } from '../vorgangService';
import { hasFinalSchlussrechnung } from '../orderBillingRules';
import {
  getOrderAmendment,
} from '../orderAmendmentService';
import {
  clearOrderAmendmentConfirmIntent,
  getOrderAmendmentConfirmIntent,
  resolveOrderAmendmentConfirmIntent,
  updateOrderAmendmentConfirmIntentState,
  type OrderAmendmentConfirmIntent,
} from './orderAmendmentConfirmIntentService';
import {
  buildOrderAmendmentConfirmContentFingerprint,
  buildOrderAmendmentConfirmRpcInput,
} from './orderAmendmentConfirmPayload';
import { applyConfirmedOrderAmendmentLocally } from './orderAmendmentLocalApplyService';
import {
  rpcConfirmWorkspaceOrderAmendment,
  WorkspaceOrderAmendmentCloudError,
} from './workspaceOrderAmendmentCloudService';

export type OrderAmendmentConfirmFailureReason =
  | 'vorgang_missing'
  | 'draft_not_found'
  | 'contract_confirmation_missing'
  | 'final_invoice_exists'
  | 'invalid_position'
  | 'cloud_unavailable'
  | 'session_required'
  | 'workspace_required'
  | 'network_or_unknown'
  | 'idempotency_conflict'
  | 'position_id_conflict'
  | 'parent_position_not_found'
  | 'vorgang_not_found'
  | 'invalid_response'
  | 'local_persist_failed'
  | 'local_confirmation_conflict'
  | 'already_confirmed'
  | 'draft_locked'
  | 'rpc_failed';

export type OrderAmendmentConfirmResult =
  | {
      ok: true;
      vorgang: Vorgang;
      confirmed: ConfirmedOrderAmendment;
      idempotentReplay: boolean;
    }
  | {
      ok: false;
      reason: OrderAmendmentConfirmFailureReason;
      errorKey: string;
      message?: string;
      intentRetained?: boolean;
      draftLocked?: boolean;
    };

async function hasAuthSession(): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;
  const { data, error } = await client.auth.getSession();
  return Boolean(!error && data.session);
}

function resolveActiveWorkspaceId(): string {
  return resolveCloudWorkspaceId(buildPersistedStateSnapshot()) ?? '';
}

function validateDraftForConfirm(draft: OrderAmendment): string | null {
  if (!draft.title.trim()) return 'order_amendment_invalid_position';
  if (!draft.positions.length) return 'order_amendment_invalid_position';
  for (const position of draft.positions) {
    if (!position.description.trim()) return 'order_amendment_invalid_position';
    if (!Number.isFinite(position.quantity) || position.quantity <= 0) {
      return 'order_amendment_invalid_position';
    }
    if (!Number.isFinite(position.unitPrice) || position.unitPrice < 0) {
      return 'order_amendment_invalid_position';
    }
    if (position.changeType === 'quantity_increase' && !position.parentPositionId) {
      return 'order_amendment_parent_position_not_found';
    }
    if (position.changeType === 'add' && position.parentPositionId) {
      return 'order_amendment_invalid_position';
    }
  }
  return null;
}

function mapCloudError(
  error: WorkspaceOrderAmendmentCloudError,
): OrderAmendmentConfirmFailureReason {
  switch (error.code) {
    case 'auth':
      return 'session_required';
    case 'network':
    case 'unknown':
      return 'network_or_unknown';
    case 'idempotency_conflict':
      return 'idempotency_conflict';
    case 'final_invoice_exists':
      return 'final_invoice_exists';
    case 'position_id_conflict':
      return 'position_id_conflict';
    case 'parent_position_not_found':
      return 'parent_position_not_found';
    case 'contract_confirmation_missing':
      return 'contract_confirmation_missing';
    case 'vorgang_not_found':
      return 'vorgang_not_found';
    case 'invalid_response':
      return 'invalid_response';
    case 'validation':
      return 'invalid_position';
    default:
      return 'rpc_failed';
  }
}

function errorKeyForReason(reason: OrderAmendmentConfirmFailureReason): string {
  const map: Record<OrderAmendmentConfirmFailureReason, string> = {
    vorgang_missing: 'vorgang.notFound',
    draft_not_found: 'order_amendment_draft_not_found',
    contract_confirmation_missing: 'order_amendment_contract_confirmation_missing',
    final_invoice_exists: 'order_amendment_final_invoice_exists',
    invalid_position: 'order_amendment_invalid_position',
    cloud_unavailable: 'order_amendment_cloud_unavailable',
    session_required: 'order_amendment_session_required',
    workspace_required: 'order_amendment_workspace_required',
    network_or_unknown: 'order_amendment_confirmation_outcome_unknown',
    idempotency_conflict: 'order_amendment_idempotency_conflict',
    position_id_conflict: 'order_amendment_position_id_conflict',
    parent_position_not_found: 'order_amendment_parent_position_not_found',
    vorgang_not_found: 'order_amendment_vorgang_not_found',
    invalid_response: 'order_amendment_confirmation_outcome_unknown',
    local_persist_failed: 'order_amendment_local_persist_failed',
    local_confirmation_conflict: 'order_amendment_local_confirmation_conflict',
    already_confirmed: 'order_amendment_already_confirmed',
    draft_locked: 'order_amendment_confirmation_outcome_unknown',
    rpc_failed: 'order_amendment_cloud_unavailable',
  };
  return map[reason];
}

export async function confirmOrderAmendmentWithCloud(
  vorgangId: string,
  draftId: string,
): Promise<OrderAmendmentConfirmResult> {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) {
    return {
      ok: false,
      reason: 'vorgang_missing',
      errorKey: errorKeyForReason('vorgang_missing'),
    };
  }

  if (!vorgang.contractConfirmation) {
    return {
      ok: false,
      reason: 'contract_confirmation_missing',
      errorKey: errorKeyForReason('contract_confirmation_missing'),
    };
  }

  if (hasFinalSchlussrechnung(vorgang)) {
    clearOrderAmendmentConfirmIntent(vorgangId, draftId);
    return {
      ok: false,
      reason: 'final_invoice_exists',
      errorKey: errorKeyForReason('final_invoice_exists'),
    };
  }

  const already = (vorgang.confirmedOrderAmendments ?? []).find(
    (item) => item.localSourceDraftId === draftId,
  );
  if (already) {
    clearOrderAmendmentConfirmIntent(vorgangId, draftId);
    return {
      ok: false,
      reason: 'already_confirmed',
      errorKey: errorKeyForReason('already_confirmed'),
    };
  }

  const draft = getOrderAmendment(vorgangId, draftId);
  if (!draft) {
    return {
      ok: false,
      reason: 'draft_not_found',
      errorKey: errorKeyForReason('draft_not_found'),
    };
  }

  const existingIntent = getOrderAmendmentConfirmIntent(vorgangId, draftId);
  if (
    existingIntent &&
    (existingIntent.state === 'outcome_unknown' || existingIntent.state === 'local_apply_pending')
  ) {
    const lockedFingerprint = buildOrderAmendmentConfirmContentFingerprint(
      vorgangId,
      existingIntent.rpcInput,
    );
    const currentInput = buildOrderAmendmentConfirmRpcInput(draft);
    const currentFingerprint = buildOrderAmendmentConfirmContentFingerprint(
      vorgangId,
      currentInput,
    );
    if (currentFingerprint !== lockedFingerprint) {
      return {
        ok: false,
        reason: 'draft_locked',
        errorKey: errorKeyForReason('draft_locked'),
        intentRetained: true,
        draftLocked: true,
        message: 'Der Entwurf ist für einen sicheren Retry gesperrt.',
      };
    }
  }

  const validationError = validateDraftForConfirm(draft);
  if (validationError) {
    return {
      ok: false,
      reason: 'invalid_position',
      errorKey: validationError,
    };
  }

  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      reason: 'cloud_unavailable',
      errorKey: errorKeyForReason('cloud_unavailable'),
    };
  }

  if (!(await hasAuthSession())) {
    return {
      ok: false,
      reason: 'session_required',
      errorKey: errorKeyForReason('session_required'),
    };
  }

  const workspaceId = resolveActiveWorkspaceId();
  if (!workspaceId) {
    return {
      ok: false,
      reason: 'workspace_required',
      errorKey: errorKeyForReason('workspace_required'),
    };
  }

  const rpcInput = existingIntent?.state === 'outcome_unknown' ||
    existingIntent?.state === 'local_apply_pending'
    ? existingIntent.rpcInput
    : buildOrderAmendmentConfirmRpcInput(draft);
  const fingerprint = buildOrderAmendmentConfirmContentFingerprint(vorgangId, rpcInput);

  const intent: OrderAmendmentConfirmIntent = resolveOrderAmendmentConfirmIntent({
    workspaceId,
    vorgangId,
    draftId,
    contentFingerprint: fingerprint,
    rpcInput,
  });

  let rpcResult;
  try {
    rpcResult = await rpcConfirmWorkspaceOrderAmendment({
      workspaceId,
      vorgangId,
      clientAmendmentId: intent.clientAmendmentId,
      amendment: intent.rpcInput,
    });
  } catch (error) {
    if (error instanceof WorkspaceOrderAmendmentCloudError) {
      const reason = mapCloudError(error);
      if (reason === 'network_or_unknown' || reason === 'invalid_response') {
        updateOrderAmendmentConfirmIntentState(vorgangId, draftId, 'outcome_unknown');
        return {
          ok: false,
          reason,
          errorKey: errorKeyForReason(reason),
          message: error.message,
          intentRetained: true,
          draftLocked: true,
        };
      }
      if (
        reason === 'final_invoice_exists' ||
        reason === 'idempotency_conflict' ||
        reason === 'position_id_conflict' ||
        reason === 'parent_position_not_found' ||
        reason === 'contract_confirmation_missing' ||
        reason === 'vorgang_not_found' ||
        reason === 'invalid_position'
      ) {
        clearOrderAmendmentConfirmIntent(vorgangId, draftId);
      }
      return {
        ok: false,
        reason,
        errorKey: errorKeyForReason(reason),
        message: error.message,
        intentRetained: false,
      };
    }
    updateOrderAmendmentConfirmIntentState(vorgangId, draftId, 'outcome_unknown');
    return {
      ok: false,
      reason: 'network_or_unknown',
      errorKey: errorKeyForReason('network_or_unknown'),
      message: error instanceof Error ? error.message : 'Unbekannter Fehler',
      intentRetained: true,
      draftLocked: true,
    };
  }

  updateOrderAmendmentConfirmIntentState(vorgangId, draftId, 'local_apply_pending');

  const apply = applyConfirmedOrderAmendmentLocally({
    vorgangId,
    draftId,
    confirmed: rpcResult.confirmed,
  });

  if (!apply.ok) {
    const reason =
      apply.errorKey === 'order_amendment_position_id_conflict'
        ? 'position_id_conflict'
        : apply.errorKey === 'order_amendment_local_confirmation_conflict'
          ? 'local_confirmation_conflict'
          : 'local_persist_failed';
    return {
      ok: false,
      reason,
      errorKey: apply.errorKey,
      intentRetained: true,
      draftLocked: true,
      message: 'Serverseitig bestätigt — lokale Übernahme ausstehend.',
    };
  }

  clearOrderAmendmentConfirmIntent(vorgangId, draftId);

  return {
    ok: true,
    vorgang: apply.vorgang,
    confirmed: rpcResult.confirmed,
    idempotentReplay: rpcResult.idempotentReplay,
  };
}
