/**
 * P1 EXPENSE-SYNC-VERSIONSVERTRAG — `expense.sync.version` ist die zuletzt
 * vom Server bestätigte `row_version`, nie ein lokaler Zähler.
 *
 * Realbefund (lokale Supabase): Server v1 → lokale Bearbeitung zählte auf 2 →
 * „Versionskonflikt: Ausgabe … hat Version 1, erwartet 2" (blocked). Im
 * Konkurrenzfall traf die erfundene 2 die echte Remote-v2 eines anderen Geräts
 * und überschrieb dessen Änderung still; der Pull verwarf die Remote-v2 als
 * „nicht neuer". Dasselbe Muster wie der Intake-Fix (5e5425a).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../data/mockData';
import type { Expense } from '../types/expense';
import type { AppPersistedState } from '../types/models';
import type { SyncMeta } from '../types/sync';
import { createTestVorgang } from '../test/fixtures';
import {
  addExpense,
  assignExpenseToVorgang,
  cancelExpense,
  deleteExpense,
  getExpenseById,
  removeExpenseAllocation,
  updateExpense,
} from './expenseService';
import { getExpenseStoreSnapshot, hydrateExpenseStore } from './expenseStore';
import { hydrateVorgangStore } from './vorgangService';
import * as persistenceService from './persistenceService';
import {
  buildExpensePushPayload,
  mergeExpensesFromPull,
  pushExpenseEntity,
  type CloudExpenseRow,
} from './expense/expenseCloudSyncService';
import { createSyncClient, resetSyncClientForTests } from './sync/syncClientService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from './sync/syncOutboxService';
import {
  resetSyncChangeTrackerForTests,
  resetSyncChangeTrackerFromState,
  trackPersistedChanges,
} from './sync/syncChangeTrackerService';
import { STORAGE_VERSION } from './sync/syncMigrationService';
import { extractCloudSyncEntity } from './workspace/workspaceSyncPayloadService';

const WS = 'ws-expense-version';
const VORGANG = 'v-expense-version';

function confirmed(version: number): SyncMeta {
  return { updatedAt: '2026-10-01T08:00:00.000Z', version, deleted: false, deviceId: 'dev-a', workspaceId: WS };
}

/** Eine Ausgabe über den echten Anlageweg, danach als vom Server mit `version` bestätigt markiert. */
function syncedExpense(title: string, version = 1): Expense {
  const result = addExpense({
    title,
    category: 'material',
    supplierName: 'Baustoff Nord GmbH',
    invoiceNumber: `RE-${title.replace(/\W+/g, '-')}`,
    issueDate: '2026-09-05',
    grossAmount: 119,
    netAmount: 100,
    taxAmount: 19,
    status: 'gebucht',
  });
  if (!result.success) throw new Error(result.errorKey);
  const synced = { ...result.expense, sync: confirmed(version) };
  hydrateExpenseStore([...getExpenseStoreSnapshot().filter((e) => e.id !== synced.id), synced]);
  return getExpenseById(synced.id)!;
}

function stateWith(expenses: Expense[]): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, serverWorkspaceId: WS, workspaceId: WS },
    syncOutbox: [],
    setup: DEFAULT_SETUP,
    expenses,
    inboxItems: [],
    vorgaenge: [],
    customers: [],
    tasks: [],
    documents: [],
    savedAt: '2026-10-01T08:00:00.000Z',
  } as AppPersistedState;
}

/** Push über den echten Expense-Push-Pfad; der Client protokolliert die gesendete Erwartung. */
async function pushedExpectation(expense: Expense, operation: 'create' | 'update' | 'delete') {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    rpc: async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { data: { row_version: Number(args.p_row_version) + 1, deleted: false, noop: false }, error: null };
    },
  } as unknown as SupabaseClient;
  const extracted = extractCloudSyncEntity(stateWith([expense]), 'expense', expense.id);
  expect(extracted?.entityType).toBe('expense');
  await pushExpenseEntity(extracted as Parameters<typeof pushExpenseEntity>[0], operation, WS, client);
  expect(calls).toHaveLength(1);
  return { rowVersion: Number(calls[0].p_row_version), deleted: Boolean((calls[0].p_payload as { deleted?: boolean }).deleted) };
}

beforeEach(() => {
  localStorage.clear();
  hydrateExpenseStore([]);
  hydrateVorgangStore([createTestVorgang({ id: VORGANG, title: 'Bad Sanierung' })]);
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests(createSyncClient());
  vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: true } as never);
});

