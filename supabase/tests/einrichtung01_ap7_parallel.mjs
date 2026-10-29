// EINRICHTUNG-01 / AP7 -- Wettlaeufe der Loeschung (Szenariopaket Fassung 2): L-02.5 (Uebergabe und Reparatur nach 1.6a,
// jeweils beide Reihenfolgen), L-02.6 (beide Reihenfolgen), L-02.7, L-04.5 (beide Reihenfolgen), L-05.5.
//
// NUR in der Wegwerf-Kopie nach den Migrationen AP6 und AP7 (Werkzeug pruefunterlagen/einrichtung-01/werkzeug/ap6/
// ap-sql-isoliert.mjs, Option --parallel). Der Container steht in EIN01_KOPIE; gegen den bestehenden Stack
// (supabase_db_officepilot) verweigert das Skript den Lauf. In der Kopie bleiben die Testzeilen bestehen; sie wird danach
// entfernt.
//
// Methode wie einrichtung01_ap4_parallel.mjs: alle Sitzungen vorab verbunden; A haelt ihre Sperren in pg_sleep, B wartet im
// Server, bis A nachweislich schlaeft, ein Beobachter belegt die Sperrwartezeit von B. Jeder Fall prueft die Eindeutigkeit
// des Ergebnisses und die Invariante, nicht eine bestimmte Reihenfolge, soweit der Katalog beide zulaesst.
//
// Aufruf (durch das Werkzeug):  EIN01_KOPIE=<container> node supabase/tests/einrichtung01_ap7_parallel.mjs
// Exit 0 = alle Wettlaeufe eindeutig.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const CONTAINER = process.env.EIN01_KOPIE ?? '';
if (!CONTAINER || CONTAINER === 'supabase_db_officepilot') {
  console.error('STOPP: nur in der Wegwerf-Kopie (EIN01_KOPIE) ausfuehren, nie gegen den bestehenden Stack.');
  process.exit(2);
}
const SCHLAF = 4;

const id = (praefix, n) => `00000000-0000-0000-0000-0000000e7${praefix}${String(n).padStart(2, '0')}`;
const K = {
  o: id('a', 1), // Inhaber der Uebergabe-, Einladungs- und Loeschbetriebe
  ob: id('a', 2), // gesperrter Inhaber (Reparatur 1.6a)
  al1: id('a', 3), al2: id('a', 4), al3: id('a', 5), al4: id('a', 6), // Ziele (Admins)
  m3a: id('a', 7), m3b: id('a', 8), // Eingeladene
  pa1: id('a', 9), pa2: id('a', 10), // die einzigen Plattform-Admins
};
const W = {
  t1: id('b', 1), t2: id('b', 2), r1: id('b', 3), r2: id('b', 4), inv: id('b', 5), d1: id('b', 6), d2: id('b', 7), l: id('b', 8),
};
const email = (schluessel) => `${schluessel}-ap7par@example.invalid`;

function psql(sql, { erlaubeFehler = false } = {}) {
  const r = spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' });
  if (r.status !== 0 && !erlaubeFehler) throw new Error(`psql: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

const BEREIT = 'ap7-sitzung-bereit';
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

function beobachter(muster, sek) {
  return `do $$
declare hoechst int := 0; n int; ende timestamptz := clock_timestamp() + interval '${sek} seconds';
begin
  while clock_timestamp() < ende loop
    perform pg_stat_clear_snapshot();
    select count(*) into n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%' || '${muster}' || '%' and pid <> pg_backend_pid();
    hoechst := greatest(hoechst, n);
    exit when hoechst >= 1;
    perform pg_sleep(0.01);
  end loop;
  raise notice 'BEOBACHTET=%', hoechst;
end $$;
`;
}

const als = (nutzer) =>
  `select set_config('request.jwt.claims', '{"sub":"${nutzer}","role":"authenticated"}', true);\nset local role authenticated;\n`;

async function wettlauf(sqlA, sqlB, sperreMuster) {
  const sa = oeffneSitzung();
  const sb = oeffneSitzung();
  const so = oeffneSitzung();
  await Promise.all([sa.bereit, sb.bereit, so.bereit]);
  const o = so.senden(beobachter(sperreMuster, SCHLAF + 3));
  const b = sb.senden(`begin;\n${WARTE_AUF_A}${sqlB}commit;\n`);
  const a = sa.senden(`begin;\n${sqlA}select pg_sleep(${SCHLAF});\ncommit;\n`);
  const [ra, rb, ro] = await Promise.all([a, b, o]);
  return {
    ra,
    rb,
    schlaeft: !rb.ausgabe.includes('A_SCHLAEFT_NICHT'),
    bWartete: Number(ro.ausgabe.match(/BEOBACHTET=(\d+)/)?.[1] ?? 0) >= 1,
  };
}

const ergebnisse = [];
function pruefe(name, ok, text) {
  ergebnisse.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FEHLZUSTAND'} ${name}: ${text}`);
}
const letzte = (r) => r.ausgabe.split('\n').filter(Boolean).pop() ?? '';
const fehler = (r) => (r.ausgabe.match(/ERROR:\s+([^\n]+)/)?.[1] ?? '').slice(0, 160);

