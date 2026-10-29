// EINRICHTUNG-01 / AP4 -- Wettlaeufe Team, Einladung, Uebergabe, Plattform (Katalog V3: Z-09.5, N-Z5.3, N-M1.1,
// N-M1.2, N-M2.2, N-M2.3 (jeweils beide Reihenfolgen), N-M2.4, N-M2.6, P-03.3, P-06.3).
//
// Nur gegen die LOKALE Datenbank (Docker-Container supabase_db_officepilot), niemals remote. Legt eigene synthetische
// Konten und Betriebe an und entfernt sie am Ende wieder (Zeilenzahlen davor = danach werden geprueft). Alle Sitzungen
// sind vorab verbunden. B wartet in der Datenbank, bis A nachweislich in pg_sleep steht und ihre Sperren haelt; ein
// Beobachter tastet pg_stat_activity im Server ab und belegt die Sperrwartezeit von B (keine Zeitschwellen, kein
// Abtasten per docker exec, das unter Last Sekunden braucht). Jeder Fall prueft die Eindeutigkeit des Ergebnisses, nicht
// eine bestimmte Reihenfolge, soweit der Katalog beide zulaesst.
//
// Aufruf:  node supabase/tests/einrichtung01_ap4_parallel.mjs
// Exit 0 = alle Wettlaeufe eindeutig.
import { spawn, spawnSync } from 'node:child_process';

const CONTAINER = 'supabase_db_officepilot';
// Haltezeit von A: lang genug, dass die Erkennung auch unter Last (langsames docker exec) in die Haltephase faellt.
const SCHLAF = 4;
const K = {
  o1: '00000000-0000-0000-0000-0000000e4f01',
  al: '00000000-0000-0000-0000-0000000e4f02',
  x1: '00000000-0000-0000-0000-0000000e4f03',
  x2: '00000000-0000-0000-0000-0000000e4f04',
  x3: '00000000-0000-0000-0000-0000000e4f05',
  x4: '00000000-0000-0000-0000-0000000e4f06',
  pa1: '00000000-0000-0000-0000-0000000e4f07',
  pa2: '00000000-0000-0000-0000-0000000e4f08',
  z: '00000000-0000-0000-0000-0000000e4f09',
  am: '00000000-0000-0000-0000-0000000e4f0a',
};
const W1 = '00000000-0000-0000-0000-0000000e4fa1';
// Eigene Betriebe fuer die Reihenfolge „Annahme zuerst“ (N-M2.2, N-M2.3): Dort wechselt der Inhaber, W1 bleibt bei O1.
const W2 = '00000000-0000-0000-0000-0000000e4fa2';
const W3 = '00000000-0000-0000-0000-0000000e4fa3';
// Eigener Betrieb fuer die Mutationsprobe M-19.3 (Barriere): Dort darf die Kopie ohne Neupruefung wirken.
const W4 = '00000000-0000-0000-0000-0000000e4fa4';

