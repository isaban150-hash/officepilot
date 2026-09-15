/**
 * FINANZ-CORE-DURABILITY-01C — Ausgaben in die Cloud.
 *
 * Zwei Wahrheiten, zwei Wege:
 *  - `expense`          -> `workspace_expenses` (versionierte Zeile, Grabstein), ohne Zahlungen
 *  - `expense_payment`  -> `workspace_expense_payments` (append-only + Reversal, analog
 *                          Rechnungszahlungen). `Expense.payments[]` ist lokal nur Projektion.
 *
 * Beides laeuft ueber die bestehende Outbox. Die Zahlung wird beim Buchen explizit
 * eingereiht (create) bzw. beim Entfernen (delete = Reversal). Der Beleg selbst wird
 * vom Change-Tracker verfolgt — mit einem Content-Key, der Zahlungen und den davon
 * abgeleiteten Zahlstatus ausklammert, damit eine Zahlung keinen Beleg-Push erzwingt.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppPersistedState } from '../../types/models';
import type { Expense, ExpensePayment } from '../../types/expense';
import type { SyncEntityType, SyncMeta, SyncOutboxEntry } from '../../types/sync';
import { getSupabaseClient } from '../../lib/supabase';
import { WorkspaceCloudError } from '../workspace/workspaceCloudService';
import { calculateExpensePaymentSummary } from '../expensePaymentCalculations';
import { normalizeExpense } from '../expenseNormalize';

export const EXPENSE_SYNC_ENTITY_TYPES: readonly SyncEntityType[] = ['expense', 'expense_payment'];

export function isExpenseSyncEntityType(entityType: SyncEntityType): boolean {
  return EXPENSE_SYNC_ENTITY_TYPES.includes(entityType);
}

/** Beleg vor Zahlung — die Zahlung setzt die Belegzeile voraus. */
export const EXPENSE_PUSH_ORDER: Record<string, number> = {
  expense: 10,
  expense_payment: 11,
};

/** Demo-Ausgaben (`exp-001`…) verlassen das Geraet nie. */
export function isCloudSyncBlockedMockExpenseId(id: string | undefined | null): boolean {
  return typeof id === 'string' && /^exp-\d{3}$/.test(id);
}

export function buildExpensePaymentEntityId(expenseId: string, paymentId: string): string {
  return `${expenseId}|${paymentId}`;
}

export function parseExpensePaymentEntityId(entityId: string): { expenseId: string; paymentId: string } | null {
  const index = entityId.indexOf('|');
  if (index <= 0 || index === entityId.length - 1) return null;
  return { expenseId: entityId.slice(0, index), paymentId: entityId.slice(index + 1) };
}

/** Lokale Sicht einer Zahlung fuer die Outbox — `payment` fehlt bei einem Reversal nach lokalem Entfernen. */
export interface ExpensePaymentSyncEntity {
  id: string;
  expenseId: string;
  paymentId: string;
  payment: ExpensePayment | null;
}

// ---------------------------------------------------------------------------
// Content-Key / Payload
// ---------------------------------------------------------------------------

function stripPaymentFields(expense: Expense): Record<string, unknown> {
  const { payments: _payments, paymentStatus: _status, sync: _sync, updatedAt: _updatedAt, ...rest } =
    expense as unknown as Record<string, unknown>;
  return rest;
}

/** Fachlicher Fingerabdruck ohne Zahlungen, Zahlstatus und Server-Metadaten. */
export function buildExpenseContentKey(expense: Expense): string {
  return JSON.stringify(stripPaymentFields(expense));
}

export function buildExpensePushPayload(expense: Expense, deleted: boolean): Record<string, unknown> {
  return {
    client_expense_id: expense.id,
    status: expense.status,
    dedupe_key: expense.dedupeKey ?? '',
    linked_inbox_id: expense.linkedInboxId ?? null,
    archive_document_id: expense.archiveDocumentId ?? null,
    payload: { ...stripPaymentFields(expense), updatedAt: expense.updatedAt },
    deleted,
  };
}

