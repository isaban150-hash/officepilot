/**
 * PRODUCT-BASIS-FIRMENPROFIL-EINSTELLUNGEN-01B — SQL/RLS-Laufzeittests gegen die
 * lokale Supabase-Instanz: schema-versionierter Altclient-Schutz im
 * company_profile-Zweig von `upsert_workspace_sync_entity`.
 *
 *  B  owner schreibt / C member liest, schreibt nicht
 *  E  Versionskonflikt bei veralteter row_version
 *  F  alter Client (ohne/mit niedriger Schema-Version) ohne neue Keys loescht sie nicht
 *  G  neuer Client (Schema 2) loescht ein optionales Feld bewusst (weglassen und null)
 *  L  branding-Regel unveraendert (fehlend/null -> bewahren, {} -> uebernehmen)
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
let clientMember: SupabaseClient;
let ws = '';

async function login(user: LocalDbUser): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`Login fehlgeschlagen: ${error.message}`);
  return client;
}

const BASE = { companyName: 'Cirmak Haustechnik GmbH', legalForm: 'GmbH', street: 'Werkstraße 12', zip: '32657', city: 'Lemgo', country: 'Deutschland', email: 'info@cirmak.example', iban: 'DE89370400440532013000', defaultPaymentDays: 14 };

async function upsert(client: SupabaseClient, payload: Record<string, unknown>, rowVersion: number, schemaVersion?: number) {
  const { data, error } = await client.rpc('upsert_workspace_sync_entity', {
    p_workspace_id: ws,
    p_entity_type: 'company_profile',
    p_payload: schemaVersion === undefined ? { payload } : { payload, profile_schema_version: schemaVersion },
    p_row_version: rowVersion,
  });
  return { rowVersion: Number((data as { row_version?: number } | null)?.row_version ?? 0), error };
}

async function stored(): Promise<Record<string, unknown>> {
  const { data } = await admin.from('workspace_company_profiles').select('payload,row_version').eq('workspace_id', ws).single();
  return data!.payload as Record<string, unknown>;
}

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'cp-owner' });
  member = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'cp-member' });
  clientOwner = await login(owner);
  clientMember = await login(member);
  const { data, error } = await clientOwner.rpc('ensure_personal_workspace', { p_name: 'Profil SQL Test' });
  if (error) throw new Error(error.message);
  ws = (data as { workspace: { id: string } }).workspace.id;
  const ins = await admin.from('workspace_members').insert({ workspace_id: ws, user_id: member.id, role: 'member', status: 'active' });
  if (ins.error) throw new Error(ins.error.message);
});
test.afterAll(async () => {
  for (const user of [owner, member]) if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
});

test.describe('FIRMENPROFIL-01B — Schema-Preserve gegen die lokale Datenbank', () => {
  test('B/E: owner legt an (Schema 2) und aktualisiert; veraltete Version = Versionskonflikt', async () => {
    const created = await upsert(clientOwner, { ...BASE, defaultTaxStatus: 'standard_19', currency: 'EUR', replyToEmail: 'rechnung@cirmak.example', senderDisplayName: 'Cirmak Service', branding: { primaryColor: '#123456' } }, 0, 2);
    expect(created.error).toBeNull();
    expect(created.rowVersion).toBe(1);
    const stale = await upsert(clientOwner, { ...BASE, currency: 'EUR' }, 5, 2);
    expect(stale.error?.message).toContain('Versionskonflikt');
    expect(await stored()).toMatchObject({ currency: 'EUR', replyToEmail: 'rechnung@cirmak.example', defaultTaxStatus: 'standard_19' });
  });

  test('C: member liest das Profil, kann aber nicht schreiben — auch nicht die neuen Felder', async () => {
    const read = await clientMember.from('workspace_company_profiles').select('payload').eq('workspace_id', ws).single();
    expect(read.error).toBeNull();
    expect((read.data!.payload as Record<string, unknown>).currency).toBe('EUR');
    const write = await upsert(clientMember, { ...BASE, currency: 'USD', replyToEmail: 'hack@x.de' }, 1, 2);
    expect(write.error?.message).toContain('Keine Schreibberechtigung');
    expect((await stored()).currency).toBe('EUR');
  });

  test('F: alter Client ohne Schema-Version und ohne neue Keys loescht currency/replyToEmail/senderDisplayName/defaultTaxStatus/branding nicht', async () => {
    const legacy = await upsert(clientOwner, { ...BASE, city: 'Detmold' }, 1); // kein profile_schema_version, kein branding
    expect(legacy.error).toBeNull();
    const after = await stored();
    expect(after).toMatchObject({ city: 'Detmold', currency: 'EUR', replyToEmail: 'rechnung@cirmak.example', senderDisplayName: 'Cirmak Service', defaultTaxStatus: 'standard_19', branding: { primaryColor: '#123456' } });
    // Schema-Version 1 (kennt branding, aber nicht die 01B-Felder): dieselbe Bewahrung
    const v1 = await upsert(clientOwner, { ...BASE, city: 'Lemgo', branding: { primaryColor: '#abcdef' } }, 2, 1);
    expect(v1.error).toBeNull();
    expect(await stored()).toMatchObject({ city: 'Lemgo', currency: 'EUR', replyToEmail: 'rechnung@cirmak.example', defaultTaxStatus: 'standard_19', branding: { primaryColor: '#abcdef' } });
  });

  test('G: neuer Client (Schema 2) loescht replyToEmail bewusst — durch Weglassen und durch null; Pflichtfelder bleiben', async () => {
    const omitted = await upsert(clientOwner, { ...BASE, currency: 'EUR', defaultTaxStatus: 'standard_19', senderDisplayName: 'Cirmak Service' }, 3, 2);
    expect(omitted.error).toBeNull();
    let after = await stored();
    expect('replyToEmail' in after).toBe(false);
    expect(after).toMatchObject({ currency: 'EUR', defaultTaxStatus: 'standard_19', senderDisplayName: 'Cirmak Service' });
    const nulled = await upsert(clientOwner, { ...BASE, currency: 'EUR', defaultTaxStatus: 'standard_19', senderDisplayName: null }, 4, 2);
    expect(nulled.error).toBeNull();
    after = await stored();
    expect('senderDisplayName' in after).toBe(false);
    expect(after.currency).toBe('EUR');
    // ein alter Client danach belebt nichts wieder (nichts vorhanden zum Bewahren) und loescht currency weiterhin nicht
    const legacyAgain = await upsert(clientOwner, { ...BASE }, 5);
    expect(legacyAgain.error).toBeNull();
    after = await stored();
    expect('replyToEmail' in after).toBe(false);
    expect(after.currency).toBe('EUR');
  });

  test('L: branding — fehlend/null bewahrt, {} uebernommen (Regel unveraendert)', async () => {
    const nullBranding = await upsert(clientOwner, { ...BASE, currency: 'EUR', defaultTaxStatus: 'standard_19', branding: null }, 6, 2);
    expect(nullBranding.error).toBeNull();
    expect((await stored()).branding).toEqual({ primaryColor: '#abcdef' });
    const emptied = await upsert(clientOwner, { ...BASE, currency: 'EUR', defaultTaxStatus: 'standard_19', branding: {} }, 7, 2);
    expect(emptied.error).toBeNull();
    expect((await stored()).branding).toEqual({});
  });
});

/**
 * 01B3 — serverseitige Validierung: ein ungueltiger Wert weist den gesamten
 * Write atomar ab; der bestehende Remote-Stand bleibt byteidentisch.
 */
