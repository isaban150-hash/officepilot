// EINRICHTUNG-01 -- H-Nachweise gegen LOKALE Edge Functions (Kong 127.0.0.1:54321/functions/v1, gestartet mit
// `npx supabase@2.117.0 functions serve --env-file <Platzhalterdatei>`: MAIL_PROVIDER stub bzw. brevo OHNE Schluessel,
// kein GEMINI_API_KEY, Microsoft-OAuth nur mit Platzhaltern). Katalog V3: Z-02.2, Z-04.7, Z-04.8, Z-05.6, M-17.1,
// M-17.3 (Modus „providerfehler“), dazu Linkbasis und fremdes Konto bei der Einladungsmail.
//
// Kein externer Aufruf: stub versendet nichts; brevo ohne Schluessel bricht vor jedem Aufruf ab; ohne Gemini-Schluessel
// endet die KI nach der Autorisierung; der Postfach-Start baut nur die Autorisierungsadresse. Synthetische Konten werden
// am Ende entfernt (Zeilenzahlen davor = danach). Das Skript gibt weder Passwoerter noch Tokens aus.
//
// Aufruf:  node supabase/tests/einrichtung01_http_edge.mjs [stub|providerfehler]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const MODUS = process.argv[2] ?? 'stub';
if (!['stub', 'providerfehler'].includes(MODUS)) throw new Error('Modus stub|providerfehler');
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

async function http(pfad, { method = 'GET', token = null, body = undefined, schluessel = ANON } = {}) {
  const headers = { apikey: schluessel };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const antwort = await fetch(`${API}${pfad}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await antwort.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* kein JSON */
  }
  return { status: antwort.status, json, text };
}
const kurz = (r) => `${r.status} ${String(r.json?.error ?? r.json?.reason ?? r.json?.error_code ?? r.json?.message ?? r.text ?? '').slice(0, 80)}`;

const ergebnisse = [];
function pruefe(name, ok, text) {
  ergebnisse.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FEHLZUSTAND'} ${name}: ${text}`);
}

function zeilenStand() {
  return psql(`
select string_agg(t.relname || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', t.nspname, t.relname), false, true, '')))[1]::text, ',' order by t.nspname, t.relname)
from (select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = 'users'))) t;`);
}

const W1 = '00000000-0000-0000-0000-0000000e4ea1';
const W2 = '00000000-0000-0000-0000-0000000e4ea2';
const konten = {};

async function kontoAnlegen(name) {
  const email = `${name}-ein01e@example.invalid`;
  const passwort = `E-${randomBytes(12).toString('base64url')}-7b`;
  const r = await http('/auth/v1/admin/users', {
    method: 'POST',
    token: SERVICE,
    schluessel: SERVICE,
    body: { email, password: passwort, email_confirm: true, user_metadata: { firstName: name.toUpperCase(), lastName: 'EIN01E' } },
  });
  if (r.status !== 200 || !r.json?.id) throw new Error(`Konto ${name}: ${r.status}`);
  konten[name] = { id: r.json.id, email, passwort };
}
async function anmelden(name) {
  const r = await http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: konten[name].email, password: konten[name].passwort } });
  if (r.status !== 200) throw new Error(`Anmeldung ${name}: ${r.status}`);
  return r.json.access_token;
}
const fn = (name, body, token) => http(`/functions/v1/${name}`, { method: 'POST', token, body });

async function aufraeumen() {
  const ids = Object.values(konten).map((k) => `'${k.id}'`).join(', ') || `'00000000-0000-0000-0000-000000000000'`;
  psql(`
alter table public.workspace_member_events disable trigger einrichtung01_audit_immutable;
do $$
declare t record; w record; v_rest int; v_runde int;
begin
  for w in select id from public.workspaces where id in ('${W1}', '${W2}') or owner_user_id in (${ids}) loop
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
  delete from public.einrichtung_request_log where actor_user_id in (${ids});
  delete from public.workspace_invitation_attempts where user_id in (${ids});
  delete from public.ai_usage_counters where user_id in (${ids});
  delete from public.workspace_members where user_id in (${ids});
end $$;
alter table public.workspace_member_events enable trigger einrichtung01_audit_immutable;`);
  for (const k of Object.values(konten)) {
    await http(`/auth/v1/admin/users/${k.id}`, { method: 'DELETE', token: SERVICE, schluessel: SERVICE });
  }
}

