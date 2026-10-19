// FINANZ-CORE-01A -- Gesamtabschluss: Wettlaeufe Storno gegen Zahlung (bisher ungeprueft).
//
// Nur gegen die LOKALE Datenbank (Docker-Container supabase_db_officepilot), niemals remote.
// Legt einen eigenen synthetischen Betrieb an und entfernt ihn am Ende wieder (Zeilenzahlen
// davor = danach werden geprueft). Aufbau wie fc01a_p1_parallel.mjs.
//
//   S1  Storno haelt die Sperre, gleichzeitig eine Zahlung von Hand: Die Zahlung wartet und
//       wird abgewiesen ("Rechnung storniert").
//   S2  Umgekehrt: erst die Zahlung, gleichzeitig der Storno: Der Storno wartet und wird
//       abgewiesen (invoice_cancel_has_active_payments).
//   S3  Storno gegen Bankabgleich: Der Abgleich wartet und bucht nichts.
//   S4  Bankabgleich gegen Storno: Der Storno wartet und wird abgewiesen.
//
// Endpruefung: keine stornierte Rechnung mit wirksamer Zahlung.
//
// Aufruf:  node supabase/tests/fc01a_storno_parallel.mjs
// Exit 0 = alle Wettlaeufe ohne Fehlzustand.
import { spawn, spawnSync } from 'node:child_process';

const CONTAINER = 'supabase_db_officepilot';
const WS = '00000000-0000-0000-0000-00000000fcc5';
const NUTZER = '00000000-0000-0000-0000-0000000fcc05';

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

const AUFTRAG = {
  customerId: 'cust-1',
  customerBilling: { name: 'Muster GmbH', street: 'Weg 1', zip: '33602', city: 'Bielefeld' },
  title: 'FC01A Storno parallel', baustelle: '', taxStatus: 'kleinunternehmer_19',
  positions: [{ id: 'cp1', description: 'Montagestunden', plannedQuantity: 100, unit: 'Stück', unitPrice: 100 }],
};

/** Eine Rechnung (§ 19) ueber 10 Stunden = 1.000 im eigenen Vorgang, freigegeben, nicht versendet. */
const RECHNUNG = {
  type: 'rechnung',
  taxStatus: 'kleinunternehmer_19',
  legalNotices: ['Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.'],
  issueDate: '2026-09-01',
  customerSnapshot: { name: 'Muster GmbH', street: 'Weg 1', zip: '33602', city: 'Bielefeld' },
  positions: [{ id: 'line-1', orderPositionId: 'cp1', description: 'Montagestunden', quantity: 10, unit: 'Stück', unitPrice: 100, lineTotal: 1000 }],
  subtotal: 1000,
  amount: 1000,
};

const rechnungSql = (vorgang, rechnung) =>
  `select public.create_workspace_order('${WS}', ${lit(vorgang)}, ${json(AUFTRAG)});\n` +
  `select public.finalize_workspace_invoice('${WS}', ${lit(vorgang)}, ${lit(rechnung)}, ${json(RECHNUNG)});\n`;

const bankSql = (id, cents, tag) =>
  `insert into public.workspace_bank_transactions (workspace_id, client_transaction_id, account_key, import_id, file_name, imported_at, booking_date, amount_cents, fingerprint, occurrence, payload, created_by, updated_by)\n` +
  `values ('${WS}', ${lit(id)}, 's-bacc', 's-import', 'S.csv', now(), ${lit(tag)}, ${cents}, ${lit(`fp-${id}`)}, 1, '{}'::jsonb, '${NUTZER}', '${NUTZER}');\n`;

const stornoSql = (rechnung) => `select public.cancel_workspace_invoice('${WS}', ${lit(rechnung)}, 'Wettlauf');\n`;
const zahlungSql = (rechnung, zahlung) =>
  `select public.add_workspace_invoice_payment('${WS}', ${lit(rechnung)}, ${lit(zahlung)}, 1000, '2026-09-05', null, null, 'bank');\n`;
const zuordnen = (btx, rechnung, zahlung) =>
  `select public.confirm_workspace_bank_reconciliation('${WS}', ${lit(btx)}, 'invoice', ${lit(rechnung)}, ${lit(zahlung)}, ${lit(`rec-${zahlung}`)});\n`;

/** Zwei Sitzungen: A haelt ihre Sperren 2 s, B startet 0,5 s spaeter. */
async function wettlauf(sqlA, sqlB) {
  const a = sitzung(`begin;\n${ALS}${sqlA}select pg_sleep(2);\ncommit;\n`);
  await warte(500);
  const b = sitzung(`begin;\n${ALS}${sqlB}commit;\n`);
  return Promise.all([a, b]);
}

