/**
 * STEUERBERATER-06A — Kontierungen in der Cloud.
 *
 * Aufbau wie `expenseCloudSyncService`: ein Inhaltsschlüssel, ein Payload-Bauer,
 * die RPC-Hüllen und die Zusammenführung eines Pulls. Keine eigene Sync-Welt —
 * Outbox, Versionsvertrag und Konfliktbehandlung sind dieselben wie überall.
 */
import { WorkspaceCloudError } from '../workspace/workspaceCloudService';
import { getSupabaseClient } from '../../lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccountingAssignment, AccountingSourceType } from '../../types/accounting';
import type { SyncEntityType, SyncMeta, SyncOutboxEntry } from '../../types/sync';

/**
 * FINANZ-SYNC-BLOCKER-01B — die Entitaeten, die ueber die dedizierten
 * Kontierungs-RPCs laufen und nicht ueber das generische Upsert.
 */
export const ACCOUNTING_SYNC_ENTITY_TYPES: readonly SyncEntityType[] = [
  'accounting_assignment',
  'accounting_period_closure',
];

export function isAccountingSyncEntityType(entityType: SyncEntityType): boolean {
  return ACCOUNTING_SYNC_ENTITY_TYPES.includes(entityType);
}

/**
 * Kontierung vor Abschluss.
 *
 * Das Abschlussmanifest zitiert die Kontierungen des Monats. Liefe der
 * Abschluss zuerst, stuende er in der Cloud ueber Belegen, die dort noch keine
 * Kontierung haben — fachlich derselbe Grund, aus dem die Ausgabe vor ihrer
 * Zahlung geht.
 */
export const ACCOUNTING_PUSH_ORDER: Record<string, number> = {
  accounting_assignment: 20,
  accounting_period_closure: 21,
};

/**
 * Der Inhaltsschlüssel entscheidet, ob sich fachlich etwas geändert hat.
 *
 * Bewusst **ohne** `updatedAt`: Sonst gälte jeder Klick als Änderung und der
 * Sync liefe ohne Inhalt. Und bewusst **mit** `status` und `confirmedAt` — die
 * Bestätigung ist der eigentliche Vorgang, den ein zweites Gerät sehen muss.
 */
export function buildAccountingCloudContentKey(assignment: AccountingAssignment): string {
  return [
    assignment.sourceType,
    assignment.sourceId,
    assignment.chartOfAccounts,
    assignment.accountNumber.trim(),
    assignment.accountLabel.trim(),
    assignment.taxTreatment,
    assignment.bookingText.trim(),
    assignment.status,
    assignment.origin,
    assignment.confirmedAt ?? '',
  ].join('|');
}

/**
 * Was an den Server geht.
 *
 * `sync` bleibt draussen — es ist Gerätewissen, keine Kontierung. Der Server
 * entfernt es zusätzlich, damit auch ein fremder Client es nicht einschleusen
 * kann.
 */
export function buildAccountingCloudPushPayload(
  assignment: AccountingAssignment,
  deleted: boolean,
): Record<string, unknown> {
  const { sync: _sync, ...rest } = assignment;
  return {
    client_assignment_id: assignment.id,
    source_type: assignment.sourceType,
    source_id: assignment.sourceId,
    payload: rest,
    deleted,
  };
}

function client(explicit?: SupabaseClient | null): SupabaseClient {
  const resolved = explicit ?? getSupabaseClient();
  if (!resolved) throw new WorkspaceCloudError('Supabase ist nicht konfiguriert.', 'unknown', false);
  return resolved;
}

function classify(error: { message?: string; code?: string }): WorkspaceCloudError {
  const message = error.message ?? 'Unbekannter Cloud-Fehler';
  if (message.includes('Nicht angemeldet')) return new WorkspaceCloudError(message, 'auth', false);
  if (message.includes('Kein Zugriff') || error.code === '42501') {
    return new WorkspaceCloudError(message, 'rls', false);
  }
  if (message.includes('Versionskonflikt')) {
    return new WorkspaceCloudError(message, 'version_conflict', false);
  }
  /*
   * Die serverseitigen Kontierungsregeln sind Urteile über den Inhalt: Derselbe
   * Datensatz wird beim nächsten Versuch genauso abgelehnt. Ohne diese
   * Einstufung fiele der Auftrag in den Standardfall unten ('unknown',
   * wiederholbar) und der Sync versuchte es endlos weiter — dieselbe Falle wie
   * bei der Geldintegrität in 05B2.
   */
  if (
    message.includes('accounting_') ||
    message.includes('Kontierung bereits geloescht') ||
    message.includes('source_type ungueltig')
  ) {
    return new WorkspaceCloudError(message, 'unknown', false);
  }
  if (message.includes('Failed to fetch') || message.includes('Network')) {
    return new WorkspaceCloudError(message, 'network', true);
  }
  return new WorkspaceCloudError(message, 'unknown', true);
}

