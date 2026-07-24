import type { SupabaseClient } from '@supabase/supabase-js';
import type { VorgangInvoice, VorgangInvoiceLine } from '../../types/models';
import { getSupabaseClient } from '../../lib/supabase';
import { WorkspaceCloudError } from '../workspace/workspaceCloudService';
import { formatInvoiceNumber } from '../invoiceNumberService';

/**
 * CLOUD-ORDER-CHAIN-03A/03B2 – thin binding for finalize + pull workspace invoices.
 *
 * Note on SyncAdapter.reserveInvoiceNumber:
 * Separating number reservation from invoice insert is unsafe for multi-device.
 * SupabaseSyncAdapter must keep throwing on reserveInvoiceNumber; use this RPC instead.
 */

export type WorkspaceInvoiceCloudErrorCode =
  | 'auth'
  | 'rls'
  | 'validation'
  | 'idempotency_conflict'
  | 'network'
  | 'unknown';

export class WorkspaceInvoiceCloudError extends Error {
  readonly code: WorkspaceInvoiceCloudErrorCode;
  readonly retryable: boolean;

  constructor(message: string, code: WorkspaceInvoiceCloudErrorCode, retryable = false) {
    super(message);
    this.name = 'WorkspaceInvoiceCloudError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface WorkspaceInvoiceFinalizeInput {
  workspaceId: string;
  vorgangId: string;
  /** Stable idempotency key — typically VorgangInvoice.id */
  clientInvoiceId: string;
  invoice: VorgangInvoice;
}

export interface WorkspaceInvoiceFinalizeResult {
  invoice: VorgangInvoice;
  idempotentReplay: boolean;
  rowVersion: number;
  cloudInvoiceId: string;
}

export interface WorkspaceInvoicePullRow {
  id: string;
  workspace_id: string;
  vorgang_id: string;
  client_invoice_id: string;
  invoice_number: string;
  invoice_year: number;
  invoice_sequence_number: number;
  invoice_type: string;
  invoice_status: string;
  payload: Record<string, unknown>;
  row_version: number;
  created_at: string;
  updated_at: string;
  updated_by?: string | null;
}

/** Cloud row after successful finalize (03A). */
type WorkspaceInvoiceRow = WorkspaceInvoicePullRow;

export interface MappedWorkspaceInvoicePull {
  workspaceId: string;
  vorgangId: string;
  clientInvoiceId: string;
  cloudInvoiceId: string;
  rowVersion: number;
  invoice: VorgangInvoice;
}

function getClient(client?: SupabaseClient | null): SupabaseClient {
  const resolved = client ?? getSupabaseClient();
  if (!resolved) {
    throw new WorkspaceInvoiceCloudError('Supabase ist nicht konfiguriert.', 'unknown', false);
  }
  return resolved;
}

function classifyInvoiceCloudError(error: { message?: string; code?: string }): WorkspaceInvoiceCloudError {
  const message = error.message ?? 'Unbekannter Cloud-Fehler';
  if (message.includes('Nicht angemeldet') || error.code === 'PGRST301') {
    return new WorkspaceInvoiceCloudError(message, 'auth', false);
  }
  if (
    message.includes('Kein Zugriff') ||
    message.includes('permission') ||
    error.code === '42501'
  ) {
    return new WorkspaceInvoiceCloudError(message, 'rls', false);
  }
  if (message.includes('Idempotenzkonflikt')) {
    return new WorkspaceInvoiceCloudError(message, 'idempotency_conflict', false);
  }
  if (
    message.includes('fehlt') ||
    message.includes('positions') ||
    message.includes('type') ||
    message.includes('Vorgang gehört nicht')
  ) {
    return new WorkspaceInvoiceCloudError(message, 'validation', false);
  }
  if (message.includes('Failed to fetch') || message.includes('Network')) {
    return new WorkspaceInvoiceCloudError(message, 'network', true);
  }
  if (error instanceof WorkspaceCloudError) {
    return new WorkspaceInvoiceCloudError(
      error.message,
      error.code === 'auth' || error.code === 'rls' || error.code === 'network'
        ? error.code
        : 'unknown',
      error.retryable,
    );
  }
  return new WorkspaceInvoiceCloudError(message, 'unknown', true);
}

const INVOICE_STATUSES = new Set(['entwurf', 'vorbereitet', 'versendet']);
const INVOICE_TYPES = new Set([
  'rechnung',
  'abschlag',
  'teilrechnung',
  'schluss',
  'gutschrift',
  'storno',
]);

function cloneLine(line: VorgangInvoiceLine): VorgangInvoiceLine {
  return { ...line };
}

/**
 * Build RPC invoice JSON from existing VorgangInvoice.
 * Strips payments and archive/PDF references — not part of 03A.
 * Number fields may be present locally but are reassigned by the server.
 */
export function buildWorkspaceInvoiceFinalizePayload(invoice: VorgangInvoice): Record<string, unknown> {
  const {
    payments: _payments,
    paymentStatus: _paymentStatus,
    archiveDocumentId: _archiveDocumentId,
    ...rest
  } = invoice;

  const payload: Record<string, unknown> = {
    ...rest,
    positions: (invoice.positions ?? []).map(cloneLine),
    previousAbschlagDeductions: (invoice.previousAbschlagDeductions ?? []).map((d) => ({ ...d })),
    legalNotices: [...(invoice.legalNotices ?? [])],
    customerSnapshot: invoice.customerSnapshot ? { ...invoice.customerSnapshot } : undefined,
    companySnapshot: invoice.companySnapshot
      ? (() => {
          const { logoDataUrl: _logo, ...profile } = invoice.companySnapshot;
          return profile;
        })()
      : undefined,
  };

  // Schluss: send frozen expectedAmendmentSequence only (camelCase). Never send snake_case twin.
  if (invoice.type === 'schluss') {
    payload.expectedAmendmentSequence = invoice.expectedAmendmentSequence ?? 0;
  } else {
    delete payload.expectedAmendmentSequence;
  }
  delete payload.expected_amendment_sequence;

  return payload;
}

export function buildWorkspaceInvoiceFinalizeInput(
  workspaceId: string,
  vorgangId: string,
  invoice: VorgangInvoice,
): WorkspaceInvoiceFinalizeInput {
  return {
    workspaceId,
    vorgangId,
    clientInvoiceId: invoice.id,
    invoice,
  };
}

export function mapCloudPayloadToVorgangInvoice(payload: Record<string, unknown>): VorgangInvoice {
  const positionsRaw = (payload.positions as VorgangInvoiceLine[] | undefined) ?? [];
  return {
    id: String(payload.id ?? ''),
    number: String(payload.number ?? ''),
    type: payload.type as VorgangInvoice['type'],
    abschlagNumber:
      typeof payload.abschlagNumber === 'number' ? payload.abschlagNumber : undefined,
    invoiceSequenceNumber:
      typeof payload.invoiceSequenceNumber === 'number'
        ? payload.invoiceSequenceNumber
        : undefined,
    positions: positionsRaw.map(cloneLine),
    subtotal: Number(payload.subtotal ?? 0),
    taxStatus: payload.taxStatus as VorgangInvoice['taxStatus'],
    amount: Number(payload.amount ?? 0),
    status: (payload.status as VorgangInvoice['status']) ?? 'vorbereitet',
    date: String(payload.date ?? ''),
    createdAt: String(payload.createdAt ?? new Date().toISOString()),
    issueDate: payload.issueDate ? String(payload.issueDate) : undefined,
    servicePeriodFrom: payload.servicePeriodFrom
      ? String(payload.servicePeriodFrom)
      : undefined,
    servicePeriodTo: payload.servicePeriodTo ? String(payload.servicePeriodTo) : undefined,
    paymentDueDate: payload.paymentDueDate ? String(payload.paymentDueDate) : undefined,
    paymentTermsText: payload.paymentTermsText ? String(payload.paymentTermsText) : undefined,
    skontoText: payload.skontoText ? String(payload.skontoText) : undefined,
    customerSnapshot: payload.customerSnapshot as VorgangInvoice['customerSnapshot'],
    companySnapshot: payload.companySnapshot as VorgangInvoice['companySnapshot'],
    legalNotices: Array.isArray(payload.legalNotices)
      ? payload.legalNotices.map(String)
      : undefined,
    previousAbschlagDeductions:
      payload.previousAbschlagDeductions as VorgangInvoice['previousAbschlagDeductions'],
    introText: payload.introText ? String(payload.introText) : undefined,
    closingText: payload.closingText ? String(payload.closingText) : undefined,
    baustelle: payload.baustelle ? String(payload.baustelle) : undefined,
    vorgangTitle: payload.vorgangTitle ? String(payload.vorgangTitle) : undefined,
    sentAt: payload.sentAt ? String(payload.sentAt) : undefined,
    sentVia: payload.sentVia as VorgangInvoice['sentVia'],
    sentNote: payload.sentNote ? String(payload.sentNote) : undefined,
    // Intentionally omit payments / archiveDocumentId in 03A cloud mapping.
  };
}

/** Exported for tests — mirrors SQL format_workspace_invoice_number. */
export function formatWorkspaceInvoiceNumber(year: number, sequence: number): string {
  return formatInvoiceNumber(year, sequence);
}

export function parseWorkspaceInvoicePullRow(
  raw: unknown,
): WorkspaceInvoicePullRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = String(row.id ?? '').trim();
  const workspaceId = String(row.workspace_id ?? '').trim();
  const vorgangId = String(row.vorgang_id ?? '').trim();
  const clientInvoiceId = String(row.client_invoice_id ?? '').trim();
  const invoiceNumber = String(row.invoice_number ?? '').trim();
  const invoiceType = String(row.invoice_type ?? '').trim();
  const invoiceStatus = String(row.invoice_status ?? '').trim();
  const payload =
    row.payload && typeof row.payload === 'object'
      ? (row.payload as Record<string, unknown>)
      : null;
  const year = Number(row.invoice_year);
  const sequence = Number(row.invoice_sequence_number);
  const rowVersion = Number(row.row_version ?? 1);

