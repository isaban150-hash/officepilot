// FC01A-P1-NACHARBEIT (ZAH-04) -- Wettlaeufe zwischen zwei Sitzungen.
//
// Nur gegen die LOKALE Datenbank (Docker-Container supabase_db_officepilot), niemals
// remote. Legt einen eigenen synthetischen Betrieb an und entfernt ihn am Ende wieder
// (nur, was dieses Skript angelegt hat; Zeilenzahlen davor = danach werden geprueft).
//
//   R1  Zwei Bankbewegungen ueber je 10 auf einen Abschlag, der noch 10 offen hat:
//       genau eine wird gebucht, die zweite wartet und wird abgewiesen.
//   R2  Bankabgleich 90 (gleicht mit Skonto aus) gleichzeitig mit einer Zahlung von
//       Hand ueber 10: Die Zahlung wartet und wird als Ueberzahlung abgewiesen.
//   R3  Schlussrechnung friert 490 + 10 Skonto ein, gleichzeitig eine bestaetigte
//       Zahlung von 10 auf den Abschlag: Die Zahlung wartet und wird abgewiesen.
//   R4  Umgekehrt: erst die bestaetigte Zahlung, gleichzeitig die Schlussrechnung mit
//       490 + 10: Die Schlussrechnung wartet und wird abgewiesen (Aufteilung falsch).
//
// Jeder Lauf endet mit derselben Pruefung: keine wirksame Schlussrechnung, deren
// eingefrorene Aufteilung nicht zu den Zahlungen passt; kein ausgeglichener Abschlag
// mit zusaetzlicher Zahlung.
//
// Aufruf:  node supabase/tests/fc01a_p1_parallel.mjs
// Exit 0 = alle Wettlaeufe ohne Fehlzustand. Vor der Migration 20261115120000 zeigt
// derselbe Lauf die Fehlzustaende (Gegenprobe).
import { spawn, spawnSync } from 'node:child_process';

const CONTAINER = 'supabase_db_officepilot';
const WS = '00000000-0000-0000-0000-00000000fcc1';
const NUTZER = '00000000-0000-0000-0000-0000000fcc01';
const SKONTO = 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.';

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
  title: 'FC01A-P1 parallel', baustelle: '', taxStatus: 'kleinunternehmer_19',
  positions: [{ id: 'cp1', description: 'Montagestunden', plannedQuantity: 100, unit: 'Stück', unitPrice: 100 }],
};

function beleg(type, menge, subtotal, amount, extra = {}) {
  return {
    type,
    taxStatus: 'kleinunternehmer_19',
    legalNotices: ['Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.'],
    issueDate: '2026-10-04',
    customerSnapshot: { name: 'Muster GmbH', street: 'Weg 1', zip: '33602', city: 'Bielefeld' },
    positions: menge > 0
      ? [{ id: `line-${type}-${menge}`, orderPositionId: 'cp1', description: 'Montagestunden', quantity: menge, unit: 'Stück', unitPrice: 100, lineTotal: menge * 100 }]
      : [],
    subtotal,
    amount,
    ...extra,
  };
}

const ABSCHLAG = beleg('abschlag', 0, 500, 500, {
  calculationMode: 'fixed_amount', fixedAmountNet: 500, abschlagNumber: 1, issueDate: '2026-09-01', skontoText: SKONTO,
});

/** Ein Vorgang mit Pauschalabschlag 500 (2 % Skonto, 10 Tage ab 01.09.) und einer ersten Zahlung. */
function abschlagSql(vorgang, rechnung, betrag, tag) {
  return `select public.create_workspace_order('${WS}', ${lit(vorgang)}, ${json(AUFTRAG)});\n` +
    `select public.finalize_workspace_invoice('${WS}', ${lit(vorgang)}, ${lit(rechnung)}, ${json(ABSCHLAG)});\n` +
    `select public.add_workspace_invoice_payment('${WS}', ${lit(rechnung)}, ${lit(`pay-${rechnung}`)}, ${betrag}, ${lit(tag)}, null, null, 'bank');\n`;
}

