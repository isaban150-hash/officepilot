/**
 * OFFICEPILOT-PAYMENT-CLOUD-DURABILITY-04B2B — Geldbewegungen dauerhaft sichern.
 *
 * Getrennt vom Rechnungs-Cloud-Dienst, weil die Konfliktnatur eine andere ist:
 * Eine Rechnung wird einmal geschrieben und ihr Versandstatus ist monoton;
 * Zahlungen sind mehrfach, unabhaengig voneinander und nicht monoton.
 *
 * Jede Funktion ist total — kein Pfad endet still. Die Lehre aus 04B1S/U gilt
 * hier verschaerft: Bei Geld ist ein unbemerkter Fehlschlag schlimmer als ein
 * sichtbarer.
 */
import { getSupabaseClient, isSupabaseConfigured } from '../../lib/supabase';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Eine Zahlungszeile, wie die Cloud sie fuehrt — inklusive Grabstein. */
export interface WorkspaceInvoicePaymentRow {
  workspaceId: string;
  clientInvoiceId: string;
  clientPaymentId: string;
  amount: number;
  paidOn: string;
  reference?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
  /** Gesetzt heisst: storniert. Die Zeile bleibt, zaehlt aber nicht mehr. */
  reversedAt?: string;
}

export interface WorkspaceInvoicePaymentAddInput {
  clientInvoiceId: string;
  /** Stabile Kennung — UUID oder historisches `pay-…`. Nie neu erzeugt. */
  clientPaymentId: string;
  amount: number;
  paidOn: string;
  reference?: string;
  note?: string;
}

/**
 * Ausgang einer Cloud-Operation. `supabase_not_configured` ist der bewusst
 * lokale Betrieb und kein Fehler; alles andere muss sichtbar werden.
 */
export type InvoicePaymentCloudOutcome =
  | 'synced'
  | 'supabase_not_configured'
  | 'workspace_missing'
  | 'conflict'
  | 'failed';

export type InvoicePaymentCloudResult =
  | { outcome: 'synced'; row: WorkspaceInvoicePaymentRow }
  | { outcome: Exclude<InvoicePaymentCloudOutcome, 'synced'>; detail?: string };

export type InvoicePaymentCloudPullResult =
  | { outcome: 'synced'; rows: WorkspaceInvoicePaymentRow[] }
  | { outcome: Exclude<InvoicePaymentCloudOutcome, 'synced'>; detail?: string };