  if (
    !id ||
    !workspaceId ||
    !vorgangId ||
    !clientInvoiceId ||
    !invoiceNumber ||
    !payload ||
    !Number.isFinite(year) ||
    !Number.isFinite(sequence) ||
    sequence <= 0 ||
    !INVOICE_TYPES.has(invoiceType) ||
    !INVOICE_STATUSES.has(invoiceStatus)
  ) {
    return null;
  }

  return {
    id,
    workspace_id: workspaceId,
    vorgang_id: vorgangId,
    client_invoice_id: clientInvoiceId,
    invoice_number: invoiceNumber,
    invoice_year: year,
    invoice_sequence_number: sequence,
    invoice_type: invoiceType,
    invoice_status: invoiceStatus,
    payload,
    row_version: Number.isFinite(rowVersion) ? rowVersion : 1,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    updated_by: row.updated_by == null ? null : String(row.updated_by),
  };
}

/**
 * Map a pull row into VorgangInvoice.
 * Identity/number/type/status come from row columns; body from payload.
 * Payments and PDF/archive fields are never reconstructed from cloud.
 */
export function mapWorkspaceInvoicePullRowToVorgangInvoice(
  row: WorkspaceInvoicePullRow,
): MappedWorkspaceInvoicePull {
  const fromPayload = mapCloudPayloadToVorgangInvoice(row.payload);
  const invoice: VorgangInvoice = {
    ...fromPayload,
    id: row.client_invoice_id,
    number: row.invoice_number,
    invoiceSequenceNumber: row.invoice_sequence_number,
    type: row.invoice_type as VorgangInvoice['type'],
    status: row.invoice_status as VorgangInvoice['status'],
  };
  // Explicitly drop comfort/local-only fields from cloud mapping.
  delete (invoice as { payments?: unknown }).payments;
  delete (invoice as { paymentStatus?: unknown }).paymentStatus;
  delete (invoice as { archiveDocumentId?: unknown }).archiveDocumentId;

  return {
    workspaceId: row.workspace_id,
    vorgangId: row.vorgang_id,
    clientInvoiceId: row.client_invoice_id,
    cloudInvoiceId: row.id,
    rowVersion: row.row_version,
    invoice,
  };
}

