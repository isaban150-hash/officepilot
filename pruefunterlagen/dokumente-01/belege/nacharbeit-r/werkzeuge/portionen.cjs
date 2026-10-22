// Läuft eine Dateiliste in Portionen (sichere Konfiguration, 2 Worker), JSON-Bericht je Portion.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [liste, ausgabe, groesse = '30'] = process.argv.slice(2);
const dateien = fs.readFileSync(liste, 'utf8').split(/\r?\n/).filter(Boolean);
const n = Number(groesse);
fs.mkdirSync(ausgabe, { recursive: true });

function relativ(name) {
  return path.relative(process.cwd(), name).split(path.sep).join('/');
}

const zusammenfassung = [];
for (let i = 0; i < dateien.length; i += n) {
  const portion = dateien.slice(i, i + n);
  const nr = String(i / n + 1).padStart(2, '0');
  const json = path.join(ausgabe, `portion-${nr}.json`);
  const start = Date.now();
  const r = spawnSync(
    'npx',
    ['vitest', 'run', '--config', 'vitest.safe.config.ts', '--maxWorkers=2', '--reporter=json', `--outputFile=${json}`, ...portion],
    { stdio: ['ignore', 'ignore', 'pipe'], shell: true, encoding: 'utf8' },
  );
  let bericht = null;
  try {
    bericht = JSON.parse(fs.readFileSync(json, 'utf8'));
  } catch {
    bericht = null;
  }
  const rote = [];
  for (const datei of (bericht && bericht.testResults) || []) {
    for (const t of datei.assertionResults || []) {
      if (t.status === 'failed') rote.push(`${relativ(datei.name)} :: ${t.fullName}`);
    }
    if ((datei.assertionResults || []).length === 0 && datei.status === 'failed') {
      rote.push(`${relativ(datei.name)} :: (Datei) ${String(datei.message).slice(0, 200)}`);
    }
  }
  const zeile = {
    portion: nr,
    dateien: portion.length,
    tests: bericht ? bericht.numTotalTests : null,
    gruen: bericht ? bericht.numPassedTests : null,
    rot: bericht ? bericht.numFailedTests : null,
    sekunden: Math.round((Date.now() - start) / 1000),
    exit: r.status,
    rote,
  };
  zusammenfassung.push(zeile);
  console.log(JSON.stringify({ ...zeile, rote: rote.length }));
  for (const rot of rote) console.log('  ROT ' + rot);
  if (!bericht) console.log('  STDERR ' + String(r.stderr).slice(-800));
}
fs.writeFileSync(path.join(ausgabe, 'zusammenfassung.json'), JSON.stringify(zusammenfassung, null, 2));
