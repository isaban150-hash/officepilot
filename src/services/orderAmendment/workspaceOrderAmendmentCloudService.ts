import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../lib/supabase';
import { WorkspaceCloudError } from '../workspace/workspaceCloudService';
import type {
  ConfirmedOrderAmendment,
  ConfirmedOrderAmendmentPosition,
  OrderAmendmentChangeType,
  OrderUnit,
  OrderPositionCategory,
} from '../../types/models';
import type { OrderAmendmentConfirmRpcInput } from './orderAmendmentConfirmPayload';

export type WorkspaceOrderAmendmentCloudErrorCode =
  | 'auth'
  | 'rls'
  | 'network'
  | 'validation'
  | 'idempotency_conflict'
  | 'final_invoice_exists'
  | 'position_id_conflict'
  | 'parent_position_not_found'
  | 'contract_confirmation_missing'
  | 'vorgang_not_found'
  | 'invalid_response'
  | 'unknown';

export class WorkspaceOrderAmendmentCloudError extends Error {
  readonly code: WorkspaceOrderAmendmentCloudErrorCode;
  readonly retryable: boolean;

  constructor(
    message: string,
    code: WorkspaceOrderAmendmentCloudErrorCode,
    retryable: boolean,
  ) {
    super(message);
    this.name = 'WorkspaceOrderAmendmentCloudError';
    this.code = code;
    this.retryable = retryable;
  }
}

export type ConfirmWorkspaceOrderAmendmentInput = {
  workspaceId: string;
  vorgangId: string;
  clientAmendmentId: string;
  amendment: OrderAmendmentConfirmRpcInput;
};

export type ConfirmWorkspaceOrderAmendmentResult = {
  confirmed: ConfirmedOrderAmendment;
  idempotentReplay: boolean;
};

const ORDER_UNITS = new Set<OrderUnit>(['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal']);
const CHANGE_TYPES = new Set<OrderAmendmentChangeType>(['add', 'quantity_increase']);

function getClient(client?: SupabaseClient | null): SupabaseClient {
  const resolved = client ?? getSupabaseClient();
  if (!resolved) {
    throw new WorkspaceOrderAmendmentCloudError(
      'Supabase ist nicht konfiguriert.',
      'unknown',
      false,
    );
  }
  return resolved;
}