const bankSql = (id, cents, tag) =>
  `insert into public.workspace_bank_transactions (workspace_id, client_transaction_id, account_key, import_id, file_name, imported_at, booking_date, amount_cents, fingerprint, occurrence, payload, created_by, updated_by)\n` +
  `values ('${WS}', ${lit(id)}, 'r-bacc', 'r-import', 'R.csv', now(), ${lit(tag)}, ${cents}, ${lit(`fp-${id}`)}, 1, '{}'::jsonb, '${NUTZER}', '${NUTZER}');\n`;

const zuordnen = (btx, rechnung, zahlung) =>
  `select public.confirm_workspace_bank_reconciliation('${WS}', ${lit(btx)}, 'invoice', ${lit(rechnung)}, ${lit(zahlung)}, ${lit(`rec-${zahlung}`)});\n`;

/** Die Schlussrechnung mit dem Abzug, wie ihn der Client baut (Angaben aus dem gespeicherten Abschlag). */
const schlussSql = (vorgang, rechnung, abschlag) =>
  `select public.finalize_workspace_invoice('${WS}', ${lit(vorgang)}, ${lit(rechnung)}, ${json(beleg('schluss', 100, 10000, 9500))}\n` +
  `  || jsonb_build_object('previousAbschlagDeductions', jsonb_build_array((\n` +
  `    select jsonb_build_object('invoiceId', a.client_invoice_id, 'invoiceNumber', a.invoice_number, 'abschlagNumber', a.payload->'abschlagNumber',\n` +
  `      'date', a.payload->>'issueDate', 'subtotal', a.payload->'subtotal', 'amount', a.payload->'amount', 'paidAmount', 490, 'skontoAmount', 10)\n` +
  `    from public.workspace_invoices a where a.workspace_id = '${WS}' and a.client_invoice_id = ${lit(abschlag)}))));\n`;

const zahlungSql = (rechnung, zahlung, betrag, tag, bestaetigt) =>
  `select public.add_workspace_invoice_payment('${WS}', ${lit(rechnung)}, ${lit(zahlung)}, ${betrag}, ${lit(tag)}, null, null, 'bank'${bestaetigt ? ', true' : ''});\n`;

/** Zwei Sitzungen: A haelt ihre Sperren 2 s, B startet 0,5 s spaeter. */
async function wettlauf(sqlA, sqlB) {
  const a = sitzung(`begin;\n${ALS}${sqlA}select pg_sleep(2);\ncommit;\n`);
  await warte(500);
  const b = sitzung(`begin;\n${ALS}${sqlB}commit;\n`);
  return Promise.all([a, b]);
}

const gezahlt = (rechnung) =>
  Number(psql(`select coalesce(sum(amount), 0) from public.workspace_invoice_payments where workspace_id = '${WS}' and client_invoice_id = ${lit(rechnung)} and reversed_at is null;`));
const gibt = (rechnung) =>
  psql(`select count(*) from public.workspace_invoices where workspace_id = '${WS}' and client_invoice_id = ${lit(rechnung)};`) === '1';

