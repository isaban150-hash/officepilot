// EINRICHTUNG-01 / AP1 -- Wettlaeufe der Zugriffsregel (Katalog V3: Z-09.1, Z-09.2, Z-10.3, N-Z4.1, N-Z4.2).
//
// Nur gegen die LOKALE Datenbank (Docker-Container supabase_db_officepilot), niemals remote. Legt eigene synthetische
// Konten an und entfernt sie samt ihrer Betriebe am Ende wieder (Zeilenzahlen davor = danach werden geprueft).
// Alle Sitzungen sind vorab verbunden; B wartet in der Datenbank, bis A nachweislich in pg_sleep steht und ihre Sperren
// haelt. Dass B hinter A wartet, belegt ein Beobachter, der pg_stat_activity im Server abtastet (keine Zeitschwellen,
// kein Abtasten per docker exec, das unter Last Sekunden braucht).
//
//   Z-09.1  neues lizenziertes Konto: A ruft ensure in offener Transaktion, B danach -> B wartet, liefert denselben
//           Betrieb; genau ein Betrieb, genau eine Inhaber-Mitgliedschaft
//   Z-09.2  Konto mit Betrieb: gleichzeitiges ensure -> kein weiterer Betrieb
//   Z-10.3  Mutation: dieselbe Funktion ohne Kontosperre (Kopie, nur fuer diesen Lauf) -> zwei Betriebe (rot = erkannt)
//   N-Z4.1  Admin schreibt, gleichzeitig wird die Betriebslizenz entzogen -- in beiden Reihenfolgen eindeutig:
//           Schreiben vollstaendig vor der Aenderung, oder Abweisung danach
//   N-Z4.2  dito mit Herabstufung des Admins zum Mitglied
//
// Aufruf:  node supabase/tests/einrichtung01_ap1_parallel.mjs
// Exit 0 = alle Wettlaeufe eindeutig und die Mutation erkannt.
import { spawn, spawnSync } from 'node:child_process';

const CONTAINER = 'supabase_db_officepilot';
const K = {
  neu: '00000000-0000-0000-0000-0000000e1901',
  mitBetrieb: '00000000-0000-0000-0000-0000000e1902',
  mutation: '00000000-0000-0000-0000-0000000e1903',
  inhaber: '00000000-0000-0000-0000-0000000e1904',
  admin: '00000000-0000-0000-0000-0000000e1905',
};
const WS_Z092 = '00000000-0000-0000-0000-0000000e19b2';
const WS_NZ4 = '00000000-0000-0000-0000-0000000e19b4';

