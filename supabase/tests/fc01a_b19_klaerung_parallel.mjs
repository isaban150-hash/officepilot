// FINANZ-CORE-01A -- Restnacharbeit nach WEISS-Bericht 18, END18-R1: die Klaerung der Fristgrundlage ist bei
// Wiederholung und Parallelitaet idempotent und eindeutig entschieden (Migration 20261122120000).
//
// Nur gegen die LOKALE Datenbank (Docker-Container supabase_db_officepilot), niemals remote. Legt einen
// eigenen synthetischen Betrieb an und entfernt ihn am Ende wieder (Zeilenzahlen davor = danach).
//
// Abschlag 400/476 (19 %), 2 % Skonto in 10 Tagen ab 25.05.2026, Grenz-PLZ 48431 (NI+NW), Zahlung 466,48 am
// Fr 05.06. -> ungeklaert. A haelt seine Transaktion jeweils 2 s offen, B startet nach 0,5 s.
//
//   L1  WEISS K7: A klaert NW mit Kennung X, B sendet dieselbe Kennung mit demselben Inhalt: B wartet, dann
//       erfolgreiche Wiederholung -- genau eine Protokollzeile, genau eine Versionsaenderung.
//   L2  Dieselbe Kennung mit anderem Inhalt (andere Grundlage): B wartet, dann invoice_frist_klaerung_conflict.
//   L3  Dieselbe Kennung an einer anderen Rechnung: B wartet am eindeutigen Schluessel, dann Konflikt (kein 23505).
//   L4  Zwei verschiedene bewusste Klaerungen derselben Rechnung (NI, dann NW): beide angenommen, nacheinander,
//       beide protokolliert; die zweite traegt als Lage vorher die der ersten.
//   L5  Verlorene Antwort: dieselbe Kennung nach dem Festschreiben erneut -> Erfolg, keine zweite Zeile, Version gleich.
//
// Aufruf:  node supabase/tests/fc01a_b19_klaerung_parallel.mjs
// Exit 0 = alle Wettlaeufe ohne Fehlzustand.
import { spawn, spawnSync } from 'node:child_process';

const CONTAINER = 'supabase_db_officepilot';
const WS = '00000000-0000-0000-0000-00000000fe32';
const NUTZER = '00000000-0000-0000-0000-0000000fe321';
const SKONTO = 'Bei Zahlung innerhalb von 10 Tagen ab Rechnungsdatum gewähren wir 2 % Skonto.';

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
    kind.on('close', (code) => resolve({ code, ms: Date.now() - start, ausgabe: ausgabe.trim() }));
    kind.stdin.end(sql);
  });
}

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const lit = (wert) => `'${String(wert).replace(/'/g, "''")}'`;
const json = (wert) => `${lit(JSON.stringify(wert))}::jsonb`;
const ALS = `select set_config('request.jwt.claims', '{"sub":"${NUTZER}","role":"authenticated"}', true);\n`;

const ANSCHRIFT = { name: 'Rheine GmbH', street: 'Weg 1', zip: '48431', city: 'Rheine' };
const AUFTRAG = {
  customerId: 'cust-grenz', customerBilling: ANSCHRIFT, title: 'FC01A B19 Klaerung parallel', baustelle: '', taxStatus: 'standard_19',
  positions: [{ id: 'cp1', description: 'Montagestunden', plannedQuantity: 100, unit: 'Stück', unitPrice: 100 }],
};
const ABSCHLAG = {
  type: 'abschlag', taxStatus: 'standard_19', legalNotices: [], issueDate: '2026-05-25', calculationMode: 'fixed_amount',
  fixedAmountNet: 400, abschlagNumber: 1, customerId: 'cust-grenz', customerSnapshot: ANSCHRIFT, positions: [],
  subtotal: 400, amount: 476, skontoText: SKONTO,
};

const rechnung = (vorgang) => `inv-${vorgang}-ab`;

