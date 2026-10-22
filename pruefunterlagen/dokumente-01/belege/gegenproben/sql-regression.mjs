// DOKUMENTE-01 — alle nicht parallelen SQL-Tests ohne und mit den DOKUMENTE-01-Migrationen,
// je in einer zurückgerollten Transaktion. Die eigenen Tests laufen zusätzlich als Gegenprobe
// ohne Migration (sie müssen dort scheitern).
// Aufruf aus dem Repo: node <dieses Skript> [muster]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = process.cwd();
const MIGRATIONEN = [
  'supabase/migrations/20261125120000_dokumente01_aufbewahrung.sql',
  'supabase/migrations/20261126120000_dokumente01_papierregister.sql',
];
const EIGENE = new Set(['dokumente01_aufbewahrung.sql', 'dokumente01_papierregister.sql']);
// Lokal datenabhängig rot, vorbestehend (Gedächtnis „Lokale SQL-Testfallen"): ohne Prelude nicht grün.
const BEKANNT_ROT = new Set(['inbound_email_07e.sql', 'mailbox_auto_sync_07eauto.sql', 'document_delivery_bulk_list_b6.sql']);
const MIGRATION = MIGRATIONEN.map((p) => readFileSync(join(REPO, p), 'utf8')).join('\n');
const muster = process.argv[2];

function psql(input) {
  const r = spawnSync('docker', ['exec', '-i', 'supabase_db_officepilot', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  const fehler = (r.stderr || '').split('\n').filter((z) => /ERROR|FEHLER/.test(z)).slice(0, 2).join(' | ');
  return { code: r.status, fehler };
}

const tests = readdirSync(join(REPO, 'supabase/tests'))
  .filter((f) => f.endsWith('.sql') && !f.includes('parallel'))
  .filter((f) => !muster || f.includes(muster))
  .sort();

const zeilen = [];
let befunde = 0;
for (const name of tests) {
  const sql = readFileSync(join(REPO, 'supabase/tests', name), 'utf8');
  const rumpf = sql.split('\n').filter((z) => z.trim() !== 'begin;' && z.trim() !== 'rollback;').join('\n');
  const ohne = psql(sql);
  const mit = psql(`begin;\n${MIGRATION}\n${rumpf}\nrollback;\n`);
  let urteil;
  if (EIGENE.has(name)) {
    urteil = mit.code === 0 && ohne.code !== 0 ? 'OK (Gegenprobe ohne Migration rot)' : 'BEFUND';
  } else if (ohne.code === 0 && mit.code === 0) {
    urteil = 'OK';
  } else if (ohne.code === mit.code && ohne.fehler === mit.fehler && BEKANNT_ROT.has(name)) {
    urteil = 'VORBESTEHEND ROT (lokale Daten)';
  } else {
    urteil = 'BEFUND';
  }
  if (urteil === 'BEFUND') befunde += 1;
  const zeile = `${urteil}  ${name}  ohne=${ohne.code} mit=${mit.code}${ohne.fehler ? `  [ohne: ${ohne.fehler}]` : ''}${mit.fehler ? `  [mit: ${mit.fehler}]` : ''}`;
  zeilen.push(zeile);
  console.log(zeile);
}
writeFileSync(join(process.env.TEMP ?? '.', 'dok01-sql-regression.txt'), `${zeilen.join('\n')}\n`);
console.log(`\n${tests.length} Tests, ${befunde} Befunde`);
process.exit(befunde === 0 ? 0 : 1);