describe('P1 Expense-Versionsvertrag — Server-Version bleibt Server-Version', () => {
  it('U1: alle vier Update-Writer behalten die bestätigte v1; der echte Push erwartet 1', async () => {
    const writers: Array<[string, (id: string) => { success: boolean }]> = [
      ['updateExpense', (id) => updateExpense(id, { title: 'Neuer Titel' })],
      ['cancelExpense', (id) => cancelExpense(id, 'Fehlbuchung')],
      ['assignExpenseToVorgang', (id) => assignExpenseToVorgang(id, { vorgangId: VORGANG, amount: 50 })],
    ];
    for (const [name, write] of writers) {
      const expense = syncedExpense(`U1 ${name}`);
      expect(write(expense.id).success, name).toBe(true);
      const after = getExpenseById(expense.id)!;
      expect(after.sync, name).toEqual(confirmed(1));
      expect(await pushedExpectation(after, 'update'), name).toEqual({ rowVersion: 1, deleted: false });
    }
    // removeExpenseAllocation braucht eine vorhandene Zuordnung — diese ist bereits bestätigt.
    const withAllocation = syncedExpense('U1 removeExpenseAllocation');
    hydrateExpenseStore([
      ...getExpenseStoreSnapshot().filter((e) => e.id !== withAllocation.id),
      { ...withAllocation, allocations: [{ vorgangId: VORGANG, vorgangTitle: 'Bad Sanierung', amount: 40 }], sync: confirmed(1) },
    ]);
    expect(removeExpenseAllocation(withAllocation.id, VORGANG).success).toBe(true);
    const removed = getExpenseById(withAllocation.id)!;
    expect(removed.allocations ?? []).toEqual([]);
    expect(removed.sync).toEqual(confirmed(1));
    expect(await pushedExpectation(removed, 'update')).toEqual({ rowVersion: 1, deleted: false });
  });

  it('U1b: bestätigte v3 — updateExpense erfindet keine Version (früher immer 2)', async () => {
    const expense = syncedExpense('U1b', 3);
    expect(updateExpense(expense.id, { description: 'Nachtrag' }).success).toBe(true);
    const after = getExpenseById(expense.id)!;
    expect(after.description).toBe('Nachtrag');
    expect(after.sync?.version).toBe(3);
    expect(await pushedExpectation(after, 'update')).toEqual({ rowVersion: 3, deleted: false });
  });

  it('U2: synchronisierte v1 → deleteExpense → deleted, gesendete Erwartung 1', async () => {
    const expense = syncedExpense('U2');
    expect(deleteExpense(expense.id).success).toBe(true);
    const tombstone = getExpenseStoreSnapshot().find((e) => e.id === expense.id)!;
    expect(tombstone.sync?.deleted).toBe(true);
    expect(tombstone.sync?.version).toBe(1);
    expect(await pushedExpectation(tombstone, 'delete')).toEqual({ rowVersion: 1, deleted: true });
  });

  it('U3: unsynchronisierte Ausgabe — Bearbeiten zählt nicht hoch, Create bleibt Insert-kompatibel', async () => {
    const created = addExpense({
      title: 'U3 neu',
      category: 'material',
      supplierName: 'Baustoff Nord GmbH',
      invoiceNumber: 'RE-U3',
      issueDate: '2026-09-05',
      grossAmount: 119,
      netAmount: 100,
      taxAmount: 19,
    });
    expect(created.success).toBe(true);
    if (!created.success) return;
    const initial = created.expense.sync?.version;
    // addExpense unverändert (P3: unbestätigt 1) — der Insert prüft die Erwartung nicht.
    expect(initial).toBe(1);
    expect(updateExpense(created.expense.id, { title: 'U3 bearbeitet' }).success).toBe(true);
    expect(updateExpense(created.expense.id, { description: 'zweiter Edit' }).success).toBe(true);
    const after = getExpenseById(created.expense.id)!;
    expect(after.sync?.version).toBe(initial);
    expect(await pushedExpectation(after, 'create')).toEqual({ rowVersion: initial, deleted: false });
  });

  it('U4: fachliche Änderung ohne Versionssprung wird vom Tracker genau einmal als Update eingereiht', () => {
    const expense = syncedExpense('U4');
    resetSyncChangeTrackerFromState(stateWith([expense]));
    expect(updateExpense(expense.id, { title: 'U4 geändert' }).success).toBe(true);
    const after = getExpenseById(expense.id)!;
    expect(after.sync?.version).toBe(1);
    trackPersistedChanges(stateWith([after]));
    const entries = getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'expense' && entry.entityId === expense.id);
    expect(entries.map((entry) => entry.operation)).toEqual(['update']);
    trackPersistedChanges(stateWith([after]));
    expect(getSyncOutboxSnapshot().filter((entry) => entry.entityId === expense.id)).toHaveLength(1);
  });

  it('U5: Remote v2 gegen lokal bearbeitete Basis v1 → Konflikt statt stiller Verwerfung', () => {
    const expense = syncedExpense('U5');
    expect(updateExpense(expense.id, { title: 'Lokal von A' }).success).toBe(true);
    const local = getExpenseById(expense.id)!;
    expect(local.sync?.version).toBe(1);
    const remote: CloudExpenseRow = {
      client_expense_id: expense.id,
      status: local.status,
      dedupe_key: local.dedupeKey ?? '',
      linked_inbox_id: null,
      archive_document_id: null,
      payload: { ...(buildExpensePushPayload(local, false).payload as Record<string, unknown>), title: 'Fremdänderung Gerät B' },
      deleted: false,
      row_version: 2,
      updated_at: '2026-10-01T09:00:00.000Z',
    };
    const dirty = mergeExpensesFromPull([local], { expenses: [remote], payments: [] }, { deviceId: 'dev-a', workspaceId: WS, dirty: new Set([`expense:${expense.id}`]) });
    expect(dirty.conflicts).toEqual([`expense:${expense.id}`]);
    expect(dirty.expenses.find((e) => e.id === expense.id)!.title).toBe('Lokal von A');
    // Ohne lokale Änderung übernimmt der Pull die neuere Remote-Fassung.
    const clean = mergeExpensesFromPull([local], { expenses: [remote], payments: [] }, { deviceId: 'dev-a', workspaceId: WS, dirty: new Set() });
    expect(clean.conflicts).toEqual([]);
    const adopted = clean.expenses.find((e) => e.id === expense.id)!;
    expect(adopted.title).toBe('Fremdänderung Gerät B');
    expect(adopted.sync?.version).toBe(2);
  });
});
