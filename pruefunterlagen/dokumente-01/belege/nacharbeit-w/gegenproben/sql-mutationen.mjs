// DOKUMENTE-01 Nacharbeit W1/W2 — Mutationsgegenproben der neuen Serverregeln (nur lokal, alles zurückgerollt).
//
//   node pruefunterlagen/dokumente-01/belege/nacharbeit-w/gegenproben/sql-mutationen.mjs   (Aufruf aus dem Repo)
//
// Je Lauf: begin; Migration (ggf. mit genau einer Verfälschung); Vertragstest ohne begin/rollback; rollback.
// „erkannt" gilt nur, wenn der Lauf an der erwarteten Zusicherung scheitert (Kennung im Fehlertext) —
// ein Aufbau- oder Syntaxfehler zählt nicht. Die Kontrollläufe ohne Verfälschung müssen bestehen.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const HIER = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const lies = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const ohneRahmen = (sql) => sql.split('\n').filter((z) => z !== 'begin;' && z !== 'rollback;').join('\n');

const AUFBEWAHRUNG = 'supabase/migrations/20261125120000_dokumente01_aufbewahrung.sql';
const PAPIER = 'supabase/migrations/20261126120000_dokumente01_papierregister.sql';
const TEST_AUFBEWAHRUNG = 'supabase/tests/dokumente01_aufbewahrung.sql';
const TEST_PAPIER = 'supabase/tests/dokumente01_papierregister.sql';

function ersetze(text, alt, neu, name) {
  if (!text.includes(alt)) throw new Error(`${name}: Stelle nicht gefunden`);
  return text.replace(alt, neu);
}

const BINDUNG_TRIGGER = `  for each row
  execute function public.workspace_document_file_bindings_retention_guard();`;
const DATEI_TRIGGER = `  for each row
  execute function public.workspace_files_retention_guard();`;

const MUTATIONEN = [
  {
    name: 'M1 Bindungswächter wie vor W1 (nur Grabstein)', migration: AUFBEWAHRUNG, test: TEST_AUFBEWAHRUNG, erwartet: 'H1 ',
    an: (t) => ersetze(t, BINDUNG_TRIGGER, `  for each row\n  when (not old.deleted and new.deleted)\n  execute function public.workspace_document_file_bindings_retention_guard();`, 'M1'),
  },
  {
    name: 'M2 Dateiwechsel gilt als identische Wiederholung', migration: AUFBEWAHRUNG, test: TEST_AUFBEWAHRUNG, erwartet: 'H1 ',
    an: (t) => ersetze(t, '     and new.client_file_ref_id is not distinct from old.client_file_ref_id\n', '', 'M2'),
  },
  {
    name: 'M3 Betrieb nicht verglichen', migration: AUFBEWAHRUNG, test: TEST_AUFBEWAHRUNG, erwartet: 'H6c ',
    an: (t) => ersetze(t, '  if new.workspace_id = old.workspace_id\n     and new.client_document_id = old.client_document_id', '  if new.client_document_id = old.client_document_id', 'M3'),
  },
  {
    name: 'M4 Teil nicht verglichen', migration: AUFBEWAHRUNG, test: TEST_AUFBEWAHRUNG, erwartet: 'H6e ',
    an: (t) => ersetze(t, "     and coalesce(new.part, '') = coalesce(old.part, '')\n", '', 'M4'),
  },
  {
    name: 'M5 Dateiwächter wie vor W1 (nur Grabstein)', migration: AUFBEWAHRUNG, test: TEST_AUFBEWAHRUNG, erwartet: 'H7a ',
    an: (t) => ersetze(t, DATEI_TRIGGER, `  for each row\n  when (not old.deleted and new.deleted)\n  execute function public.workspace_files_retention_guard();`, 'M5'),
  },
  {
    // Erkannt an der identischen Wiederholung vor H5: Sie scheitert dann mit der Original-Abweisung.
    name: 'M6 Überschutz: keine identische Wiederholung mehr', migration: AUFBEWAHRUNG, test: TEST_AUFBEWAHRUNG, erwartet: 'Original eines Dokuments mit Aufbewahrungsfrist',
    an: (t) => ersetze(t, "     and not coalesce(new.deleted, false) then\n    return new;\n  end if;\n\n  select * into v_document", "     and not coalesce(new.deleted, false) and false then\n    return new;\n  end if;\n\n  select * into v_document", 'M6'),
  },
  {
    name: 'M7 kein Nachzug, wenn das Dokument nach dem Eintrag kommt', migration: PAPIER, test: TEST_PAPIER, erwartet: 'P7b ',
    // Der Trigger bleibt (P5 schaltet ihn im Aufbau kurz ab), seine Funktion tut nichts.
    an: (t) => ersetze(t, '  if new.created_by is null then\n    return null;\n  end if;\n  for v_eintrag in',
      '  return null;\n  for v_eintrag in', 'M7'),
  },
  {
    name: 'M8 Nachzug ohne Prüfspur', migration: PAPIER, test: TEST_PAPIER, erwartet: 'P7g ',
    an: (t) => ersetze(t, "      new.created_by, 'dokument_nachgereicht'\n    );", "      new.created_by, 'dokument_nachgereicht'\n    ) on conflict do nothing;\n    delete from public.workspace_paper_register_owner_changes where reason = 'dokument_nachgereicht';", 'M8'),
  },
  {
    name: 'M9 Nachzug betriebsübergreifend', migration: PAPIER, test: TEST_PAPIER, erwartet: 'P7l ',
    an: (t) => ersetze(t, '    where e.workspace_id = new.workspace_id\n      and e.client_document_id = new.client_document_id\n      and e.created_by is distinct from new.created_by\n    for update',
      '    where e.client_document_id = new.client_document_id\n      and e.created_by is distinct from new.created_by\n    for update', 'M9'),
  },
  {
    name: 'M10 Nachzug zählt die Version hoch', migration: PAPIER, test: TEST_PAPIER, erwartet: 'P7b ',
    an: (t) => ersetze(t, '    set created_by = new.created_by\n    where id = v_eintrag.id;', '    set created_by = new.created_by, row_version = row_version + 1\n    where id = v_eintrag.id;', 'M10'),
  },
  {
    name: 'M11 Anlage ohne Prüfspur', migration: PAPIER, test: TEST_PAPIER, erwartet: 'P5f ',
    an: (t) => ersetze(t, "      new.workspace_id, new.client_entry_id, new.client_document_id, new.created_by, v_anleger, 'anlage'\n    );",
      "      new.workspace_id, new.client_entry_id, new.client_document_id, new.created_by, v_anleger, 'anlage'\n    );\n    delete from public.workspace_paper_register_owner_changes where reason = 'anlage';", 'M11'),
  },
];

