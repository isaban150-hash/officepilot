// FINANZ-CORE-01A -- Gesamtnacharbeit Paket 2 (INV-11): Wettlaeufe zwischen zwei Sitzungen um dieselbe
// Ausgabe -- Zahlung gegen Loeschen, Storno, Betragsaenderung, Ruecknahme und zweite Zahlung, jeweils in
// beiden Richtungen (WEISS-Gesamtmaengelinventur: "Beide erfolgreich: deleted=true, status=gebucht, paid=119").
//
// Nur gegen die LOKALE Datenbank (Docker-Container supabase_db_officepilot), niemals remote. Legt einen
// eigenen synthetischen Betrieb an und entfernt ihn am Ende wieder (Zeilenzahlen davor = danach).
//
//   E1  A loescht (haelt 2 s), B zahlt 119          -> B wartet, dann 'Ausgabe geloescht'
//   E2  A zahlt 119 (haelt), B loescht               -> B wartet, dann 'Ausgabe hat gebuchte Zahlungen'
//   E3  A storniert (haelt), B zahlt 119             -> B wartet, dann 'Ausgabe storniert'
//   E4  A zahlt 119 (haelt), B storniert             -> B wartet, dann expense_cancel_has_payments
//   E5  A aendert 119 -> 238 (haelt), B zahlt 238    -> B wartet, dann angenommen (offen 238)
//   E6  A zahlt 119 (haelt), B aendert auf 238       -> B wartet, dann expense_amount_locked_after_payment
//   E7  A zahlt 119 (haelt), B zahlt 119 (neue Kennung, ohne Bestaetigung) -> B wartet, dann Ueberzahlung abgewiesen
//   E8  A nimmt die Zahlung zurueck (haelt), B storniert -> B wartet, dann angenommen (keine aktive Zahlung mehr)
//
// Endpruefung: keine geloeschte oder stornierte Ausgabe mit aktiver Zahlung; keine Ausgabe, deren aktive
// Zahlungen den Bruttobetrag ohne Bestaetigung uebersteigen.
//
// Aufruf:  node supabase/tests/fc01a_inventur_ausgaben_parallel.mjs
// Exit 0 = alle Wettlaeufe ohne Fehlzustand.
import { spawn, spawnSync } from 'node:child_process';

const CONTAINER = 'supabase_db_officepilot';
const WS = '00000000-0000-0000-0000-00000000fe51';
const NUTZER = '00000000-0000-0000-0000-0000000fe511';

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
const ALS = `select set_config('request.jwt.claims', '{"sub":"${NUTZER}","role":"authenticated"}', true);\n`;

function ausgabe(id, { status = 'gebucht', gross = 119, deleted = false } = {}) {
  const net = Math.round((gross / 1.19) * 100) / 100;
  return JSON.stringify({
    client_expense_id: id, status, dedupe_key: id, deleted,
    payload: {
      id, category: 'material', supplierName: 'Lieferant', title: 'Inventur Rennen', issueDate: '2026-06-01',
      netAmount: net, taxAmount: Math.round((gross - net) * 100) / 100, grossAmount: gross, taxStatus: 'standard_19', isCreditNote: false,
    },
  });
}

const upsert = (id, opts) =>
  `select public.upsert_workspace_expense('${WS}', ${lit(ausgabe(id, opts))}::jsonb, (select row_version from public.workspace_expenses where workspace_id = '${WS}' and client_expense_id = ${lit(id)}));\n`;
const zahlen = (id, pay, betrag, bestaetigt = false) =>
  `select public.add_workspace_expense_payment('${WS}', ${lit(id)}, ${lit(pay)}, ${betrag}, '2026-06-02', null, null, 'bank'${bestaetigt ? ', true' : ''});\n`;
const zuruecknehmen = (id, pay) => `select public.reverse_workspace_expense_payment('${WS}', ${lit(id)}, ${lit(pay)});\n`;

async function wettlauf(sqlA, sqlB) {
  const a = sitzung(`begin;\n${ALS}${sqlA}select pg_sleep(2);\ncommit;\n`);
  await warte(500);
  const b = sitzung(`begin;\n${ALS}${sqlB}commit;\n`);
  return Promise.all([a, b]);
}

const zustand = (id) => {
  const zeile = psql(`select deleted || '|' || status || '|' || (payload->>'grossAmount') || '|' ||
    (select coalesce(sum(amount), 0) from public.workspace_expense_payments p where p.workspace_id = e.workspace_id and p.client_expense_id = e.client_expense_id and reversed_at is null)
    from public.workspace_expenses e where workspace_id = '${WS}' and client_expense_id = ${lit(id)};`);
  const [deleted, status, gross, paid] = zeile.split('|');
  return { deleted: deleted === 'true', status, gross: Number(gross), paid: Number(paid) };
};

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
const kurz = (s) => (s.match(/ERROR:\s+([^\n]+)/)?.[1] ?? s.split('\n').pop() ?? '').slice(0, 100);
const fmt = (z) => `deleted=${z.deleted}, status=${z.status}, brutto=${z.gross}, gezahlt=${z.paid}`;

