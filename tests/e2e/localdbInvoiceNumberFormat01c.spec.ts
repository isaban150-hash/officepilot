/**
 * PRODUCT-BASIS-FIRMENPROFIL-EINSTELLUNGEN-01C — Rechnungsnummernformat gegen
 * die lokale Supabase-Instanz (nur RPCs, keine UI).
 *
 *  A  Workspace ohne Nummern: RE + Jahr + padding 4 speichern
 *  B/C erste/zweite Rechnung RE-2026-0001 / RE-2026-0002 (serverseitig vergeben)
 *  D  Parallelfinalisierung: eindeutig, monoton, konfigurierte Form
 *  E/F/G 01C2: nach erster Nummer bleibt das laufende Jahr bei seiner eingefrorenen Kopie —
 *        der Standard darf sich aendern und gilt ab dem naechsten unbenutzten Jahr
 *  H  Member-Schreibversuch abgelehnt (lesen erlaubt)
 *  I  historischer Workspace mit YYYY-NNNN-Nummern: Legacy-Format fixiert, Nummer unveraendert
 *  J  Jahreswechsel: neues Format greift nur fuer noch unbenutztes Jahr
 *  V  Validierung: Prefix-Zeichen/Laenge, padding-Bereich
 *  R  Race: Formataenderung vs. erste Nummer serialisiert (kein halber Zustand)
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const ANON_KEY = process.env.E2E_LOCALDB_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let owner: LocalDbUser;
let member: LocalDbUser;
let admin: SupabaseClient;
let clientOwner: SupabaseClient;
let clientOwner2: SupabaseClient;
let clientMember: SupabaseClient;
let ws = '';
const YEAR = new Date().getUTCFullYear();

async function login(user: LocalDbUser): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`Login fehlgeschlagen: ${error.message}`);
  return client;
}

async function setFormat(client: SupabaseClient, wsId: string, prefix: string, yearInNumber: boolean, padding: number, rowVersion = 0) {
  const { data, error } = await client.rpc('set_workspace_invoice_number_format', { p_workspace_id: wsId, p_prefix: prefix, p_year_in_number: yearInNumber, p_padding: padding, p_row_version: rowVersion });
  return { data: data as Record<string, unknown> | null, error };
}
async function getFormat(client: SupabaseClient, wsId: string) {
  const { data, error } = await client.rpc('get_workspace_invoice_number_format', { p_workspace_id: wsId });
  return { data: data as Record<string, unknown> | null, error };
}
async function finalize(client: SupabaseClient, wsId: string, clientInvoiceId: string, issueDate: string) {
  const { data, error } = await client.rpc('finalize_workspace_invoice', {
    p_workspace_id: wsId, p_vorgang_id: null, p_client_invoice_id: clientInvoiceId,
    p_invoice: { type: 'rechnung', positions: [{ id: 'p1', description: 'Leistung', quantity: 1, unitPrice: 100 }], issueDate, customerSnapshot: { name: 'Kunde' }, subtotal: 100, amount: 119 },
  });
  return { number: (data as { invoice?: { number?: string } } | null)?.invoice?.number, error };
}

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'nf-owner' });
  member = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'nf-member' });
  clientOwner = await login(owner);
  clientOwner2 = await login(owner);
  clientMember = await login(member);
  const { data, error } = await clientOwner.rpc('ensure_personal_workspace', { p_name: 'Nummernformat Test' });
  if (error) throw new Error(error.message);
  ws = (data as { workspace: { id: string } }).workspace.id;
  const ins = await admin.from('workspace_members').insert({ workspace_id: ws, user_id: member.id, role: 'member', status: 'active' });
  if (ins.error) throw new Error(ins.error.message);
});
test.afterAll(async () => {
  for (const user of [owner, member]) if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
});

test.describe('FIRMENPROFIL-01C — Nummernformat gegen die lokale Datenbank', () => {
  test('A/V/H: Standard lesen, ungueltige Formate abgelehnt, Member gesperrt, RE + Jahr + 4 speichern', async () => {
    const initial = await getFormat(clientOwner, ws);
    expect(initial.error).toBeNull();
    expect(initial.data).toMatchObject({ prefix: '', year_in_number: true, padding: 4, row_version: 0, locked_years: [] });

    for (const [prefix, yin, pad, field] of [['RE ', true, 4, 'prefix'], ['RE/2026', true, 4, 'prefix'], ['x'.repeat(11), true, 4, 'prefix'], ['RE', true, 2, 'padding'], ['RE', true, 9, 'padding']] as const) {
      const bad = await setFormat(clientOwner, ws, prefix, yin, pad);
      expect(bad.error?.message, `${prefix}/${pad}`).toContain(`Nummernformat ungueltig: ${field}`);
    }
    const memberWrite = await setFormat(clientMember, ws, 'XX', true, 4);
    expect(memberWrite.error?.message).toContain('Keine Schreibberechtigung');
    const memberRead = await getFormat(clientMember, ws);
    expect(memberRead.error).toBeNull();

    const saved = await setFormat(clientOwner, ws, 'RE', true, 4);
    expect(saved.error).toBeNull();
    expect(saved.data).toMatchObject({ prefix: 'RE', year_in_number: true, padding: 4, row_version: 1, current_year_locked: false });
    // zweite Aenderung vor der ersten Nummer ist noch erlaubt (Versionsguard)
    const stale = await setFormat(clientOwner, ws, 'RE', true, 5, 7);
    expect(stale.error?.message).toContain('Versionskonflikt');
    const padded = await setFormat(clientOwner, ws, 'RE', true, 4, 1);
    expect(padded.error).toBeNull();
    expect(padded.data?.row_version).toBe(2);
  });

  test('B/C/D/K: erste, zweite und parallele Rechnungen im konfigurierten Format, eindeutig und monoton', async () => {
    const first = await finalize(clientOwner, ws, 'inv-nf-1', `${YEAR}-03-01`);
    expect(first.error).toBeNull();
    expect(first.number).toBe(`RE-${YEAR}-0001`);
    const second = await finalize(clientOwner, ws, 'inv-nf-2', `${YEAR}-03-02`);
    expect(second.number).toBe(`RE-${YEAR}-0002`);

    const parallel = await Promise.all([
      finalize(clientOwner, ws, 'inv-nf-p1', `${YEAR}-03-03`),
      finalize(clientOwner2, ws, 'inv-nf-p2', `${YEAR}-03-03`),
      finalize(clientOwner, ws, 'inv-nf-p3', `${YEAR}-03-03`),
    ]);
    for (const result of parallel) expect(result.error).toBeNull();
    const numbers = parallel.map((r) => r.number!).sort();
    expect(numbers).toEqual([`RE-${YEAR}-0003`, `RE-${YEAR}-0004`, `RE-${YEAR}-0005`]);
    // Snapshot/Zeile traegt exakt die vergebene Nummer (K)
    const rows = await admin.from('workspace_invoices').select('client_invoice_id,invoice_number,invoice_sequence_number,payload').eq('workspace_id', ws).order('invoice_sequence_number');
    expect(rows.data!.map((r) => r.invoice_number)).toEqual([1, 2, 3, 4, 5].map((n) => `RE-${YEAR}-000${n}`));
    expect(rows.data!.every((r) => (r.payload as { number: string }).number === r.invoice_number)).toBe(true);
    const seq = await admin.from('workspace_invoice_sequences').select('last_sequence,number_prefix,year_in_number,number_padding,format_locked_at').eq('workspace_id', ws).eq('invoice_year', YEAR).single();
    expect(seq.data).toMatchObject({ last_sequence: 5, number_prefix: 'RE', year_in_number: true, number_padding: 4 });
    expect(seq.data!.format_locked_at).toBeTruthy();
  });

  test('E/F/G (01C2): Standard aendern ist erlaubt, wirkt aber nicht auf das gesperrte Jahr — Prefix/padding/Jahr des laufenden Jahres bleiben eingefroren', async () => {
    const current = await getFormat(clientOwner, ws);
    expect(current.data?.effective_from_year).toBe(YEAR + 1);
    const version = Number(current.data!.row_version);
    const changed = await setFormat(clientOwner, ws, 'RG', false, 6, version);
    expect(changed.error).toBeNull();
    expect(changed.data).toMatchObject({ prefix: 'RG', year_in_number: false, padding: 6, current_year_locked: true, effective_from_year: YEAR + 1 });
    // laufendes Jahr: naechste Nummer weiterhin im eingefrorenen Format
    const sixth = await finalize(clientOwner, ws, 'inv-nf-6', `${YEAR}-04-01`);
    expect(sixth.number).toBe(`RE-${YEAR}-0006`);
    const seq = await admin.from('workspace_invoice_sequences').select('number_prefix,year_in_number,number_padding').eq('workspace_id', ws).eq('invoice_year', YEAR).single();
    expect(seq.data).toEqual({ number_prefix: 'RE', year_in_number: true, number_padding: 4 });
    const after = await getFormat(clientOwner, ws);
    expect((after.data!.locked_years as Array<{ year: number }>).map((y) => y.year)).toEqual([YEAR]);
    // Sequenz und Nummern unveraendert
    const rows = await admin.from('workspace_invoices').select('invoice_number').eq('workspace_id', ws);
    expect(rows.data!.every((r) => r.invoice_number.startsWith(`RE-${YEAR}-`))).toBe(true);
    // zurueck auf RE/Jahr/4 fuer die folgenden Tests (Standard aenderbar, Jahr unberuehrt)
    const back = await setFormat(clientOwner, ws, 'RE', true, 4, Number(changed.data!.row_version));
    expect(back.error).toBeNull();
  });

  test('I: historischer Workspace mit YYYY-NNNN — Legacy-Format fixiert, Nummern unveraendert, Standard nur fuer unbenutzte Jahre', async () => {
    // Historik nachbilden: Sequenz mit Nummern, aber (wie vor 01C) ohne Format-Sperre
    const { data: legacyWs } = await clientOwner2.rpc('ensure_personal_workspace', { p_name: 'x' });
    const legacyId = (legacyWs as { workspace: { id: string } }).workspace.id;
    expect(legacyId).toBe(ws); // derselbe Owner hat genau einen Workspace — Historik daher ueber ein weiteres Jahr
    const legacyYear = YEAR - 1;
    const seeded = await admin.from('workspace_invoice_sequences').insert({ workspace_id: ws, invoice_year: legacyYear, last_sequence: 7, number_prefix: '', year_in_number: true, number_padding: 4, format_locked_at: null });
    expect(seeded.error).toBeNull();
    await admin.from('workspace_invoices').insert({ workspace_id: ws, vorgang_id: null, client_invoice_id: 'inv-legacy-7', invoice_number: `${legacyYear}-0007`, invoice_year: legacyYear, invoice_sequence_number: 7, invoice_type: 'rechnung', invoice_status: 'versendet', payload: { id: 'inv-legacy-7', number: `${legacyYear}-0007` } });
    // Migrations-Backfill-Regel nachgestellt: last_sequence > 0 -> Legacy-Format fixieren
    await admin.from('workspace_invoice_sequences').update({ format_locked_at: new Date().toISOString() }).eq('workspace_id', ws).eq('invoice_year', legacyYear).is('format_locked_at', null);
    // Naechste Nummer im historischen Jahr folgt weiterhin YYYY-NNNN, obwohl der Standard RE-… ist
    const eighth = await finalize(clientOwner, ws, 'inv-legacy-8', `${legacyYear}-12-30`);
    expect(eighth.error).toBeNull();
    expect(eighth.number).toBe(`${legacyYear}-0008`);
    const old = await admin.from('workspace_invoices').select('invoice_number').eq('client_invoice_id', 'inv-legacy-7').single();
    expect(old.data!.invoice_number).toBe(`${legacyYear}-0007`);
  });

  test('J/R (01C2): Folgejahr uebernimmt den vor dem Jahreswechsel gesetzten Standard und ist danach gesperrt; Race bleibt konsistent', async () => {
    const next = YEAR + 1;
    // Waehrend das laufende Jahr gesperrt ist, wird der Standard auf RG/Jahr/5 gesetzt -> gilt ab dem naechsten unbenutzten Jahr
    const current = await getFormat(clientOwner, ws);
    const set = await setFormat(clientOwner, ws, 'RG', true, 5, Number(current.data!.row_version));
    expect(set.error).toBeNull();
    expect(set.data?.effective_from_year).toBe(next);
    const race = await Promise.all([
      setFormat(clientOwner, ws, 'RG', true, 5, Number(set.data!.row_version)),
      finalize(clientOwner2, ws, 'inv-next-1', `${next}-01-05`),
    ]);
    expect(race[0].error).toBeNull();
    expect(race[1].error).toBeNull();
    expect(race[1].number).toBe(`RG-${next}-00001`);
    const nextSeq = await admin.from('workspace_invoice_sequences').select('number_prefix,year_in_number,number_padding,format_locked_at,last_sequence').eq('workspace_id', ws).eq('invoice_year', next).single();
    expect(nextSeq.data).toMatchObject({ number_prefix: 'RG', year_in_number: true, number_padding: 5, last_sequence: 1 });
    expect(nextSeq.data!.format_locked_at).toBeTruthy();
    // danach: Folgejahr eingefroren — ein neuer Standard aendert es nicht mehr
    const later = await setFormat(clientOwner, ws, 'XX', false, 3, Number(race[0].data!.row_version));
    expect(later.error).toBeNull();
    const second = await finalize(clientOwner, ws, 'inv-next-2', `${next}-02-01`);
    expect(second.number).toBe(`RG-${next}-00002`);
    // historische Nummern unveraendert, alle drei Jahre sichtbar gesperrt
    const rows = await admin.from('workspace_invoices').select('client_invoice_id,invoice_number').eq('workspace_id', ws).in('client_invoice_id', ['inv-nf-1', 'inv-legacy-7']);
    expect(rows.data!.map((r) => r.invoice_number).sort()).toEqual([`${YEAR - 1}-0007`, `RE-${YEAR}-0001`]);
    const state = await getFormat(clientOwner, ws);
    expect((state.data!.locked_years as Array<{ year: number }>).map((y) => y.year)).toEqual([YEAR - 1, YEAR, next]);
  });
});