function psql(sql, { erlaubeFehler = false } = {}) {
  const r = spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' });
  if (r.status !== 0 && !erlaubeFehler) throw new Error(`psql: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
// Haltezeit von A in Sekunden.
const SCHLAF = 4;

// Vorab verbundene Sitzung: docker exec und Verbindungsaufbau laufen vor dem Wettlauf, das SQL geht erst mit senden()
// hinaus. -q: ohne Befehlsstatus, damit die letzte Zeile das Ergebnis der Abfrage ist.
const BEREIT = 'ap1-sitzung-bereit';
function oeffneSitzung() {
  const kind = spawn('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1']);
  let ausgabe = '';
  let meldeBereit;
  const bereitSignal = new Promise((r) => { meldeBereit = r; });
  const ende = new Promise((r) => kind.on('close', (code) => { meldeBereit(false); r(code); }));
  kind.stdout.on('data', (d) => {
    ausgabe += d;
    if (ausgabe.includes(BEREIT)) meldeBereit(true);
  });
  kind.stderr.on('data', (d) => { ausgabe += d; });
  kind.stdin.write(`select '${BEREIT}';\n`);
  const bereit = Promise.race([bereitSignal, warte(60000).then(() => false)]);
  return {
    bereit,
    async senden(sql) {
      if (!(await bereit)) throw new Error(`Sitzung nicht bereit: ${ausgabe.slice(0, 500)}`);
      ausgabe = '';
      const start = Date.now();
      kind.stdin.end(sql);
      const code = await ende;
      return { code, ms: Date.now() - start, ausgabe: ausgabe.trim() };
    },
  };
}
const sitzung = (sql) => oeffneSitzung().senden(sql);

// B wartet im Server (als postgres), bis A in pg_sleep steht. Das Muster ist zusammengesetzt, damit dieser Block selbst
// nicht darauf passt; pg_stat_clear_snapshot holt je Runde einen frischen Stand.
const WARTE_AUF_A = `do $$
declare ende timestamptz := clock_timestamp() + interval '60 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    exit when exists (select 1 from pg_stat_activity where query ilike '%pg_' || 'sleep(${SCHLAF})%' and state = 'active' and pid <> pg_backend_pid());
    if clock_timestamp() > ende then raise exception 'A_SCHLAEFT_NICHT'; end if;
    perform pg_sleep(0.01);
  end loop;
end $$;
`;

// Beobachter im Server: Steht eine Sitzung mit diesem Abfragetext in einer Sperrwartezeit?
function beobachter(muster, sek) {
  const m = muster.replace(/'/g, "''");
  return `do $$
declare hoechst int := 0; n int; ende timestamptz := clock_timestamp() + interval '${sek} seconds';
begin
  while clock_timestamp() < ende and hoechst < 1 loop
    perform pg_stat_clear_snapshot();
    select count(*) into n from pg_stat_activity
     where wait_event_type = 'Lock' and query ilike '%' || '${m}' || '%' and pid <> pg_backend_pid();
    hoechst := greatest(hoechst, n);
    perform pg_sleep(0.01);
  end loop;
  raise notice 'BEOBACHTET=%', hoechst;
end $$;
`;
}

const als = (nutzer) =>
  `select set_config('request.jwt.claims', '{"sub":"${nutzer}","role":"authenticated"}', true);\nset local role authenticated;\n`;

/** A haelt ihre Sperren SCHLAF Sekunden; B laeuft, sobald A schlaeft. sperreMuster: Aufruf von B, dessen Warten belegt wird. */
async function wettlauf(sqlA, sqlB, { sperreMuster = null } = {}) {
  const sa = oeffneSitzung();
  const sb = oeffneSitzung();
  const so = sperreMuster ? oeffneSitzung() : null;
  await Promise.all([sa.bereit, sb.bereit, so ? so.bereit : true]);
  const o = so ? so.senden(beobachter(sperreMuster, SCHLAF + 3)) : Promise.resolve(null);
  const b = sb.senden(`begin;\n${WARTE_AUF_A}${sqlB}commit;\n`);
  const a = sa.senden(`begin;\n${sqlA}select pg_sleep(${SCHLAF});\ncommit;\n`);
  const [ra, rb, ro] = await Promise.all([a, b, o]);
  const schlaeft = !rb.ausgabe.includes('A_SCHLAEFT_NICHT');
  const bWartete = ro ? Number(ro.ausgabe.match(/BEOBACHTET=(\d+)/)?.[1] ?? 0) >= 1 : null;
  return { ra, rb, schlaeft, bWartete };
}

const kurz = (s) => (s.match(/ERROR:\s+([^\n]+)/)?.[1] ?? '').slice(0, 120);
const ergebnisse = [];
function pruefe(name, ok, text) {
  ergebnisse.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FEHLZUSTAND'} ${name}: ${text}`);
}

function zeilenStand() {
  return psql(`
select string_agg(t.relname || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', t.nspname, t.relname), false, true, '')))[1]::text, ',' order by t.relname)
from (select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = 'users'))) t;`);
}

function aufraeumen() {
  const konten = Object.values(K).map((k) => `'${k}'`).join(', ');
  psql(`
drop function if exists public.zz_ap1_probe_ensure_ohne_sperre(text);
do $$
declare t record; w record; v_rest int; v_runde int;
begin
  for w in select id from public.workspaces where owner_user_id in (${konten}) or id in ('${WS_Z092}', '${WS_NZ4}') loop
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
  delete from public.workspace_members where user_id in (${konten});
  delete from auth.users where id in (${konten});
end $$;`);
}

const betriebe = (nutzer) => Number(psql(`select count(*) from public.workspaces where owner_user_id = '${nutzer}';`));
const inhaberMitgliedschaften = (nutzer) => Number(psql(`select count(*) from public.workspace_members where user_id = '${nutzer}' and role = 'owner';`));
const kunde = (id) => Number(psql(`select count(*) from public.workspace_customers where workspace_id = '${WS_NZ4}' and customer_id = '${id}';`));
const kundeSql = (id) =>
  `select public.upsert_workspace_sync_entity('${WS_NZ4}', 'customer', '{"customer_id":"${id}","payload":{"name":"${id}"}}'::jsonb, 0);\n`;

