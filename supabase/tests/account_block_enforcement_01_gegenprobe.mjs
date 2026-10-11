// GO-LIVE-SECURITY-01 / KONTOSPERRE — Gegenprobe zu supabase/tests/account_block_enforcement_01.sql.
//
// Je Mutation wird innerhalb der Testtransaktion eine Korrektur aus 20261109120000 zurückgenommen:
// die vorherige Funktionsfassung (neueste Definition in den Migrationen vor 20261109120000) oder die
// neue Sperrprüfung neutralisiert. Erwartet: Der Vertragstest scheitert, und zwar an der genannten
// Stelle. Der Test endet mit rollback; es bleibt nichts zurück.
//
// Aufruf (nur lokal, niemals --linked oder remote):
//   node supabase/tests/account_block_enforcement_01_gegenprobe.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONTAINER = 'supabase_db_officepilot';
const GRENZE = '20261109120000';
const hier = path.dirname(fileURLToPath(import.meta.url));
const migrationen = path.join(hier, '..', 'migrations');
const test = fs.readFileSync(path.join(hier, 'account_block_enforcement_01.sql'), 'utf8').replace(/\r\n/g, '\n');

const dateien = fs.readdirSync(migrationen).filter((f) => f.endsWith('.sql')).sort();

/** Funktionsblock einer Datei: create or replace function public.<name>( … bis zum schliessenden Dollar-Tag. */
function blockAus(text, name) {
  const muster = new RegExp(`create or replace function public\\.${name}\\(`, 'i');
  const treffer = muster.exec(text);
  if (!treffer) return null;
  const kopf = text.slice(treffer.index);
  const tag = (/\bas\s+(\$[a-z_]*\$)/i.exec(kopf) ?? [])[1];
  if (!tag) throw new Error(`${name}: Dollar-Tag nicht gefunden`);
  const rumpfStart = kopf.indexOf(tag) + tag.length;
  const ende = kopf.indexOf(tag, rumpfStart);
  return kopf.slice(0, ende + tag.length) + ';';
}

/** Neueste Definition vor 20261109120000. */
function vorher(name) {
  let gefunden = null;
  for (const datei of dateien) {
    if (datei >= GRENZE) break;
    const b = blockAus(fs.readFileSync(path.join(migrationen, datei), 'utf8').replace(/\r\n/g, '\n'), name);
    if (b) gefunden = { datei, sql: b };
  }
  if (!gefunden) throw new Error(`${name}: keine Fassung vor ${GRENZE}`);
  return gefunden;
}

const sperreAus = {
  datei: GRENZE,
  sql: `create or replace function public.workspace_account_blocked(p_user_id uuid) returns boolean
language sql stable security definer set search_path = public as $$ select false $$;`,
};

const mutationen = [
  ['S1 Sperrpruefung neutralisiert', sperreAus, 'K1'],
  ['S2a is_active_workspace_member vorher', vorher('is_active_workspace_member'), 'K1'],
  ['S2b workspace_member_role vorher', vorher('workspace_member_role'), 'K1'],
  ['S3 workspace_user_can_write vorher (Edge-Bruecke)', vorher('workspace_user_can_write'), 'K1 workspace_user_can_write'],
  ['S4 assert_is_admin vorher', vorher('assert_is_admin'), 'K8a'],
  ['S5a ensure_personal_workspace vorher', vorher('ensure_personal_workspace'), 'K9a'],
  ['S5b get_active_workspace vorher', vorher('get_active_workspace'), 'K9b'],
  ['S6 assert_financial_action_allowed vorher', vorher('assert_financial_action_allowed'), 'K5c'],
  ['S7 get_workspace_mailbox_oauth_pending vorher', vorher('get_workspace_mailbox_oauth_pending'), 'K10'],
];

let alleOk = true;
for (const [name, { datei, sql }, stelle] of mutationen) {
  // Ersetzungsfunktion statt Text: $$, $' und $& in Funktionsrümpfen dürfen nicht als Muster gelten.
  const eingespritzt = test.replace(/^begin;$/m, () => `begin;\n-- GEGENPROBE: ${name}\n${sql}\n`);
  if (eingespritzt === test) throw new Error('begin; im Test nicht gefunden');
  const lauf = spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'], {
    input: eingespritzt,
    encoding: 'utf8',
  });
  const fehler = ((`${lauf.stdout}\n${lauf.stderr}`).match(/ERROR:\s+(.*)/) ?? [])[1] ?? '';
  const getroffen = lauf.status !== 0 && fehler.startsWith(stelle);
  if (!getroffen) alleOk = false;
  console.log(`${getroffen ? 'OK  ' : 'FEHL'}  ${name} [${datei}] -> ${fehler.slice(0, 140) || `(kein Fehler, exit ${lauf.status})`}`);
}
console.log(alleOk ? 'Gegenprobe: alle Mutationen an der erwarteten Stelle erkannt' : 'Gegenprobe: NICHT alle Mutationen erkannt');
process.exit(alleOk ? 0 : 1);
