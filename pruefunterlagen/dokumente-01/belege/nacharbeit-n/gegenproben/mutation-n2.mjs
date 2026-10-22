// DOKUMENTE-01 N2 — Gegenprobe des Regeltests in der isolierten Kopie: die Korrektur `z-index: auto` entfernen
// (Stand vor N2), Test muss rot werden; danach wiederherstellen und grün.
//   node mutation-n2.mjs <kopie-repo> <bericht.json>
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const [kopie, bericht] = process.argv.slice(2);
if (!kopie || !/OfficeTakt-Sicherungen[\\/]DOK01-GEGENPROBEN-/.test(kopie)) throw new Error('Nur in der isolierten Kopie');
const REPO = 'C:/Users/Lenovo-ThinkPad-E590/Desktop/officepilot';
const TEST = 'src/abmeldeMenueN2Dokumente01.test.ts';
copyFileSync(join(REPO, TEST), join(kopie, TEST));
copyFileSync(join(REPO, 'src/styles/shell.css'), join(kopie, 'src/styles/shell.css'));

function lauf(ausgabe) {
  spawnSync(process.execPath, [join(kopie, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.safe.config.ts', '--reporter=json', `--outputFile=${ausgabe}`, TEST], { cwd: kopie, encoding: 'utf8', env: { ...process.env, GOLD_WRITE_REPORT: '' } });
  const j = JSON.parse(readFileSync(ausgabe, 'utf8'));
  return {
    gesamt: j.numTotalTests,
    rot: j.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === 'failed').map((a) => ({ test: a.title, grund: String(a.failureMessages[0] ?? '').split('\n')[0].slice(0, 200) }))),
  };
}

const tmp = join(kopie, '..', 'vitest-tmp-n2.json');
const pfad = join(kopie, 'src/styles/shell.css');
const original = readFileSync(pfad, 'utf8');
const anker = '  z-index: auto;\n  padding: var(--space-3) var(--space-4) 0;';
const ankerPasst = original.includes(anker) ? anker : anker.replace(/\n/g, '\r\n');
if (original.split(ankerPasst).length !== 2) throw new Error('Anker nicht eindeutig');
const ergebnis = { vorher: lauf(tmp) };
writeFileSync(pfad, original.replace(ankerPasst, ankerPasst.replace(/ {2}z-index: auto;\r?\n/, '')));
try {
  ergebnis.mutiert = lauf(tmp);
} finally {
  writeFileSync(pfad, original);
}
ergebnis.nachher = lauf(tmp);
writeFileSync(bericht, JSON.stringify(ergebnis, null, 2));
console.log(`vorher rot ${ergebnis.vorher.rot.length}/${ergebnis.vorher.gesamt}; ohne z-index:auto rot ${ergebnis.mutiert.rot.length} (${ergebnis.mutiert.rot.map((r) => r.test.slice(0, 50)).join(' | ')}); nachher rot ${ergebnis.nachher.rot.length}/${ergebnis.nachher.gesamt}`);
process.exit(ergebnis.vorher.rot.length === 0 && ergebnis.mutiert.rot.length > 0 && ergebnis.nachher.rot.length === 0 ? 0 : 1);