/** Raw pull rows from RPC (typed mapping happens client-side with isolation). */
export async function rpcPullWorkspaceInvoiceRows(
  workspaceId: string,
  options?: { since?: string | null; client?: SupabaseClient | null },
): Promise<unknown[]> {
  if (!workspaceId.trim()) {
    throw new WorkspaceInvoiceCloudError('workspace_id fehlt', 'validation', false);
  }

  try {
    const supabase = getClient(options?.client);
    const { data, error } = await supabase.rpc('pull_workspace_invoices', {
      p_workspace_id: workspaceId,
      p_since: options?.since ?? null,
    });

    if (error) {
      throw classifyInvoiceCloudError(error);
    }

    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error instanceof WorkspaceInvoiceCloudError) {
      throw error;
    }
    throw classifyInvoiceCloudError(
      error instanceof Error ? { message: error.message } : { message: 'Unbekannter Fehler' },
    );
  }
}

export async function rpcPullWorkspaceInvoices(
  workspaceId: string,
  options?: { since?: string | null; client?: SupabaseClient | null },
): Promise<MappedWorkspaceInvoicePull[]> {
  const rows = await rpcPullWorkspaceInvoiceRows(workspaceId, options);
  const mapped: MappedWorkspaceInvoicePull[] = [];
  for (const raw of rows) {
    const parsed = parseWorkspaceInvoicePullRow(raw);
    if (!parsed || parsed.workspace_id !== workspaceId) continue;
    mapped.push(mapWorkspaceInvoicePullRowToVorgangInvoice(parsed));
  }
  return mapped;
}