export async function rpcUpsertWorkspaceAccountingAssignment(
  workspaceId: string,
  payload: Record<string, unknown>,
  rowVersion: number,
  explicit?: SupabaseClient | null,
): Promise<{ rowVersion: number; deleted: boolean; noop: boolean }> {
  const { data, error } = await client(explicit).rpc('upsert_workspace_accounting_assignment', {
    p_workspace_id: workspaceId,
    p_payload: payload,
    p_row_version: rowVersion,
  });
  if (error) throw classify(error);
  return {
    rowVersion: Number(data?.row_version ?? rowVersion),
    deleted: Boolean(data?.deleted),
    noop: Boolean(data?.noop),
  };
}

export interface CloudAccountingRow {
  client_assignment_id: string;
  source_type: AccountingSourceType;
  source_id: string;
  payload: Record<string, unknown>;
  deleted: boolean;
  row_version: number;
  updated_at: string;
}

export interface AccountingCloudPull {
  assignments: CloudAccountingRow[];
}

export async function rpcPullWorkspaceAccountingAssignments(
  workspaceId: string,
  explicit?: SupabaseClient | null,
): Promise<AccountingCloudPull> {
  const { data, error } = await client(explicit).rpc('pull_workspace_accounting_assignments', {
    p_workspace_id: workspaceId,
  });
  if (error) throw classify(error);
  return { assignments: (data?.assignments ?? []) as CloudAccountingRow[] };
}

/**
 * FINANZ-SYNC-BLOCKER-01C — der Kontext eines Pulls.
 *
 * Ohne ihn liesse sich keine Sync-Meta bilden, und genau das war der Fehler:
 * `rowToAssignment` übernahm bisher die **lokale** Meta (`base.sync`). Für eine
 * Kontierung, die es lokal noch gar nicht gab, blieb sie damit leer — der
 * nächste Push hätte Version 0 gemeldet, obwohl die Cloud längst weiter war.
 */
export interface AccountingPullContext {
  readonly deviceId: string;
  readonly workspaceId: string;
}

function rowSyncMeta(row: CloudAccountingRow, context?: AccountingPullContext): SyncMeta {
  return {
    updatedAt: row.updated_at,
    version: Number(row.row_version),
    deleted: Boolean(row.deleted),
    deletedAt: row.deleted ? row.updated_at : undefined,
    deviceId: context?.deviceId ?? '',
    workspaceId: context?.workspaceId ?? '',
  } as SyncMeta;
}

function rowToAssignment(
  row: CloudAccountingRow,
  local?: AccountingAssignment,
  context?: AccountingPullContext,
): AccountingAssignment {
  const payload = row.payload ?? {};
  const base = (local ?? {}) as Partial<AccountingAssignment>;
  return {
    id: row.client_assignment_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    chartOfAccounts: (payload.chartOfAccounts as AccountingAssignment['chartOfAccounts']) ?? base.chartOfAccounts ?? 'SKR03',
    accountNumber: (payload.accountNumber as string) ?? '',
    accountLabel: (payload.accountLabel as string) ?? '',
    taxTreatment: (payload.taxTreatment as AccountingAssignment['taxTreatment']) ?? 'unclear',
    bookingText: (payload.bookingText as string) ?? '',
    suggestionReason: payload.suggestionReason as string | undefined,
    status: (payload.status as AccountingAssignment['status']) ?? 'needs_review',
    origin: (payload.origin as AccountingAssignment['origin']) ?? 'suggested',
    suggestedAt: payload.suggestedAt as string | undefined,
    confirmedAt: payload.confirmedAt as string | undefined,
    confirmedBy: payload.confirmedBy as string | undefined,
    createdAt: (payload.createdAt as string) ?? row.updated_at,
    updatedAt: (payload.updatedAt as string) ?? row.updated_at,
    /*
     * Die Serverversion ist die Wahrheit. Sie hier zu übernehmen ist die
     * Voraussetzung dafür, dass ein späterer Push dieses Geräts die erwartete
     * Version mitschickt und nicht in einen Versionskonflikt läuft.
     */
    sync: rowSyncMeta(row, context),
  };
}

/**
 * Die Kontierungen, deren lokale Änderung noch unterwegs ist.
 *
 * Dieselbe Regel wie bei den Ausgaben: Ein aktiver Sendeauftrag bedeutet, dass
 * der lokale Stand neuer ist als alles, was die Cloud dazu sagen kann.
 */
export function collectDirtyAccountingKeys(outbox: SyncOutboxEntry[] | undefined): Set<string> {
  const dirty = new Set<string>();
  for (const entry of outbox ?? []) {
    if (entry.status !== 'pending' && entry.status !== 'error' && entry.status !== 'blocked') continue;
    if (entry.entityType === 'accounting_assignment') dirty.add(entry.entityId);
  }
  return dirty;
}