/** Nachweis wie die Edge Function ihn nach erfolgreicher Passwortpruefung ausstellt: Zufallstoken, beim Server nur der Hash. */
function nachweis(nutzer, aktion, ws, anfrage) {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const v = psql(`select public.destructive_action_issue('${nutzer}', '${aktion}', ${ws ? `'${ws}'` : 'null'}, '${anfrage}', '${hash}')::text;`);
  if (!v.includes('"ok": true') && !v.includes('"ok":true')) throw new Error(`Nachweis nicht ausgestellt: ${v}`);
  return token;
}
const anfrage = () => crypto.randomUUID();
const kontoLoeschen = (nutzer, schluessel) => {
  const r = anfrage();
  const token = nachweis(nutzer, 'account_delete', null, r);
  return `${als(nutzer)}select public.account_deletion_begin('${r}', '${token}', '${email(schluessel)}')::text;\n`;
};
const loeschauftrag = (nutzer) => Number(psql(`select count(*) from public.account_deletion_jobs where user_id = '${nutzer}';`));
const aktiveMitgliedschaften = (nutzer) => Number(psql(`select count(*) from public.workspace_members where user_id = '${nutzer}' and status = 'active';`));
const inhaber = (ws) => psql(`select owner_user_id from public.workspaces where id = '${ws}';`);
// Invariante (L-02.5/L-02.6): kein Konto im Loeschauftrag ist Inhaber oder aktives Mitglied.
const invariante = () => Number(psql(`select count(*) from public.account_deletion_jobs j
  join public.workspace_members m on m.user_id = j.user_id and m.status = 'active';`)) +
  Number(psql(`select count(*) from public.account_deletion_jobs j join public.workspaces w on w.owner_user_id = j.user_id;`));