const davor = zeilenStand();
let exitCode = 0;
try {
  const vorab = await http('/functions/v1/ai', { method: 'OPTIONS' });
  if (vorab.status !== 200) throw new Error(`Edge-Laufzeit nicht erreichbar (${vorab.status})`);

  for (const name of ['o1', 'p1', 'l1']) await kontoAnlegen(name);
  const id = (n) => konten[n].id;
  psql(`
update public.profiles set status = 'approved' where id in ('${id('o1')}', '${id('l1')}');
update public.profiles set license_status = 'active', license_expires_at = null where id = '${id('o1')}';
update public.profiles set license_status = 'expired' where id = '${id('l1')}';
insert into public.workspaces (id, name, owner_user_id) values ('${W1}', 'E W1', '${id('o1')}'), ('${W2}', 'E W2', '${id('l1')}');
insert into public.workspace_members (workspace_id, user_id, role, status) values
  ('${W1}', '${id('o1')}', 'owner', 'active'), ('${W2}', '${id('l1')}', 'owner', 'active');`);
  const o1 = await anmelden('o1');
  const p1 = await anmelden('p1');
  const l1 = await anmelden('l1');

  // Einladung von O1 (Token nur im Speicher dieses Skripts)
  const einladung = await http('/rest/v1/rpc/team_invite', {
    method: 'POST',
    token: o1,
    body: { p_workspace_id: W1, p_email: 'gast-ein01e@example.invalid', p_role: 'member', p_request_id: crypto.randomUUID() },
  });
  if (einladung.status !== 200 || !einladung.json?.token) throw new Error(`Einladung: ${einladung.status}`);
  const mail = { invitationId: einladung.json.invitation_id, token: einladung.json.token, language: 'de', linkBase: 'http://127.0.0.1:5235' };

  if (MODUS === 'providerfehler') {
    const r = await fn('send-team-invitation', mail, o1);
    pruefe('M-17.3 Providerfehler (brevo ohne Schluessel)', r.status === 200 && r.json?.ok === true && r.json?.sent === false && Boolean(r.json?.reason), `Antwort ${r.status} ${JSON.stringify(r.json)}`);
  } else {
    /* ---------------- KI: Z-02.2, Z-04.8, Z-05.6 ---------------- */
    const frage = (ws) => ({ operation: 'document_question', workspaceId: ws, prompt: 'Worum geht es in diesem Testtext?' });
    const ohne = await http('/functions/v1/ai', { method: 'POST', body: frage(W1) });
    const kiP1 = await fn('ai', frage(W1), p1);
    const kiO1 = await fn('ai', frage(W1), o1);
    pruefe('Z-02.2 P1 (wartend) KI', kiP1.status === 403, `ohne Anmeldung ${kurz(ohne)}; P1 ${kurz(kiP1)}`);
    pruefe('Z-04.8 O1 KI: Autorisierung gelingt, danach „nicht konfiguriert“ (kein Gemini-Schluessel)',
      ohne.status === 401 && kiP1.status === 403 && kiO1.status >= 500 && kiO1.json?.error === 'server_misconfigured',
      `ohne Anmeldung ${kurz(ohne)}, P1 ${kurz(kiP1)}, O1 ${kurz(kiO1)} (Nachweisgrenze: der Gemini-Aufruf selbst ist lokal nicht pruefbar)`);
    const kiL1 = await fn('ai', frage(W2), l1);

    /* ---------------- Postfach-Start: Z-04.7, Z-05.6 ---------------- */
    const start = (ws) => ({ workspaceId: ws, provider: 'microsoft_graph', expectedAddress: 'postfach-ein01e@example.invalid' });
    const startO1 = await fn('mailbox-oauth-start', start(W1), o1);
    const adresse = String(startO1.json?.authorizeUrl ?? startO1.json?.authorizationUrl ?? startO1.json?.url ?? '');
    pruefe('Z-04.7 O1 Postfach-Start', startO1.status === 200 && /^https:\/\/login\.microsoftonline\.com\//.test(adresse),
      `${startO1.status}; Autorisierungsadresse ${adresse ? new URL(adresse).origin + new URL(adresse).pathname : 'fehlt'} (nur gebaut, kein externer Aufruf)`);
    const startL1 = await fn('mailbox-oauth-start', start(W2), l1);
    const syncL1 = await fn('sync-mailbox', { workspaceId: W2, connectionId: crypto.randomUUID() }, l1);
    // Die KI meldet den Grund mit ihrem Vertragscode: license_not_effective -> license_inactive (aiContract.ts).
    pruefe('Z-05.6 L1: KI, Postfach-Start, sync-mailbox abgewiesen',
      kiL1.status === 403 && kiL1.json?.error === 'license_inactive' && startL1.status === 403 && syncL1.status === 403 && [startL1, syncL1].every((r) => r.json?.error === 'license_not_effective'),
      `KI ${kurz(kiL1)}, Postfach-Start ${kurz(startL1)}, sync-mailbox ${kurz(syncL1)}`);

    /* ---------------- Einladungsmail: M-17.1 und Grenzen ---------------- */
    const gesendet = await fn('send-team-invitation', mail, o1);
    const fremdeBasis = await fn('send-team-invitation', { ...mail, linkBase: 'https://fremd.example' }, o1);
    const fremdesKonto = await fn('send-team-invitation', mail, p1);
    pruefe('M-17.1 Einladungsmail ueber stub', gesendet.status === 200 && gesendet.json?.ok === true && gesendet.json?.sent === true, `Antwort ${gesendet.status} ${JSON.stringify(gesendet.json)}`);
    pruefe('M-17 Linkbasis ausserhalb APP_ALLOWED_ORIGINS abgewiesen', fremdeBasis.status === 400 && fremdeBasis.json?.error === 'link_not_allowed', kurz(fremdeBasis));
    pruefe('M-17 fremdes Konto bekommt keinen Mailkontext', fremdesKonto.status === 403 && fremdesKonto.json?.error === 'forbidden', kurz(fremdesKonto));
  }
} catch (error) {
  console.error(error?.message ?? error);
  exitCode = 1;
} finally {
  await aufraeumen();
}

const danach = zeilenStand();
pruefe('Aufraeumen (Zeilen davor = danach: public, auth.users)', davor === danach, davor === danach ? 'unveraendert' : 'Abweichung');
if (exitCode !== 0 || ergebnisse.some((e) => !e.ok)) process.exit(1);
