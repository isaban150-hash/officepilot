/**
 * P1 MITARBEITERZAHLUNGEN — Mitarbeiter und Mitarbeiterzahlungen in die Cloud.
 *
 * Zwei Wahrheiten, zwei Tabellen, eigene RPCs mit Finanzautorisierung —
 * bewusst **nicht** über den generischen Dispatcher (der kennt keinen
 * Finanzschutz, und sein Pull würde Personaldaten auch an Mitglieder liefern):
 *  - `employee`          -> `workspace_employees` (versionierte Zeile, kein Löschen)
 *  - `employee_payment`  -> `workspace_employee_payments` (append-only + Storno)
 *
 * Die Zahlung wird als idempotente Folge gesendet: anlegen (Replay-sicher),
 * Quittung (einmal), Nachweis, Storno. Jeder Schritt ist serverseitig
 * idempotent, ein Wiederholungslauf erzeugt nichts doppelt.
 *
 * Der Pull führt zusammen, ohne lokale Tatsachen zu verlieren: Eine lokal
 * bekannte Zahlung, ein lokaler Storno oder ein lokal gesetzter Beleg, den der
 * Server noch nicht kennt, bleibt erhalten und wird nachgereicht (Backfill).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppPersistedState } from '../../types/models';
import type { Employee, EmployeePayment, EmployeePaymentKind, EmployeePaymentMethod } from '../../types/employee';
import { EMPLOYEE_PAYMENT_KINDS, EMPLOYEE_PAYMENT_METHODS } from '../../types/employee';
import type { SyncEntityType, SyncOutboxEntry } from '../../types/sync';
import { getSupabaseClient } from '../../lib/supabase';
import { WorkspaceCloudError } from '../workspace/workspaceCloudService';
import { isFinancialActionDenial } from '../auth/financialActionDenial';
import { normalizeEmployee, normalizeEmployeePayment } from './employeeStore';

export const EMPLOYEE_SYNC_ENTITY_TYPES: readonly SyncEntityType[] = ['employee', 'employee_payment'];

export function isEmployeeSyncEntityType(entityType: SyncEntityType | string): boolean {
  return EMPLOYEE_SYNC_ENTITY_TYPES.includes(entityType as SyncEntityType);
}

/** Mitarbeiter vor Zahlung — der Server prüft die Zahlung gegen den Stammsatz. */
export const EMPLOYEE_PUSH_ORDER: Record<string, number> = {
  employee: 20,
  employee_payment: 21,
};

/* ------------------------------------------------------------------ */
/* Zeilen                                                              */
/* ------------------------------------------------------------------ */

export interface CloudEmployeeRow {
  client_employee_id: string;
  name: string;
  personnel_number: string | null;
  active: boolean;
  row_version: number | string;
  created_at: string;
  updated_at: string;
}

export interface CloudEmployeePaymentRow {
  client_payment_id: string;
  client_employee_id: string;
  employee_name: string;
  personnel_number: string | null;
  kind: string;
  amount: number | string;
  paid_on: string;
  method: string;
  wage_month: string | null;
  purpose: string | null;
  note: string | null;
  receipt_reference: string;
  paid_by_name: string | null;
  receipt_document_id: string | null;
  proof_document_id: string | null;
  created_at: string;
  reversed_at: string | null;
  reversal_reason: string | null;
}

export interface EmployeeCloudPull {
  employees: CloudEmployeeRow[];
  payments: CloudEmployeePaymentRow[];
}

/* ------------------------------------------------------------------ */
/* Fehler                                                              */
/* ------------------------------------------------------------------ */