let exitCode = 0;
try {
  const alle = Object.entries(K);
  psql(`
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.email, 'x', now(), now(), now(), '{}'::jsonb, '{"firstName":"AP7","lastName":"Parallel"}'::jsonb
from (values ${alle.map(([s, k]) => `('${k}', '${email(s)}')`).join(', ')}) as u(id, email);
update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null where id in (${alle.map(([, k]) => `'${k}'`).join(', ')});
-- Nur PA1 und PA2 sind Plattform-Admins (die Kopie traegt keine anderen Konten).
update public.profiles set role = 'user' where role = 'admin';
update public.profiles set role = 'admin' where id in ('${K.pa1}', '${K.pa2}');
insert into public.workspaces (id, name, owner_user_id) values
  ('${W.t1}', 'AP7 T1', '${K.o}'), ('${W.t2}', 'AP7 T2', '${K.o}'), ('${W.r1}', 'AP7 R1', '${K.ob}'), ('${W.r2}', 'AP7 R2', '${K.ob}'),
  ('${W.inv}', 'AP7 Einladung', '${K.o}'), ('${W.d1}', 'AP7 D1', '${K.o}'), ('${W.d2}', 'AP7 D2', '${K.o}'), ('${W.l}', 'AP7 L', '${K.o}');
insert into public.workspace_members (workspace_id, user_id, role, status) values
  ('${W.t1}', '${K.o}', 'owner', 'active'), ('${W.t1}', '${K.al1}', 'admin', 'active'),
  ('${W.t2}', '${K.o}', 'owner', 'active'), ('${W.t2}', '${K.al2}', 'admin', 'active'),
  ('${W.r1}', '${K.ob}', 'owner', 'active'), ('${W.r1}', '${K.al3}', 'admin', 'active'),
  ('${W.r2}', '${K.ob}', 'owner', 'active'), ('${W.r2}', '${K.al4}', 'admin', 'active'),
  ('${W.inv}', '${K.o}', 'owner', 'active'), ('${W.d1}', '${K.o}', 'owner', 'active'), ('${W.d2}', '${K.o}', 'owner', 'active'), ('${W.l}', '${K.o}', 'owner', 'active');
insert into public.workspace_company_profiles (workspace_id, payload, row_version, updated_by)
select w, jsonb_build_object('companyName', n), 1, '${K.o}'::uuid from (values ('${W.d1}'::uuid, 'AP7 D1'), ('${W.d2}'::uuid, 'AP7 D2'), ('${W.l}'::uuid, 'AP7 L')) as x(w, n);
`);

  /* ---------------- L-02.7 die beiden letzten Plattform-Admins loeschen gleichzeitig ---------------- */
  {
    const { ra, rb, schlaeft, bWartete } = await wettlauf(kontoLoeschen(K.pa1, 'pa1'), kontoLoeschen(K.pa2, 'pa2'), 'account_deletion_begin');
    const auftraege = loeschauftrag(K.pa1) + loeschauftrag(K.pa2);
    const zweiterAbgewiesen = letzte(rb).includes('last_platform_admin') || letzte(ra).includes('last_platform_admin');
    pruefe('L-02.7', schlaeft && ra.code === 0 && rb.code === 0 && auftraege === 1 && zweiterAbgewiesen,
      `A ${letzte(ra).slice(0, 90)}; B ${letzte(rb).slice(0, 90)}; Auftraege ${auftraege}; B wartete auf Sperre: ${bWartete}`);
  }
  // Fuer die Reparatur braucht es einen Plattform-Admin ohne Loeschauftrag.
  const pa = loeschauftrag(K.pa1) === 0 ? K.pa1 : K.pa2;

  /* ---------------- L-02.5 Uebergabe-Annahme gegen Kontoloeschung des Ziels (beide Reihenfolgen) ---------------- */
  const uebergabe = (ws, ziel) =>
    psql(`begin;\n${als(K.o)}select public.team_request_transfer('${ws}', '${ziel}', gen_random_uuid())->>'transfer_id';\ncommit;`)
      .split('\n').find((z) => /^[0-9a-f-]{36}$/.test(z));
  {
    const tr = uebergabe(W.t1, K.al1);
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      `${als(K.al1)}select public.team_accept_transfer('${tr}', gen_random_uuid())->>'status';\n`,
      kontoLoeschen(K.al1, 'al1'),
      'account_deletion_begin',
    );
    const ok = schlaeft && ra.code === 0 && inhaber(W.t1) === K.al1 && loeschauftrag(K.al1) === 0 && letzte(rb).includes('account_owner');
    pruefe('L-02.5 Uebergabe zuerst', ok && invariante() === 0, `A ${letzte(ra)}; B ${letzte(rb).slice(0, 90)}${fehler(rb) ? ` (${fehler(rb)})` : ''}; Inhaber ${inhaber(W.t1) === K.al1 ? 'AL1' : 'O'}; B wartete: ${bWartete}`);
  }
  {
    const tr = uebergabe(W.t2, K.al2);
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      kontoLoeschen(K.al2, 'al2'),
      `${als(K.al2)}select public.team_accept_transfer('${tr}', gen_random_uuid())->>'status';\n`,
      'team_accept_transfer',
    );
    const ok = schlaeft && ra.code === 0 && loeschauftrag(K.al2) === 1 && inhaber(W.t2) === K.o && aktiveMitgliedschaften(K.al2) === 0;
    pruefe('L-02.5 Kontoloeschung zuerst', ok && invariante() === 0, `A ${letzte(ra).slice(0, 90)}; B ${letzte(rb) || fehler(rb)}; Inhaber ${inhaber(W.t2) === K.o ? 'O' : 'AL2'}; B wartete: ${bWartete}`);
  }

  /* ---------------- L-02.5 mit Reparatur nach 1.6a (Inhaber gesperrt), beide Reihenfolgen ---------------- */
  psql(`update public.profiles set status = 'blocked' where id = '${K.ob}';`);
  const reparatur = (ws, ziel) =>
    psql(`begin;\n${als(pa)}select public.platform_request_ownership_repair('${ws}', '${ziel}', gen_random_uuid())->>'transfer_id';\ncommit;`)
      .split('\n').find((z) => /^[0-9a-f-]{36}$/.test(z));
  {
    const tr = reparatur(W.r1, K.al3);
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      `${als(K.al3)}select public.team_accept_transfer('${tr}', gen_random_uuid())->>'status';\n`,
      kontoLoeschen(K.al3, 'al3'),
      'account_deletion_begin',
    );
    const ok = Boolean(tr) && schlaeft && ra.code === 0 && inhaber(W.r1) === K.al3 && loeschauftrag(K.al3) === 0 && letzte(rb).includes('account_owner');
    pruefe('L-02.5 Reparatur zuerst', ok && invariante() === 0, `Reparatur ${tr ? 'beantragt' : 'FEHLT'}; A ${letzte(ra)}; B ${letzte(rb).slice(0, 90)}; B wartete: ${bWartete}`);
  }
  {
    const tr = reparatur(W.r2, K.al4);
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      kontoLoeschen(K.al4, 'al4'),
      `${als(K.al4)}select public.team_accept_transfer('${tr}', gen_random_uuid())->>'status';\n`,
      'team_accept_transfer',
    );
    const ok = Boolean(tr) && schlaeft && ra.code === 0 && loeschauftrag(K.al4) === 1 && inhaber(W.r2) === K.ob && aktiveMitgliedschaften(K.al4) === 0;
    pruefe('L-02.5 Kontoloeschung vor der Reparatur', ok && invariante() === 0, `A ${letzte(ra).slice(0, 90)}; B ${letzte(rb) || fehler(rb)}; B wartete: ${bWartete}`);
  }

  /* ---------------- L-02.6 Einladungsannahme gegen Kontoloeschung (beide Reihenfolgen) ---------------- */
  const einladung = (adresse) =>
    psql(`begin;\n${als(K.o)}select public.team_invite('${W.inv}', '${adresse}', 'member', gen_random_uuid())->>'token';\ncommit;`)
      .split('\n').find((z) => /^[A-Za-z0-9_-]{40,}$/.test(z));
  {
    const token = einladung(email('m3a'));
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      kontoLoeschen(K.m3a, 'm3a'),
      `${als(K.m3a)}select public.accept_invitation(null, '${token}', gen_random_uuid())->>'status';\n`,
      'accept_invitation',
    );
    pruefe('L-02.6 Kontoloeschung zuerst', schlaeft && ra.code === 0 && loeschauftrag(K.m3a) === 1 && aktiveMitgliedschaften(K.m3a) === 0 && invariante() === 0,
      `A ${letzte(ra).slice(0, 90)}; B ${letzte(rb) || fehler(rb)}; aktive Mitgliedschaften ${aktiveMitgliedschaften(K.m3a)}; B wartete: ${bWartete}`);
  }
  {
    const token = einladung(email('m3b'));
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      `${als(K.m3b)}select public.accept_invitation(null, '${token}', gen_random_uuid())->>'status';\n`,
      kontoLoeschen(K.m3b, 'm3b'),
      'account_deletion_begin',
    );
    // Annahme zuerst: Mitglied (kein Inhaber); die Loeschung beginnt danach und beendet die Mitgliedschaft.
    pruefe('L-02.6 Annahme zuerst', schlaeft && ra.code === 0 && rb.code === 0 && loeschauftrag(K.m3b) === 1 && aktiveMitgliedschaften(K.m3b) === 0 && invariante() === 0,
      `A ${letzte(ra)}; B ${letzte(rb).slice(0, 90)}; aktive Mitgliedschaften ${aktiveMitgliedschaften(K.m3b)}; B wartete: ${bWartete}`);
  }

  /* ---------------- L-04.5 Ausfuehrungsbeginn gegen Widerruf (beide Reihenfolgen) ---------------- */
  const fassung = psql(`select public.workspace_deletion_notice_version();`);
  const antrag = (ws, name) => {
    const r = anfrage();
    const token = nachweis(K.o, 'workspace_delete_request', ws, r);
    const v = psql(`begin;\n${als(K.o)}select public.workspace_request_deletion('${ws}', '${name}', '${fassung}', '${token}', '${r}')::text;\ncommit;`);
    if (!/"state": ?"open"/.test(v)) throw new Error(`Antrag fuer ${name} nicht offen: ${v}`);
    psql(`update public.workspace_deletion_requests set execute_after = now() - interval '1 minute' where workspace_id = '${ws}' and state = 'open';`);
  };
  const zustand = (ws) => psql(`select string_agg(state, ',' order by requested_at) from public.workspace_deletion_requests where workspace_id = '${ws}';`);
  {
    antrag(W.d1, 'AP7 D1');
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      `select public.workspace_deletion_begin('${W.d1}', gen_random_uuid(), 600)->>'state';\n`,
      `${als(K.o)}select public.workspace_revoke_deletion('${W.d1}', gen_random_uuid())::text;\n`,
      'workspace_revoke_deletion',
    );
    const z = zustand(W.d1);
    pruefe('L-04.5 Beginn zuerst', schlaeft && ra.code === 0 && z === 'deleting' && (letzte(rb).includes('deletion_in_progress') || fehler(rb).includes('deletion_in_progress')),
      `A ${letzte(ra)}; B ${(letzte(rb) || fehler(rb)).slice(0, 90)}; Zustand ${z}; B wartete: ${bWartete}`);
  }
  {
    antrag(W.d2, 'AP7 D2');
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      `${als(K.o)}select public.workspace_revoke_deletion('${W.d2}', gen_random_uuid())->>'state';\n`,
      `select public.workspace_deletion_begin('${W.d2}', gen_random_uuid(), 600)::text;\n`,
      'workspace_deletion_begin',
    );
    const z = zustand(W.d2);
    pruefe('L-04.5 Widerruf zuerst', schlaeft && ra.code === 0 && z === 'revoked' && /deletion_not_requested|not_requested/.test(letzte(rb) + fehler(rb)),
      `A ${letzte(ra)}; B ${(letzte(rb) || fehler(rb)).slice(0, 90)}; Zustand ${z}; B wartete: ${bWartete}`);
  }

  /* ---------------- L-05.5 zwei Laeufe gleichzeitig ---------------- */
  {
    antrag(W.l, 'AP7 L');
    const { ra, rb, schlaeft, bWartete } = await wettlauf(
      `select public.workspace_deletion_begin('${W.l}', gen_random_uuid(), 600)->>'state';\n`,
      `select public.workspace_deletion_begin('${W.l}', gen_random_uuid(), 600)::text;\n`,
      'workspace_deletion_begin',
    );
    const sperren = Number(psql(`select count(distinct lease_owner) from public.workspace_deletion_requests where workspace_id = '${W.l}' and state = 'deleting' and lease_owner is not null;`));
    pruefe('L-05.5', schlaeft && ra.code === 0 && letzte(ra) === 'deleting' && letzte(rb).includes('deletion_locked') && sperren === 1,
      `A ${letzte(ra)}; B ${letzte(rb).slice(0, 90)}; Sperrhalter ${sperren}; B wartete: ${bWartete}`);
  }
} catch (error) {
  console.error(`ABBRUCH: ${error.message}`);
  exitCode = 1;
}

const rot = ergebnisse.filter((e) => !e.ok);
console.log(`\nGESAMT ${ergebnisse.length}, OK ${ergebnisse.length - rot.length}, FEHLZUSTAND ${rot.length}`);
process.exit(exitCode || (rot.length ? 1 : 0));
