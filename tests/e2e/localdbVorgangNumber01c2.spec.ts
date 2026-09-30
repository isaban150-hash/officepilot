/**
 * EINGANG-01C-2 — echte Vorgangsnummer VG-JJJJ-NNNN gegen die **lokale**
 * Supabase-Instanz (nur RPCs und SQL, keine UI).
 *
 *  T1/T2  erste/zweite Vergabe im Berliner Jahr
 *  T3     anderer Workspace: eigene Folge
 *  T4     Jahreswechsel: eigene Folge je Jahr
 *  T4b    Berlin/UTC-Grenze am Jahreswechsel
 *  T5     40 parallele Anlagen ueber zwei Clients: eindeutig, lueckenlos
 *  T6     doppelte Nummer: Unique-Index
 *  T7/7b  vergebene Nummer aendern/entfernen: Trigger und Upsert lehnen ab
 *  T8     veralteter Push ohne Nummer: Nummer bleibt, Payload wieder deckungsgleich
 *  T11    Angebotsannahme und manueller Auftrag: AU + VG, Replay ohne zweite VG
 *  T16    Member/Fremder: keine Vergabe; Allokator nicht direkt aufrufbar
 *  T17    Rollback: Nummer und Zaehler verschwinden mit der Transaktion
 *  T18    Insert ohne ausdruecklichen Wunsch: NULL (kein Backfill)
 *  T19    9999 -> 10000 ohne Abschneiden
 *  T20    Grabstein-Insert mit Wunsch: keine Nummer verbraucht
 *
 * SQL laeuft ausschliesslich ueber `docker exec` gegen den lokalen Container.
 */
import { execFileSync } from 'node:child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const ANON_KEY = process.env.E2E_LOCALDB_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';
const DB_CONTAINER = 'supabase_db_officepilot';
const YEAR = Number(new Intl.DateTimeFormat('en', { timeZone: 'Europe/Berlin', year: 'numeric' }).format(new Date()));
const vg = (n: number, year = YEAR) => `VG-${year}-${String(n).padStart(4, '0')}`;

let owner: LocalDbUser;
let owner2: LocalDbUser;
let member: LocalDbUser;
let outsider: LocalDbUser;
let admin: SupabaseClient;
let clientOwner: SupabaseClient;
let clientOwnerB: SupabaseClient;
let clientOwner2: SupabaseClient;
let clientMember: SupabaseClient;
let clientOutsider: SupabaseClient;
let ws = '';
let ws2 = '';

async function login(user: LocalDbUser): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`Login fehlgeschlagen: ${error.message}`);
  return client;
}

async function ensureWorkspace(client: SupabaseClient, name: string): Promise<string> {
  const { data, error } = await client.rpc('ensure_personal_workspace', { p_name: name });
  if (error) throw new Error(error.message);
  return (data as { workspace: { id: string } }).workspace.id;
}

type Upsert = { number: string | null; payloadNumber: string | null; rowVersion: number; replayed: boolean; error: string | null };

async function upsertVorgang(
  client: SupabaseClient,
  wsId: string,
  id: string,
  options: { request?: unknown; rowVersion?: number; deleted?: boolean; payload?: Record<string, unknown> } = {},
): Promise<Upsert> {
  const body: Record<string, unknown> = {
    vorgang_id: id,
    id,
    deleted: options.deleted ?? false,
    payload: options.payload ?? { id, title: `Vorgang ${id}`, customer: 'Beispiel GmbH', baustelle: '', status: 'eingegangen', materialSource: 'unclear', orderPositions: [] },
  };
  if (options.request !== undefined) body.request_vorgang_number = options.request;
  const { data, error } = await client.rpc('upsert_workspace_sync_entity', {
    p_workspace_id: wsId,
    p_entity_type: 'vorgang',
    p_payload: body,
    p_row_version: options.rowVersion ?? 0,
  });
  const row = (data as { payload?: Record<string, unknown>; row_version?: number; replayed?: boolean } | null) ?? {};
  const payload = (row.payload?.payload as Record<string, unknown> | undefined) ?? {};
  return {
    number: (row.payload?.vorgang_number as string | null | undefined) ?? null,
    payloadNumber: (payload.vorgangNumber as string | undefined) ?? null,
    rowVersion: Number(row.row_version ?? 0),
    replayed: row.replayed === true,
    error: error?.message ?? null,
  };
}