const gezahlt = (rechnung) =>
  Number(psql(`select coalesce(sum(amount), 0) from public.workspace_invoice_payments where workspace_id = '${WS}' and client_invoice_id = ${lit(rechnung)} and reversed_at is null;`));
const storniert = (rechnung) =>
  psql(`select cancelled_at is not null from public.workspace_invoices where workspace_id = '${WS}' and client_invoice_id = ${lit(rechnung)};`) === 't';

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
values ('${NUTZER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fc01a-storno-parallel@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null where email = 'fc01a-storno-parallel@example.invalid';
insert into public.workspaces (id, name, owner_user_id) values ('${WS}', 'FC01A Storno parallel', '${NUTZER}');
insert into public.workspace_members (workspace_id, user_id, role, status) values ('${WS}', '${NUTZER}', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload) values ('${WS}', 'cust-1', '{"id":"cust-1","name":"Muster GmbH"}'::jsonb);
insert into public.workspace_bank_accounts (workspace_id, client_account_id, display_name, identifier, payload, created_by, updated_by)
values ('${WS}', 's-bacc', 'S synthetisch', 'DE00S', '{}'::jsonb, '${NUTZER}', '${NUTZER}');
begin;
${ALS}${rechnungSql('v-s1', 'inv-s1')}${rechnungSql('v-s2', 'inv-s2')}${rechnungSql('v-s3', 'inv-s3')}${rechnungSql('v-s4', 'inv-s4')}
${bankSql('btx-s3', 100000, '2026-09-05')}${bankSql('btx-s4', 100000, '2026-09-05')}
commit;`);

  {
    const [a, b] = await wettlauf(stornoSql('inv-s1'), zahlungSql('inv-s1', 'pay-s1'));
    const ok = a.code === 0 && b.code !== 0 && /storniert/i.test(b.ausgabe) && storniert('inv-s1') && gezahlt('inv-s1') === 0;
    pruefe('S1 Storno gegen Zahlung', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); storniert ${storniert('inv-s1')}, gezahlt ${gezahlt('inv-s1')}`);
  }
  {
    const [a, b] = await wettlauf(zahlungSql('inv-s2', 'pay-s2'), stornoSql('inv-s2'));
    const ok = a.code === 0 && b.code !== 0 && /invoice_cancel_has_active_payments/.test(b.ausgabe) && !storniert('inv-s2') && gezahlt('inv-s2') === 1000;
    pruefe('S2 Zahlung gegen Storno', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); storniert ${storniert('inv-s2')}, gezahlt ${gezahlt('inv-s2')}`);
  }
  {
    const [a, b] = await wettlauf(stornoSql('inv-s3'), zuordnen('btx-s3', 'inv-s3', 'pay-s3'));
    const ok = a.code === 0 && b.code !== 0 && storniert('inv-s3') && gezahlt('inv-s3') === 0;
    pruefe('S3 Storno gegen Bankabgleich', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); storniert ${storniert('inv-s3')}, gezahlt ${gezahlt('inv-s3')}`);
  }
  {
    const [a, b] = await wettlauf(zuordnen('btx-s4', 'inv-s4', 'pay-s4'), stornoSql('inv-s4'));
    const ok = a.code === 0 && b.code !== 0 && /invoice_cancel_has_active_payments/.test(b.ausgabe) && !storniert('inv-s4') && gezahlt('inv-s4') === 1000;
    pruefe('S4 Bankabgleich gegen Storno', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); storniert ${storniert('inv-s4')}, gezahlt ${gezahlt('inv-s4')}`);
  }
  {
    const falsch = psql(`
select count(*) from public.workspace_invoices i
where i.workspace_id = '${WS}' and i.cancelled_at is not null
  and exists (select 1 from public.workspace_invoice_payments p
              where p.workspace_id = i.workspace_id and p.client_invoice_id = i.client_invoice_id and p.reversed_at is null);`);
    pruefe('Endpruefung keine stornierte Rechnung mit Zahlung', falsch === '0', `${falsch} Fehlzustaende`);
  }
} finally {
  aufraeumen();
  const danach = zeilenStand();
  pruefe('Aufraeumen: Zeilenzahlen davor = danach', davor === danach, davor === danach ? 'gleich' : 'ABWEICHEND');
}

const fehl = ergebnisse.filter((e) => !e.ok).length;
console.log(fehl === 0 ? 'ALLE WETTLAEUFE OHNE FEHLZUSTAND' : `${fehl} FEHLZUSTAND/FEHLZUSTAENDE`);
process.exitCode = fehl === 0 ? 0 : 1;
