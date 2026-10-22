// DOKUMENTE-01 Nacharbeit — gezielter Clientlauf über vitest.safe.config.ts (Muster: FC01A gezielt-lauf.mjs).
//   node pruefunterlagen/dokumente-01/belege/nacharbeit-w/werkzeuge/gezielt-lauf.mjs <ausgabe.json> <liste.txt>
// Aufruf aus dem Repository. Der Snapshot-Test InvoiceDocumentView läuft nie; die drei Schutzartefakte
// werden vor und nach dem Lauf gehasht und müssen gleich bleiben (sonst Exit 2).
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repo = process.cwd();
const [ziel, liste] = process.argv.slice(2);
if (!ziel || !liste) throw new Error('Aufruf: gezielt-lauf.mjs <ausgabe.json> <liste.txt>');
fs.mkdirSync(path.dirname(ziel), { recursive: true });

const SCHUTZ = [
  'test-world/reports/gold-pipeline-04b.json',
  'test-world/reports/gold-pipeline-04b.md',
  'src/components/invoice/__snapshots__/InvoiceDocumentView.test.tsx.snap',
];
const hashe = () => Object.fromEntries(SCHUTZ.map((p) => {
  const voll = path.join(repo, p);
  return [p, fs.existsSync(voll) ? crypto.createHash('sha256').update(fs.readFileSync(voll)).digest('hex') : 'FEHLT'];
}));

const dateien = fs.readFileSync(liste, 'utf8').split(/\r?\n/).map((z) => z.trim()).filter(Boolean)
  .filter((d) => !d.includes('InvoiceDocumentView.test'));
const vorher = hashe();
const json = ziel.replace(/\.json$/, '.vitest.json');
if (fs.existsSync(json)) fs.unlinkSync(json);
const lauf = spawnSync(process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.safe.config.ts', '--maxWorkers=2',
    '--reporter=default', '--reporter=json', `--outputFile.json=${json}`, ...dateien],
  { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
fs.writeFileSync(ziel.replace(/\.json$/, '.log'), `${lauf.stdout}\n${lauf.stderr}`.replace(/\u001b\[[0-9;]*m/g, ''));
const nachher = hashe();

const summe = { start: new Date().toISOString(), dateien: dateien.length, exit: lauf.status, dateienOk: 0, dateienRot: 0, testsOk: 0, testsRot: 0, uebersprungen: 0, rot: [] };
if (fs.existsSync(json)) {
  const r = JSON.parse(fs.readFileSync(json, 'utf8'));
  for (const d of r.testResults ?? []) {
    const rel = path.relative(repo, d.name).replace(/\\/g, '/');
    const rote = (d.assertionResults ?? []).filter((a) => a.status === 'failed');
    if (d.status === 'failed' || rote.length) {
      summe.dateienRot += 1;
      if (!rote.length) summe.rot.push(`${rel} > (Datei) ${String(d.message ?? '').slice(0, 200)}`);
      for (const f of rote) summe.rot.push(`${rel} > ${f.fullName.slice(0, 160)}`);
    } else summe.dateienOk += 1;
    for (const f of d.assertionResults ?? []) {
      if (f.status === 'passed') summe.testsOk += 1;
      else if (f.status === 'failed') summe.testsRot += 1;
      else summe.uebersprungen += 1;
    }
  }
} else summe.rot.push(`kein JSON-Ergebnis (exit ${lauf.status})`);
summe.schutzartefakte = { vorher, nachher, unveraendert: JSON.stringify(vorher) === JSON.stringify(nachher) };
fs.writeFileSync(ziel, JSON.stringify(summe, null, 2));
console.log(`Dateien ${summe.dateienOk}/${summe.dateien} ok, Tests ${summe.testsOk} ok / ${summe.testsRot} rot / ${summe.uebersprungen} übersprungen; Schutzartefakte ${summe.schutzartefakte.unveraendert ? 'unverändert' : 'VERÄNDERT'}`);
for (const r of summe.rot) console.log(`  ROT ${r}`);
process.exit(!summe.schutzartefakte.unveraendert ? 2 : summe.rot.length ? 1 : 0);
