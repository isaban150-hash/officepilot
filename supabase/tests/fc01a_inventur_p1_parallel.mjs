// FINANZ-CORE-01A -- Gesamtnacharbeit Paket 1 (INV-01/03): Wettlaeufe zwischen zwei Sitzungen um die
// Klaerung der Fristgrundlage, die Schlussrechnung und die Zahlung desselben Abschlags.
//
// Nur gegen die LOKALE Datenbank (Docker-Container supabase_db_officepilot), niemals remote. Legt einen
// eigenen synthetischen Betrieb an und entfernt ihn am Ende wieder (Zeilenzahlen davor = danach).
//
// Abschlag 400/476 (19 %), 2 % Skonto in 10 Tagen ab 25.05.2026, Grenz-PLZ 48431 (NI+NW), Fristende
// Do 04.06. (Fronleichnam nur in NW), Zahlung 466,48 am Fr 05.06. -> ungeklaert.
//
//   K1  A klaert NW (haelt 2 s), B gibt die Schlussrechnung 466,48 + 9,52 frei: B wartet, dann angenommen.
//   K2  Schon NW; A gibt die Schlussrechnung frei (haelt), B klaert NI: B wartet, dann abgewiesen
//       (invoice_frist_final_invoice_exists) -- die eingefrorene Aufteilung bleibt wahr.
//   K3  A klaert NI (verspaetet, haelt), B gibt die Schlussrechnung 466,48 + 9,52 frei: B wartet, dann
//       abgewiesen (invoice_abschlag_unpaid).
//   K4  A klaert NI (haelt), B zahlt 9,52 ohne Bestaetigung: B wartet, dann angenommen (Rest geschuldet).
//   K5  A klaert NW (haelt), B zahlt 9,52 ohne Bestaetigung: B wartet, dann abgewiesen (Ueberzahlung).
//   K6  Schon NW, Schlussrechnung wirksam; A und B zahlen je 9,52 (bestaetigt) auf den Abschlag: beide
//       abgewiesen, auch parallel.
//
// Endpruefung: jede wirksame Schlussrechnung passt zu den Zahlungen; jede Fristgrundlage ist die der
// zuletzt angenommenen Klaerung; jede Klaerung steht genau einmal im Protokoll.
//
// Aufruf:  node supabase/tests/fc01a_inventur_p1_parallel.mjs
// Exit 0 = alle Wettlaeufe ohne Fehlzustand.
import { spawn, spawnSync } from 'node:child_process';

const CONTAINER = 'supabase_db_officepilot';
const WS = '00000000-0000-0000-0000-00000000fe31';
const NUTZER = '00000000-0000-0000-0000-0000000fe311';
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
  customerId: 'cust-grenz', customerBilling: ANSCHRIFT, title: 'FC01A Inventur parallel', baustelle: '', taxStatus: 'standard_19',
  positions: [{ id: 'cp1', description: 'Montagestunden', plannedQuantity: 100, unit: 'Stück', unitPrice: 100 }],
};
const ABSCHLAG = {
  type: 'abschlag', taxStatus: 'standard_19', legalNotices: [], issueDate: '2026-05-25', calculationMode: 'fixed_amount',
  fixedAmountNet: 400, abschlagNumber: 1, customerId: 'cust-grenz', customerSnapshot: ANSCHRIFT, positions: [],
  subtotal: 400, amount: 476, skontoText: SKONTO,
};

function abschlagSql(vorgang) {
  const rechnung = `inv-${vorgang}-ab`;
  return `select public.create_workspace_order('${WS}', ${lit(vorgang)}, ${json(AUFTRAG)});\n` +
    `select public.finalize_workspace_invoice('${WS}', ${lit(vorgang)}, ${lit(rechnung)}, ${json(ABSCHLAG)});\n` +
    `select public.add_workspace_invoice_payment('${WS}', ${lit(rechnung)}, ${lit(`pay-${vorgang}`)}, 466.48, '2026-06-05', null, null, 'bank');\n`;
}

const klaerenSql = (vorgang, id, region) =>
  `select public.clarify_workspace_invoice_frist('${WS}', ${lit(`inv-${vorgang}-ab`)}, ${lit(id)}, ${json({ art: 'inland', region })}, 'Wettlauf ${region}');\n`;

