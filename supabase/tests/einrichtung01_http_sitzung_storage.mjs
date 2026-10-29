// EINRICHTUNG-01 -- H-Nachweise ueber HTTP gegen den LOKALEN Stack (Kong 127.0.0.1:54321): echte GoTrue-Sitzungen,
// Storage-API und PostgREST. Katalog V3: Z-02.3, Z-04.5, Z-05.2, Z-05.4, M-10.1, A-04.1, A-05.1, A-05.2, A-05.3,
// K-03.2, K-03.4 (K-03.5: dieses Skript gibt weder Passwoerter noch Tokens aus).
//
// Nur lokal: Die API-Adresse muss 127.0.0.1/localhost sein, sonst Abbruch. Synthetische Konten (*-ein01h@example.invalid)
// werden ueber die Admin-API angelegt und am Ende samt Betrieben, Dateien und Objekten entfernt (Zeilenzahlen davor =
// danach fuer public, auth.users und storage.objects). Edge Functions laufen lokal nicht (eigener Treiber).
//
// Aufruf:  node supabase/tests/einrichtung01_http_sitzung_storage.mjs      Exit 0 = alle Faelle wie erwartet.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const CONTAINER = 'supabase_db_officepilot';

function statusEnv() {
  const r = spawnSync('npx supabase@2.117.0 status -o env', { encoding: 'utf8', shell: true });
  if (r.status !== 0) throw new Error('supabase status fehlgeschlagen');
  const env = {};
  for (const zeile of r.stdout.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(zeile.trim());
    if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return env;
}
const ENV = statusEnv();
const API = ENV.API_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(API ?? '')) throw new Error('Nur gegen den lokalen Stack');
const ANON = ENV.ANON_KEY;
const SERVICE = ENV.SERVICE_ROLE_KEY;

function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

async function http(pfad, { method = 'GET', token = null, body = undefined, roh = undefined, kopf = {}, schluessel = ANON } = {}) {
  const headers = { apikey: schluessel, ...kopf };
  if (token) headers.Authorization = `Bearer ${token}`;
  let daten = roh;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    daten = JSON.stringify(body);
  }
  const antwort = await fetch(`${API}${pfad}`, { method, headers, body: daten });
  const text = await antwort.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* kein JSON */
  }
  return { status: antwort.status, json, text };
}
const kurz = (r) => `${r.status} ${String(r.json?.error_code ?? r.json?.code ?? r.json?.error ?? r.json?.message ?? r.text ?? '').slice(0, 90)}`;

const ergebnisse = [];
function pruefe(name, ok, text) {
  ergebnisse.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FEHLZUSTAND'} ${name}: ${text}`);
}

function zeilenStand() {
  return psql(`
select string_agg(t.relname || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', t.nspname, t.relname), false, true, '')))[1]::text, ',' order by t.nspname, t.relname)
from (select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = 'users') or (n.nspname = 'storage' and c.relname = 'objects'))) t;`);
}

const W1 = '00000000-0000-0000-0000-0000000e4ba1';
const W2 = '00000000-0000-0000-0000-0000000e4ba2';
const W3 = '00000000-0000-0000-0000-0000000e4ba3';
const konten = {}; // name -> { id, email, passwort }
const neuesPasswort = () => `H-${randomBytes(12).toString('base64url')}-9a`;

async function kontoAnlegen(name) {
  const email = `${name}-ein01h@example.invalid`;
  const passwort = neuesPasswort();
  const r = await http('/auth/v1/admin/users', {
    method: 'POST',
    token: SERVICE,
    schluessel: SERVICE,
    body: { email, password: passwort, email_confirm: true, user_metadata: { firstName: name.toUpperCase(), lastName: 'EIN01H' } },
  });
  if (r.status !== 200 || !r.json?.id) throw new Error(`Konto ${name}: ${kurz(r)}`);
  konten[name] = { id: r.json.id, email, passwort };
  return konten[name];
}

