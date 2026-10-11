// GO-LIVE-SECURITY-01 / FINALISIERUNG -- Wettläufe zwischen zwei Sitzungen.
//
// Nur gegen die LOKALE Datenbank (Docker-Container supabase_db_officepilot),
// niemals remote. Legt einen eigenen synthetischen Betrieb an und entfernt ihn
// am Ende wieder (nur, was dieses Skript angelegt hat).
//
//   R1  Inhaber bindet die XRechnung an eine Datei, während ein Mitglied die
//       Angaben derselben Datei ändert: Das Mitglied wartet auf den Inhaber und
//       wird danach abgewiesen (42501); die Datei bleibt XML.
//   R2  Ein Mitglied ändert die Datei zuerst (PDF), der Inhaber bindet
//       gleichzeitig: Der Inhaber wartet und wird danach abgewiesen
//       (Dateityp passt nicht); keine Bindung entsteht.
//
// Aufruf:  node supabase/tests/go_live_security_01_race.mjs
//          node supabase/tests/go_live_security_01_race.mjs --gegenprobe
// Mit --gegenprobe läuft zusätzlich derselbe Wettlauf gegen eine Fassung des
// Bindungswächters ohne FOR SHARE (wird danach wiederhergestellt und per
// Prüfsumme kontrolliert): Dort entsteht der Fehlzustand.
import { spawn, spawnSync } from 'node:child_process';

const CONTAINER = 'supabase_db_officepilot';
const WS = '00000000-0000-0000-0000-000000f2ac01';
const INHABER = '00000000-0000-0000-0000-000000f2a001';
const MITGLIED = '00000000-0000-0000-0000-000000f2a003';
const HASH1 = '1'.repeat(64);
const HASH2 = '2'.repeat(64);
const gegenprobe = process.argv.includes('--gegenprobe');

function psql(sql, { erlaubeFehler = false } = {}) {
  const lauf = spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
  });
  if (lauf.status !== 0 && !erlaubeFehler) throw new Error(`psql: ${lauf.stderr || lauf.stdout}`);
  return lauf.stdout.trim();
}

function sitzung(sql) {
  return new Promise((resolve) => {
    const start = Date.now();
    const kind = spawn('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1']);
    let ausgabe = '';
    kind.stdout.on('data', (d) => { ausgabe += d; });
    kind.stderr.on('data', (d) => { ausgabe += d; });
    kind.on('close', (code) => resolve({ code, ms: Date.now() - start, ausgabe }));
    kind.stdin.end(sql);
  });
}

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const als = (nutzer) =>
  `select set_config('request.jwt.claims', '{"sub":"${nutzer}","role":"authenticated"}', true);\nset local role authenticated;\n`;
const bindung = (dokument, datei) =>
  `select public.upsert_workspace_intake_entity('${WS}', 'document_file_binding', jsonb_build_object(` +
  `'binding_id','${dokument}|structured|xrechnung-cii','client_document_id','${dokument}','client_file_ref_id','${datei}',` +
  `'binding_kind','structured','part','xrechnung-cii','provenance','derived'), 0);\n`;
const dateiAendern = (datei, hash) =>
  `select public.upsert_workspace_intake_entity('${WS}', 'document_file', jsonb_build_object(` +
  `'client_file_ref_id','${datei}','content_sha256','${hash}','size_bytes',10,'mime_type','application/pdf','original_file_name','umgetypt.pdf'), 1);\n`;