function classify(error: { message?: string; code?: string }): WorkspaceCloudError {
  const message = error.message ?? 'Unbekannter Cloud-Fehler';
  if (isFinancialActionDenial(message)) return new WorkspaceCloudError(message, 'rls', false);
  if (message.includes('Nicht angemeldet')) return new WorkspaceCloudError(message, 'auth', false);
  if (message.includes('Kein Zugriff') || error.code === '42501') return new WorkspaceCloudError(message, 'rls', false);
  if (
    message.includes('Versionskonflikt') ||
    message.includes('Zahlungskonflikt') ||
    message.includes('Referenzkonflikt') ||
    message.includes('Quittung bereits gesetzt')
  ) {
    return new WorkspaceCloudError(message, 'version_conflict', false);
  }
  if (message.includes('Failed to fetch') || message.includes('Network')) {
    return new WorkspaceCloudError(message, 'network', true);
  }
  /*
   * Fehlt der Stammsatz oder das Dokument in der Cloud noch, kommt es mit
   * dem nächsten Lauf — wiederholbar. Ein inhaltliches Urteil (ungültige
   * Werte, storniert) bleibt dagegen beim nächsten Versuch dasselbe.
   */
  if (message.includes('nicht gefunden')) return new WorkspaceCloudError(message, 'unknown', true);
  if (message.includes('employee_payment_') || message.includes('employee_')) {
    return new WorkspaceCloudError(message, 'unknown', false);
  }
  return new WorkspaceCloudError(message, 'unknown', true);
}

/** Nur für Tests: dieselbe Einstufung ohne Netzaufruf. */
export function classifyEmployeeCloudErrorForTests(error: { message?: string; code?: string }): WorkspaceCloudError {
  return classify(error);
}

function client(explicit?: SupabaseClient | null): SupabaseClient {
  const resolved = explicit ?? getSupabaseClient();
  if (!resolved) throw new WorkspaceCloudError('Supabase ist nicht konfiguriert.', 'unknown', false);
  return resolved;
}

/* ------------------------------------------------------------------ */
/* RPC                                                                 */
/* ------------------------------------------------------------------ */

export function buildEmployeePushPayload(employee: Employee): Record<string, unknown> {
  return {
    client_employee_id: employee.id,
    name: employee.name,
    personnel_number: employee.personnelNumber ?? null,
    active: employee.active,
  };
}

export async function rpcUpsertWorkspaceEmployee(
  workspaceId: string,
  employee: Employee,
  rowVersion: number,
  explicit?: SupabaseClient | null,
): Promise<{ rowVersion: number; replayed: boolean }> {
  const { data, error } = await client(explicit).rpc('upsert_workspace_employee', {
    p_workspace_id: workspaceId,
    p_payload: buildEmployeePushPayload(employee),
    p_row_version: rowVersion,
  });
  if (error) throw classify(error);
  const row = (data ?? {}) as { row_version?: number | string; replayed?: boolean };
  const version = Number(row.row_version);
  if (!Number.isFinite(version) || version < 1) {
    throw new WorkspaceCloudError('Ungültige Serverantwort für den Mitarbeiter.', 'unknown', true);
  }
  return { rowVersion: version, replayed: Boolean(row.replayed) };
}

export function buildEmployeePaymentAddParams(workspaceId: string, payment: EmployeePayment): Record<string, unknown> {
  return {
    p_workspace_id: workspaceId,
    p_client_payment_id: payment.id,
    p_client_employee_id: payment.employeeId,
    p_employee_name: payment.employeeName,
    p_personnel_number: payment.personnelNumber ?? null,
    p_kind: payment.kind,
    p_amount: payment.amount,
    p_paid_on: payment.paymentDate,
    p_method: payment.paymentMethod,
    p_wage_month: payment.wageMonth ?? null,
    p_purpose: payment.purpose ?? null,
    p_note: payment.note ?? null,
    p_receipt_reference: payment.receiptReference,
    p_paid_by_name: payment.paidByName ?? null,
  };
}

export async function rpcAddWorkspaceEmployeePayment(
  workspaceId: string,
  payment: EmployeePayment,
  explicit?: SupabaseClient | null,
): Promise<void> {
  const { error } = await client(explicit).rpc(
    'add_workspace_employee_payment',
    buildEmployeePaymentAddParams(workspaceId, payment),
  );
  if (error) throw classify(error);
}

export async function rpcSetWorkspaceEmployeePaymentReceipt(
  workspaceId: string,
  paymentId: string,
  documentId: string,
  explicit?: SupabaseClient | null,
): Promise<void> {
  const { error } = await client(explicit).rpc('set_workspace_employee_payment_receipt', {
    p_workspace_id: workspaceId,
    p_client_payment_id: paymentId,
    p_client_document_id: documentId,
  });
  if (error) throw classify(error);
}