export function classifyOrderAmendmentCloudError(error: {
  message?: string;
  code?: string;
}): WorkspaceOrderAmendmentCloudError {
  const message = error.message ?? 'Unbekannter Cloud-Fehler';
  if (message.includes('Nicht angemeldet') || error.code === 'PGRST301') {
    return new WorkspaceOrderAmendmentCloudError(message, 'auth', false);
  }
  if (
    message.includes('Kein Zugriff') ||
    message.includes('permission') ||
    error.code === '42501'
  ) {
    return new WorkspaceOrderAmendmentCloudError(message, 'rls', false);
  }
  if (message.includes('order_amendment_idempotency_conflict')) {
    return new WorkspaceOrderAmendmentCloudError(message, 'idempotency_conflict', false);
  }
  if (message.includes('order_amendment_final_invoice_exists')) {
    return new WorkspaceOrderAmendmentCloudError(message, 'final_invoice_exists', false);
  }
  if (message.includes('order_amendment_position_id_conflict')) {
    return new WorkspaceOrderAmendmentCloudError(message, 'position_id_conflict', false);
  }
  if (message.includes('order_amendment_parent_position_not_found')) {
    return new WorkspaceOrderAmendmentCloudError(message, 'parent_position_not_found', false);
  }
  if (message.includes('order_amendment_contract_confirmation_missing')) {
    return new WorkspaceOrderAmendmentCloudError(
      message,
      'contract_confirmation_missing',
      false,
    );
  }
  if (message.includes('order_amendment_vorgang_not_found')) {
    return new WorkspaceOrderAmendmentCloudError(message, 'vorgang_not_found', false);
  }
  if (
    message.includes('order_amendment_invalid_position') ||
    message.includes('fehlt') ||
    message.includes('workspace_id')
  ) {
    return new WorkspaceOrderAmendmentCloudError(message, 'validation', false);
  }
  if (message.includes('Failed to fetch') || message.includes('Network')) {
    return new WorkspaceOrderAmendmentCloudError(message, 'network', true);
  }
  if (error instanceof WorkspaceCloudError) {
    return new WorkspaceOrderAmendmentCloudError(
      error.message,
      error.code === 'auth' || error.code === 'rls' || error.code === 'network'
        ? error.code
        : 'unknown',
      error.retryable,
    );
  }
  return new WorkspaceOrderAmendmentCloudError(message, 'unknown', true);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function requirePositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function parsePosition(raw: unknown): ConfirmedOrderAmendmentPosition | null {
  const row = asRecord(raw);
  if (!row) return null;
  const id = requireNonEmptyString(row.id);
  const changeTypeRaw = requireNonEmptyString(row.changeType);
  const description = requireNonEmptyString(row.description);
  const unitRaw = requireNonEmptyString(row.unit);
  if (!id || !changeTypeRaw || !description || !unitRaw) return null;
  if (!CHANGE_TYPES.has(changeTypeRaw as OrderAmendmentChangeType)) return null;
  if (!ORDER_UNITS.has(unitRaw as OrderUnit)) return null;
  if (typeof row.plannedQuantity !== 'number' || !Number.isFinite(row.plannedQuantity) || row.plannedQuantity <= 0) {
    return null;
  }
  if (typeof row.unitPrice !== 'number' || !Number.isFinite(row.unitPrice) || row.unitPrice < 0) {
    return null;
  }

  const changeType = changeTypeRaw as OrderAmendmentChangeType;
  const parentRaw =
    row.parentPositionId === null || row.parentPositionId === undefined
      ? undefined
      : requireNonEmptyString(row.parentPositionId);
  if (changeType === 'add' && parentRaw) return null;
  if (changeType === 'quantity_increase' && !parentRaw) return null;

  const position: ConfirmedOrderAmendmentPosition = {
    id,
    changeType,
    description,
    plannedQuantity: row.plannedQuantity,
    unit: unitRaw as OrderUnit,
    unitPrice: row.unitPrice,
  };
  if (parentRaw) position.parentPositionId = parentRaw;
  if (typeof row.unitLabel === 'string' && row.unitLabel.trim()) {
    position.unitLabel = row.unitLabel.trim();
  }
  if (row.category === 'arbeit' || row.category === 'material' || row.category === 'sonstiges') {
    position.category = row.category as OrderPositionCategory;
  }
  if (typeof row.billable === 'boolean') position.billable = row.billable;
  return position;
}

/**
 * Parse a workspace_order_amendments cloud row (+ payload) into ConfirmedOrderAmendment.
 * Shared by Confirm-response and Pull-row parsers.
 */
function parseConfirmedOrderAmendmentFromCloudRow(
  row: Record<string, unknown>,
  payloadSource: Record<string, unknown>,
  expected?: {
    workspaceId: string;
    vorgangId?: string;
    clientAmendmentId?: string;
  },
): ConfirmedOrderAmendment | null {
  const cloudId = requireNonEmptyString(row.id);
  const workspaceId = requireNonEmptyString(row.workspace_id);
  const vorgangId = requireNonEmptyString(row.vorgang_id);
  const clientAmendmentId = requireNonEmptyString(row.client_amendment_id);
  const sequenceNo = requirePositiveInt(row.sequence_no);
  const status = requireNonEmptyString(row.status);
  const contentFingerprint = requireNonEmptyString(row.content_fingerprint);
  const confirmedAt = requireNonEmptyString(row.confirmed_at);
  const confirmedBy = requireNonEmptyString(row.confirmed_by);
  const rowVersion = requirePositiveInt(row.row_version);
  const createdAt = requireNonEmptyString(row.created_at);
  const updatedAt = requireNonEmptyString(row.updated_at);

  if (
    !cloudId ||
    !workspaceId ||
    !vorgangId ||
    !clientAmendmentId ||
    sequenceNo === null ||
    !status ||
    !contentFingerprint ||
    !confirmedAt ||
    !confirmedBy ||
    rowVersion === null ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }

  if (status !== 'bestaetigt') return null;
  if (expected && workspaceId !== expected.workspaceId) return null;
  if (expected?.vorgangId && vorgangId !== expected.vorgangId) return null;
  if (expected?.clientAmendmentId && clientAmendmentId !== expected.clientAmendmentId) {
    return null;
  }

  const payloadTitle = requireNonEmptyString(payloadSource.title);
  const payloadClientId = requireNonEmptyString(payloadSource.clientAmendmentId);
  const payloadVorgangId = requireNonEmptyString(payloadSource.vorgangId);
  const payloadSequence = requirePositiveInt(payloadSource.sequenceNo);
  const positionsRaw = payloadSource.positions;
  if (
    !payloadTitle ||
    !payloadClientId ||
    !payloadVorgangId ||
    payloadSequence === null ||
    !Array.isArray(positionsRaw) ||
    positionsRaw.length < 1
  ) {
    return null;
  }

  if (
    payloadClientId !== clientAmendmentId ||
    payloadVorgangId !== vorgangId ||
    payloadSequence !== sequenceNo
  ) {
    return null;
  }

  const positions: ConfirmedOrderAmendmentPosition[] = [];
  const seenPositionIds = new Set<string>();
  for (const item of positionsRaw) {
    const parsed = parsePosition(item);
    if (!parsed) return null;
    if (seenPositionIds.has(parsed.id)) return null;
    seenPositionIds.add(parsed.id);
    positions.push(parsed);
  }

  const reason =
    typeof payloadSource.reason === 'string' && payloadSource.reason.trim()
      ? payloadSource.reason.trim()
      : payloadSource.reason === null || payloadSource.reason === undefined
        ? undefined
        : null;
  if (reason === null) return null;

  return {
    cloudId,
    clientAmendmentId,
    vorgangId,
    sequenceNo,
    status: 'bestaetigt',
    title: payloadTitle,
    reason,
    positions,
    contentFingerprint,
    confirmedAt,
    confirmedBy,
    rowVersion,
    createdAt,
    updatedAt,
  };
}

export function parseConfirmWorkspaceOrderAmendmentResponse(
  data: unknown,
  expected: {
    workspaceId: string;
    vorgangId: string;
    clientAmendmentId: string;
  },
): ConfirmWorkspaceOrderAmendmentResult | null {
  const root = asRecord(data);
  if (!root) return null;
  const row = asRecord(root.row);
  const amendmentPayload = asRecord(root.amendment);
  if (!row || !amendmentPayload) return null;

  const payload = asRecord(row.payload) ?? amendmentPayload;
  const confirmed = parseConfirmedOrderAmendmentFromCloudRow(row, payload, expected);
  if (!confirmed) return null;

  return {
    confirmed,
    idempotentReplay: root.idempotent_replay === true,
  };
}

/**
 * Strict Pull-row parser (ORDER-AMENDMENT-01B3A).
 * Returns null for malformed / wrong-workspace rows (caller isolates).
 */
export function parseWorkspaceOrderAmendmentPullRow(
  raw: unknown,
  expectedWorkspaceId: string,
): ConfirmedOrderAmendment | null {
  const row = asRecord(raw);
  if (!row) return null;
  const payload = asRecord(row.payload);
  if (!payload) return null;
  return parseConfirmedOrderAmendmentFromCloudRow(row, payload, {
    workspaceId: expectedWorkspaceId,
  });
}

export async function rpcConfirmWorkspaceOrderAmendment(
  input: ConfirmWorkspaceOrderAmendmentInput,
  client?: SupabaseClient | null,
): Promise<ConfirmWorkspaceOrderAmendmentResult> {
  const supabase = getClient(client);
  const { data, error } = await supabase.rpc('confirm_workspace_order_amendment', {
    p_workspace_id: input.workspaceId,
    p_vorgang_id: input.vorgangId,
    p_client_amendment_id: input.clientAmendmentId,
    p_amendment: input.amendment,
  });

  if (error) {
    throw classifyOrderAmendmentCloudError(error);
  }

  const parsed = parseConfirmWorkspaceOrderAmendmentResponse(data, {
    workspaceId: input.workspaceId,
    vorgangId: input.vorgangId,
    clientAmendmentId: input.clientAmendmentId,
  });
  if (!parsed) {
    throw new WorkspaceOrderAmendmentCloudError(
      'Ungültige RPC-Antwort für Nachtragsbestätigung.',
      'invalid_response',
      true,
    );
  }
  return parsed;
}

/**
 * Full amendment pull (ORDER-AMENDMENT-01B3A). Always sends p_since = null.
 * Response must be a JSON array — null/object/string are global invalid_response.
 */
export async function rpcPullWorkspaceOrderAmendmentRows(
  workspaceId: string,
  options?: { client?: SupabaseClient | null },
): Promise<unknown[]> {
  if (!workspaceId.trim()) {
    throw new WorkspaceOrderAmendmentCloudError('workspace_id fehlt', 'validation', false);
  }

  try {
    const supabase = getClient(options?.client);
    const { data, error } = await supabase.rpc('pull_workspace_order_amendments', {
      p_workspace_id: workspaceId,
      p_since: null,
    });

    if (error) {
      throw classifyOrderAmendmentCloudError(error);
    }

    if (data === null || data === undefined) {
      throw new WorkspaceOrderAmendmentCloudError(
        'Ungültige RPC-Antwort für Nachtrags-Pull: null.',
        'invalid_response',
        true,
      );
    }
    if (!Array.isArray(data)) {
      throw new WorkspaceOrderAmendmentCloudError(
        'Ungültige RPC-Antwort für Nachtrags-Pull: kein Array.',
        'invalid_response',
        true,
      );
    }
    return data;
  } catch (error) {
    if (error instanceof WorkspaceOrderAmendmentCloudError) {
      throw error;
    }
    throw classifyOrderAmendmentCloudError(
      error instanceof Error ? { message: error.message } : { message: 'Unbekannter Fehler' },
    );
  }
}