async function lastSequence(wsId: string, year = YEAR): Promise<number> {
  const { data, error } = await admin.from('workspace_vorgang_sequences').select('last_sequence').eq('workspace_id', wsId).eq('vorgang_year', year).maybeSingle();
  if (error) throw new Error(error.message);
  return Number((data as { last_sequence?: number } | null)?.last_sequence ?? 0);
}

async function dbRow(wsId: string, id: string) {
  const { data, error } = await admin.from('workspace_vorgaenge').select('vorgang_number,payload,row_version').eq('workspace_id', wsId).eq('vorgang_id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data as { vorgang_number: string | null; payload: Record<string, unknown>; row_version: number } | null;
}

/** Lokales SQL im Container. Liefert { ok, out, err }. */
function sql(statements: string): { ok: boolean; out: string; err: string } {
  try {
    const out = execFileSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-A', '-t'], {
      input: statements,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, out: out.trim(), err: '' };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '') };
  }
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const base = { supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY };
  owner = await provisionLocalDbUser({ ...base, label: 'vg-owner' });
  owner2 = await provisionLocalDbUser({ ...base, label: 'vg-owner2' });
  member = await provisionLocalDbUser({ ...base, label: 'vg-member' });
  outsider = await provisionLocalDbUser({ ...base, label: 'vg-outsider' });
  clientOwner = await login(owner);
  clientOwnerB = await login(owner);
  clientOwner2 = await login(owner2);
  clientMember = await login(member);
  clientOutsider = await login(outsider);
  ws = await ensureWorkspace(clientOwner, 'Vorgangsnummer Test');
  ws2 = await ensureWorkspace(clientOwner2, 'Vorgangsnummer Test 2');
  await ensureWorkspace(clientOutsider, 'Fremder Workspace');
  const ins = await admin.from('workspace_members').insert({ workspace_id: ws, user_id: member.id, role: 'member', status: 'active' });
  if (ins.error) throw new Error(ins.error.message);
  const baseline = sql(FOREIGN_UNNUMBERED_SQL());
  if (!baseline.ok) throw new Error(baseline.err);
  foreignUnnumberedBefore = baseline.out;
});

/** Anzahl und Kennungen der Bestandszeilen ohne Nummer ausserhalb der Test-Workspaces. */
let foreignUnnumberedBefore = '';
const FOREIGN_UNNUMBERED_SQL = () =>
  `select count(*) || '|' || md5(coalesce(string_agg(workspace_id::text || '/' || vorgang_id, ',' order by workspace_id, vorgang_id), '')) from public.workspace_vorgaenge where vorgang_number is null and workspace_id not in (${quote(ws)}, ${quote(ws2)});`;

test.afterAll(async () => {
  for (const user of [owner, owner2, member, outsider]) {
    if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
  }
});

test.describe.configure({ mode: 'serial' });