export async function rpcSetWorkspaceEmployeePaymentProof(
  workspaceId: string,
  paymentId: string,
  documentId: string | null,
  explicit?: SupabaseClient | null,
): Promise<void> {
  const { error } = await client(explicit).rpc('set_workspace_employee_payment_proof', {
    p_workspace_id: workspaceId,
    p_client_payment_id: paymentId,
    p_client_document_id: documentId,
  });
  if (error) throw classify(error);
}

export async function rpcReverseWorkspaceEmployeePayment(
  workspaceId: string,
  paymentId: string,
  reason: string,
  explicit?: SupabaseClient | null,
): Promise<void> {
  const { error } = await client(explicit).rpc('reverse_workspace_employee_payment', {
    p_workspace_id: workspaceId,
    p_client_payment_id: paymentId,
    p_reason: reason,
  });
  if (error) throw classify(error);
}

export async function rpcPullWorkspaceEmployeeData(
  workspaceId: string,
  explicit?: SupabaseClient | null,
): Promise<EmployeeCloudPull> {
  const { data, error } = await client(explicit).rpc('pull_workspace_employee_data', {
    p_workspace_id: workspaceId,
  });
  if (error) throw classify(error);
  return {
    employees: (data?.employees as CloudEmployeeRow[] | null) ?? [],
    payments: (data?.payments as CloudEmployeePaymentRow[] | null) ?? [],
  };
}

/* ------------------------------------------------------------------ */
/* Push                                                                */
/* ------------------------------------------------------------------ */

export type EmployeePushOutcome =
  | { kind: 'pushed'; rowVersion: number }
  | { kind: 'skipped'; reason: string };

export type EmployeeSyncExtracted =
  | { entityType: 'employee'; entityId: string; entity: Employee; rowVersion: number; deleted: boolean }
  | { entityType: 'employee_payment'; entityId: string; entity: EmployeePayment; rowVersion: number; deleted: boolean };

export async function pushEmployeeEntity(
  extracted: EmployeeSyncExtracted,
  _operation: SyncOutboxEntry['operation'],
  workspaceId: string,
  explicit?: SupabaseClient | null,
): Promise<EmployeePushOutcome> {
  if (extracted.entityType === 'employee') {
    const result = await rpcUpsertWorkspaceEmployee(
      workspaceId,
      extracted.entity,
      extracted.entity.sync?.version ?? 0,
      explicit,
    );
    return { kind: 'pushed', rowVersion: result.rowVersion };
  }

  const payment = extracted.entity;
  await rpcAddWorkspaceEmployeePayment(workspaceId, payment, explicit);
  /*
   * Belege als zweite, geldfreie Schritte — bewusst nach der Zahlung und vor
   * dem Storno: Ein bereits gesetzter Beleg bleibt nach dem Storno erhalten,
   * und der Server nimmt denselben Wert jederzeit idempotent an.
   */
  if (payment.receiptDocumentId) {
    await rpcSetWorkspaceEmployeePaymentReceipt(workspaceId, payment.id, payment.receiptDocumentId, explicit);
  }
  await rpcSetWorkspaceEmployeePaymentProof(workspaceId, payment.id, payment.proofDocumentId ?? null, explicit);
  if (payment.reversedAt) {
    await rpcReverseWorkspaceEmployeePayment(workspaceId, payment.id, payment.reversalReason ?? '', explicit);
  }
  return { kind: 'skipped', reason: 'payment_synced' };
}

export function applyEmployeePushResultToState(
  employees: Employee[],
  entityId: string,
  rowVersion: number,
  updatedAt: string,
): Employee[] {
  return employees.map((employee) =>
    employee.id === entityId && employee.sync
      ? { ...employee, sync: { ...employee.sync, version: rowVersion, updatedAt } }
      : employee,
  );
}

/* ------------------------------------------------------------------ */
/* Pull                                                                */
/* ------------------------------------------------------------------ */

export function collectDirtyEmployeeKeys(outbox: SyncOutboxEntry[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const entry of outbox ?? []) {
    if (!isEmployeeSyncEntityType(entry.entityType)) continue;
    if (entry.status === 'completed' || entry.status === 'failed') continue;
    keys.add(`${entry.entityType}:${entry.entityId}`);
  }
  return keys;
}

function money(value: number | string): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