const davor = zeilenStand();
aufraeumen();
try {
  psql(`
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('${NUTZER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fc01a-inventur-ausgaben-parallel@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null where email = 'fc01a-inventur-ausgaben-parallel@example.invalid';
insert into public.workspaces (id, name, owner_user_id) values ('${WS}', 'FC01A Inventur Ausgaben parallel', '${NUTZER}');
insert into public.workspace_members (workspace_id, user_id, role, status) values ('${WS}', '${NUTZER}', 'owner', 'active');
begin;
${ALS}${['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'].map((id) => upsert(id)).join('')}${zahlen('e8', 'e8-p', 119)}
commit;`);

  const faelle = [
    ['E1 Löschen gegen Zahlung', upsert('e1', { deleted: true }), zahlen('e1', 'e1-p', 119), (a, b, z) => a.code === 0 && b.code !== 0 && /Ausgabe geloescht/.test(b.ausgabe) && z.deleted && z.paid === 0],
    ['E2 Zahlung gegen Löschen', zahlen('e2', 'e2-p', 119), upsert('e2', { deleted: true }), (a, b, z) => a.code === 0 && b.code !== 0 && /Ausgabe hat gebuchte Zahlungen/.test(b.ausgabe) && !z.deleted && z.paid === 119],
    ['E3 Storno gegen Zahlung', upsert('e3', { status: 'storniert' }), zahlen('e3', 'e3-p', 119), (a, b, z) => a.code === 0 && b.code !== 0 && /Ausgabe storniert/.test(b.ausgabe) && z.status === 'storniert' && z.paid === 0],
    ['E4 Zahlung gegen Storno', zahlen('e4', 'e4-p', 119), upsert('e4', { status: 'storniert' }), (a, b, z) => a.code === 0 && b.code !== 0 && /expense_cancel_has_payments/.test(b.ausgabe) && z.status === 'gebucht' && z.paid === 119],
    ['E5 Betragsänderung gegen Zahlung', upsert('e5', { gross: 238 }), zahlen('e5', 'e5-p', 238), (a, b, z) => a.code === 0 && b.code === 0 && b.ms >= 1500 && z.gross === 238 && z.paid === 238],
    ['E6 Zahlung gegen Betragsänderung', zahlen('e6', 'e6-p', 119), upsert('e6', { gross: 238 }), (a, b, z) => a.code === 0 && b.code !== 0 && /expense_amount_locked_after_payment/.test(b.ausgabe) && z.gross === 119 && z.paid === 119],
    ['E7 Zahlung gegen zweite Zahlung', zahlen('e7', 'e7-p1', 119), zahlen('e7', 'e7-p2', 119), (a, b, z) => a.code === 0 && b.code !== 0 && /expense_payment_overpayment_unconfirmed/.test(b.ausgabe) && z.paid === 119],
    ['E8 Rücknahme gegen Storno', zuruecknehmen('e8', 'e8-p'), upsert('e8', { status: 'storniert' }), (a, b, z) => a.code === 0 && b.code === 0 && b.ms >= 1500 && z.status === 'storniert' && z.paid === 0],
  ];
  for (const [name, sqlA, sqlB, erwartet] of faelle) {
    const id = name.slice(0, 2).toLowerCase();
    const [a, b] = await wettlauf(sqlA, sqlB);
    const z = zustand(id);
    pruefe(name, erwartet(a, b, z), `A exit ${a.code}; B exit ${b.code} nach ${b.ms} ms (${kurz(b.ausgabe)}); ${fmt(z)}`);
  }
  {
    const widerspruch = psql(`
select count(*) from public.workspace_expenses e
where e.workspace_id = '${WS}' and (e.deleted or e.status = 'storniert')
  and exists (select 1 from public.workspace_expense_payments p where p.workspace_id = e.workspace_id and p.client_expense_id = e.client_expense_id and p.reversed_at is null);`);
    pruefe('Endprüfung: keine gelöschte oder stornierte Ausgabe mit aktiver Zahlung', widerspruch === '0', `${widerspruch} Widersprüche`);
    const ueber = psql(`
select count(*) from public.workspace_expenses e
where e.workspace_id = '${WS}' and (select coalesce(sum(round(p.amount * 100)), 0) from public.workspace_expense_payments p
  where p.workspace_id = e.workspace_id and p.client_expense_id = e.client_expense_id and p.reversed_at is null) > round((e.payload->>'grossAmount')::numeric * 100);`);
    pruefe('Endprüfung: keine unbestätigte Überzahlung', ueber === '0', `${ueber} überzahlt`);
  }
} finally {
  aufraeumen();
  const danach = zeilenStand();
  pruefe('Aufräumen: Zeilenzahlen davor = danach', davor === danach, davor === danach ? 'gleich' : 'ABWEICHEND');
}

const fehl = ergebnisse.filter((e) => !e.ok).length;
console.log(fehl === 0 ? 'ALLE WETTLAEUFE OHNE FEHLZUSTAND' : `${fehl} FEHLZUSTAND/FEHLZUSTAENDE`);
process.exitCode = fehl === 0 ? 0 : 1;
