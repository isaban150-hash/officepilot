/**
 * P2 EXPENSE -> INBOX_ITEM ROW_VERSION — DB-Vertrag gegen die **lokale**
 * Supabase-Instanz (nur RPCs, zwei getrennte Sessions desselben Nutzers).
 *
 * `workspace_inbox_items.expense_id` ist server-owned: abgeleitet aus
 * `workspace_expenses.linked_inbox_id`. Der Intake-Push darf sie nicht
 * überschreiben, und ihr Setzen/Lösen erhöht die `row_version` des Eingangs
 * nicht — sonst entstehen falsche Intake-Konflikte.
 *
 *  A Link · B Intake-Push danach · C Expense-Edit · D Unlink · E Relink
 *  F Expense-Delete · G Insert-Rekonstruktion · H falscher Konflikt bleibt aus
 *  I echter Intake-Konflikt bleibt Konflikt
 *
 * Payloads in exakt der Form der Client-Builder (`buildInboxItemPushPayload`
 * sendet `expense_id: null`; `buildExpensePushPayload` mit Geldwerten).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const ANON_KEY = process.env.E2E_LOCALDB_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let user: LocalDbUser;
let deviceA: SupabaseClient;
let deviceB: SupabaseClient;
let ws = '';

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SUPABASE_URL)) throw new Error('Nur gegen die lokale Instanz.');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'inbox-expense-p2' });
  const login = async () => {
    const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
    if (error) throw new Error(error.message);
    return client;
  };
  deviceA = await login();
  deviceB = await login();
  const { data, error } = await deviceA.rpc('ensure_personal_workspace', { p_name: 'P2 Inbox Expense' });
  if (error) throw new Error(error.message);
  ws = (data as { workspace: { id: string } }).workspace.id;
});

test.afterAll(async () => {
  if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
});

function inboxPayload(id: string, title: string, status = 'neu') {
  return {
    client_inbox_id: id, status, vorgang_link_status: 'none', client_file_ref_id: null, archive_document_id: null,
    vorgang_id: null, expense_id: null, payload: { id, title, status }, deleted: false,
  };
}

async function pushInbox(client: SupabaseClient, id: string, title: string, expected: number, status = 'neu') {
  const { data, error } = await client.rpc('upsert_workspace_intake_entity', {
    p_workspace_id: ws, p_entity_type: 'inbox_item', p_payload: inboxPayload(id, title, status), p_row_version: expected,
  });
  return { rowVersion: Number((data as { row_version?: number } | null)?.row_version ?? 0), error: error?.message ?? null };
}

function expensePayload(id: string, inboxId: string | null, title: string, deleted = false) {
  return {
    client_expense_id: id, status: 'gebucht', dedupe_key: `p2|${id}`, linked_inbox_id: inboxId, archive_document_id: null,
    payload: { id, title, supplierName: 'Baustoff Nord GmbH', issueDate: '2026-09-01', netAmount: 100, taxAmount: 19, grossAmount: 119, taxStatus: 'standard_19', currency: 'EUR', status: 'gebucht' },
    deleted,
  };
}

async function pushExpense(client: SupabaseClient, id: string, inboxId: string | null, title: string, expected: number, deleted = false) {
  const { data, error } = await client.rpc('upsert_workspace_expense', {
    p_workspace_id: ws, p_payload: expensePayload(id, inboxId, title, deleted), p_row_version: expected,
  });
  return { rowVersion: Number((data as { row_version?: number } | null)?.row_version ?? 0), error: error?.message ?? null };
}

type InboxRow = { row_version: number; expense_id: string | null; status: string; payload: { title?: string } };
async function inbox(id: string): Promise<InboxRow> {
  const { data, error } = await deviceA.rpc('pull_workspace_intake_state', { p_workspace_id: ws });
  if (error) throw new Error(error.message);
  const row = (data as { inbox_items: Array<InboxRow & { client_inbox_id: string }> }).inbox_items.find((r) => r.client_inbox_id === id);
  if (!row) throw new Error(`Eingang ${id} fehlt`);
  return row;
}

test.describe.configure({ mode: 'serial' });

test.describe('P2 — expense_id am Eingang ist server-owned', () => {
  test('A/B/C: Verknüpfen ohne Versionssprung; Intake-Push lässt expense_id stehen; Expense-Edit ohne Sprung', async () => {
    expect((await pushInbox(deviceA, 'in-a', 'Rechnung A', 0)).rowVersion).toBe(1);

    // A — Link
    expect((await pushExpense(deviceA, 'exp-a', 'in-a', 'Ausgabe A', 0)).error).toBeNull();
    expect(await inbox('in-a')).toMatchObject({ row_version: 1, expense_id: 'exp-a' });

    // B — normaler Intake-Push danach: Fachänderung wird versioniert, expense_id bleibt
    const pushed = await pushInbox(deviceA, 'in-a', 'Rechnung A geprüft', 1, 'geprueft');
    expect(pushed).toEqual({ rowVersion: 2, error: null });
    expect(await inbox('in-a')).toMatchObject({ row_version: 2, expense_id: 'exp-a', status: 'geprueft', payload: { title: 'Rechnung A geprüft' } });

    // C — Expense-Edit bei unveränderter Verknüpfung: kein Hin und Her, kein Sprung
    expect((await pushExpense(deviceA, 'exp-a', 'in-a', 'Ausgabe A neu', 1)).rowVersion).toBe(2);
    expect((await pushExpense(deviceA, 'exp-a', 'in-a', 'Ausgabe A neu 2', 2)).rowVersion).toBe(3);
    expect(await inbox('in-a')).toMatchObject({ row_version: 2, expense_id: 'exp-a' });
  });

  test('D/E/F: Lösen, Umverknüpfen und Löschen ändern nur expense_id, nie die row_version', async () => {
    await pushInbox(deviceA, 'in-d', 'Rechnung D', 0);
    await pushInbox(deviceA, 'in-e', 'Rechnung E', 0);
    expect((await pushExpense(deviceA, 'exp-d', 'in-d', 'Ausgabe D', 0)).error).toBeNull();
    expect(await inbox('in-d')).toMatchObject({ row_version: 1, expense_id: 'exp-d' });

    // D — Unlink
    expect((await pushExpense(deviceA, 'exp-d', null, 'Ausgabe D', 1)).error).toBeNull();
    expect(await inbox('in-d')).toMatchObject({ row_version: 1, expense_id: null });

    // E — Relink: erst wieder an D, dann von D auf E
    expect((await pushExpense(deviceA, 'exp-d', 'in-d', 'Ausgabe D', 2)).error).toBeNull();
    expect(await inbox('in-d')).toMatchObject({ row_version: 1, expense_id: 'exp-d' });
    expect((await pushExpense(deviceA, 'exp-d', 'in-e', 'Ausgabe D', 3)).error).toBeNull();
    expect(await inbox('in-d')).toMatchObject({ row_version: 1, expense_id: null });
    expect(await inbox('in-e')).toMatchObject({ row_version: 1, expense_id: 'exp-d' });

    // F — Expense-Delete
    expect((await pushExpense(deviceA, 'exp-d', 'in-e', 'Ausgabe D', 4, true)).error).toBeNull();
    expect(await inbox('in-e')).toMatchObject({ row_version: 1, expense_id: null });
  });

  test('G: Insert-Rekonstruktion — der Eingang entsteht nach der Ausgabe, expense_id wird abgeleitet', async () => {
    expect((await pushExpense(deviceA, 'exp-g', 'in-g', 'Ausgabe G', 0)).error).toBeNull();
    // Der Client sendet expense_id: null — der Server leitet ab.
    expect((await pushInbox(deviceA, 'in-g', 'Rechnung G', 0)).rowVersion).toBe(1);
    expect(await inbox('in-g')).toMatchObject({ row_version: 1, expense_id: 'exp-g' });
    // Ohne verknüpfte Ausgabe bleibt sie NULL; eine gelöschte zählt nicht.
    expect((await pushExpense(deviceA, 'exp-g2', 'in-g2', 'Ausgabe G2', 0)).error).toBeNull();
    expect((await pushExpense(deviceA, 'exp-g2', 'in-g2', 'Ausgabe G2', 1, true)).error).toBeNull();
    expect((await pushInbox(deviceA, 'in-g2', 'Rechnung G2', 0)).rowVersion).toBe(1);
    expect(await inbox('in-g2')).toMatchObject({ expense_id: null });
    expect((await pushInbox(deviceA, 'in-g3', 'Rechnung G3', 0)).rowVersion).toBe(1);
    expect(await inbox('in-g3')).toMatchObject({ expense_id: null });
  });

  test('H: ungesendete Intake-Änderung auf Basis v1 + Ausgaben-Verknüpfung durch Gerät B → Push mit v1 gelingt', async () => {
    expect((await pushInbox(deviceA, 'in-h', 'Rechnung H', 0)).rowVersion).toBe(1);
    // Gerät A hält Basis v1 mit einer ungesendeten Änderung; Gerät B verknüpft und bearbeitet die Ausgabe.
    expect((await pushExpense(deviceB, 'exp-h', 'in-h', 'Ausgabe H', 0)).error).toBeNull();
    expect((await pushExpense(deviceB, 'exp-h', 'in-h', 'Ausgabe H neu', 1)).error).toBeNull();
    expect(await inbox('in-h')).toMatchObject({ row_version: 1, expense_id: 'exp-h' });
    // A pusht jetzt seine Änderung mit der bestätigten Basis 1.
    const push = await pushInbox(deviceA, 'in-h', 'Rechnung H von A geprüft', 1, 'geprueft');
    expect(push).toEqual({ rowVersion: 2, error: null });
    expect(await inbox('in-h')).toMatchObject({ row_version: 2, expense_id: 'exp-h', status: 'geprueft', payload: { title: 'Rechnung H von A geprüft' } });
  });

  test('I: echte Intake-Fremdänderung bleibt ein Konflikt — kein Überschreiben', async () => {
    expect((await pushInbox(deviceA, 'in-i', 'Rechnung I', 0)).rowVersion).toBe(1);
    // Gerät B ändert ein echtes Intake-Fachfeld → v2.
    expect(await pushInbox(deviceB, 'in-i', 'Rechnung I von B', 1, 'geprueft')).toEqual({ rowVersion: 2, error: null });
    // Gerät A versucht seinen alten Edit auf Basis 1.
    const stale = await pushInbox(deviceA, 'in-i', 'Rechnung I von A', 1, 'neu');
    expect(stale.error).toContain('Versionskonflikt inbox_item:2');
    expect(await inbox('in-i')).toMatchObject({ row_version: 2, status: 'geprueft', payload: { title: 'Rechnung I von B' } });
  });
});
