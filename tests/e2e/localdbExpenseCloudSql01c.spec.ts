/**
 * FINANZ-CORE-DURABILITY-01C — SQL/RLS-Laufzeittests gegen die lokale
 * Supabase-Instanz (kein --linked, keine Remote-Daten).
 *
 * Geprueft: `workspace_expenses`, `workspace_expense_payments`, die RPCs
 * `upsert_workspace_expense`, `add_workspace_expense_payment`,
 * `reverse_workspace_expense_payment`, `pull_workspace_expenses` und die
 * Ableitung von `expense_id` am Eingang:
 *   - fremder Workspace gesperrt; member (kein Finanzrecht) gesperrt
 *   - owner/admin: anlegen, versioniert aendern, Grabstein
 *   - Zahlung: idempotent ueber Kennung, Konflikt bei abweichenden Daten,
 *     Reversal als Grabstein, kein Reversal-Wiederbeleben, Beleg mit Zahlung nicht loeschbar
 *   - Zahlungen nie im Payload; expense_id am Eingang folgt der Ausgabenzeile
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const ANON_KEY = process.env.E2E_LOCALDB_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let ownerA: LocalDbUser;
let memberA: LocalDbUser;
let ownerB: LocalDbUser;
let admin: SupabaseClient;
let clientOwnerA: SupabaseClient;
let clientMemberA: SupabaseClient;
let clientOwnerB: SupabaseClient;
let wsA = '';
let wsB = '';

async function login(user: LocalDbUser): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`Login fehlgeschlagen: ${error.message}`);
  return client;
}

async function ensureWorkspace(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.rpc('ensure_personal_workspace', { p_name: 'Expense SQL Test' });
  if (error) throw new Error(error.message);
  const id = (data as { workspace?: { id?: string } })?.workspace?.id;
  if (!id) throw new Error(`Workspace-ID fehlt: ${JSON.stringify(data)}`);
  return id;
}

function expensePayload(id: string, extra: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return {
    client_expense_id: id,
    status: 'gebucht',
    dedupe_key: 'lieferant|re-1',
    payload: { id, title: 'Material', supplierName: 'Lieferant', grossAmount: 119, payments: [{ id: 'darf-nicht' }], ...payload },
    ...extra,
  };
}

async function upsert(client: SupabaseClient, ws: string, payload: Record<string, unknown>, rowVersion = 0) {
  const { data, error } = await client.rpc('upsert_workspace_expense', { p_workspace_id: ws, p_payload: payload, p_row_version: rowVersion });
  return { data: data as { row_version?: number; deleted?: boolean; noop?: boolean } | null, error };
}

async function addPayment(client: SupabaseClient, ws: string, expenseId: string, paymentId: string, amount: number, paidOn = '2026-06-05', extra: Record<string, unknown> = {}) {
  const { data, error } = await client.rpc('add_workspace_expense_payment', {
    p_workspace_id: ws, p_client_expense_id: expenseId, p_client_payment_id: paymentId, p_amount: amount, p_paid_on: paidOn, p_reference: null, p_note: null, ...extra,
  });
  return { data: data as Array<Record<string, unknown>> | null, error };
}

async function reverse(client: SupabaseClient, ws: string, expenseId: string, paymentId: string) {
  const { data, error } = await client.rpc('reverse_workspace_expense_payment', { p_workspace_id: ws, p_client_expense_id: expenseId, p_client_payment_id: paymentId });
  return { data: data as Array<Record<string, unknown>> | null, error };
}

async function pull(client: SupabaseClient, ws: string) {
  const { data, error } = await client.rpc('pull_workspace_expenses', { p_workspace_id: ws });
  return { data: data as { expenses: Array<Record<string, unknown>>; payments: Array<Record<string, unknown>> } | null, error };
}

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  ownerA = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'exp-owner-a' });
  memberA = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'exp-member-a' });
  ownerB = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'exp-owner-b' });
  clientOwnerA = await login(ownerA);
  clientMemberA = await login(memberA);
  clientOwnerB = await login(ownerB);
  wsA = await ensureWorkspace(clientOwnerA);
  wsB = await ensureWorkspace(clientOwnerB);
  const { error } = await admin.from('workspace_members').insert({ workspace_id: wsA, user_id: memberA.id, role: 'member', status: 'active' });
  if (error) throw new Error(`Member anlegen: ${error.message}`);
});

test.afterAll(async () => {
  for (const user of [ownerA, memberA, ownerB]) {
    if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
  }
});

test.describe('DURABILITY-01C — Ausgaben-Cloud gegen die lokale Datenbank', () => {
  test('E1/E2: Owner legt an, Version steigt, Konflikt bei falscher Version, Zahlungen nie im Payload', async () => {
    const created = await upsert(clientOwnerA, wsA, expensePayload('exp-a-1'));
    expect(created.error).toBeNull();
    expect(created.data?.row_version).toBe(1);

    const stale = await upsert(clientOwnerA, wsA, expensePayload('exp-a-1', {}, { title: 'Falsch' }), 5);
    expect(stale.error?.message).toContain('Versionskonflikt');

    const updated = await upsert(clientOwnerA, wsA, expensePayload('exp-a-1', {}, { title: 'Material neu' }), 1);
    expect(updated.error).toBeNull();
    expect(updated.data?.row_version).toBe(2);

    const pulled = await pull(clientOwnerA, wsA);
    expect(pulled.error).toBeNull();
    const rowA = pulled.data!.expenses.find((e) => e.client_expense_id === 'exp-a-1')!;
    expect((rowA.payload as Record<string, unknown>).title).toBe('Material neu');
    expect((rowA.payload as Record<string, unknown>).payments).toBeUndefined();
    expect(rowA.row_version).toBe(2);
  });

  test('R1/M1: fremder Workspace gesperrt; member ohne Finanzrecht liest und schreibt nichts', async () => {
    const foreign = await upsert(clientOwnerB, wsA, expensePayload('exp-fremd'));
    expect(foreign.error?.message).toContain('Kein Zugriff');
    const foreignPull = await pull(clientOwnerB, wsA);
    expect(foreignPull.error?.message).toContain('Kein Zugriff');

    const memberWrite = await upsert(clientMemberA, wsA, expensePayload('exp-member'));
    expect(memberWrite.error?.message).toContain('Kein Zugriff');
    const memberPull = await pull(clientMemberA, wsA);
    expect(memberPull.error?.message).toContain('Kein Zugriff');
    const memberSelect = await clientMemberA.from('workspace_expenses').select('client_expense_id').eq('workspace_id', wsA);
    expect(memberSelect.error).toBeNull();
    expect(memberSelect.data).toEqual([]);
    const memberPay = await addPayment(clientMemberA, wsA, 'exp-a-1', 'pay-member', 10);
    expect(memberPay.error?.message).toContain('Kein Zugriff');
  });

  test('P1/P2: Zahlung idempotent ueber Kennung; abweichende Daten = Konflikt; unbekannter Beleg abgelehnt', async () => {
    const first = await addPayment(clientOwnerA, wsA, 'exp-a-1', 'pay-1', 50);
    expect(first.error).toBeNull();
    expect(first.data).toHaveLength(1);
    const replay = await addPayment(clientOwnerA, wsA, 'exp-a-1', 'pay-1', 50);
    expect(replay.error).toBeNull();
    expect(replay.data).toHaveLength(1);
    const conflict = await addPayment(clientOwnerA, wsA, 'exp-a-1', 'pay-1', 60);
    expect(conflict.error?.message).toContain('Zahlungskonflikt');
    const unknown = await addPayment(clientOwnerA, wsA, 'exp-gibt-es-nicht', 'pay-x', 10);
    expect(unknown.error?.message).toContain('Ausgabe nicht gefunden');
    const badDate = await addPayment(clientOwnerA, wsA, 'exp-a-1', 'pay-bad', 10, '2026-02-30');
    expect(badDate.error?.message).toContain('paid_on');

    const rows = await admin.from('workspace_expense_payments').select('client_payment_id').eq('workspace_id', wsA).eq('client_expense_id', 'exp-a-1');
    expect(rows.data?.map((r) => r.client_payment_id)).toEqual(['pay-1']);
  });

  test('P3/P4: Beleg mit gebuchter Zahlung nicht loeschbar; Reversal = Grabstein, Wiederholung idempotent, kein Wiederbeleben', async () => {
    const blocked = await upsert(clientOwnerA, wsA, expensePayload('exp-a-1', { deleted: true }), 2);
    expect(blocked.error?.message).toContain('gebuchte Zahlungen');

    const reversed = await reverse(clientOwnerA, wsA, 'exp-a-1', 'pay-1');
    expect(reversed.error).toBeNull();
    expect(reversed.data?.[0]?.reversed_at).toBeTruthy();
    const again = await reverse(clientOwnerA, wsA, 'exp-a-1', 'pay-1');
    expect(again.error).toBeNull();
    // Gleiche Kennung nach Reversal: kein stilles Wiederbeleben.
    const revive = await addPayment(clientOwnerA, wsA, 'exp-a-1', 'pay-1', 50);
    expect(revive.error?.message).toContain('storniert');
    const unknownReverse = await reverse(clientOwnerA, wsA, 'exp-a-1', 'pay-nie');
    expect(unknownReverse.error?.message).toContain('Zahlung nicht gefunden');

    const pulled = await pull(clientOwnerA, wsA);
    const pay = pulled.data!.payments.find((p) => p.client_payment_id === 'pay-1')!;
    expect(pay.reversed_at).toBeTruthy();

    // Ohne aktive Zahlung ist der Grabstein erlaubt; danach keine Zahlung mehr moeglich.
    const tomb = await upsert(clientOwnerA, wsA, expensePayload('exp-a-1', { deleted: true }), 2);
    expect(tomb.error).toBeNull();
    expect(tomb.data?.deleted).toBe(true);
    expect(tomb.data?.row_version).toBe(3);
    const afterTomb = await addPayment(clientOwnerA, wsA, 'exp-a-1', 'pay-2', 10);
    expect(afterTomb.error?.message).toContain('geloescht');
    const tombUnknown = await upsert(clientOwnerA, wsA, expensePayload('exp-nie', { deleted: true }), 0);
    expect(tombUnknown.error).toBeNull();
    expect(tombUnknown.data?.noop).toBe(true);
  });

  test('I1: expense_id am Eingang folgt der Ausgabenzeile (setzen, umhaengen, Grabstein loest)', async () => {
    for (const inboxId of ['inbox-upload-1', 'inbox-upload-2']) {
      const { error } = await clientOwnerA.rpc('upsert_workspace_intake_entity', {
        p_workspace_id: wsA, p_entity_type: 'inbox_item',
        p_payload: { client_inbox_id: inboxId, status: 'neu', payload: { id: inboxId, title: 'Beleg' } }, p_row_version: 0,
      });
      expect(error).toBeNull();
    }
    const created = await upsert(clientOwnerA, wsA, expensePayload('exp-a-2', { linked_inbox_id: 'inbox-upload-1' }));
    expect(created.error).toBeNull();
    const inboxRows = async () => {
      const { data } = await admin.from('workspace_inbox_items').select('client_inbox_id,expense_id').eq('workspace_id', wsA).in('client_inbox_id', ['inbox-upload-1', 'inbox-upload-2']);
      return Object.fromEntries((data ?? []).map((r) => [r.client_inbox_id, r.expense_id]));
    };
    expect(await inboxRows()).toEqual({ 'inbox-upload-1': 'exp-a-2', 'inbox-upload-2': null });

    const moved = await upsert(clientOwnerA, wsA, expensePayload('exp-a-2', { linked_inbox_id: 'inbox-upload-2' }), 1);
    expect(moved.error).toBeNull();
    expect(await inboxRows()).toEqual({ 'inbox-upload-1': null, 'inbox-upload-2': 'exp-a-2' });

    const tomb = await upsert(clientOwnerA, wsA, expensePayload('exp-a-2', { linked_inbox_id: 'inbox-upload-2', deleted: true }), 2);
    expect(tomb.error).toBeNull();
    expect(await inboxRows()).toEqual({ 'inbox-upload-1': null, 'inbox-upload-2': null });
  });

  test('S1: stornierte Ausgabe nimmt keine Zahlung an; Status-Check greift', async () => {
    const created = await upsert(clientOwnerA, wsA, expensePayload('exp-a-3', { status: 'storniert' }));
    expect(created.error).toBeNull();
    const pay = await addPayment(clientOwnerA, wsA, 'exp-a-3', 'pay-s', 10);
    expect(pay.error?.message).toContain('storniert');
    const bad = await upsert(clientOwnerA, wsA, expensePayload('exp-a-4', { status: 'kaputt' }));
    expect(bad.error?.message).toContain('Status ungueltig');
  });
});