/** Auch für die Konfliktentscheidung (`employeeConflictService`): dieselbe Abbildung wie im Abgleich. */
export function mapEmployeeRow(row: CloudEmployeeRow, previous: Employee | undefined, deviceId: string, workspaceId: string): Employee {
  const version = Number(row.row_version);
  return normalizeEmployee({
    id: row.client_employee_id,
    name: row.name,
    ...(row.personnel_number ? { personnelNumber: row.personnel_number } : {}),
    active: row.active !== false,
    createdAt: previous?.createdAt ?? row.created_at,
    ...(previous?.createdBy ? { createdBy: previous.createdBy } : {}),
    updatedAt: row.updated_at,
    sync: {
      updatedAt: row.updated_at,
      version: Number.isFinite(version) ? version : 0,
      deleted: false,
      deviceId: previous?.sync?.deviceId ?? deviceId,
      workspaceId: previous?.sync?.workspaceId ?? workspaceId,
    },
  });
}

function mapPaymentRow(row: CloudEmployeePaymentRow, previous: EmployeePayment | undefined): EmployeePayment | null {
  const amount = money(row.amount);
  if (amount === null) return null;
  const kind = EMPLOYEE_PAYMENT_KINDS.includes(row.kind as EmployeePaymentKind) ? (row.kind as EmployeePaymentKind) : null;
  const method = EMPLOYEE_PAYMENT_METHODS.includes(row.method as EmployeePaymentMethod)
    ? (row.method as EmployeePaymentMethod)
    : null;
  if (!kind || !method) return null;
  return normalizeEmployeePayment({
    id: row.client_payment_id,
    employeeId: row.client_employee_id,
    employeeName: row.employee_name,
    ...(row.personnel_number ? { personnelNumber: row.personnel_number } : {}),
    kind,
    amount,
    paymentDate: row.paid_on,
    paymentMethod: method,
    ...(row.wage_month ? { wageMonth: row.wage_month } : {}),
    ...(row.purpose ? { purpose: row.purpose } : {}),
    ...(row.note ? { note: row.note } : {}),
    receiptReference: row.receipt_reference,
    ...(row.paid_by_name ? { paidByName: row.paid_by_name } : {}),
    ...(row.receipt_document_id ? { receiptDocumentId: row.receipt_document_id } : {}),
    ...(row.proof_document_id ? { proofDocumentId: row.proof_document_id } : {}),
    createdAt: previous?.createdAt ?? row.created_at,
    ...(previous?.createdBy ? { createdBy: previous.createdBy } : {}),
    ...(row.reversed_at ? { reversedAt: row.reversed_at } : {}),
    ...(previous?.reversedBy ? { reversedBy: previous.reversedBy } : {}),
    ...(row.reversal_reason ? { reversalReason: row.reversal_reason } : {}),
  });
}

export interface EmployeeMergeContext {
  deviceId: string;
  workspaceId: string;
  dirty: Set<string>;
}

export interface EmployeeMergeResult {
  employees: Employee[];
  payments: EmployeePayment[];
  conflicts: string[];
  counts: { employees: number; payments: number };
  /** Lokale Tatsachen, die der Server noch nicht kennt — erneut einzureihen. */
  backfill: Array<{ entityType: 'employee' | 'employee_payment'; entityId: string; version: number }>;
}

/**
 * Regel Mitarbeiter: lokal unbekannt -> übernehmen; Remote <= lokal -> behalten;
 * Remote neuer & lokal schmutzig -> Konflikt (lokal behalten, melden); sonst übernehmen.
 * Lokal vorhanden, in der Cloud unbekannt -> nachreichen.
 *
 * Regel Zahlung: Die Geldfelder sind unveränderlich — die Cloud-Zeile ist die
 * Wahrheit. Storno und Belege wachsen nur: Was eine Seite kennt und die andere
 * nicht, bleibt erhalten; was lokal fehlt, kommt aus der Cloud; was der Cloud
 * fehlt, wird nachgereicht.
 */