function abschlagSql(vorgang) {
  return `select public.create_workspace_order('${WS}', ${lit(vorgang)}, ${json(AUFTRAG)});\n` +
    `select public.finalize_workspace_invoice('${WS}', ${lit(vorgang)}, ${lit(rechnung(vorgang))}, ${json(ABSCHLAG)});\n` +
    `select public.add_workspace_invoice_payment('${WS}', ${lit(rechnung(vorgang))}, ${lit(`pay-${vorgang}`)}, 466.48, '2026-06-05', null, null, 'bank');\n`;
}

const klaerenSql = (vorgang, id, region, grund = 'Kundensitz laut Vertrag') =>
  `select public.clarify_workspace_invoice_frist('${WS}', ${lit(rechnung(vorgang))}, ${lit(id)}, ${json({ art: 'inland', region })}, ${lit(grund)});\n`;

async function wettlauf(sqlA, sqlB) {
  const a = sitzung(`begin;\n${ALS}${sqlA}select pg_sleep(2);\ncommit;\n`);
  await warte(500);
  const b = sitzung(`begin;\n${ALS}${sqlB}commit;\n`);
  return Promise.all([a, b]);
}

const protokoll = (vorgang) =>
  Number(psql(`select count(*) from public.workspace_invoice_frist_klaerungen where workspace_id = '${WS}' and client_invoice_id = ${lit(rechnung(vorgang))};`));
const protokollMitKennung = (id) =>
  Number(psql(`select count(*) from public.workspace_invoice_frist_klaerungen where workspace_id = '${WS}' and client_klaerung_id = ${lit(id)};`));
const version = (vorgang) =>
  Number(psql(`select row_version from public.workspace_invoices where workspace_id = '${WS}' and client_invoice_id = ${lit(rechnung(vorgang))};`));
const land = (vorgang) =>
  psql(`select frist_basis->'lage'->>'laender' from public.workspace_invoices where workspace_id = '${WS}' and client_invoice_id = ${lit(rechnung(vorgang))};`);
const kette = (vorgang) =>
  psql(`select string_agg((lage_vorher->>'laender') || '>' || (lage_nachher->>'laender'), ' | ' order by created_at) from public.workspace_invoice_frist_klaerungen where workspace_id = '${WS}' and client_invoice_id = ${lit(rechnung(vorgang))};`);

function zeilenStand() {
  return psql(`
select string_agg(t.relname || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', t.nspname, t.relname), false, true, '')))[1]::text, ',' order by t.relname)
from (select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = 'users'))) t;`);
}

function aufraeumen() {
  psql(`
do $$
declare t record; v_rest int := 1; v_runde int := 0;
begin
  while v_rest > 0 and v_runde < 8 loop
    v_rest := 0; v_runde := v_runde + 1;
    for t in select c.table_name from information_schema.columns c
             join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
             where c.table_schema = 'public' and c.column_name = 'workspace_id' loop
      begin
        execute format('delete from public.%I where workspace_id = %L', t.table_name, '${WS}');
      exception when foreign_key_violation then v_rest := v_rest + 1;
      end;
    end loop;
  end loop;
  delete from public.workspaces where id = '${WS}';
  delete from auth.users where id = '${NUTZER}';
end $$;`);
}

const ergebnisse = [];
function pruefe(name, ok, text) {
  ergebnisse.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FEHLZUSTAND'} ${name}: ${text}`);
}
const kurz = (s) => (s.match(/ERROR:\s+([^\n]+)/)?.[1] ?? s.split('\n').pop() ?? '').slice(0, 110);