test.describe('FIRMENPROFIL-01B3 — Servervalidierung', () => {
  test('A–F/I/J: gueltig akzeptiert; USD, "euro", ungueltige E-Mail, >120 Zeichen, unbekannter Steuerstatus, falsche Schema-Version abgelehnt — Stand unveraendert; Member gesperrt', async () => {
    const before = await admin.from('workspace_company_profiles').select('payload,row_version').eq('workspace_id', ws).single();
    const version = Number(before.data!.row_version);
    const ok = await upsert(clientOwner, { ...BASE, currency: 'EUR', defaultTaxStatus: 'standard_19', replyToEmail: 'rechnung@cirmak.example', senderDisplayName: 'Cirmak Service' }, version, 2);
    expect(ok.error).toBeNull();
    const snapshot = await admin.from('workspace_company_profiles').select('payload,row_version').eq('workspace_id', ws).single();
    const stableVersion = Number(snapshot.data!.row_version);

    const rejected: Array<[string, Record<string, unknown>, number | undefined]> = [
      ['currency', { ...BASE, currency: 'USD' }, 2],
      ['currency', { ...BASE, currency: 'euro' }, 2],
      ['currency', { ...BASE, currency: 7 }, 2],
      ['replyToEmail', { ...BASE, currency: 'EUR', replyToEmail: 'kein-mail' }, 2],
      ['replyToEmail', { ...BASE, currency: 'EUR', replyToEmail: '' }, 2],
      ['senderDisplayName', { ...BASE, currency: 'EUR', senderDisplayName: 'x'.repeat(121) }, 2],
      ['senderDisplayName', { ...BASE, currency: 'EUR', senderDisplayName: '   ' }, 2],
      ['defaultTaxStatus', { ...BASE, currency: 'EUR', defaultTaxStatus: 'kaputt' }, 2],
      ['profile_schema_version', { ...BASE, currency: 'EUR' }, 99],
      ['profile_schema_version', { ...BASE, currency: 'EUR' }, -1],
      // Altclient (ohne Version) mit explizit ungueltigem Wert: ebenfalls abgelehnt, nichts bewahrt/ueberschrieben
      ['currency', { ...BASE, currency: 'CHF' }, undefined],
    ];
    for (const [field, payload, schema] of rejected) {
      const result = await upsert(clientOwner, payload, stableVersion, schema);
      expect(result.error?.message, `${field} ${JSON.stringify(payload[field] ?? schema)}`).toContain(`Firmenprofil ungueltig: ${field}`);
    }
    const after = await admin.from('workspace_company_profiles').select('payload,row_version').eq('workspace_id', ws).single();
    expect(after.data!.payload).toEqual(snapshot.data!.payload);
    expect(Number(after.data!.row_version)).toBe(stableVersion);

    // Member bleibt gesperrt — auch mit gueltigem Payload
    const member = await upsert(clientMember, { ...BASE, currency: 'EUR' }, stableVersion, 2);
    expect(member.error?.message).toContain('Keine Schreibberechtigung');

    // Anlegen (Insert-Pfad) wird ebenso validiert: neuer Workspace des Members mit ungueltiger Waehrung
    const { data: ownWs } = await clientMember.rpc('ensure_personal_workspace', { p_name: 'Member eigener WS' });
    const ownWsId = (ownWs as { workspace: { id: string } }).workspace.id;
    const insertInvalid = await clientMember.rpc('upsert_workspace_sync_entity', { p_workspace_id: ownWsId, p_entity_type: 'company_profile', p_payload: { payload: { ...BASE, currency: 'USD' }, profile_schema_version: 2 }, p_row_version: 0 });
    expect(insertInvalid.error?.message).toContain('Firmenprofil ungueltig: currency');
    const insertNull = await clientMember.rpc('upsert_workspace_sync_entity', { p_workspace_id: ownWsId, p_entity_type: 'company_profile', p_payload: { payload: { ...BASE, currency: 'EUR', replyToEmail: null }, profile_schema_version: 2 }, p_row_version: 0 });
    expect(insertNull.error).toBeNull();
    const created = await admin.from('workspace_company_profiles').select('payload').eq('workspace_id', ownWsId).single();
    expect('replyToEmail' in (created.data!.payload as object)).toBe(false);
    expect((created.data!.payload as Record<string, unknown>).currency).toBe('EUR');
  });
});