const schlussSql = (vorgang) =>
  `select public.finalize_workspace_invoice('${WS}', ${lit(vorgang)}, ${lit(`inv-${vorgang}-schluss`)}, jsonb_build_object(\n` +
  `  'type', 'schluss', 'taxStatus', 'standard_19', 'legalNotices', '[]'::jsonb, 'issueDate', '2026-10-05',\n` +
  `  'customerId', 'cust-grenz', 'customerSnapshot', ${json(ANSCHRIFT)},\n` +
  `  'positions', '[{"id":"line-s","orderPositionId":"cp1","description":"Montagestunden","quantity":100,"unit":"Stück","unitPrice":100,"lineTotal":10000}]'::jsonb,\n` +
  `  'subtotal', 10000, 'amount', 11424,\n` +
  `  'previousAbschlagDeductions', jsonb_build_array((select jsonb_build_object('invoiceId', a.client_invoice_id, 'invoiceNumber', a.invoice_number,\n` +
  `    'abschlagNumber', a.payload->'abschlagNumber', 'date', a.payload->>'issueDate', 'subtotal', a.payload->'subtotal', 'amount', a.payload->'amount',\n` +
  `    'paidAmount', 466.48, 'skontoAmount', 9.52) from public.workspace_invoices a\n` +
  `    where a.workspace_id = '${WS}' and a.client_invoice_id = ${lit(`inv-${vorgang}-ab`)}))));\n`;

const zahlungSql = (vorgang, id, bestaetigt) =>
  `select public.add_workspace_invoice_payment('${WS}', ${lit(`inv-${vorgang}-ab`)}, ${lit(id)}, 9.52, '2026-06-10', null, null, 'bank'${bestaetigt ? ', true' : ''});\n`;

async function wettlauf(sqlA, sqlB) {
  const a = sitzung(`begin;\n${ALS}${sqlA}select pg_sleep(2);\ncommit;\n`);
  await warte(500);
  const b = sitzung(`begin;\n${ALS}${sqlB}commit;\n`);
  return Promise.all([a, b]);
}

const gezahlt = (vorgang) =>
  Number(psql(`select coalesce(sum(amount), 0) from public.workspace_invoice_payments where workspace_id = '${WS}' and client_invoice_id = ${lit(`inv-${vorgang}-ab`)} and reversed_at is null;`));
const gibtSchluss = (vorgang) =>
  psql(`select count(*) from public.workspace_invoices where workspace_id = '${WS}' and client_invoice_id = ${lit(`inv-${vorgang}-schluss`)};`) === '1';