/* Zeilenzahlen aller Tabellen in public und auth.users -- davor = danach. */
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
values ('${NUTZER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fc01a-p1-parallel@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null where email = 'fc01a-p1-parallel@example.invalid';
insert into public.workspaces (id, name, owner_user_id) values ('${WS}', 'FC01A-P1 parallel', '${NUTZER}');
insert into public.workspace_members (workspace_id, user_id, role, status) values ('${WS}', '${NUTZER}', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload) values ('${WS}', 'cust-1', '{"id":"cust-1","name":"Muster GmbH"}'::jsonb);
insert into public.workspace_bank_accounts (workspace_id, client_account_id, display_name, identifier, payload, created_by, updated_by)
values ('${WS}', 'r-bacc', 'R synthetisch', 'DE00R', '{}'::jsonb, '${NUTZER}', '${NUTZER}');
begin;
${ALS}${abschlagSql('v-r1', 'inv-r1-ab', 490, '2026-09-20')}${abschlagSql('v-r2', 'inv-r2-ab', 400, '2026-09-05')}${abschlagSql('v-r3', 'inv-r3-ab', 490, '2026-09-08')}${abschlagSql('v-r4', 'inv-r4-ab', 490, '2026-09-08')}
${bankSql('btx-r1a', 1000, '2026-09-21')}${bankSql('btx-r1b', 1000, '2026-09-21')}${bankSql('btx-r2', 9000, '2026-09-07')}
commit;`);

  // R1 -- verspaetetes Skonto: 10 offen; zwei Bankbewegungen ueber je 10.
  {
    const [a, b] = await wettlauf(zuordnen('btx-r1a', 'inv-r1-ab', 'pay-r1a'), zuordnen('btx-r1b', 'inv-r1-ab', 'pay-r1b'));
    const ok = a.code === 0 && b.code !== 0 && /Kein offener Betrag/.test(b.ausgabe) && gezahlt('inv-r1-ab') === 500;
    pruefe('R1 Bank gegen Bank (10 offen)', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); gezahlt ${gezahlt('inv-r1-ab')}`);
  }
  // R2 -- 400 rechtzeitig; Bank 90 gleicht mit Skonto aus, gleichzeitig 10 von Hand.
  {
    const [a, b] = await wettlauf(zuordnen('btx-r2', 'inv-r2-ab', 'pay-r2-bank'), zahlungSql('inv-r2-ab', 'pay-r2-hand', 10, '2026-09-08', false));
    const ok = a.code === 0 && b.code !== 0 && gezahlt('inv-r2-ab') === 490;
    pruefe('R2 Bank (Skontoausgleich) gegen Zahlung von Hand', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); gezahlt ${gezahlt('inv-r2-ab')}`);
  }
  // R3 -- Schlussrechnung (490 + 10 eingefroren) gegen bestaetigte Zahlung von 10.
  {
    const [a, b] = await wettlauf(schlussSql('v-r3', 'inv-r3-schluss', 'inv-r3-ab'), zahlungSql('inv-r3-ab', 'pay-r3-hand', 10, '2026-09-09', true));
    const ok = a.code === 0 && b.code !== 0 && gezahlt('inv-r3-ab') === 490;
    pruefe('R3 Schlussrechnung gegen bestaetigte Zahlung', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); gezahlt ${gezahlt('inv-r3-ab')}`);
  }
  // R4 -- erst die bestaetigte Zahlung, gleichzeitig die Schlussrechnung mit 490 + 10.
  {
    const [a, b] = await wettlauf(zahlungSql('inv-r4-ab', 'pay-r4-hand', 10, '2026-09-09', true), schlussSql('v-r4', 'inv-r4-schluss', 'inv-r4-ab'));
    const ok = a.code === 0 && b.code !== 0 && !gibt('inv-r4-schluss');
    pruefe('R4 bestaetigte Zahlung gegen Schlussrechnung', ok, `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); Schlussrechnung ${gibt('inv-r4-schluss') ? 'GESPEICHERT' : 'nicht gespeichert'}`);
  }
  // Endpruefung: jede wirksame Schlussrechnung passt zu den Zahlungen; kein ausgeglichener Abschlag mit Zusatzzahlung.
  {
    const falsch = psql(`
select count(*) from public.workspace_invoices s, jsonb_array_elements(s.payload->'previousAbschlagDeductions') d
where s.workspace_id = '${WS}' and s.invoice_type = 'schluss' and s.cancelled_at is null
  and round((d.value->>'paidAmount')::numeric * 100) <> least(round((d.value->>'amount')::numeric * 100),
      (select coalesce(sum(round(p.amount * 100)), 0) from public.workspace_invoice_payments p
       where p.workspace_id = s.workspace_id and p.client_invoice_id = d.value->>'invoiceId' and p.reversed_at is null));`);
    pruefe('Endpruefung eingefrorene Aufteilung = Zahlungen', falsch === '0', `${falsch} abweichende Abzuege`);
  }
} finally {
  aufraeumen();
  const danach = zeilenStand();
  pruefe('Aufraeumen: Zeilenzahlen davor = danach', davor === danach, davor === danach ? 'gleich' : 'ABWEICHEND');
}

const fehl = ergebnisse.filter((e) => !e.ok).length;
console.log(fehl === 0 ? 'ALLE WETTLAEUFE OHNE FEHLZUSTAND' : `${fehl} FEHLZUSTAND/FEHLZUSTAENDE`);
process.exitCode = fehl === 0 ? 0 : 1;