export function mergeEmployeeDataFromPull(
  localEmployees: Employee[],
  localPayments: EmployeePayment[],
  pull: EmployeeCloudPull,
  context: EmployeeMergeContext,
): EmployeeMergeResult {
  const conflicts: string[] = [];
  const backfill: EmployeeMergeResult['backfill'] = [];
  let mergedEmployees = 0;
  let mergedPayments = 0;

  const employees = new Map(localEmployees.map((employee) => [employee.id, employee]));
  const remoteEmployeeIds = new Set<string>();
  for (const row of pull.employees) {
    remoteEmployeeIds.add(row.client_employee_id);
    const existing = employees.get(row.client_employee_id);
    if (!existing) {
      employees.set(row.client_employee_id, mapEmployeeRow(row, undefined, context.deviceId, context.workspaceId));
      mergedEmployees += 1;
      continue;
    }
    const localVersion = existing.sync?.version ?? 0;
    const remoteVersion = Number(row.row_version);
    if (remoteVersion <= localVersion) continue;
    if (context.dirty.has(`employee:${row.client_employee_id}`)) {
      conflicts.push(`employee:${row.client_employee_id}`);
      continue;
    }
    employees.set(row.client_employee_id, mapEmployeeRow(row, existing, context.deviceId, context.workspaceId));
    mergedEmployees += 1;
  }
  for (const employee of employees.values()) {
    if (remoteEmployeeIds.has(employee.id)) continue;
    if (context.dirty.has(`employee:${employee.id}`)) continue;
    backfill.push({ entityType: 'employee', entityId: employee.id, version: employee.sync?.version ?? 0 });
  }

  const payments = new Map(localPayments.map((payment) => [payment.id, payment]));
  const remotePaymentIds = new Set<string>();
  for (const row of pull.payments) {
    remotePaymentIds.add(row.client_payment_id);
    const existing = payments.get(row.client_payment_id);
    const remote = mapPaymentRow(row, existing);
    if (!remote) continue;
    if (!existing) {
      payments.set(remote.id, remote);
      mergedPayments += 1;
      continue;
    }
    const dirty = context.dirty.has(`employee_payment:${existing.id}`);
    const reversedAt = existing.reversedAt ?? remote.reversedAt;
    const reversalReason = existing.reversedAt ? existing.reversalReason : remote.reversalReason;
    const receiptDocumentId = existing.receiptDocumentId ?? remote.receiptDocumentId;
    // Nachweis: lokal schmutzig oder in der Cloud leer -> lokal; sonst die Cloud.
    const proofDocumentId = dirty || !remote.proofDocumentId ? existing.proofDocumentId : remote.proofDocumentId;
    const merged = normalizeEmployeePayment({
      ...remote,
      createdAt: existing.createdAt,
      ...(existing.createdBy ? { createdBy: existing.createdBy } : {}),
      ...(reversedAt ? { reversedAt } : {}),
      ...(existing.reversedBy ? { reversedBy: existing.reversedBy } : {}),
      ...(reversalReason ? { reversalReason } : {}),
      ...(receiptDocumentId ? { receiptDocumentId } : {}),
      ...(proofDocumentId ? { proofDocumentId } : {}),
    });
    if (JSON.stringify(merged) !== JSON.stringify(existing)) mergedPayments += 1;
    payments.set(merged.id, merged);
    const cloudBehind =
      (Boolean(merged.reversedAt) && !remote.reversedAt) ||
      (Boolean(merged.receiptDocumentId) && !remote.receiptDocumentId) ||
      (merged.proofDocumentId ?? '') !== (remote.proofDocumentId ?? '');
    if (cloudBehind && !dirty) {
      backfill.push({ entityType: 'employee_payment', entityId: merged.id, version: 1 });
    }
  }
  for (const payment of payments.values()) {
    if (remotePaymentIds.has(payment.id)) continue;
    if (context.dirty.has(`employee_payment:${payment.id}`)) continue;
    backfill.push({ entityType: 'employee_payment', entityId: payment.id, version: 1 });
  }

  return {
    employees: [...employees.values()],
    payments: [...payments.values()],
    conflicts,
    counts: { employees: mergedEmployees, payments: mergedPayments },
    backfill,
  };
}

export function applyEmployeePullToState(
  state: AppPersistedState,
  pull: EmployeeCloudPull,
  context: EmployeeMergeContext,
): {
  state: AppPersistedState;
  conflicts: string[];
  counts: EmployeeMergeResult['counts'];
  backfill: EmployeeMergeResult['backfill'];
} {
  const merged = mergeEmployeeDataFromPull(state.employees ?? [], state.employeePayments ?? [], pull, context);
  return {
    state: { ...state, employees: merged.employees, employeePayments: merged.payments },
    conflicts: merged.conflicts,
    counts: merged.counts,
    backfill: merged.backfill,
  };
}