const land = (vorgang) =>
  psql(`select frist_basis->'lage'->>'laender' from public.workspace_invoices where workspace_id = '${WS}' and client_invoice_id = ${lit(`inv-${vorgang}-ab`)};`);

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
values ('${NUTZER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fc01a-inventur-p1-parallel@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null where email = 'fc01a-inventur-p1-parallel@example.invalid';
insert into public.workspaces (id, name, owner_user_id) values ('${WS}', 'FC01A Inventur P1 parallel', '${NUTZER}');
insert into public.workspace_members (workspace_id, user_id, role, status) values ('${WS}', '${NUTZER}', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload) values ('${WS}', 'cust-grenz', '{"id":"cust-grenz","name":"Rheine GmbH"}'::jsonb);
begin;
${ALS}${['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].map(abschlagSql).join('')}${klaerenSql('k2', 'kl-k2-vor', 'NW')}${klaerenSql('k6', 'kl-k6-vor', 'NW')}${schlussSql('k6')}
commit;`);

  {
    const [a, b] = await wettlauf(klaerenSql('k1', 'kl-k1', 'NW'), schlussSql('k1'));
    const ok = a.code === 0 && b.code === 0 && b.ms >= 1500 && gibtSchluss('k1') && land('k1') === '["NW"]';
    pruefe('K1 Klärung NW gegen Schlussrechnung', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); Schluss ${gibtSchluss('k1')}; Land ${land('k1')}`);
  }
  {
    const [a, b] = await wettlauf(schlussSql('k2'), klaerenSql('k2', 'kl-k2', 'NI'));
    const ok = a.code === 0 && b.code !== 0 && /invoice_frist_final_invoice_exists/.test(b.ausgabe) && land('k2') === '["NW"]';
    pruefe('K2 Schlussrechnung gegen Klärung NI', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); Land ${land('k2')}`);
  }
  {
    const [a, b] = await wettlauf(klaerenSql('k3', 'kl-k3', 'NI'), schlussSql('k3'));
    const ok = a.code === 0 && b.code !== 0 && /invoice_abschlag_unpaid/.test(b.ausgabe) && !gibtSchluss('k3');
    pruefe('K3 Klärung NI gegen Schlussrechnung', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); Schluss ${gibtSchluss('k3')}`);
  }
  {
    const [a, b] = await wettlauf(klaerenSql('k4', 'kl-k4', 'NI'), zahlungSql('k4', 'pay-k4-rest', false));
    const ok = a.code === 0 && b.code === 0 && b.ms >= 1500 && gezahlt('k4') === 476;
    pruefe('K4 Klärung NI gegen Restzahlung', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); gezahlt ${gezahlt('k4')}`);
  }
  {
    const [a, b] = await wettlauf(klaerenSql('k5', 'kl-k5', 'NW'), zahlungSql('k5', 'pay-k5-rest', false));
    const ok = a.code === 0 && b.code !== 0 && /invoice_payment_overpayment_unconfirmed/.test(b.ausgabe) && gezahlt('k5') === 466.48;
    pruefe('K5 Klärung NW gegen Restzahlung', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); gezahlt ${gezahlt('k5')}`);
  }
  {
    const [a, b] = await wettlauf(zahlungSql('k6', 'pay-k6-a', true), zahlungSql('k6', 'pay-k6-b', true));
    const ok = a.code !== 0 && b.code !== 0 && /invoice_payment_final_invoice_exists/.test(a.ausgabe) && /invoice_payment_final_invoice_exists/.test(b.ausgabe)
      && gezahlt('k6') === 466.48;
    pruefe('K6 zwei Zahlungen auf eingefrorenen Abschlag', ok, `A exit ${a.code} (${kurz(a.ausgabe)}); B exit ${b.code}; gezahlt ${gezahlt('k6')}`);
  }
  {
    const falsch = psql(`
select count(*) from public.workspace_invoices s, jsonb_array_elements(s.payload->'previousAbschlagDeductions') d
where s.workspace_id = '${WS}' and s.invoice_type = 'schluss' and s.cancelled_at is null
  and round((d.value->>'paidAmount')::numeric * 100) <> least(round((d.value->>'amount')::numeric * 100),
      (select coalesce(sum(round(p.amount * 100)), 0) from public.workspace_invoice_payments p
       where p.workspace_id = s.workspace_id and p.client_invoice_id = d.value->>'invoiceId' and p.reversed_at is null));`);
    pruefe('Endprüfung eingefrorene Aufteilung = Zahlungen', falsch === '0', `${falsch} abweichende Abzüge`);
    const protokoll = psql(`
select count(*) from public.workspace_invoices i
where i.workspace_id = '${WS}' and i.frist_basis->>'quelle' = 'klaerung'
  and i.frist_basis->'lage' is distinct from (select k.lage_nachher from public.workspace_invoice_frist_klaerungen k
      where k.workspace_id = i.workspace_id and k.client_invoice_id = i.client_invoice_id order by k.created_at desc, k.id desc limit 1);`);
    const doppelt = psql(`select count(*) from (select client_klaerung_id from public.workspace_invoice_frist_klaerungen where workspace_id = '${WS}' group by 1 having count(*) > 1) x;`);
    pruefe('Endprüfung Fristgrundlage = letzte Klärung, keine doppelte Protokollzeile', protokoll === '0' && doppelt === '0', `${protokoll} abweichend, ${doppelt} doppelt`);
  }
} finally {
  aufraeumen();
  const danach = zeilenStand();
  pruefe('Aufräumen: Zeilenzahlen davor = danach', davor === danach, davor === danach ? 'gleich' : 'ABWEICHEND');
}

const fehl = ergebnisse.filter((e) => !e.ok).length;
console.log(fehl === 0 ? 'ALLE WETTLAEUFE OHNE FEHLZUSTAND' : `${fehl} FEHLZUSTAND/FEHLZUSTAENDE`);
process.exitCode = fehl === 0 ? 0 : 1;