function aufbauen() {
  psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('${INHABER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'inhaber-race@example.invalid', 'x', now(), now(), now(), '{}', '{}'),
       ('${MITGLIED}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mitglied-race@example.invalid', 'x', now(), now(), now(), '{}', '{}');
update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null where id in ('${INHABER}', '${MITGLIED}');
insert into public.workspaces (id, name, owner_user_id) values ('${WS}', 'Race', '${INHABER}');
insert into public.workspace_members (workspace_id, user_id, role, status) values ('${WS}', '${INHABER}', 'owner', 'active'), ('${WS}', '${MITGLIED}', 'member', 'active');
insert into public.workspace_invoices (workspace_id, vorgang_id, client_invoice_id, invoice_number, invoice_year, invoice_sequence_number, invoice_type, invoice_status, payload)
values ('${WS}', null, 'inv-r', '2026-9501', 2026, 9501, 'rechnung', 'vorbereitet', '{"status":"vorbereitet","servicePeriodConfirmed":true}'),
       ('${WS}', null, 'inv-r2', '2026-9502', 2026, 9502, 'rechnung', 'vorbereitet', '{"status":"vorbereitet","servicePeriodConfirmed":true}');
insert into public.workspace_documents (workspace_id, client_document_id, document_kind, linked_invoice_id, payload, created_by)
values ('${WS}', 'doc-r', 'generated_invoice', 'inv-r', '{}', '${INHABER}'),
       ('${WS}', 'doc-r2', 'generated_invoice', 'inv-r2', '{}', '${INHABER}');
insert into public.workspace_files (workspace_id, client_file_ref_id, content_sha256, size_bytes, mime_type, storage_path, created_by, uploaded_by)
values ('${WS}', 'file-r1', '${HASH1}', 10, 'application/xml', '${WS}/${HASH1}', '${MITGLIED}', '${MITGLIED}'),
       ('${WS}', 'file-r2', '${HASH2}', 10, 'application/xml', '${WS}/${HASH2}', '${MITGLIED}', '${MITGLIED}');
commit;`);
}

function zuruecksetzen() {
  psql(`begin;
delete from public.workspace_document_file_bindings where workspace_id = '${WS}';
delete from public.workspace_files where workspace_id = '${WS}';
delete from public.workspace_documents where workspace_id = '${WS}';
delete from public.workspace_invoices where workspace_id = '${WS}';
delete from public.workspace_members where workspace_id = '${WS}';
delete from public.workspaces where id = '${WS}';
delete from auth.users where id in ('${INHABER}', '${MITGLIED}');
commit;`, { erlaubeFehler: true });
}

function zustand() {
  return psql(`select coalesce((select mime_type from public.workspace_files where workspace_id = '${WS}' and client_file_ref_id = 'file-r1'), '-')
  || '|' || coalesce((select mime_type from public.workspace_files where workspace_id = '${WS}' and client_file_ref_id = 'file-r2'), '-')
  || '|' || coalesce((select client_file_ref_id from public.workspace_document_file_bindings where workspace_id = '${WS}' and client_document_id = 'doc-r'), '-')
  || '|' || coalesce((select client_file_ref_id from public.workspace_document_file_bindings where workspace_id = '${WS}' and client_document_id = 'doc-r2'), '-');`);
}

async function r1() {
  const a = sitzung(`begin;\n${als(INHABER)}${bindung('doc-r', 'file-r1')}select pg_sleep(3);\ncommit;\n`);
  await warte(1000);
  const b = await sitzung(`begin;\n${als(MITGLIED)}${dateiAendern('file-r1', HASH1)}commit;\n`);
  const ea = await a;
  return { a: ea, b, zustand: zustand() };
}

async function r2() {
  const a = sitzung(`begin;\n${als(MITGLIED)}${dateiAendern('file-r2', HASH2)}select pg_sleep(3);\ncommit;\n`);
  await warte(1000);
  const b = await sitzung(`begin;\n${als(INHABER)}${bindung('doc-r2', 'file-r2')}commit;\n`);
  const ea = await a;
  return { a: ea, b, zustand: zustand() };
}

const kurz = (t) => (t.split('\n').find((z) => z.startsWith('ERROR:')) ?? 'ohne Fehler').slice(0, 110);
let fehler = 0;
function pruefe(label, bedingung, info) {
  console.log(`${bedingung ? 'OK ' : 'XX '} ${label}${info ? ` -- ${info}` : ''}`);
  if (!bedingung) fehler += 1;
}

async function laufe(fassung) {
  zuruecksetzen();
  aufbauen();
  try {
    const e1 = await r1();
    const e2 = await r2();
    return { e1, e2 };
  } finally {
    zuruecksetzen();
  }
}

const original = psql(`select pg_get_functiondef('public.workspace_einvoice_binding_write_guard()'::regprocedure);`);
const originalMd5 = psql(`select md5(prosrc) from pg_proc where oid = 'public.workspace_einvoice_binding_write_guard()'::regprocedure;`);
if (!original.includes('for share')) {
  console.log('XX  Der lokale Bindungswächter enthält kein FOR SHARE -- ist 20261107120000 lokal eingespielt?');
  process.exit(1);
}

const mit = await laufe('mit Sperre');
pruefe('R1 Mitglied wartet auf den Inhaber', mit.e1.b.ms >= 1500, `${mit.e1.b.ms} ms`);
pruefe('R1 Inhaber bindet', mit.e1.a.code === 0, kurz(mit.e1.a.ausgabe));
pruefe('R1 Mitglied danach abgewiesen', mit.e1.b.code !== 0 && mit.e1.b.ausgabe.includes('Keine Schreibberechtigung'), kurz(mit.e1.b.ausgabe));
pruefe('R1 Datei bleibt XML, Bindung steht', mit.e1.zustand.startsWith('application/xml|') && mit.e1.zustand.split('|')[2] === 'file-r1', mit.e1.zustand);
pruefe('R2 Inhaber wartet auf das Mitglied', mit.e2.b.ms >= 1500, `${mit.e2.b.ms} ms`);
pruefe('R2 Mitglied ändert seine Datei', mit.e2.a.code === 0, kurz(mit.e2.a.ausgabe));
pruefe('R2 Inhaber danach abgewiesen (Dateityp)', mit.e2.b.code !== 0 && mit.e2.b.ausgabe.includes('Dateityp passt nicht'), kurz(mit.e2.b.ausgabe));
pruefe('R2 keine Bindung an die PDF-Datei', mit.e2.zustand.split('|')[1] === 'application/pdf' && mit.e2.zustand.split('|')[3] === '-', mit.e2.zustand);

if (gegenprobe) {
  console.log('--- Gegenprobe: Bindungswächter ohne FOR SHARE (vorübergehend)');
  const ohne = original.replaceAll('\n  for share;', ';');
  try {
    psql(`${ohne};`);
    const ohneSperre = await laufe('ohne Sperre');
    pruefe('G-R1 ohne Sperre wartet das Mitglied nicht', ohneSperre.e1.b.ms < 1500, `${ohneSperre.e1.b.ms} ms`);
    pruefe('G-R1 ohne Sperre entsteht der Fehlzustand (XRechnung an PDF-Datei)',
      ohneSperre.e1.zustand.startsWith('application/pdf|') && ohneSperre.e1.zustand.split('|')[2] === 'file-r1', ohneSperre.e1.zustand);
    pruefe('G-R2 ohne Sperre entsteht der Fehlzustand (XRechnung an PDF-Datei)',
      ohneSperre.e2.zustand.split('|')[1] === 'application/pdf' && ohneSperre.e2.zustand.split('|')[3] === 'file-r2', ohneSperre.e2.zustand);
  } finally {
    psql(`${original};`);
    const wieder = psql(`select md5(prosrc) from pg_proc where oid = 'public.workspace_einvoice_binding_write_guard()'::regprocedure;`);
    pruefe('Bindungswächter wiederhergestellt (Prüfsumme)', wieder === originalMd5, wieder);
  }
}

const rest = psql(`select count(*) from public.workspaces where id = '${WS}';`);
pruefe('Aufgeräumt: kein Testbetrieb zurückgeblieben', rest === '0');
process.exit(fehler ? 1 : 0);