// ---------------------------------------------------------------------------
// Cloud-Zeilen
// ---------------------------------------------------------------------------

export interface CloudExpenseRow {
  client_expense_id: string;
  status: Expense['status'];
  dedupe_key: string;
  linked_inbox_id: string | null;
  archive_document_id: string | null;
  payload: Record<string, unknown>;
  deleted: boolean;
  row_version: number;
  updated_at: string;
}

export interface CloudExpensePaymentRow {
  client_expense_id: string;
  client_payment_id: string;
  amount: number | string;
  paid_on: string;
  reference: string | null;
  note: string | null;
  created_at: string;
  row_version: number;
  reversed_at: string | null;
}

export interface ExpenseCloudPull {
  expenses: CloudExpenseRow[];
  payments: CloudExpensePaymentRow[];
}

export interface ExpenseMergeContext {
  deviceId: string;
  workspaceId: string;
  /** `expense:<id>` mit lokal noch nicht gepushten Aenderungen. */
  dirty: ReadonlySet<string>;
}

export function collectDirtyExpenseKeys(outbox: SyncOutboxEntry[] | undefined): Set<string> {
  const dirty = new Set<string>();
  for (const entry of outbox ?? []) {
    if (entry.status !== 'pending' && entry.status !== 'error' && entry.status !== 'blocked') continue;
    if (entry.entityType === 'expense') dirty.add(`expense:${entry.entityId}`);
    if (entry.entityType === 'expense_payment') dirty.add(`expense_payment:${entry.entityId}`);
  }
  return dirty;
}

function cloudMeta(row: CloudExpenseRow, context: ExpenseMergeContext): SyncMeta {
  return {
    updatedAt: row.updated_at,
    version: Number(row.row_version),
    deleted: Boolean(row.deleted),
    deletedAt: row.deleted ? row.updated_at : undefined,
    deviceId: context.deviceId,
    workspaceId: context.workspaceId,
  };
}