function lauf(migrationText, testPfad) {
  const sql = ['begin;', migrationText, ohneRahmen(lies(testPfad)), 'rollback;'].join('\n');
  const r = spawnSync('docker', ['exec', '-i', 'supabase_db_officepilot', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ausgabe = `${r.stdout}\n${r.stderr}`;
  const fehler = (ausgabe.match(/ERROR:\s+(.*)/) ?? [])[1] ?? null;
  const bestanden = (ausgabe.match(/NOTICE:\s+(OK|ABGEWIESEN)\s/g) ?? []).length;
  return { code: r.status, fehler, bestanden };
}

const ergebnis = { zeit: new Date().toISOString(), kontrolle: [], mutationen: [] };
for (const [m, t] of [[AUFBEWAHRUNG, TEST_AUFBEWAHRUNG], [PAPIER, TEST_PAPIER]]) {
  const r = lauf(lies(m), t);
  ergebnis.kontrolle.push({ test: path.basename(t), ...r, ok: r.code === 0 });
}
for (const mu of MUTATIONEN) {
  const r = lauf(mu.an(lies(mu.migration)), mu.test);
  const erkannt = r.code !== 0 && r.bestanden > 0 && Boolean(r.fehler?.includes(mu.erwartet));
  ergebnis.mutationen.push({ name: mu.name, erwartet: mu.erwartet.trim(), code: r.code, bestandenVorher: r.bestanden, fehler: r.fehler?.slice(0, 160) ?? null, erkannt });
}
fs.writeFileSync(path.join(HIER, 'sql-mutationen.json'), JSON.stringify(ergebnis, null, 2));
for (const k of ergebnis.kontrolle) console.log(`Kontrolle ${k.test}: ${k.ok ? 'besteht' : 'ROT'} (${k.bestanden} Zusicherungen)`);
for (const m of ergebnis.mutationen) console.log(`${m.erkannt ? 'erkannt   ' : 'NICHT erk.'} ${m.name} -> ${m.fehler ?? '(kein Fehler)'}`);
const alle = ergebnis.kontrolle.every((k) => k.ok) && ergebnis.mutationen.every((m) => m.erkannt);
console.log(`Ergebnis: ${ergebnis.mutationen.filter((m) => m.erkannt).length}/${ergebnis.mutationen.length} erkannt, Kontrollen ${ergebnis.kontrolle.every((k) => k.ok) ? 'grün' : 'ROT'}`);
process.exit(alle ? 0 : 1);