async function anmelden(name, passwort = konten[name].passwort) {
  const r = await http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: konten[name].email, password: passwort } });
  return r.status === 200 ? { ok: true, access: r.json.access_token, refresh: r.json.refresh_token, status: r.status } : { ok: false, status: r.status, r };
}
const erneuern = (refresh) => http('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refresh } });
const rpc = (fn, args, token) => http(`/rest/v1/rpc/${fn}`, { method: 'POST', token, body: args });
const hochladen = (pfad, bytes, token) => http(`/storage/v1/object/workspace-files/${pfad}`, { method: 'POST', token, roh: bytes, kopf: { 'Content-Type': 'application/octet-stream' } });
const herunterladen = (pfad, token) => http(`/storage/v1/object/authenticated/workspace-files/${pfad}`, { token });

function objektPfad(ws, bytes) {
  return `${ws}/${createHash('sha256').update(bytes).digest('hex')}`;
}
function dateiZeile(ws, pfad, bytes, ersteller) {
  const sha = pfad.split('/')[1];
  psql(`insert into public.workspace_files (workspace_id, client_file_ref_id, content_sha256, size_bytes, mime_type, original_file_name, storage_path, created_by, uploaded_by)
        values ('${ws}', 'h-${sha.slice(0, 12)}', '${sha}', ${bytes.length}, 'application/octet-stream', 'h.bin', '${pfad}', '${ersteller}', '${ersteller}');`);
}
const angelegteObjekte = [];

async function aufraeumen() {
  if (angelegteObjekte.length > 0) {
    await http('/storage/v1/object/workspace-files', { method: 'DELETE', token: SERVICE, schluessel: SERVICE, body: { prefixes: angelegteObjekte } });
  }
  const ids = Object.values(konten).map((k) => `'${k.id}'`).join(', ') || `'00000000-0000-0000-0000-000000000000'`;
  psql(`
alter table public.workspace_member_events disable trigger einrichtung01_audit_immutable;
alter table public.platform_admin_events disable trigger einrichtung01_audit_immutable;
do $$
declare t record; w record; v_rest int; v_runde int;
begin
  for w in select id from public.workspaces where id in ('${W1}', '${W2}', '${W3}') or owner_user_id in (${ids}) loop
    v_rest := 1; v_runde := 0;
    while v_rest > 0 and v_runde < 8 loop
      v_rest := 0; v_runde := v_runde + 1;
      for t in select c.table_name from information_schema.columns c
               join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
               where c.table_schema = 'public' and c.column_name = 'workspace_id' loop
        begin
          execute format('delete from public.%I where workspace_id = %L', t.table_name, w.id);
        exception when foreign_key_violation then v_rest := v_rest + 1;
        end;
      end loop;
    end loop;
    delete from public.workspaces where id = w.id;
  end loop;
  delete from public.platform_admin_events where actor_user_id in (${ids}) or target_user_id in (${ids});
  delete from public.einrichtung_request_log where actor_user_id in (${ids});
  delete from public.workspace_members where user_id in (${ids});
end $$;
alter table public.workspace_member_events enable trigger einrichtung01_audit_immutable;
alter table public.platform_admin_events enable trigger einrichtung01_audit_immutable;`);
  for (const k of Object.values(konten)) {
    await http(`/auth/v1/admin/users/${k.id}`, { method: 'DELETE', token: SERVICE, schluessel: SERVICE });
  }
}

const davor = zeilenStand();
let exitCode = 0;
try {
  for (const name of ['o1', 'm1', 'l1', 'p1', 's1', 'k1']) await kontoAnlegen(name);
  const id = (n) => konten[n].id;
  psql(`
update public.profiles set status = 'approved' where id in ('${id('o1')}', '${id('m1')}', '${id('l1')}', '${id('s1')}', '${id('k1')}');
update public.profiles set license_status = 'active', license_expires_at = null where id in ('${id('o1')}', '${id('s1')}', '${id('k1')}');
update public.profiles set license_status = 'expired' where id = '${id('l1')}';
insert into public.workspaces (id, name, owner_user_id) values ('${W1}', 'H W1', '${id('o1')}'), ('${W2}', 'H W2', '${id('l1')}'), ('${W3}', 'H W3', '${id('s1')}');
insert into public.workspace_members (workspace_id, user_id, role, status) values
  ('${W1}', '${id('o1')}', 'owner', 'active'), ('${W1}', '${id('m1')}', 'member', 'active'),
  ('${W2}', '${id('l1')}', 'owner', 'active'), ('${W3}', '${id('s1')}', 'owner', 'active');`);

  /* ---------------- Storage: Z-04.5, Z-02.3, Z-05.2, Z-05.4 ---------------- */
  const o1 = await anmelden('o1');
  const p1 = await anmelden('p1');
  const l1 = await anmelden('l1');
  const m1 = await anmelden('m1');
  if (![o1, p1, l1, m1].every((s) => s.ok)) throw new Error('Anmeldung der Testkonten fehlgeschlagen');

  const bytesO1 = Buffer.from(`EIN01 H O1 ${randomBytes(8).toString('hex')}`);
  const pfadO1 = objektPfad(W1, bytesO1);
  const upO1 = await hochladen(pfadO1, bytesO1, o1.access);
  angelegteObjekte.push(pfadO1);
  dateiZeile(W1, pfadO1, bytesO1, id('o1'));
  const downO1 = await herunterladen(pfadO1, o1.access);
  pruefe('Z-04.5 O1 Upload und Download', upO1.status === 200 && downO1.status === 200 && downO1.text === bytesO1.toString(), `Upload ${kurz(upO1)}, Download ${downO1.status}, Inhalt ${downO1.text === bytesO1.toString() ? 'gleich' : 'abweichend'}`);

  const bytesP1 = Buffer.from(`EIN01 H P1 ${randomBytes(8).toString('hex')}`);
  const pfadP1 = objektPfad(W1, bytesP1);
  const upP1 = await hochladen(pfadP1, bytesP1, p1.access);
  if (upP1.status === 200) angelegteObjekte.push(pfadP1);
  const downP1 = await herunterladen(pfadO1, p1.access);
  pruefe('Z-02.3 P1 (wartend) Upload und Download', upP1.status >= 400 && downP1.status >= 400, `Upload ${kurz(upP1)}, Download ${kurz(downP1)}`);

  const bytesW2 = Buffer.from(`EIN01 H W2 ${randomBytes(8).toString('hex')}`);
  const pfadW2 = objektPfad(W2, bytesW2);
  const upFixture = await http(`/storage/v1/object/workspace-files/${pfadW2}`, { method: 'POST', token: SERVICE, schluessel: SERVICE, roh: bytesW2, kopf: { 'Content-Type': 'application/octet-stream' } });
  angelegteObjekte.push(pfadW2);
  dateiZeile(W2, pfadW2, bytesW2, id('l1'));
  const downL1 = await herunterladen(pfadW2, l1.access);
  pruefe('Z-05.2 L1 (Lizenz abgelaufen) Download', upFixture.status === 200 && downL1.status === 200 && downL1.text === bytesW2.toString(), `Fixture ${upFixture.status}, Download ${downL1.status}`);

  const bytesL1 = Buffer.from(`EIN01 H L1 ${randomBytes(8).toString('hex')}`);
  const pfadL1 = objektPfad(W2, bytesL1);
  const upL1 = await hochladen(pfadL1, bytesL1, l1.access);
  if (upL1.status === 200) angelegteObjekte.push(pfadL1);
  pruefe('Z-05.4 L1 Upload', upL1.status >= 400, `Upload ${kurz(upL1)}`);

  /* ---------------- M-10.1 Entzug: danach RPC, Abzug und Download abgewiesen ---------------- */
  const bytesM1 = Buffer.from(`EIN01 H M1 ${randomBytes(8).toString('hex')}`);
  const pfadM1 = objektPfad(W1, bytesM1);
  const upM1 = await hochladen(pfadM1, bytesM1, m1.access);
  angelegteObjekte.push(pfadM1);
  dateiZeile(W1, pfadM1, bytesM1, id('m1'));
  const vorherDown = await herunterladen(pfadM1, m1.access);
  const vorherPull = await rpc('pull_workspace_sync_state', { p_workspace_id: W1 }, m1.access);
  const entfernt = await rpc('team_remove_member', { p_workspace_id: W1, p_target_user_id: id('m1'), p_request_id: crypto.randomUUID() }, o1.access);
  const nachPull = await rpc('pull_workspace_sync_state', { p_workspace_id: W1 }, m1.access);
  const nachZugriff = await rpc('get_workspace_access', { p_workspace_id: W1 }, m1.access);
  const nachDown = await herunterladen(pfadM1, m1.access);
  const nachSelect = await http(`/rest/v1/workspace_files?workspace_id=eq.${W1}&select=id`, { token: m1.access });
  pruefe('M-10.1 Entzug wirkt beim naechsten Serveraufruf',
    upM1.status === 200 && vorherDown.status === 200 && vorherPull.status === 200 && entfernt.status === 200 &&
      nachPull.status >= 400 && nachZugriff.status >= 400 && nachDown.status >= 400 && nachSelect.status === 200 && Array.isArray(nachSelect.json) && nachSelect.json.length === 0,
    `vorher Upload ${upM1.status}/Download ${vorherDown.status}/Abzug ${vorherPull.status}; entfernt ${entfernt.status}; danach Abzug ${kurz(nachPull)}, Zugriff ${kurz(nachZugriff)}, Download ${kurz(nachDown)}, Tabelle ${nachSelect.status} mit ${Array.isArray(nachSelect.json) ? nachSelect.json.length : '?'} Zeilen`);

  /* ---------------- A-04.1 lokal abmelden ---------------- */
  {
    const a = await anmelden('s1');
    const b = await anmelden('s1');
    const aus = await http('/auth/v1/logout?scope=local', { method: 'POST', token: a.access });
    const ra = await erneuern(a.refresh);
    const rb = await erneuern(b.refresh);
    pruefe('A-04.1 lokal abmelden', aus.status === 204 && ra.status >= 400 && rb.status === 200, `Abmelden ${aus.status}; Refresh Sitzung 1 ${kurz(ra)}; Sitzung 2 ${rb.status}`);
  }

  /* ---------------- A-05.1 bis A-05.3 auf allen Geraeten abmelden ---------------- */
  {
    const bytesS1 = Buffer.from(`EIN01 H S1 ${randomBytes(8).toString('hex')}`);
    const pfadS1 = objektPfad(W3, bytesS1);
    const a = await anmelden('s1');
    const b = await anmelden('s1');
    const upS1 = await hochladen(pfadS1, bytesS1, b.access);
    angelegteObjekte.push(pfadS1);
    dateiZeile(W3, pfadS1, bytesS1, id('s1'));
    const vorherRpc = await rpc('get_workspace_access', { p_workspace_id: W3 }, b.access);
    const vorherDown = await herunterladen(pfadS1, b.access);
    const aus = await http('/auth/v1/logout?scope=global', { method: 'POST', token: a.access });
    const ra = await erneuern(a.refresh);
    const rb = await erneuern(b.refresh);
    pruefe('A-05.1 auf allen Geraeten abmelden', aus.status === 204 && ra.status >= 400 && rb.status >= 400, `Abmelden ${aus.status}; Refresh Sitzung 1 ${kurz(ra)}; Sitzung 2 ${kurz(rb)}`);

    const nachRpc = await rpc('get_workspace_access', { p_workspace_id: W3 }, b.access);
    const nachDown = await herunterladen(pfadS1, b.access);
    const nachTabelle = await http(`/rest/v1/workspace_files?workspace_id=eq.${W3}&select=id`, { token: b.access });
    pruefe('A-05.2 Zugriffstoken der anderen Sitzung sofort abgewiesen (DB, RPC, Storage)',
      upS1.status === 200 && vorherRpc.status === 200 && vorherDown.status === 200 && nachRpc.status >= 400 && /session_not_active/.test(nachRpc.text) && nachDown.status >= 400 && (nachTabelle.status >= 400 || (Array.isArray(nachTabelle.json) && nachTabelle.json.length === 0)),
      `vorher RPC ${vorherRpc.status}/Download ${vorherDown.status}; danach RPC ${kurz(nachRpc)}, Download ${kurz(nachDown)}, Tabelle ${nachTabelle.status}${Array.isArray(nachTabelle.json) ? ` (${nachTabelle.json.length} Zeilen)` : ` ${kurz(nachTabelle)}`}`);

    const nutzer = await http('/auth/v1/user', { token: b.access });
    const kopf = JSON.parse(Buffer.from(b.access.split('.')[1], 'base64url').toString('utf8'));
    const rest = kopf.exp - Math.floor(Date.now() / 1000);
    pruefe('A-05.3 Auth-Endpunkt und Restlaufzeit (gemessen)', kopf.exp - kopf.iat <= 3600 && rest <= 3600,
      `GET /auth/v1/user mit dem alten Token: ${kurz(nutzer)}; Tokenlaufzeit ${kopf.exp - kopf.iat} s, Rest bei der Messung ${rest} s (Datenbank, RPC und Storage weisen sofort ab, siehe A-05.2)`);
  }

  /* ---------------- K-03.2 und K-03.4 Passwortwechsel ---------------- */
  {
    const altes = konten.k1.passwort;
    const a = await anmelden('k1');
    const b = await anmelden('k1');
    const neues = neuesPasswort();
    const wechsel = await http('/auth/v1/user', { method: 'PUT', token: a.access, body: { password: neues } });
    const andere = await http('/auth/v1/logout?scope=others', { method: 'POST', token: a.access });
    const ra = await erneuern(a.refresh);
    const rb = await erneuern(b.refresh);
    const mitAltem = await anmelden('k1', altes);
    const mitNeuem = await anmelden('k1', neues);
    konten.k1.passwort = neues;
    pruefe('K-03.2 das neue Passwort gilt, das alte nicht', wechsel.status === 200 && !mitAltem.ok && mitNeuem.ok, `Wechsel ${wechsel.status}; Anmeldung alt ${mitAltem.ok ? 'gelingt' : mitAltem.status}, neu ${mitNeuem.ok ? 'gelingt' : mitNeuem.status}`);
    pruefe('K-03.4 andere Sitzungen abgemeldet, diese bleibt', andere.status === 204 && ra.status === 200 && rb.status >= 400, `Abmelden der anderen ${andere.status}; Refresh diese Sitzung ${ra.status}, andere ${kurz(rb)}`);
  }
} catch (error) {
  console.error(error?.message ?? error);
  exitCode = 1;
} finally {
  await aufraeumen();
}

const danach = zeilenStand();
pruefe('Aufraeumen (Zeilen davor = danach: public, auth.users, storage.objects)', davor === danach, davor === danach ? 'unveraendert' : 'Abweichung');
if (exitCode !== 0 || ergebnisse.some((e) => !e.ok)) process.exit(1);