function psql(sql, { erlaubeFehler = false } = {}) {
  const r = spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' });
  if (r.status !== 0 && !erlaubeFehler) throw new Error(`psql: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const warte = (ms) => new Promise((r) => setTimeout(r, ms));

// Vorab verbundene Sitzung: docker exec und Verbindungsaufbau laufen vor dem Wettlauf, das eigentliche SQL geht erst mit
// senden() hinaus. So haengt der Wettlauf nicht an der Startzeit von docker exec (unter Last bis zu Sekunden), und `ms`
// misst nur die Ausfuehrung einschliesslich Sperrwartezeit.
// -q: ohne Befehlsstatus (BEGIN, SET, COMMIT), damit die letzte Zeile das Ergebnis der Abfrage ist.
const BEREIT = 'ap4-sitzung-bereit';
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

// B wartet im Server (als postgres, also mit Sicht auf alle Abfragetexte), bis A in pg_sleep steht. Das Muster ist
// zusammengesetzt, damit dieser Block selbst nicht darauf passt; pg_stat_clear_snapshot holt je Runde einen frischen Stand.
const SCHLAF_MUSTER = `'%pg_' || 'sleep(${SCHLAF})%'`;
const WARTE_AUF_A = `do $$
declare ende timestamptz := clock_timestamp() + interval '60 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    exit when exists (select 1 from pg_stat_activity where query ilike ${SCHLAF_MUSTER} and state = 'active' and pid <> pg_backend_pid());
    if clock_timestamp() > ende then raise exception 'A_SCHLAEFT_NICHT'; end if;
    perform pg_sleep(0.01);
  end loop;
end $$;
`;

// Beobachter im Server: hoechste Zahl gleichzeitig in einer Sperrwartezeit stehender Sitzungen mit diesem Aufruf; mit
// inhaberVon zusaetzlich die Zahl der owner dieses Betriebs in jeder Probe (dann ueber die ganze Dauer, ohne Abbruch).
function beobachter({ muster, ziel, sek, inhaberVon = null }) {
  const inhaberProbe = inhaberVon
    ? `select count(*) into i from public.workspace_members where workspace_id = '${inhaberVon}' and role = 'owner' and status = 'active';
    i_min := least(coalesce(i_min, i), i);
    i_max := greatest(coalesce(i_max, i), i);`
    : `exit when hoechst >= ${ziel};`;
  return `do $$
declare
  hoechst int := 0; n int; i int; proben int := 0; i_min int; i_max int;
  ende timestamptz := clock_timestamp() + interval '${sek} seconds';
begin
  while clock_timestamp() < ende loop
    perform pg_stat_clear_snapshot();
    select count(*) into n from pg_stat_activity
     where wait_event_type = 'Lock' and query ilike '%' || '${muster}' || '%' and pid <> pg_backend_pid();
    hoechst := greatest(hoechst, n);
    proben := proben + 1;
    ${inhaberProbe}
    perform pg_sleep(0.01);
  end loop;
  raise notice 'BEOBACHTET=% PROBEN=% INHABER_MIN=% INHABER_MAX=%', hoechst, proben, coalesce(i_min, -1), coalesce(i_max, -1);
end $$;
`;
}

function auswertung(r) {
  const m = r?.ausgabe.match(/BEOBACHTET=(\d+) PROBEN=(\d+) INHABER_MIN=(-?\d+) INHABER_MAX=(-?\d+)/);
  return m
    ? { wartende: Number(m[1]), proben: Number(m[2]), inhaberMin: Number(m[3]), inhaberMax: Number(m[4]) }
    : { wartende: 0, proben: 0, inhaberMin: -1, inhaberMax: -1 };
}

const als = (nutzer) =>
  `select set_config('request.jwt.claims', '{"sub":"${nutzer}","role":"authenticated"}', true);\nset local role authenticated;\n`;

// sperreMuster: Aufruf von B, dessen Sperrwartezeit hinter A der Beobachter belegen soll.
async function wettlauf(sqlA, sqlB, { sperreMuster = null } = {}) {
  const sa = oeffneSitzung();
  const sb = oeffneSitzung();
  const so = sperreMuster ? oeffneSitzung() : null;
  await Promise.all([sa.bereit, sb.bereit, so ? so.bereit : true]);
  const o = so ? so.senden(beobachter({ muster: sperreMuster, ziel: 1, sek: SCHLAF + 3 })) : Promise.resolve(null);
  const b = sb.senden(`begin;\n${WARTE_AUF_A}${sqlB}commit;\n`);
  const a = sa.senden(`begin;\n${sqlA}select pg_sleep(${SCHLAF});\ncommit;\n`);
  const [ra, rb, ro] = await Promise.all([a, b, o]);
  const schlaeft = !rb.ausgabe.includes('A_SCHLAEFT_NICHT');
  const bWartete = so ? auswertung(ro).wartende >= 1 : null;
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

const konten = Object.values(K).map((k) => `'${k}'`).join(', ');

function aufraeumen() {
  psql(`
drop function if exists public.zz_ap4_probe_accept_ohne_neupruefung(uuid, uuid);
alter table public.workspace_member_events disable trigger einrichtung01_audit_immutable;
alter table public.platform_admin_events disable trigger einrichtung01_audit_immutable;
do $$
declare t record; w record; v_rest int; v_runde int;
begin
  for w in select id from public.workspaces where owner_user_id in (${konten}) or id = '${W1}' loop
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
  delete from public.platform_admin_events where actor_user_id in (${konten}) or target_user_id in (${konten});
  delete from public.einrichtung_request_log where actor_user_id in (${konten});
  delete from public.workspace_invitation_attempts where user_id in (${konten});
  delete from public.workspace_members where user_id in (${konten});
  delete from auth.users where id in (${konten});
end $$;
alter table public.workspace_member_events enable trigger einrichtung01_audit_immutable;
alter table public.platform_admin_events enable trigger einrichtung01_audit_immutable;`);
}

function einladung(email, rolle = 'member') {
  return psql(`
begin;
${als(K.o1)}
select public.team_invite('${W1}', '${email}', '${rolle}', gen_random_uuid())->>'token';
commit;`).split('\n').find((z) => /^[A-Za-z0-9_-]{40,}$/.test(z));
}

const mitglieder = (nutzer, ws = W1) => Number(psql(`select count(*) from public.workspace_members where workspace_id = '${ws}' and user_id = '${nutzer}' and status = 'active';`));
const eigeneBetriebe = (nutzer) => Number(psql(`select count(*) from public.workspaces where owner_user_id = '${nutzer}';`));
const ereignisse = (aktion, ziel) => Number(psql(`select count(*) from public.workspace_member_events where workspace_id = '${W1}' and action = '${aktion}' and target_user_id = '${ziel}';`));
const inhaberZahl = (ws = W1) => Number(psql(`select count(*) from public.workspace_members where workspace_id = '${ws}' and role = 'owner' and status = 'active';`));
const inhaber = (ws = W1) => psql(`select owner_user_id from public.workspaces where id = '${ws}';`);
const rolle = (nutzer, ws) => psql(`select role || '/' || status from public.workspace_members where workspace_id = '${ws}' and user_id = '${nutzer}';`);

const davor = zeilenStand();
aufraeumen();
let exitCode = 0;
try {
  psql(`
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.email, 'x', now(), now(), now(), '{}'::jsonb, '{"firstName":"AP4","lastName":"Parallel"}'::jsonb
from (values ('${K.o1}', 'o1-ap4par@example.invalid'), ('${K.al}', 'al-ap4par@example.invalid'), ('${K.x1}', 'x1-ap4par@example.invalid'),
             ('${K.x2}', 'x2-ap4par@example.invalid'), ('${K.x3}', 'x3-ap4par@example.invalid'), ('${K.x4}', 'x4-ap4par@example.invalid'),
             ('${K.pa1}', 'pa1-ap4par@example.invalid'), ('${K.pa2}', 'pa2-ap4par@example.invalid'), ('${K.z}', 'z-ap4par@example.invalid'),
             ('${K.am}', 'am-ap4par@example.invalid')) as u(id, email);
update public.profiles set status = 'approved' where id in (${konten});
update public.profiles set license_status = 'active', license_expires_at = null where id in ('${K.o1}', '${K.al}', '${K.x1}', '${K.am}', '${K.z}');
update public.profiles set role = 'admin' where id in ('${K.pa1}', '${K.pa2}');
update public.profiles set license_status = 'active', license_expires_at = now() + interval '20 days' where id = '${K.z}';
insert into public.workspaces (id, name, owner_user_id) values ('${W1}', 'AP4 parallel', '${K.o1}'), ('${W2}', 'AP4 parallel 2', '${K.o1}'), ('${W3}', 'AP4 parallel 3', '${K.o1}'), ('${W4}', 'AP4 parallel 4', '${K.o1}');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('${W1}', '${K.o1}', 'owner', 'active'), ('${W1}', '${K.al}', 'admin', 'active'), ('${W1}', '${K.am}', 'admin', 'active'),
       ('${W2}', '${K.o1}', 'owner', 'active'), ('${W2}', '${K.al}', 'admin', 'active'),
       ('${W3}', '${K.o1}', 'owner', 'active'), ('${W3}', '${K.al}', 'admin', 'active'),
       ('${W4}', '${K.o1}', 'owner', 'active'), ('${W4}', '${K.al}', 'admin', 'active');
`);

  /* ---------------- Z-09.5 offene Einladung, paralleles ensure ---------------- */
  {
    einladung('x1-ap4par@example.invalid');
    const { ra, rb, schlaeft } = await wettlauf(
      `${als(K.x1)}select public.ensure_personal_workspace('A')->>'reason';\n`,
      `${als(K.x1)}select public.ensure_personal_workspace('B')->>'reason';\n`,
    );
    pruefe('Z-09.5', schlaeft && ra.code === 0 && rb.code === 0 && ra.ausgabe.endsWith('invitation_pending') && rb.ausgabe.endsWith('invitation_pending') && eigeneBetriebe(K.x1) === 0,
      `A ${ra.ausgabe.split('\n').pop()}, B ${rb.ausgabe.split('\n').pop()}; eigene Betriebe ${eigeneBetriebe(K.x1)}`);
  }

  /* ---------------- N-Z5.3 Annahme parallel zum ersten ensure (lizenzlos) ---------------- */
  {
    const token = einladung('x2-ap4par@example.invalid');
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      `${als(K.x2)}select public.accept_invitation(null, '${token}', gen_random_uuid())->>'status';\n`,
      `${als(K.x2)}select coalesce(public.ensure_personal_workspace(null)->'workspace'->>'id', public.ensure_personal_workspace(null)->>'reason');\n`,
      { sperreMuster: 'ensure_personal_workspace(null)' },
    );
    pruefe('N-Z5.3', schlaeft && bWartete && ra.code === 0 && rb.code === 0 && ra.ausgabe.endsWith('accepted') && rb.ausgabe.endsWith(W1) && mitglieder(K.x2) === 1 && eigeneBetriebe(K.x2) === 0,
      `Annahme ${ra.ausgabe.split('\n').pop()}, ensure ${bWartete ? 'wartete auf die Sperre der Annahme' : 'OHNE Sperrwartezeit'} (${rb.ms} ms) ${rb.ausgabe.split('\n').pop()}; Mitgliedschaften ${mitglieder(K.x2)}, eigene Betriebe ${eigeneBetriebe(K.x2)}`);
  }

  /* ---------------- N-M1.1 zwei Annahmen desselben Kontos ---------------- */
  {
    const token = einladung('x3-ap4par@example.invalid');
    const { ra, rb, schlaeft } = await wettlauf(
      `${als(K.x3)}select public.accept_invitation(null, '${token}', gen_random_uuid())->>'status';\n`,
      `${als(K.x3)}select public.accept_invitation(null, '${token}', gen_random_uuid())->>'status';\n`,
    );
    pruefe('N-M1.1', schlaeft && ra.code === 0 && rb.code === 0 && ra.ausgabe.endsWith('accepted') && rb.ausgabe.endsWith('already_member') && mitglieder(K.x3) === 1 && ereignisse('invitation_accepted', K.x3) === 1,
      `A ${ra.ausgabe.split('\n').pop()}, B ${rb.ausgabe.split('\n').pop()}; Mitgliedschaften ${mitglieder(K.x3)}, Annahme-Eintraege ${ereignisse('invitation_accepted', K.x3)}`);
  }

  /* ---------------- N-M1.2 Annahme und Widerruf parallel (beide Reihenfolgen) ---------------- */
  for (const reihenfolge of ['Annahme zuerst', 'Widerruf zuerst']) {
    psql(`update public.workspace_members set status = 'removed' where workspace_id = '${W1}' and user_id = '${K.x4}';
          update public.workspace_invitations set status = 'revoked' where workspace_id = '${W1}' and email = 'x4-ap4par@example.invalid' and status = 'open';`);
    const token = einladung('x4-ap4par@example.invalid');
    const inv = psql(`select id from public.workspace_invitations where workspace_id = '${W1}' and email = 'x4-ap4par@example.invalid' and status = 'open';`);
    const annahme = `${als(K.x4)}select public.accept_invitation(null, '${token}', gen_random_uuid())->>'status';\n`;
    const widerruf = `${als(K.o1)}select public.team_revoke_invitation('${inv}', gen_random_uuid())->>'status';\n`;
    const { ra, rb, schlaeft } = reihenfolge === 'Annahme zuerst' ? await wettlauf(annahme, widerruf) : await wettlauf(widerruf, annahme);
    const status = psql(`select status from public.workspace_invitations where id = '${inv}';`);
    const mitglied = mitglieder(K.x4);
    const eindeutig = (status === 'accepted' && mitglied === 1) || (status === 'revoked' && mitglied === 0);
    pruefe(`N-M1.2 (${reihenfolge})`, schlaeft && ra.code === 0 && rb.code === 0 && eindeutig, `Einladung ${status}, Mitgliedschaft ${mitglied}`);
  }

  /* ---------------- Uebergabe O1 -> AL (Antrag) ---------------- */
  const antrag = (ws = W1) =>
    psql(`begin;\n${als(K.o1)}select public.team_request_transfer('${ws}', '${K.al}', gen_random_uuid())->>'transfer_id';\ncommit;`)
      .split('\n').find((z) => /^[0-9a-f-]{36}$/.test(z));

  /* ---------------- N-M2.2 Annahme und Widerruf parallel ---------------- */
  {
    const tr = antrag();
    const { ra, rb, schlaeft } = await wettlauf(
      `${als(K.o1)}select public.team_revoke_transfer('${tr}', gen_random_uuid())->>'status';\n`,
      `${als(K.al)}select public.team_accept_transfer('${tr}', gen_random_uuid())->>'status';\n`,
    );
    const status = psql(`select status from public.workspace_ownership_transfers where id = '${tr}';`);
    pruefe('N-M2.2', schlaeft && ra.code === 0 && status === 'revoked' && rb.code !== 0 && kurz(rb.ausgabe).startsWith('transfer_not_open') && inhaber() === K.o1 && inhaberZahl() === 1,
      `Widerruf zuerst: Antrag ${status}, Annahme ${kurz(rb.ausgabe)}; Inhaber unveraendert`);
  }

  /* ---------------- N-M2.3 Annahme und Entzug der Zielmitgliedschaft parallel ---------------- */
  {
    const tr = antrag();
    const { ra, rb, schlaeft } = await wettlauf(
      `${als(K.o1)}select public.team_remove_member('${W1}', '${K.al}', gen_random_uuid())->>'status';\n`,
      `${als(K.al)}select public.team_accept_transfer('${tr}', gen_random_uuid())->>'status';\n`,
    );
    pruefe('N-M2.3', schlaeft && ra.code === 0 && rb.code !== 0 && inhaber() === K.o1 && inhaberZahl() === 1 && mitglieder(K.al) === 0,
      `Entzug zuerst: Annahme ${kurz(rb.ausgabe)}; Inhaber ${inhaber() === K.o1 ? 'O1' : 'anders'}`);
    psql(`update public.workspace_members set status = 'active' where workspace_id = '${W1}' and user_id = '${K.al}';`);
  }

  /* ---------------- N-M2.2 / N-M2.3 Gegenreihenfolge: Annahme zuerst (eigene Betriebe W2, W3) ---------------- */
  {
    const tr = antrag(W2);
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      `${als(K.al)}select public.team_accept_transfer('${tr}', gen_random_uuid())->>'status';\n`,
      `${als(K.o1)}select public.team_revoke_transfer('${tr}', gen_random_uuid())->>'status';\n`,
      { sperreMuster: 'team_revoke_transfer' },
    );
    const status = psql(`select status from public.workspace_ownership_transfers where id = '${tr}';`);
    // Der zu spaete Widerruf erfaehrt den Stand („accepted“, ohne Aenderung) statt einer Rollenmeldung.
    pruefe('N-M2.2 (Annahme zuerst)', schlaeft && bWartete && ra.code === 0 && ra.ausgabe.endsWith('accepted') && rb.code === 0 && rb.ausgabe.endsWith('accepted') && status === 'accepted' && inhaber(W2) === K.al && inhaberZahl(W2) === 1 && rolle(K.o1, W2) === 'admin/active',
      `Annahme ${ra.ausgabe.split('\n').pop()}, Widerruf ${bWartete ? 'wartete' : 'OHNE Sperrwartezeit'}, dann ${rb.code === 0 ? `Stand ${rb.ausgabe.split('\n').pop()}` : kurz(rb.ausgabe)}; Antrag ${status}; Inhaber ${inhaber(W2) === K.al ? 'AL' : 'anders'}, O1 ${rolle(K.o1, W2)}`);
  }
  {
    const tr = antrag(W3);
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      `${als(K.al)}select public.team_accept_transfer('${tr}', gen_random_uuid())->>'status';\n`,
      `${als(K.o1)}select public.team_remove_member('${W3}', '${K.al}', gen_random_uuid())->>'status';\n`,
      { sperreMuster: 'team_remove_member' },
    );
    // Nach der Uebergabe ist O1 admin; der neue Inhaber AL ist durch Admins nicht entfernbar.
    pruefe('N-M2.3 (Annahme zuerst)', schlaeft && bWartete && ra.code === 0 && ra.ausgabe.endsWith('accepted') && rb.code !== 0 && inhaber(W3) === K.al && inhaberZahl(W3) === 1 && rolle(K.al, W3) === 'owner/active',
      `Annahme ${ra.ausgabe.split('\n').pop()}, Entzug ${bWartete ? 'wartete' : 'OHNE Sperrwartezeit'}, dann ${kurz(rb.ausgabe)}; Inhaber ${inhaber(W3) === K.al ? 'AL' : 'anders'}, AL ${rolle(K.al, W3)}`);
  }

  /* ---------------- N-M2.4 Annahme und Ablauf der Ziellizenz parallel ---------------- */
  {
    const tr = antrag();
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      `update public.profiles set license_status = 'expired' where id = '${K.al}';\n`,
      `${als(K.al)}select public.team_accept_transfer('${tr}', gen_random_uuid())->>'status';\n`,
      { sperreMuster: 'team_accept_transfer' },
    );
    pruefe('N-M2.4', schlaeft && bWartete && ra.code === 0 && rb.code !== 0 && kurz(rb.ausgabe).startsWith('team_target_invalid') && inhaber() === K.o1,
      `Ablauf zuerst: Annahme ${bWartete ? 'wartete auf die Sperre' : 'OHNE Sperrwartezeit'} (${rb.ms} ms), dann ${kurz(rb.ausgabe)}`);
    psql(`update public.profiles set license_status = 'active' where id = '${K.al}';`);
  }

  /* ---------------- M-19.3 Mutation (Barriere): dieselbe Annahme ohne Neupruefung unter Sperre ---------------- */
  // Kopie nur fuer diesen Lauf (das Original bleibt unberuehrt), Betrieb W4. Rot = erkannt: Die Annahme gelingt trotz
  // inzwischen abgelaufener Ziellizenz, AL wird Inhaber. Danach wird die Kopie entfernt und W4 nicht weiter genutzt.
  {
    const def = psql(`select pg_get_functiondef('public.team_accept_transfer(uuid,uuid)'::regprocedure);`);
    const pruefung = /^\s*if public\.workspace_account_blocked\(v_user_id\) or not public\.einrichtung01_transfer_target_ok\(v_transfer\.workspace_id, v_user_id\) then\n\s*raise exception 'team_target_invalid:[^\n]*\n\s*end if;\n/m;
    if (!pruefung.test(def)) throw new Error('M-19.3: Neupruefung in team_accept_transfer nicht gefunden');
    const kopie = def
      .replace(/CREATE OR REPLACE FUNCTION public\.team_accept_transfer\(/, 'CREATE OR REPLACE FUNCTION public.zz_ap4_probe_accept_ohne_neupruefung(')
      .replace(pruefung, '  -- MUTATION M-19.3: erneute Pruefung entfernt\n');
    psql(`${kopie};\ngrant execute on function public.zz_ap4_probe_accept_ohne_neupruefung(uuid, uuid) to authenticated;`);
    const tr = antrag(W4);
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      `update public.profiles set license_status = 'expired' where id = '${K.al}';\n`,
      `${als(K.al)}select public.zz_ap4_probe_accept_ohne_neupruefung('${tr}', gen_random_uuid())->>'status';\n`,
      { sperreMuster: 'zz_ap4_probe_accept_ohne_neupruefung' },
    );
    psql('drop function public.zz_ap4_probe_accept_ohne_neupruefung(uuid, uuid);');
    psql(`update public.profiles set license_status = 'active' where id = '${K.al}';`);
    pruefe('M-19.3 (Mutation, Barriere erkannt)', schlaeft && bWartete && ra.code === 0 && rb.code === 0 && rb.ausgabe.endsWith('accepted') && inhaber(W4) === K.al,
      `ohne Neupruefung: Annahme ${rb.code === 0 ? rb.ausgabe.split('\n').pop() : kurz(rb.ausgabe)} trotz abgelaufener Ziellizenz, Inhaber ${inhaber(W4) === K.al ? 'AL (rot = erkannt; mit Neupruefung abgewiesen, siehe N-M2.4)' : 'unveraendert (NICHT erkannt)'}`);
  }

  /* ---------------- N-M2.6 waehrend der Uebergabe: genau ein owner, keine Zwischenberechtigung ---------------- */
  {
    const tr = antrag();
    const sAnnahme = oeffneSitzung();
    const sO1 = oeffneSitzung();
    const sAl = oeffneSitzung();
    const sBeob = oeffneSitzung();
    await Promise.all([sAnnahme.bereit, sO1.bereit, sAl.bereit, sBeob.bereit]);
    // Der Beobachter tastet ueber die ganze Uebergabe ab: Sperrwartende Finanzaktionen und Zahl der owner je Probe.
    const beob = sBeob.senden(beobachter({ muster: 'set_workspace_invoice_number_format', ziel: 2, sek: SCHLAF + 2, inhaberVon: W1 }));
    const finanz = (s, nutzer) =>
      s.senden(`begin;\n${WARTE_AUF_A}${als(nutzer)}select public.set_workspace_invoice_number_format('${W1}', 'AP4', true, 4, 0);\ncommit;\n`);
    const finanzO1 = finanz(sO1, K.o1);
    const finanzAl = finanz(sAl, K.al);
    const annahme = sAnnahme.senden(`begin;\n${als(K.al)}select public.team_accept_transfer('${tr}', gen_random_uuid())->>'status';\nselect pg_sleep(${SCHLAF});\ncommit;\n`);
    const [ra, ro, rl, rb] = await Promise.all([annahme, finanzO1, finanzAl, beob]);
    const b = auswertung(rb);
    const schlaeft = ![ro, rl].some((r) => r.ausgabe.includes('A_SCHLAEFT_NICHT'));
    const danach = inhaberZahl();
    // Beide Finanzaktionen warten auf die Uebergabe (keine Zwischenberechtigung) und laufen danach mit ihrer neuen Rolle
    // (O1 admin, AL owner; owner/admin duerfen). In jeder Probe genau ein owner.
    pruefe('N-M2.6', schlaeft && ra.code === 0 && ra.ausgabe.split('\n').some((z) => z === 'accepted') && b.proben >= 20 && b.inhaberMin === 1 && b.inhaberMax === 1 && danach === 1 && inhaber() === K.al && b.wartende >= 2 && ro.code === 0 && rl.code === 0,
      `owner je Probe ${b.inhaberMin}..${b.inhaberMax} (${b.proben} Proben), danach ${danach}; in Sperrwartezeit gleichzeitig ${b.wartende}; Finanzaktion O1 nach ${ro.ms} ms ${ro.code === 0 ? 'als admin ausgefuehrt' : kurz(ro.ausgabe)}, AL nach ${rl.ms} ms ${rl.code === 0 ? 'als owner ausgefuehrt' : kurz(rl.ausgabe)}`);
  }

  /* ---------------- P-03.3 zwei Admins sperren sich gegenseitig ---------------- */
  {
    const ausgangAdmins = Number(psql(`select count(*) from public.profiles where role = 'admin' and status is distinct from 'blocked';`));
    const { ra, rb, schlaeft } = await wettlauf(
      `${als(K.pa1)}select (public.admin_block_user('${K.pa2}', gen_random_uuid())).status;\n`,
      `${als(K.pa2)}select (public.admin_block_user('${K.pa1}', gen_random_uuid())).status;\n`,
    );
    const pa1 = psql(`select status from public.profiles where id = '${K.pa1}';`);
    const pa2 = psql(`select status from public.profiles where id = '${K.pa2}';`);
    const aktiv = Number(psql(`select count(*) from public.profiles where role = 'admin' and status is distinct from 'blocked';`));
    pruefe('P-03.3', schlaeft && ra.code === 0 && rb.code !== 0 && pa2 === 'blocked' && pa1 !== 'blocked' && aktiv === ausgangAdmins - 1 && aktiv >= 1,
      `PA1 ${pa1}, PA2 ${pa2}; zweite Sperre: ${kurz(rb.ausgabe)}; aktive Admins ${aktiv}`);
    psql(`update public.profiles set status = 'approved' where id in ('${K.pa1}', '${K.pa2}');`);
  }

  /* ---------------- P-06.3 zwei Admins verlaengern parallel mit gleichem gesehenem Ablauf ---------------- */
  {
    const gesehen = psql(`select license_expires_at from public.profiles where id = '${K.z}';`);
    const { ra, rb, schlaeft } = await wettlauf(
      `${als(K.pa1)}select (public.admin_extend_license('${K.z}', '${gesehen}', gen_random_uuid())).license_expires_at;\n`,
      `${als(K.pa2)}select (public.admin_extend_license('${K.z}', '${gesehen}', gen_random_uuid())).license_expires_at;\n`,
    );
    const ablauf = psql(`select (license_expires_at - '${gesehen}'::timestamptz) = interval '30 days' from public.profiles where id = '${K.z}';`);
    pruefe('P-06.3', schlaeft && ra.code === 0 && rb.code !== 0 && kurz(rb.ausgabe).startsWith('admin_license_conflict') && ablauf === 't',
      `zweite Verlaengerung: ${kurz(rb.ausgabe)}; Ablauf genau +30 Tage: ${ablauf}`);
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