export async function rpcFinalizeWorkspaceInvoice(
  input: WorkspaceInvoiceFinalizeInput,
  client?: SupabaseClient | null,
): Promise<WorkspaceInvoiceFinalizeResult> {
  if (!input.workspaceId.trim()) {
    throw new WorkspaceInvoiceCloudError('workspace_id fehlt', 'validation', false);
  }
  if (!input.vorgangId.trim()) {
    throw new WorkspaceInvoiceCloudError('vorgang_id fehlt', 'validation', false);
  }
  if (!input.clientInvoiceId.trim()) {
    throw new WorkspaceInvoiceCloudError('client_invoice_id fehlt', 'validation', false);
  }

  try {
    const supabase = getClient(client);
    const { data, error } = await supabase.rpc('finalize_workspace_invoice', {
      p_workspace_id: input.workspaceId,
      p_vorgang_id: input.vorgangId,
      p_client_invoice_id: input.clientInvoiceId,
      p_invoice: buildWorkspaceInvoiceFinalizePayload(input.invoice),
    });

    if (error) {
      throw classifyInvoiceCloudError(error);
    }

    const invoicePayload = (data?.invoice as Record<string, unknown> | undefined) ?? null;
    const row = (data?.row as WorkspaceInvoiceRow | undefined) ?? null;
    if (!invoicePayload || !row) {
      throw new WorkspaceInvoiceCloudError(
        'Ungültige Server-Antwort bei Rechnungsfinalisierung.',
        'unknown',
        true,
      );
    }

    return {
      invoice: mapCloudPayloadToVorgangInvoice(invoicePayload),
      idempotentReplay: Boolean(data?.idempotent_replay),
      rowVersion: Number(row.row_version ?? 1),
      cloudInvoiceId: String(row.id),
    };
  } catch (error) {
    if (error instanceof WorkspaceInvoiceCloudError) {
      throw error;
    }
    throw classifyInvoiceCloudError(
      error instanceof Error ? { message: error.message } : { message: 'Unbekannter Fehler' },
    );
  }
}
