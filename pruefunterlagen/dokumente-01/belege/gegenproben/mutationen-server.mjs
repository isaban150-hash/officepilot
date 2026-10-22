// DOKUMENTE-01 — Server-Gegenproben: Migration mit je einer entfernten Schutzstelle in derselben
// zurückgerollten Transaktion wie der Vertragstest. Der Test MUSS an der erwarteten Stelle scheitern.
// Nur lokal, nichts bleibt bestehen. Aufruf aus dem Repo: node <dieses Skript>
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = process.cwd();
const M25 = readFileSync(join(REPO, 'supabase/migrations/20261125120000_dokumente01_aufbewahrung.sql'), 'utf8');
const M26 = readFileSync(join(REPO, 'supabase/migrations/20261126120000_dokumente01_papierregister.sql'), 'utf8');
const T25 = readFileSync(join(REPO, 'supabase/tests/dokumente01_aufbewahrung.sql'), 'utf8');
const T26 = readFileSync(join(REPO, 'supabase/tests/dokumente01_papierregister.sql'), 'utf8');

const rumpf = (sql) => sql.split('\n').filter((z) => z.trim() !== 'begin;' && z.trim() !== 'rollback;').join('\n');

function psql(input) {
  const r = spawnSync('docker', ['exec', '-i', 'supabase_db_officepilot', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  const fehler = (r.stderr || '').split('\n').filter((z) => /ERROR/.test(z)).slice(0, 1).join(' ');
  return { code: r.status, fehler };
}

function mutiere(text, alt, neu) {
  const treffer = text.split(alt).length - 1;
  if (treffer !== 1) throw new Error(`Anker ${treffer}×: ${alt.slice(0, 80)}`);
  return text.replace(alt, neu);
}

const FAELLE = [
  {
    id: 'S1 kein Grabstein-Abweis während der Frist',
    test: 'aufbewahrung',
    m25: (m) => mutiere(m, "  if coalesce(new.deleted, false) or new.deleted_at is not null then\n    raise exception 'Keine Schreibberechtigung: Aufbewahrungsfrist laeuft bis % (%, % Jahre)'",
      "  if false then\n    raise exception 'Keine Schreibberechtigung: Aufbewahrungsfrist laeuft bis % (%, % Jahre)'"),
    erwartet: 'A1',
  },
  {
    id: 'S2 Abschwächung der Einstufung erlaubt',
    test: 'aufbewahrung',
    m25: (m) => mutiere(m, "     < (case v_alt.klasse when 'buchungsbeleg' then 2 when 'geschaeftsbrief' then 1 else 0 end) then",
      "     < -1 then"),
    erwartet: 'C1',
  },
  {
    id: 'S3 Original-Bindung ohne Wächter',
    test: 'aufbewahrung',
    m25: (m) => `${m}\ndrop trigger workspace_document_file_bindings_retention_guard on public.workspace_document_file_bindings;\n`,
    erwartet: 'E1',
  },
  {
    id: 'S4 Datei ohne Wächter',
    test: 'aufbewahrung',
    m25: (m) => `${m}\ndrop trigger workspace_files_retention_guard on public.workspace_files;\n`,
    erwartet: 'E2',
  },
  {
    id: 'S5 Regel: Quittung kein Buchungsbeleg',
    test: 'aufbewahrung',
    m25: (m) => mutiere(m, "      'quittung', 'kassenbeleg',", "      'kassenbeleg',"),
    erwartet: 'V ',
  },
  {
    id: 'S6 Regel: Jahr in UTC statt Berliner Zeit',
    test: 'aufbewahrung',
    m25: (m) => mutiere(m, "    v_year := extract(year from (v_text::timestamptz at time zone 'Europe/Berlin'))::integer;",
      "    v_year := extract(year from (v_text::timestamptz at time zone 'UTC'))::integer;"),
    erwartet: 'V ',
  },
  {
    id: 'S7 Serveranlage zählt nicht mit',
    test: 'aufbewahrung',
    m25: (m) => mutiere(m, "      to_char(p_document.created_at at time zone 'Europe/Berlin', 'YYYY-MM-DD')\n", '      null\n'),
    erwartet: 'C4',
  },
  {
    id: 'S8 Ausgabenbeleg über gemeinsamen Eingang fehlt',
    test: 'aufbewahrung',
    m25: (m) => mutiere(m, '      and (e.archive_document_id = v_id or (v_origin is not null and e.linked_inbox_id = v_origin))',
      '      and e.archive_document_id = v_id'),
    erwartet: 'D2',
  },
  {
    id: 'S9 Rechte: authenticated darf die Regel ausführen',
    test: 'aufbewahrung',
    m25: (m) => `${m}\ngrant execute on function public.workspace_retention_rule(text, text, text, boolean, boolean, text[], integer, date) to authenticated;\n`,
    erwartet: 'G ',
  },
  {
    id: 'S10 F9: Eintrag gehört wieder dem Schreibenden',
    test: 'papierregister',
    m26: (m) => mutiere(m, '  if v_anleger is not null then\n    new.created_by := v_anleger;\n  end if;', '  null;'),
    erwartet: 'P1',
  },
  {
    id: 'S11 F9: Altbestand wird nicht umgestellt',
    test: 'papierregister',
    m26: (m) => mutiere(m, '      and e.created_by is distinct from d.created_by\n', '      and false\n'),
    erwartet: 'P5b',
  },
];

let fehlend = 0;
for (const fall of FAELLE) {
  const m25 = fall.m25 ? fall.m25(M25) : M25;
  const m26 = fall.m26 ? fall.m26(M26) : M26;
  const test = fall.test === 'aufbewahrung' ? T25 : T26;
  const lauf = psql(`begin;\n${m25}\n${m26}\n${rumpf(test)}\nrollback;\n`);
  const erkannt = lauf.code !== 0 && lauf.fehler.includes(fall.erwartet);
  if (!erkannt) fehlend += 1;
  console.log(`${erkannt ? 'ERKANNT' : 'NICHT ERKANNT'}  ${fall.id}  (Exit ${lauf.code}; ${lauf.fehler.slice(0, 170)})`);
}
// Unmutiert: beide Tests grün.
for (const [name, test] of [['aufbewahrung', T25], ['papierregister', T26]]) {
  const lauf = psql(`begin;\n${M25}\n${M26}\n${rumpf(test)}\nrollback;\n`);
  if (lauf.code !== 0) fehlend += 1;
  console.log(`${lauf.code === 0 ? 'GRÜN' : 'ROT'}  unmutiert ${name} (Exit ${lauf.code})`);
}
console.log(fehlend === 0 ? 'Alle Server-Gegenproben wie erwartet.' : `${fehlend} Abweichungen`);
process.exit(fehlend === 0 ? 0 : 1);