test.describe('EINGANG-01C-2 — Vorgangsnummer gegen die lokale Datenbank', () => {
  test('T18/T1/T2/T3: ohne Wunsch keine Nummer; mit Wunsch 0001, 0002; anderer Workspace eigene Folge', async () => {
    // T18 — kein Backfill: Insert ohne bzw. ohne echtes JSON-true bleibt NULL.
    for (const [id, request] of [['v-noreq', undefined], ['v-false', false], ['v-string', 'true'], ['v-one', 1]] as const) {
      const result = await upsertVorgang(clientOwner, ws, id, { request });
      expect(result.error, id).toBeNull();
      expect(result.number, id).toBeNull();
      expect(result.payloadNumber, id).toBeNull();
    }
    expect(await lastSequence(ws)).toBe(0);

    const first = await upsertVorgang(clientOwner, ws, 'v-first', { request: true });
    expect(first.error).toBeNull();
    expect(first.number).toBe(vg(1));
    expect(first.payloadNumber).toBe(vg(1));
    const second = await upsertVorgang(clientOwner, ws, 'v-second', { request: true });
    expect(second.number).toBe(vg(2));

    const other = await upsertVorgang(clientOwner2, ws2, 'v-other-ws', { request: true });
    expect(other.number).toBe(vg(1));
    expect(await lastSequence(ws)).toBe(2);
    expect(await lastSequence(ws2)).toBe(1);
  });

  test('T4/T4b: Jahreswechsel eigene Folge; Berliner Jahresgrenze statt UTC', async () => {
    const allocate = async (wsId: string, at: string) => {
      const { data, error } = await admin.rpc('allocate_workspace_vorgang_number', { p_workspace_id: wsId, p_at: at });
      if (error) throw new Error(error.message);
      return data as string;
    };
    expect(await allocate(ws2, '2031-06-01T10:00:00Z')).toBe('VG-2031-0001');
    expect(await allocate(ws2, '2031-06-02T10:00:00Z')).toBe('VG-2031-0002');
    expect(await allocate(ws2, '2032-01-05T10:00:00Z')).toBe('VG-2032-0001');
    // 31.12.2032 22:59:59 UTC = 23:59:59 Berlin -> 2032; 23:00:00 UTC = 00:00 Berlin -> 2033.
    expect(await allocate(ws2, '2032-12-31T22:59:59Z')).toBe('VG-2032-0002');
    expect(await allocate(ws2, '2032-12-31T23:00:00Z')).toBe('VG-2033-0001');
    // Sommerzeit: 30.06. 22:30 UTC ist in Berlin noch derselbe Tag/dasselbe Jahr.
    expect(await allocate(ws2, '2033-06-30T22:30:00Z')).toBe('VG-2033-0002');
    // Das laufende Jahr des anderen Workspace ist unberuehrt.
    expect(await lastSequence(ws)).toBe(2);
  });

  test('T5: 40 parallele Anlagen ueber zwei Clients — eindeutig, lueckenlos, kein verlorener Insert', async () => {
    const before = await lastSequence(ws);
    const ids = Array.from({ length: 40 }, (_, i) => `v-par-${i}`);
    const results = await Promise.all(ids.map((id, i) => upsertVorgang(i % 2 === 0 ? clientOwner : clientOwnerB, ws, id, { request: true })));
    for (const [i, r] of results.entries()) expect(r.error, ids[i]).toBeNull();
    const numbers = results.map((r) => r.number!);
    expect(new Set(numbers).size).toBe(40);
    const expected = Array.from({ length: 40 }, (_, i) => vg(before + 1 + i));
    expect([...numbers].sort()).toEqual([...expected].sort());
    expect(await lastSequence(ws)).toBe(before + 40);
    const { data } = await admin.from('workspace_vorgaenge').select('vorgang_id,vorgang_number').eq('workspace_id', ws).like('vorgang_id', 'v-par-%');
    expect((data ?? []).length).toBe(40);
    expect((data ?? []).every((row) => row.vorgang_number)).toBe(true);
  });

  test('T6/T7/T7b: Duplikat, Aendern und Entfernen scheitern in der Datenbank', async () => {
    const dup = sql(`update public.workspace_vorgaenge set vorgang_number = ${quote(vg(1))} where workspace_id = ${quote(ws)} and vorgang_id = 'v-noreq';`);
    expect(dup.ok).toBe(false);
    expect(dup.err).toContain('workspace_vorgaenge_vorgang_number_unique');

    const change = sql(`update public.workspace_vorgaenge set vorgang_number = ${quote(vg(9000))} where workspace_id = ${quote(ws)} and vorgang_id = 'v-first';`);
    expect(change.ok).toBe(false);
    expect(change.err).toContain('Vorgangsnummer ist unveraenderlich');
    const remove = sql(`update public.workspace_vorgaenge set vorgang_number = null where workspace_id = ${quote(ws)} and vorgang_id = 'v-first';`);
    expect(remove.ok).toBe(false);
    expect(remove.err).toContain('Vorgangsnummer ist unveraenderlich');
    const badFormat = sql(`update public.workspace_vorgaenge set vorgang_number = 'VG-ALT-1' where workspace_id = ${quote(ws)} and vorgang_id = 'v-false';`);
    expect(badFormat.ok).toBe(false);
    expect(badFormat.err).toContain('workspace_vorgaenge_vorgang_number_format');
    expect((await dbRow(ws, 'v-first'))?.vorgang_number).toBe(vg(1));
  });

  test('T7/T8: Upsert — Client kann keine Nummer setzen, aendern oder entfernen; veralteter Push behaelt sie', async () => {
    // Insert mit eigener Nummer.
    const forged = await upsertVorgang(clientOwner, ws, 'v-forged', { request: true, payload: { id: 'v-forged', title: 'x', customer: 'x', baustelle: '', status: 'eingegangen', materialSource: 'unclear', orderPositions: [], vorgangNumber: vg(7777) } });
    expect(forged.error).toContain('Vorgangsnummer vergibt ausschliesslich der Server');
    expect(await dbRow(ws, 'v-forged')).toBeNull();

    // Update einer Zeile ohne Nummer mit Nummer.
    const noNumber = await dbRow(ws, 'v-noreq');
    const inject = await upsertVorgang(clientOwner, ws, 'v-noreq', { rowVersion: noNumber!.row_version, payload: { ...noNumber!.payload, vorgangNumber: vg(7778) } });
    expect(inject.error).toContain('Vorgangsnummer vergibt ausschliesslich der Server');
    expect((await dbRow(ws, 'v-noreq'))?.vorgang_number).toBeNull();

    // Aendern einer vergebenen Nummer.
    const row = await dbRow(ws, 'v-first');
    const change = await upsertVorgang(clientOwner, ws, 'v-first', { rowVersion: row!.row_version, payload: { ...row!.payload, vorgangNumber: vg(7779) } });
    expect(change.error).toContain('Vorgangsnummer kann nicht geaendert werden');

    // T8 — veralteter Client ohne Feld, korrekte Version: Nummer bleibt, Payload wieder vollstaendig.
    const stalePayload = { ...row!.payload, title: 'Vom alten Tab bearbeitet' } as Record<string, unknown>;
    delete stalePayload.vorgangNumber;
    const stale = await upsertVorgang(clientOwner, ws, 'v-first', { rowVersion: row!.row_version, payload: stalePayload });
    expect(stale.error).toBeNull();
    expect(stale.number).toBe(vg(1));
    expect(stale.payloadNumber).toBe(vg(1));
    const after = await dbRow(ws, 'v-first');
    expect(after?.vorgang_number).toBe(vg(1));
    expect(after?.payload.title).toBe('Vom alten Tab bearbeitet');

    // Grabstein einer nummerierten Zeile: Nummer bleibt an der Zeile.
    const tomb = await upsertVorgang(clientOwner, ws, 'v-second', { rowVersion: (await dbRow(ws, 'v-second'))!.row_version, deleted: true });
    expect(tomb.error).toBeNull();
    expect((await dbRow(ws, 'v-second'))?.vorgang_number).toBe(vg(2));
  });

  test('Lost-Ack-Replay: identischer Version-0-Push nach vergebener Nummer liefert dieselbe Zeile, keine neue Nummer', async () => {
    const created = await upsertVorgang(clientOwner, ws, 'v-replay', { request: true });
    expect(created.number).toMatch(/^VG-\d{4}-\d{4,}$/);
    const before = await lastSequence(ws);
    const replay = await upsertVorgang(clientOwner, ws, 'v-replay', { request: true });
    expect(replay.error).toBeNull();
    expect(replay.replayed).toBe(true);
    expect(replay.number).toBe(created.number);
    expect(await lastSequence(ws)).toBe(before);
    // Ein abweichender Inhalt ist kein Replay, sondern ein Versionskonflikt.
    const conflict = await upsertVorgang(clientOwner, ws, 'v-replay', { request: true, payload: { id: 'v-replay', title: 'anders', customer: 'x', baustelle: '', status: 'eingegangen', materialSource: 'unclear', orderPositions: [] } });
    expect(conflict.error).toContain('Versionskonflikt');
    expect(await lastSequence(ws)).toBe(before);
  });

  test('T19/T20: 9999 -> 10000 ohne Abschneiden; Grabstein-Insert verbraucht keine Nummer', async () => {
    const before = await lastSequence(ws);
    const tomb = await upsertVorgang(clientOwner, ws, 'v-tomb-insert', { request: true, deleted: true });
    expect(tomb.error).toBeNull();
    expect(tomb.number).toBeNull();
    expect(await lastSequence(ws)).toBe(before);

    const set = await admin.from('workspace_vorgang_sequences').update({ last_sequence: 9999 }).eq('workspace_id', ws2).eq('vorgang_year', YEAR);
    expect(set.error).toBeNull();
    const big = await upsertVorgang(clientOwner2, ws2, 'v-10000', { request: true });
    expect(big.number).toBe(`VG-${YEAR}-10000`);
    const bigger = await upsertVorgang(clientOwner2, ws2, 'v-10001', { request: true });
    expect(bigger.number).toBe(`VG-${YEAR}-10001`);
  });

  test('T16: Member und Fremder vergeben nichts; Allokator und Zaehler fuer Clients gesperrt', async () => {
    const before = await lastSequence(ws);
    const asMember = await upsertVorgang(clientMember, ws, 'v-member', { request: true });
    expect(asMember.error).toContain('Keine Schreibberechtigung');
    const asOutsider = await upsertVorgang(clientOutsider, ws, 'v-outsider', { request: true });
    expect(asOutsider.error).toContain('Kein Zugriff auf Workspace');
    for (const client of [clientOwner, clientMember, clientOutsider]) {
      const direct = await client.rpc('allocate_workspace_vorgang_number', { p_workspace_id: ws });
      expect(direct.error).not.toBeNull();
      expect(direct.data ?? null).toBeNull();
    }
    const tamper = await clientOwner.from('workspace_vorgang_sequences').update({ last_sequence: 0 }).eq('workspace_id', ws).select();
    expect(tamper.error !== null || (tamper.data ?? []).length === 0).toBe(true);
    const insert = await clientOwner.from('workspace_vorgang_sequences').insert({ workspace_id: ws, vorgang_year: 2040, last_sequence: 5 });
    expect(insert.error).not.toBeNull();
    expect(await lastSequence(ws)).toBe(before);
    expect(await dbRow(ws, 'v-member')).toBeNull();
  });

  test('T17: Vergabe und Einfuegen teilen die Transaktion — Rollback hinterlaesst weder Zeile noch Zaehlerstand', async () => {
    const before = await lastSequence(ws);
    const body = JSON.stringify({ vorgang_id: 'v-rollback', id: 'v-rollback', deleted: false, request_vorgang_number: true, payload: { id: 'v-rollback', title: 'Rollback', customer: 'x', baustelle: '', status: 'eingegangen', materialSource: 'unclear', orderPositions: [] } });
    const result = sql(`
begin;
select set_config('request.jwt.claims', ${quote(JSON.stringify({ sub: owner.id, role: 'authenticated' }))}, true) is not null;
set local role authenticated;
select 'NUM=' || (public.upsert_workspace_sync_entity(${quote(ws)}::uuid, 'vorgang', ${quote(body)}::jsonb, 0)->'payload'->>'vorgang_number');
rollback;
`);
    expect(result.ok, result.err).toBe(true);
    // Innerhalb der Transaktion wurde tatsaechlich eine Nummer vergeben ...
    expect(result.out).toContain(`NUM=${vg(before + 1)}`);
    // ... nach dem Rollback ist sie weg, der Zaehler unveraendert.
    expect(await dbRow(ws, 'v-rollback')).toBeNull();
    expect(await lastSequence(ws)).toBe(before);
    const next = await upsertVorgang(clientOwner, ws, 'v-after-rollback', { request: true });
    expect(next.number).toBe(vg(before + 1));
  });

  test('T11: Angebotsannahme und manueller Auftrag vergeben AU + VG; Replay ohne zweite VG', async () => {
    const offerId = `offer-vg-${Date.now()}`;
    const fin = await clientOwner.rpc('finalize_workspace_offer', {
      p_workspace_id: ws,
      p_offer_id: offerId,
      p_payload: {
        id: offerId,
        customer: { name: 'Angebotskunde GmbH' },
        title: 'Angebot Dach',
        validUntil: '2099-12-31',
        positions: [{ id: 'p1', description: 'Dachflaeche', quantity: 2, unit: 'm²', unitPrice: 50 }],
        totals: { subtotal: 100, taxRate: 19, tax: 19, total: 119 },
      },
      p_fingerprint: `fp-${offerId}`,
    });
    expect(fin.error).toBeNull();
    const offerRowVersion = Number((fin.data as { row_version: number }).row_version);
    const before = await lastSequence(ws);

    const acceptArgs = { p_workspace_id: ws, p_offer_id: offerId, p_vorgang_id: `v-${offerId}`, p_row_version: offerRowVersion };
    const accepted = await clientOwner.rpc('accept_workspace_offer', acceptArgs);
    expect(accepted.error).toBeNull();
    const vorgang = (accepted.data as { vorgang: { vorgang_number: string; order_number: string; payload: Record<string, unknown> } }).vorgang;
    expect(vorgang.order_number).toMatch(/^AU-\d{4}-\d{4}$/);
    expect(vorgang.vorgang_number).toBe(vg(before + 1));
    expect(vorgang.payload.vorgangNumber).toBe(vorgang.vorgang_number);
    expect(vorgang.payload.orderNumber).toBe(vorgang.order_number);

    const replay = await clientOwner.rpc('accept_workspace_offer', acceptArgs);
    expect(replay.error).toBeNull();
    expect((replay.data as { replayed: boolean }).replayed).toBe(true);
    expect((replay.data as { vorgang: { vorgang_number: string } }).vorgang.vorgang_number).toBe(vorgang.vorgang_number);
    expect(await lastSequence(ws)).toBe(before + 1);

    const orderArgs = {
      p_workspace_id: ws,
      p_vorgang_id: `v-order-${Date.now()}`,
      p_order: { customerBilling: { name: 'Auftragskunde GmbH' }, title: 'Manueller Auftrag', baustelle: '', taxStatus: 'standard_19', positions: [{ id: 'p1', description: 'Arbeit', plannedQuantity: 1, unit: 'Stunden', unitPrice: 80 }] },
    };
    const order = await clientOwner.rpc('create_workspace_order', orderArgs);
    expect(order.error).toBeNull();
    const orderRow = (order.data as { vorgang: { vorgang_number: string; order_number: string; payload: Record<string, unknown> } }).vorgang;
    expect(orderRow.order_number).toMatch(/^AU-\d{4}-\d{4}$/);
    expect(orderRow.vorgang_number).toBe(vg(before + 2));
    expect(orderRow.payload.vorgangNumber).toBe(orderRow.vorgang_number);
    const orderReplay = await clientOwner.rpc('create_workspace_order', orderArgs);
    expect((orderReplay.data as { replayed: boolean }).replayed).toBe(true);
    expect((orderReplay.data as { vorgang: { vorgang_number: string } }).vorgang.vorgang_number).toBe(orderRow.vorgang_number);
    expect(await lastSequence(ws)).toBe(before + 2);

    // Ein spaeterer generischer Push eines Auftrags behaelt beide Nummern.
    const row = await dbRow(ws, orderArgs.p_vorgang_id);
    const payload = { ...row!.payload } as Record<string, unknown>;
    delete payload.vorgangNumber;
    const push = await upsertVorgang(clientOwner, ws, orderArgs.p_vorgang_id, { rowVersion: row!.row_version, payload });
    expect(push.error).toBeNull();
    expect(push.number).toBe(orderRow.vorgang_number);
    expect(push.payloadNumber).toBe(orderRow.vorgang_number);
  });

  test('Kein Backfill: fremde Bestandszeilen ohne Nummer bleiben nach allen Vergaben ohne Nummer', async () => {
    const result = sql(FOREIGN_UNNUMBERED_SQL());
    expect(result.ok, result.err).toBe(true);
    expect(result.out).toBe(foreignUnnumberedBefore);
    expect(Number(foreignUnnumberedBefore.split('|')[0])).toBeGreaterThan(0);
  });
});
