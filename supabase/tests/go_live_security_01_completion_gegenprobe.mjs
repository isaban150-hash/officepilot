// GO-LIVE-SECURITY-01 / ABSCHLUSS — Gegenprobe zu supabase/tests/go_live_security_01_completion.sql.
//
// Je Mutation wird innerhalb der Testtransaktion eine Regel aus 20261108120000 zurückgenommen: die
// vorherige Funktionsfassung (neueste Definition in den Migrationen vor 20261108120000) oder ein neuer
// Trigger entfernt. Erwartet: Der Vertragstest scheitert, und zwar an der genannten Stelle. Der Test
// endet mit rollback; es bleibt nichts zurück.
//
// Aufruf (nur lokal, niemals --linked oder remote):
//   node supabase/tests/go_live_security_01_completion_gegenprobe.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONTAINER = 'supabase_db_officepilot';
const GRENZE = '20261108120000';
const hier = path.dirname(fileURLToPath(import.meta.url));
const migrationen = path.join(hier, '..', 'migrations');
const test = fs.readFileSync(path.join(hier, 'go_live_security_01_completion.sql'), 'utf8').replace(/\r\n/g, '\n');

const dateien = fs.readdirSync(migrationen).filter((f) => f.endsWith('.sql')).sort();

/** Funktionsblock einer Datei: create or replace function public.<name>( … bis zum schliessenden Dollar-Tag. */
function blockAus(text, name) {
  const muster = new RegExp(`create or replace function public\\.${name}\\(`, 'i');
  const treffer = muster.exec(text);
  if (!treffer) return null;
  const start = treffer.index;
  const kopf = text.slice(start);
  const tag = (/\bas\s+(\$[a-z_]*\$)/i.exec(kopf) ?? [])[1];
  if (!tag) throw new Error(`${name}: Dollar-Tag nicht gefunden`);
  const rumpfStart = kopf.indexOf(tag) + tag.length;
  const ende = kopf.indexOf(tag, rumpfStart);
  return kopf.slice(0, ende + tag.length) + ';';
}

/** Neueste Definition vor 20261108120000. */
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

const abschluss = fs.readFileSync(path.join(migrationen, dateien.find((d) => d.startsWith(GRENZE))), 'utf8').replace(/\r\n/g, '\n');
const r4OhneCorr = (() => {
  const b = blockAus(abschluss, 'workspace_einvoice_file_write_guard');
  const zeile = "           or b.client_document_id like 'corr-%'\n";
  if (b.split(zeile).length !== 2) throw new Error('R4: corr-Zeile nicht eindeutig');
  return b.replace(zeile, () => '');
})();

const dropRevive = ['workspace_files', 'workspace_document_file_bindings', 'workspace_inbox_items', 'workspace_document_work_results']
  .map((t) => `drop trigger ${t}_member_revive_guard on public.${t};`).join('\n');
const dropBank = ['workspace_bank_accounts', 'workspace_bank_transactions']
  .map((t) => `drop trigger ${t}_member_own_row_guard on public.${t};`).join('\n');

const mutationen = [
  ['E1 Bindungswaechter vorher (structured = E-Rechnung)', vorher('workspace_einvoice_binding_write_guard'), 'E1'],
  ['E2 Einstufung vorher', vorher('workspace_einvoice_binding_trust_reason'), 'E6'],
  ['R1 Wiederbelebungs-Trigger entfernt', { datei: '-', sql: dropRevive }, 'R1a'],
  ['R2 Dokument-Eigentums-Trigger entfernt', { datei: '-', sql: 'drop trigger workspace_document_file_bindings_document_owner_guard on public.workspace_document_file_bindings;' }, 'R2a'],
  ['R3 Identitaetswaechter vorher', vorher('workspace_invoice_document_identity_guard'), 'R3a'],
  ['R4a Dateiwaechter vorher (ohne Abgrenzung, ohne corr-)', vorher('workspace_einvoice_file_write_guard'), 'R1c'],
  ['R4b Dateiwaechter ohne corr-Regel', { datei: GRENZE, sql: r4OhneCorr }, 'R4'],
  ['R5 Versandvermerk vorher', vorher('update_workspace_invoice_sent'), 'R5a'],
  ['R6 Leistungszeitraum vorher', vorher('confirm_workspace_invoice_service_period'), 'R6a'],
  ['R7 Speicher-Lesepolicy vorher', vorher('workspace_file_object_can_read'), 'R7a'],
  ['R8 Bank-Trigger entfernt', { datei: '-', sql: dropBank }, 'R8a'],
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
  // R4a scheitert an der eigenen Eingangs-XML (R1c) ohne Kennung im Text: Abweisung durch den Waechter.
  const getroffen = lauf.status !== 0 && (fehler.startsWith(stelle) || (stelle === 'R1c' && fehler.startsWith('Keine Schreibberechtigung')));
  if (!getroffen) alleOk = false;
  console.log(`${getroffen ? 'OK  ' : 'FEHL'}  ${name} [${datei}] -> ${fehler.slice(0, 140) || `(kein Fehler, exit ${lauf.status})`}`);
}
console.log(alleOk ? 'Gegenprobe: alle Mutationen an der erwarteten Stelle erkannt' : 'Gegenprobe: NICHT alle Mutationen erkannt');
process.exit(alleOk ? 0 : 1);