/** Nur diese beiden Ausgaenge duerfen die Oberflaeche schweigend hinnehmen. */
export function isInvoicePaymentCloudSilent(outcome: InvoicePaymentCloudOutcome): boolean {
  return outcome === 'synced' || outcome === 'supabase_not_configured';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Numerisch kann PostgREST `numeric` als Zahl oder als Text liefern. */
function money(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function parseWorkspaceInvoicePaymentRow(raw: unknown): WorkspaceInvoicePaymentRow | null {
  if (!isPlainObject(raw)) return null;

  const workspaceId = text(raw.workspace_id);
  const clientInvoiceId = text(raw.client_invoice_id);
  const clientPaymentId = text(raw.client_payment_id);
  const amount = money(raw.amount);
  const paidOn = text(raw.paid_on);
  const createdAt = text(raw.created_at);
  const updatedAt = text(raw.updated_at);
  const rowVersion =
    typeof raw.row_version === 'number' && Number.isInteger(raw.row_version)
      ? raw.row_version
      : null;

  if (
    !workspaceId ||
    !clientInvoiceId ||
    !clientPaymentId ||
    amount === null ||
    amount <= 0 ||
    !paidOn ||
    !/^\d{4}-\d{2}-\d{2}$/.test(paidOn) ||
    !createdAt ||
    !updatedAt ||
    rowVersion === null ||
    rowVersion <= 0
  ) {
    return null;
  }

  return {
    workspaceId,
    clientInvoiceId,
    clientPaymentId,
    amount,
    paidOn,
    reference: optionalText(raw.reference),
    note: optionalText(raw.note),
    createdAt,
    updatedAt,
    rowVersion,
    reversedAt: optionalText(raw.reversed_at),
  };
}

interface CloudContext {
  client: SupabaseClient;
  workspaceId: string;
}

type ContextResult =
  | { ok: true; context: CloudContext }
  | { ok: false; outcome: Exclude<InvoicePaymentCloudOutcome, 'synced' | 'conflict'> };

function resolveContext(override?: {
  client?: SupabaseClient | null;
  workspaceId?: string;
}): ContextResult {
  try {
    if (!override?.client && !isSupabaseConfigured()) {
      return { ok: false, outcome: 'supabase_not_configured' };
    }
    const client = override?.client ?? getSupabaseClient();
    if (!client) return { ok: false, outcome: 'supabase_not_configured' };

    const workspaceId = (
      override?.workspaceId ?? resolveCloudWorkspaceId(buildPersistedStateSnapshot())
    ).trim();
    // Cloud vorhanden, Workspace nicht aufloesbar — das ist ein Fehler, kein Normalfall.
    if (!workspaceId) return { ok: false, outcome: 'workspace_missing' };

    return { ok: true, context: { client, workspaceId } };
  } catch {
    return { ok: false, outcome: 'failed' };
  }
}

/** Ein Konflikt der Fachdaten ist etwas anderes als ein technischer Fehler. */
function isConflictMessage(message: string): boolean {
  return message.includes('Zahlungskonflikt');
}

/**
 * Legt eine Zahlung an — idempotent ueber
 * (workspace_id, client_invoice_id, client_payment_id).
 *
 * Erfolg nur, wenn die Antwort die Mutation beweist: exakt eine Zeile, exakt
 * diese Rechnung, exakt diese Kennung, exakt diese Werte, nicht reversiert.
 */
export async function addInvoicePaymentToCloud(
  input: WorkspaceInvoicePaymentAddInput,
  override?: { client?: SupabaseClient | null; workspaceId?: string },
): Promise<InvoicePaymentCloudResult> {
  const resolved = resolveContext(override);
  if (!resolved.ok) return { outcome: resolved.outcome };
  const { client, workspaceId } = resolved.context;

  const clientInvoiceId = input.clientInvoiceId.trim();
  const clientPaymentId = input.clientPaymentId.trim();
  const paidOn = input.paidOn.trim();
  const reference = input.reference?.trim() || undefined;
  const note = input.note?.trim() || undefined;

  if (!clientInvoiceId || !clientPaymentId) return { outcome: 'failed', detail: 'identity' };
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { outcome: 'failed', detail: 'amount' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return { outcome: 'failed', detail: 'paid_on' };

  let data: unknown;
  try {
    const response = await client.rpc('add_workspace_invoice_payment', {
      p_workspace_id: workspaceId,
      p_client_invoice_id: clientInvoiceId,
      p_client_payment_id: clientPaymentId,
      p_amount: input.amount,
      p_paid_on: paidOn,
      p_reference: reference ?? null,
      p_note: note ?? null,
    });
    if (response.error) {
      const message = response.error.message ?? '';
      return {
        outcome: isConflictMessage(message) ? 'conflict' : 'failed',
        detail: message || undefined,
      };
    }
    data = response.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return { outcome: isConflictMessage(message) ? 'conflict' : 'failed', detail: message };
  }

  const rows = Array.isArray(data) ? data : [data];
  if (rows.length !== 1) return { outcome: 'failed', detail: 'row_count' };

  const row = parseWorkspaceInvoicePaymentRow(rows[0]);
  if (
    !row ||
    row.workspaceId !== workspaceId ||
    row.clientInvoiceId !== clientInvoiceId ||
    row.clientPaymentId !== clientPaymentId ||
    Math.abs(row.amount - input.amount) > 0.004 ||
    row.paidOn !== paidOn ||
    row.reference !== reference ||
    row.note !== note ||
    row.reversedAt !== undefined
  ) {
    return { outcome: 'failed', detail: 'response_mismatch' };
  }

  return { outcome: 'synced', row };
}

/**
 * Storniert eine Zahlung in der Cloud. Die Zeile bleibt als Grabstein bestehen —
 * nur so erfaehrt ein anderes Geraet ueberhaupt davon.
 */
export async function reverseInvoicePaymentInCloud(
  input: { clientInvoiceId: string; clientPaymentId: string },
  override?: { client?: SupabaseClient | null; workspaceId?: string },
): Promise<InvoicePaymentCloudResult> {
  const resolved = resolveContext(override);
  if (!resolved.ok) return { outcome: resolved.outcome };
  const { client, workspaceId } = resolved.context;

  const clientInvoiceId = input.clientInvoiceId.trim();
  const clientPaymentId = input.clientPaymentId.trim();
  if (!clientInvoiceId || !clientPaymentId) return { outcome: 'failed', detail: 'identity' };

  let data: unknown;
  try {
    const response = await client.rpc('reverse_workspace_invoice_payment', {
      p_workspace_id: workspaceId,
      p_client_invoice_id: clientInvoiceId,
      p_client_payment_id: clientPaymentId,
    });
    if (response.error) {
      return { outcome: 'failed', detail: response.error.message ?? undefined };
    }
    data = response.data;
  } catch (error) {
    return { outcome: 'failed', detail: error instanceof Error ? error.message : undefined };
  }

  const rows = Array.isArray(data) ? data : [data];
  if (rows.length !== 1) return { outcome: 'failed', detail: 'row_count' };

  const row = parseWorkspaceInvoicePaymentRow(rows[0]);
  if (
    !row ||
    row.workspaceId !== workspaceId ||
    row.clientInvoiceId !== clientInvoiceId ||
    row.clientPaymentId !== clientPaymentId ||
    !row.reversedAt
  ) {
    return { outcome: 'failed', detail: 'response_mismatch' };
  }

  return { outcome: 'synced', row };
}

/** Holt alle Zahlungen des Workspace — Grabsteine ausdruecklich eingeschlossen. */
export async function pullInvoicePaymentsFromCloud(
  override?: { client?: SupabaseClient | null; workspaceId?: string; since?: string | null },
): Promise<InvoicePaymentCloudPullResult> {
  const resolved = resolveContext(override);
  if (!resolved.ok) return { outcome: resolved.outcome };
  const { client, workspaceId } = resolved.context;

  let data: unknown;
  try {
    const response = await client.rpc('pull_workspace_invoice_payments', {
      p_workspace_id: workspaceId,
      p_since: override?.since ?? null,
    });
    if (response.error) {
      return { outcome: 'failed', detail: response.error.message ?? undefined };
    }
    data = response.data;
  } catch (error) {
    return { outcome: 'failed', detail: error instanceof Error ? error.message : undefined };
  }

  if (!Array.isArray(data)) return { outcome: 'failed', detail: 'not_a_list' };

  const rows: WorkspaceInvoicePaymentRow[] = [];
  for (const raw of data) {
    const row = parseWorkspaceInvoicePaymentRow(raw);
    // Eine unbrauchbare Zeile wird uebersprungen, nicht repariert.
    if (row && row.workspaceId === workspaceId) rows.push(row);
  }
  return { outcome: 'synced', rows };
}