const davor = zeilenStand();
aufraeumen();
let exitCode = 0;
try {
  psql(`
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.email, 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb
from (values ('${K.neu}', 'neu-ap1par@example.invalid'), ('${K.mitBetrieb}', 'betrieb-ap1par@example.invalid'),
             ('${K.mutation}', 'mutation-ap1par@example.invalid'), ('${K.inhaber}', 'inhaber-ap1par@example.invalid'),
             ('${K.admin}', 'admin-ap1par@example.invalid')) as u(id, email);
update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
where id in (${Object.values(K).map((k) => `'${k}'`).join(', ')});
insert into public.workspaces (id, name, owner_user_id) values ('${WS_Z092}', 'AP1 parallel Z-09.2', '${K.mitBetrieb}'), ('${WS_NZ4}', 'AP1 parallel N-Z4', '${K.inhaber}');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('${WS_Z092}', '${K.mitBetrieb}', 'owner', 'active'), ('${WS_NZ4}', '${K.inhaber}', 'owner', 'active'), ('${WS_NZ4}', '${K.admin}', 'admin', 'active');
`);

  /* ---------------- Z-09.1 ---------------- */
  {
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      `${als(K.neu)}select (public.ensure_personal_workspace('A')->'workspace'->>'id');\n`,
      `${als(K.neu)}select (public.ensure_personal_workspace('B')->'workspace'->>'id');\n`,
      { sperreMuster: "ensure_personal_workspace('B')" },
    );
    const idA = ra.ausgabe.split('\n').find((z) => /^[0-9a-f-]{36}$/.test(z));
    const idB = rb.ausgabe.split('\n').find((z) => /^[0-9a-f-]{36}$/.test(z));
    pruefe('Z-09.1', schlaeft && bWartete && ra.code === 0 && rb.code === 0 && idA && idA === idB && betriebe(K.neu) === 1 && inhaberMitgliedschaften(K.neu) === 1,
      `A ${idA}, B ${idB}, B ${bWartete ? 'wartete auf die Sperre von A' : 'OHNE Sperrwartezeit'} (${rb.ms} ms); Betriebe ${betriebe(K.neu)}, Inhaber-Mitgliedschaften ${inhaberMitgliedschaften(K.neu)}`);
  }

  /* ---------------- Z-09.2 ---------------- */
  {
    const { ra, rb } = await wettlauf(
      `${als(K.mitBetrieb)}select (public.ensure_personal_workspace(null)->>'created');\n`,
      `${als(K.mitBetrieb)}select (public.ensure_personal_workspace(null)->>'created');\n`,
    );
    pruefe('Z-09.2', ra.code === 0 && rb.code === 0 && ra.ausgabe.includes('false') && rb.ausgabe.includes('false') && betriebe(K.mitBetrieb) === 1,
      `created A/B ${ra.ausgabe.split('\n').pop()}/${rb.ausgabe.split('\n').pop()}; Betriebe ${betriebe(K.mitBetrieb)}`);
  }

  /* ---------------- Z-10.3 Mutation ---------------- */
  {
    const def = psql(`select pg_get_functiondef('public.ensure_personal_workspace(text)'::regprocedure);`);
    const sperrZeile = /^\s*perform pg_advisory_xact_lock\(.*\);\s*$/m;
    if (!sperrZeile.test(def)) throw new Error('Z-10.3: Sperrzeile in ensure_personal_workspace nicht gefunden');
    const kopie = def
      .replace(/CREATE OR REPLACE FUNCTION public\.ensure_personal_workspace\(/, 'CREATE OR REPLACE FUNCTION public.zz_ap1_probe_ensure_ohne_sperre(')
      .replace(sperrZeile, '  -- MUTATION Z-10.3: Kontosperre entfernt');
    psql(`${kopie};\ngrant execute on function public.zz_ap1_probe_ensure_ohne_sperre(text) to authenticated;`);
    const { ra, rb } = await wettlauf(
      `${als(K.mutation)}select (public.zz_ap1_probe_ensure_ohne_sperre('A')->'workspace'->>'id');\n`,
      `${als(K.mutation)}select (public.zz_ap1_probe_ensure_ohne_sperre('B')->'workspace'->>'id');\n`,
    );
    psql('drop function public.zz_ap1_probe_ensure_ohne_sperre(text);');
    const n = betriebe(K.mutation);
    pruefe('Z-10.3 (Mutation erkannt)', ra.code === 0 && rb.code === 0 && n === 2,
      `ohne Sperre entstehen ${n} Betriebe (erwartet 2 = Wettlauf sichtbar; mit Sperre 1, siehe Z-09.1)`);
  }

  /* ---------------- N-Z4.1 Lizenzentzug ---------------- */
  {
    // Reihenfolge 1: Admin schreibt zuerst und haelt die Sperre; der Entzug wartet.
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      `${als(K.admin)}${kundeSql('cust-nz41a')}`,
      `update public.profiles set license_status = 'expired' where id = '${K.inhaber}';\n`,
      { sperreMuster: 'set license_status' },
    );
    const danach = await sitzung(`begin;\n${als(K.admin)}${kundeSql('cust-nz41c')}commit;\n`);
    pruefe('N-Z4.1 Schreiben vor Entzug', schlaeft && bWartete && ra.code === 0 && rb.code === 0 && kunde('cust-nz41a') === 1
      && danach.code !== 0 && kurz(danach.ausgabe).startsWith('license_not_effective') && kunde('cust-nz41c') === 0,
      `Schreiben ok, Entzug ${bWartete ? 'wartete auf die Sperre' : 'OHNE Sperrwartezeit'} (${rb.ms} ms); danach: ${kurz(danach.ausgabe)}`);

    // Reihenfolge 2: Der Entzug haelt die Sperre; der Admin schreibt danach und wird abgewiesen.
    psql(`update public.profiles set license_status = 'active' where id = '${K.inhaber}';`);
    const r2 = await wettlauf(
      `update public.profiles set license_status = 'expired' where id = '${K.inhaber}';\n`,
      `${als(K.admin)}${kundeSql('cust-nz41b')}`,
      { sperreMuster: 'cust-nz41b' },
    );
    pruefe('N-Z4.1 Entzug vor Schreiben', r2.schlaeft && r2.bWartete && r2.ra.code === 0 && r2.rb.code !== 0
      && kurz(r2.rb.ausgabe).startsWith('license_not_effective') && kunde('cust-nz41b') === 0,
      `Schreiben ${r2.bWartete ? 'wartete auf die Sperre' : 'OHNE Sperrwartezeit'} (${r2.rb.ms} ms), dann ${kurz(r2.rb.ausgabe)}`);
    psql(`update public.profiles set license_status = 'active' where id = '${K.inhaber}';`);
  }

  /* ---------------- N-Z4.2 Herabstufung ---------------- */
  {
    const herabstufen = `update public.workspace_members set role = 'member' where workspace_id = '${WS_NZ4}' and user_id = '${K.admin}';\n`;
    const aufstufen = `update public.workspace_members set role = 'admin' where workspace_id = '${WS_NZ4}' and user_id = '${K.admin}';`;
    // Reihenfolge 1: Admin schreibt zuerst; die Herabstufung wartet.
    const { ra, rb, schlaeft, bWartete } = await wettlauf(`${als(K.admin)}${kundeSql('cust-nz42a')}`, herabstufen, { sperreMuster: 'workspace_members set role' });
    const danach = await sitzung(`begin;\n${als(K.admin)}${kundeSql('cust-nz42c')}commit;\n`);
    pruefe('N-Z4.2 Schreiben vor Herabstufung', schlaeft && bWartete && ra.code === 0 && rb.code === 0 && kunde('cust-nz42a') === 1
      && danach.code !== 0 && kunde('cust-nz42c') === 0,
      `Schreiben ok, Herabstufung ${bWartete ? 'wartete auf die Sperre' : 'OHNE Sperrwartezeit'} (${rb.ms} ms); danach: ${kurz(danach.ausgabe)}`);

    // Reihenfolge 2: Die Herabstufung haelt die Sperre; der Admin prueft seine Rolle noch vor deren Abschluss,
    // wartet dann an der Sperre und wird danach abgewiesen -- kein Schreiben mit der alten Rolle.
    psql(aufstufen);
    const r2 = await wettlauf(herabstufen, `${als(K.admin)}${kundeSql('cust-nz42b')}`, { sperreMuster: 'cust-nz42b' });
    const grund = kurz(r2.rb.ausgabe);
    pruefe('N-Z4.2 Herabstufung vor Schreiben', r2.schlaeft && r2.bWartete && r2.ra.code === 0 && r2.rb.code !== 0
      && (grund.startsWith('workspace_access_changed') || grund.startsWith('workspace_forbidden_role')) && kunde('cust-nz42b') === 0,
      `Schreiben ${r2.bWartete ? 'wartete auf die Sperre' : 'OHNE Sperrwartezeit'} (${r2.rb.ms} ms), dann ${grund}`);
    psql(aufstufen);
  }
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  aufraeumen();
}

const danach = zeilenStand();
pruefe('Aufraeumen (Zeilen davor = danach)', davor === danach, davor === danach ? 'unveraendert' : 'Abweichung');
if (exitCode !== 0 || ergebnisse.some((e) => !e.ok)) process.exit(1);