export interface AccountingMergeResult {
  assignments: AccountingAssignment[];
  conflicts: string[];
  counts: { added: number; updated: number; removed: number; keptLocal: number };
}

/**
 * Führt einen Pull mit dem lokalen Bestand zusammen.
 *
 * Die Regel ist dieselbe wie bei den Ausgaben: Eine lokal noch nicht
 * übertragene Änderung (`dirtyKeys`) gewinnt und wird als Konflikt gemeldet,
 * statt still überschrieben zu werden. Bei einer Kontierung wiegt das schwer —
 * eine verlorene Bestätigung wäre eine verlorene Zusage.
 */
export function mergeAccountingFromPull(
  local: AccountingAssignment[],
  pull: AccountingCloudPull,
  dirtyKeys: ReadonlySet<string> = new Set(),
  context?: AccountingPullContext,
): AccountingMergeResult {
  const byId = new Map(local.map((item) => [item.id, item]));
  const conflicts: string[] = [];
  const counts = { added: 0, updated: 0, removed: 0, keptLocal: 0 };

  for (const row of pull.assignments) {
    const existing = byId.get(row.client_assignment_id);

    if (dirtyKeys.has(row.client_assignment_id)) {
      // Lokale Änderung noch unterwegs — sie bleibt, der Konflikt wird benannt.
      if (existing) counts.keptLocal += 1;
      conflicts.push(row.client_assignment_id);
      continue;
    }

    if (row.deleted) {
      if (existing) {
        byId.delete(row.client_assignment_id);
        counts.removed += 1;
      }
      continue;
    }

    const merged = rowToAssignment(row, existing, context);
    byId.set(row.client_assignment_id, merged);
    if (existing) counts.updated += 1;
    else counts.added += 1;
  }

  return { assignments: [...byId.values()], conflicts, counts };
}

/** Übernimmt die Serverversion nach einem erfolgreichen Push. */
export function applyAccountingPushResultToState(
  assignments: AccountingAssignment[],
  id: string,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): AccountingAssignment[] {
  if (deleted) return assignments.filter((item) => item.id !== id);
  return assignments.map((item) => {
    if (item.id !== id) return item;
    const sync: SyncMeta = {
      ...(item.sync ?? {}),
      version: rowVersion,
      updatedAt,
      updatedBy: deviceId,
      workspaceId,
    } as SyncMeta;
    return { ...item, sync };
  });
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export type AccountingPushOutcome =
  | { kind: 'pushed'; rowVersion: number; deleted: boolean }
  | { kind: 'skipped'; reason: string };

/**
 * FINANZ-SYNC-BLOCKER-01B — eine Kontierung in die Cloud.
 *
 * Der RPC ist ein echtes Upsert: Kennt der Server die Kennung noch nicht, legt
 * er sie an und ignoriert die mitgeschickte Version. Deshalb braucht der Fall
 * „lokal angelegt, lokal geaendert, noch nie gesendet" keine Sonderbehandlung —
 * der zusammengefasste Auftrag traegt den aktuellen Stand, und genau der
 * entsteht remote.
 *
 * Vor dem Senden steht dieselbe Grenze wie bei den Ausgaben: Was die
 * serverseitigen Kontierungsregeln sicher ablehnen wuerden, geht gar nicht erst
 * raus. Sonst entstuende ein Auftrag, der bei jedem Lauf erneut mit demselben
 * 400 scheitert.
 */
export async function pushAccountingAssignment(
  assignment: AccountingAssignment,
  operation: SyncOutboxEntry['operation'],
  rowVersion: number,
  workspaceId: string,
  explicit?: SupabaseClient | null,
): Promise<AccountingPushOutcome> {
  const deleted = operation === 'delete' || (assignment.sync?.deleted ?? false);

  if (!deleted) {
    const verstoss = findAccountingServerRuleViolation(assignment);
    if (verstoss) return { kind: 'skipped', reason: verstoss };
  }

  const result = await rpcUpsertWorkspaceAccountingAssignment(
    workspaceId,
    buildAccountingCloudPushPayload(assignment, deleted),
    rowVersion,
    explicit,
  );
  if (result.noop) return { kind: 'skipped', reason: 'tombstone_without_row' };
  return { kind: 'pushed', rowVersion: result.rowVersion, deleted: result.deleted };
}

/**
 * Die serverseitigen Kontierungsregeln, hier vorweggenommen.
 *
 * Bewusst **nur** die beiden Regeln, die der Server fuer `confirmed` erzwingt —
 * keine zweite, strengere Pruefwelt. `needs_review` ohne Sachkonto ist der
 * Normalfall und muss synchronisierbar bleiben.
 */
export function findAccountingServerRuleViolation(
  assignment: AccountingAssignment,
): string | null {
  if (assignment.status !== 'confirmed') return null;
  if (!assignment.accountNumber.trim()) return 'confirmed_without_account';
  if (!(assignment.confirmedAt ?? '').trim()) return 'confirmed_without_timestamp';
  return null;
}