const davor = zeilenStand();
aufraeumen();
try {
  psql(`
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('${NUTZER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fc01a-b19-klaerung-parallel@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null where email = 'fc01a-b19-klaerung-parallel@example.invalid';
insert into public.workspaces (id, name, owner_user_id) values ('${WS}', 'FC01A B19 Klaerung parallel', '${NUTZER}');
insert into public.workspace_members (workspace_id, user_id, role, status) values ('${WS}', '${NUTZER}', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload) values ('${WS}', 'cust-grenz', '{"id":"cust-grenz","name":"Rheine GmbH"}'::jsonb);
begin;
${ALS}${['l1', 'l2', 'l3a', 'l3b', 'l4', 'l5'].map(abschlagSql).join('')}
commit;`);

  {
    const vorher = version('l1');
    const [a, b] = await wettlauf(klaerenSql('l1', 'kl-l1', 'NW'), klaerenSql('l1', 'kl-l1', 'NW'));
    const ok = a.code === 0 && b.code === 0 && b.ms >= 1500 && protokoll('l1') === 1 && version('l1') === vorher + 1 && land('l1') === '["NW"]';
    pruefe('L1 WEISS K7: gleiche Kennung, gleicher Inhalt parallel', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); Protokoll ${protokoll('l1')}; Version +${version('l1') - vorher}; Land ${land('l1')}`);
  }
  {
    const [a, b] = await wettlauf(klaerenSql('l2', 'kl-l2', 'NW'), klaerenSql('l2', 'kl-l2', 'NW', 'Andere Grundlage'));
    const ok = a.code === 0 && b.code !== 0 && b.ms >= 1500 && /invoice_frist_klaerung_conflict/.test(b.ausgabe) && protokoll('l2') === 1 && land('l2') === '["NW"]';
    pruefe('L2 gleiche Kennung, anderer Inhalt parallel', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); Protokoll ${protokoll('l2')}`);
  }
  {
    const [a, b] = await wettlauf(klaerenSql('l3a', 'kl-l3', 'NW'), klaerenSql('l3b', 'kl-l3', 'NW'));
    const ok = a.code === 0 && b.code !== 0 && /invoice_frist_klaerung_conflict/.test(b.ausgabe) && !/23505|duplicate key/.test(b.ausgabe)
      && protokollMitKennung('kl-l3') === 1 && protokoll('l3b') === 0;
    pruefe('L3 gleiche Kennung an anderer Rechnung parallel', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); Zeilen mit Kennung ${protokollMitKennung('kl-l3')}`);
  }
  {
    const [a, b] = await wettlauf(klaerenSql('l4', 'kl-l4-ni', 'NI', 'Erst NI'), klaerenSql('l4', 'kl-l4-nw', 'NW', 'Dann NW laut Handelsregister'));
    const ok = a.code === 0 && b.code === 0 && b.ms >= 1500 && protokoll('l4') === 2 && land('l4') === '["NW"]' && kette('l4') === '["NI", "NW"]>["NI"] | ["NI"]>["NW"]';
    pruefe('L4 zwei bewusste Klaerungen derselben Rechnung parallel', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms; Protokoll ${protokoll('l4')}; Kette ${kette('l4')}; Land ${land('l4')}`);
  }
  {
    psql(`begin;\n${ALS}${klaerenSql('l5', 'kl-l5', 'NW')}commit;`);
    const nachErstem = version('l5');
    const zweiter = await sitzung(`begin;\n${ALS}${klaerenSql('l5', 'kl-l5', 'NW')}commit;\n`);
    const ok = zweiter.code === 0 && protokoll('l5') === 1 && version('l5') === nachErstem;
    pruefe('L5 verlorene Antwort: Wiederholung nach dem Festschreiben', ok, `exit ${zweiter.code}; Protokoll ${protokoll('l5')}; Version unveraendert ${version('l5') === nachErstem}`);
  }
} finally {
  aufraeumen();
}
const danach = zeilenStand();
pruefe('Aufräumen: Zeilenzahlen davor = danach', davor === danach, davor === danach ? 'gleich' : 'ABWEICHEND');
const fehler = ergebnisse.filter((e) => !e.ok);
console.log(fehler.length === 0 ? 'ALLE WETTLAEUFE OHNE FEHLZUSTAND' : `${fehler.length} FEHLZUSTAND`);
process.exit(fehler.length === 0 ? 0 : 1);