function money(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function mapCloudExpenseRow(row: CloudExpenseRow, local: Expense | undefined, context: ExpenseMergeContext): Expense {
  const payload = row.payload ?? {};
  const base = normalizeExpense({
    ...(local ?? {}),
    ...(payload as Partial<Expense>),
    id: row.client_expense_id,
    status: row.status,
    dedupeKey: row.dedupe_key ?? (payload.dedupeKey as string) ?? '',
    linkedInboxId: row.linked_inbox_id ?? undefined,
    archiveDocumentId: row.archive_document_id ?? undefined,
    // Zahlungen bleiben die lokale Projektion — sie werden separat gemergt.
    payments: local?.payments ?? [],
    paymentStatus: local?.paymentStatus ?? 'offen',
  } as Expense);
  return { ...base, sync: cloudMeta(row, context) };
}

export interface ExpenseMergeResult {
  expenses: Expense[];
  conflicts: string[];
  counts: { expenses: number; payments: number };
}

/**
 * Regel Beleg: lokal unbekannt -> uebernehmen; Remote <= lokal -> behalten;
 * Remote neuer & lokal schmutzig -> Konflikt (lokal behalten, melden); sonst uebernehmen.
 * Regel Zahlung: Kennung entscheidet; Grabstein entfernt die gleichnamige lokale Zahlung;
 * lokale Zahlungen ohne Cloud-Zeile bleiben (sie sind noch nicht gepusht).
 * `paymentStatus` wird danach neu abgeleitet, nie aus der Cloud uebernommen.
 */
export function mergeExpensesFromPull(local: Expense[], pull: ExpenseCloudPull, context: ExpenseMergeContext): ExpenseMergeResult {
  const byId = new Map(local.map((expense) => [expense.id, expense]));
  const conflicts: string[] = [];
  let mergedExpenses = 0;

  for (const row of pull.expenses) {
    const existing = byId.get(row.client_expense_id);
    if (!existing) {
      byId.set(row.client_expense_id, mapCloudExpenseRow(row, undefined, context));
      mergedExpenses += 1;
      continue;
    }
    const localVersion = existing.sync?.version ?? 0;
    const remoteVersion = Number(row.row_version);
    if (remoteVersion <= localVersion) continue;
    if (context.dirty.has(`expense:${row.client_expense_id}`)) {
      conflicts.push(`expense:${row.client_expense_id}`);
      continue;
    }
    byId.set(row.client_expense_id, mapCloudExpenseRow(row, existing, context));
    mergedExpenses += 1;
  }

  const paymentsByExpense = new Map<string, CloudExpensePaymentRow[]>();
  for (const row of pull.payments) {
    const list = paymentsByExpense.get(row.client_expense_id) ?? [];
    list.push(row);
    paymentsByExpense.set(row.client_expense_id, list);
  }

  let mergedPayments = 0;
  for (const [expenseId, rows] of paymentsByExpense) {
    const expense = byId.get(expenseId);
    if (!expense) continue;
    const payments = new Map((expense.payments ?? []).map((payment) => [payment.id, payment]));
    for (const row of rows) {
      if (row.reversed_at) {
        if (payments.delete(row.client_payment_id)) mergedPayments += 1;
        continue;
      }
      // Lokal entfernt, Reversal noch nicht gepusht: nicht wiederbeleben.
      if (!payments.has(row.client_payment_id) && context.dirty.has(`expense_payment:${buildExpensePaymentEntityId(expenseId, row.client_payment_id)}`)) {
        continue;
      }
      const amount = money(row.amount);
      if (amount === null) continue;
      const next: ExpensePayment = {
        id: row.client_payment_id,
        date: row.paid_on,
        amount,
        reference: row.reference ?? undefined,
        note: row.note ?? undefined,
        createdAt: row.created_at,
      };
      const previous = payments.get(row.client_payment_id);
      if (!previous || previous.amount !== next.amount || previous.date !== next.date || previous.reference !== next.reference || previous.note !== next.note) {
        mergedPayments += 1;
      }
      payments.set(row.client_payment_id, next);
    }
    const withPayments = { ...expense, payments: [...payments.values()] };
    byId.set(expenseId, { ...withPayments, paymentStatus: calculateExpensePaymentSummary(withPayments).status });
  }

  return { expenses: [...byId.values()], conflicts, counts: { expenses: mergedExpenses, payments: mergedPayments } };
}

export function applyExpensePullToState(state: AppPersistedState, pull: ExpenseCloudPull, context: ExpenseMergeContext): { state: AppPersistedState; conflicts: string[]; counts: ExpenseMergeResult['counts'] } {
  const merged = mergeExpensesFromPull(state.expenses ?? [], pull, context);
  return { state: { ...state, expenses: merged.expenses }, conflicts: merged.conflicts, counts: merged.counts };
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

function classify(error: { message?: string; code?: string }): WorkspaceCloudError {
  const message = error.message ?? 'Unbekannter Cloud-Fehler';
  if (message.includes('Nicht angemeldet')) return new WorkspaceCloudError(message, 'auth', false);
  if (message.includes('Kein Zugriff') || error.code === '42501') return new WorkspaceCloudError(message, 'rls', false);
  if (message.includes('Versionskonflikt') || message.includes('Zahlungskonflikt')) {
    return new WorkspaceCloudError(message, 'version_conflict', false);
  }
  if (message.includes('Failed to fetch') || message.includes('Network')) return new WorkspaceCloudError(message, 'network', true);
  return new WorkspaceCloudError(message, 'unknown', true);
}

function client(explicit?: SupabaseClient | null): SupabaseClient {
  const resolved = explicit ?? getSupabaseClient();
  if (!resolved) throw new WorkspaceCloudError('Supabase ist nicht konfiguriert.', 'unknown', false);
  return resolved;
}

export async function rpcUpsertWorkspaceExpense(
  workspaceId: string,
  payload: Record<string, unknown>,
  rowVersion: number,
  explicit?: SupabaseClient | null,
): Promise<{ rowVersion: number; deleted: boolean; noop: boolean }> {
  const { data, error } = await client(explicit).rpc('upsert_workspace_expense', {
    p_workspace_id: workspaceId,
    p_payload: payload,
    p_row_version: rowVersion,
  });
  if (error) throw classify(error);
  return { rowVersion: Number(data?.row_version ?? rowVersion), deleted: Boolean(data?.deleted), noop: Boolean(data?.noop) };
}

export async function rpcAddWorkspaceExpensePayment(
  workspaceId: string,
  expenseId: string,
  payment: ExpensePayment,
  explicit?: SupabaseClient | null,
): Promise<void> {
  const { error } = await client(explicit).rpc('add_workspace_expense_payment', {
    p_workspace_id: workspaceId,
    p_client_expense_id: expenseId,
    p_client_payment_id: payment.id,
    p_amount: payment.amount,
    p_paid_on: payment.date.slice(0, 10),
    p_reference: payment.reference ?? null,
    p_note: payment.note ?? null,
  });
  if (error) throw classify(error);
}

export async function rpcReverseWorkspaceExpensePayment(
  workspaceId: string,
  expenseId: string,
  paymentId: string,
  explicit?: SupabaseClient | null,
): Promise<void> {
  const { error } = await client(explicit).rpc('reverse_workspace_expense_payment', {
    p_workspace_id: workspaceId,
    p_client_expense_id: expenseId,
    p_client_payment_id: paymentId,
  });
  if (error) {
    // Eine nie gepushte Zahlung hat keine Cloud-Zeile — das Reversal ist dann erledigt.
    if ((error.message ?? '').includes('Zahlung nicht gefunden')) return;
    throw classify(error);
  }
}

export async function rpcPullWorkspaceExpenses(workspaceId: string, explicit?: SupabaseClient | null): Promise<ExpenseCloudPull> {
  const { data, error } = await client(explicit).rpc('pull_workspace_expenses', { p_workspace_id: workspaceId });
  if (error) throw classify(error);
  return {
    expenses: (data?.expenses as CloudExpenseRow[] | null) ?? [],
    payments: (data?.payments as CloudExpensePaymentRow[] | null) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export type ExpensePushOutcome =
  | { kind: 'pushed'; rowVersion: number; deleted: boolean }
  | { kind: 'skipped'; reason: string };

export async function pushExpenseEntity(
  extracted:
    | { entityType: 'expense'; entityId: string; entity: Expense; rowVersion: number; deleted: boolean }
    | { entityType: 'expense_payment'; entityId: string; entity: ExpensePaymentSyncEntity; rowVersion: number; deleted: boolean },
  operation: SyncOutboxEntry['operation'],
  workspaceId: string,
  explicit?: SupabaseClient | null,
): Promise<ExpensePushOutcome> {
  if (extracted.entityType === 'expense') {
    if (isCloudSyncBlockedMockExpenseId(extracted.entityId)) return { kind: 'skipped', reason: 'mock' };
    const deleted = operation === 'delete' || extracted.deleted;
    const result = await rpcUpsertWorkspaceExpense(workspaceId, buildExpensePushPayload(extracted.entity, deleted), extracted.rowVersion, explicit);
    if (result.noop) return { kind: 'skipped', reason: 'tombstone_without_row' };
    return { kind: 'pushed', rowVersion: result.rowVersion, deleted: result.deleted };
  }

  const { expenseId, paymentId, payment } = extracted.entity;
  if (isCloudSyncBlockedMockExpenseId(expenseId)) return { kind: 'skipped', reason: 'mock' };
  if (operation === 'delete' || !payment) {
    await rpcReverseWorkspaceExpensePayment(workspaceId, expenseId, paymentId, explicit);
    return { kind: 'skipped', reason: 'reversed' };
  }
  await rpcAddWorkspaceExpensePayment(workspaceId, expenseId, payment, explicit);
  return { kind: 'skipped', reason: 'payment_added' };
}
