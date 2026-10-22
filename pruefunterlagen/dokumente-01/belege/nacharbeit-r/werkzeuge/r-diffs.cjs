// DOKUMENTE-01 R1/R2 — Diffs nur des R-Anteils.
//  - Dateien ohne frühere Änderung: Diff gegen HEAD.
//  - neue Dateien: vollständiger Diff gegen leer.
//  - Dateien mit N1-Änderungen: N1-Stand = HEAD + N1-Diff (geprüft gegen die N1-Prüfsumme), dann Diff N1 → jetzt.
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repo = process.argv[2];
const ziel = process.argv[3];
const arbeit = process.argv[4];
fs.mkdirSync(ziel, { recursive: true });
fs.mkdirSync(arbeit, { recursive: true });

const NUR_R = [
  'src/services/sync/supabaseSyncAdapter.ts',
  'src/services/sync/syncAdapter.ts',
  'src/services/sync/syncCoordinator.ts',
  'src/services/sync/syncOutboxService.ts',
  'src/services/sync/syncUiService.ts',
  'src/services/sync/syncIndicatorService.ts',
  'src/services/persistenceService.ts',
  'src/services/orderAmendment/orderAmendmentCloudPullOrchestrator.ts',
  'src/types/sync.ts',
  'src/pages/SyncPage.tsx',
];
const NEU = [
  'src/services/sync/syncRunIdentityService.ts',
  'src/services/sync/syncConfirmationJournal.ts',
  'src/services/sync/syncOutboxOriginService.ts',
  'src/i18n/locales/de/syncHeldOrders.ts',
  'src/services/sync/sendekontoR1Dokumente01.test.ts',
  'src/services/sync/altwarteschlangeR2Dokumente01.test.ts',
  'src/pages/syncHeldOrdersR2Dokumente01.test.tsx',
];
const MIT_N1 = [
  { datei: 'src/services/storage/storageBootstrapService.ts', n1Diff: 'storageBootstrapService.ts.diff' },
  { datei: 'src/services/storage/workspaceAccountStorageService.ts', n1Diff: 'workspaceAccountStorageService.ts.diff' },
  { datei: 'src/companyIdentityRecovery02.test.tsx', n1Diff: 'companyIdentityRecovery02.test.tsx.diff' },
  { datei: 'src/services/sync/syncPullPersistService.ts', n1Diff: 'syncPullPersistService.ts.diff' },
];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const name = (datei) => datei.split('/').pop();
const lf = (text) => text.replace(/\r\n/g, '\n');

const n1Summen = new Map(
  fs
    .readFileSync(path.join(repo, 'pruefunterlagen/dokumente-01/belege/nacharbeit-n/pruefsummen.txt'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((zeile) => {
      const [hash, datei] = zeile.split(' *');
      return [datei, hash];
    }),
);

const bericht = [];
for (const datei of NUR_R) {
  const diff = git(['diff', 'HEAD', '--', datei]);
  fs.writeFileSync(path.join(ziel, `${name(datei)}.diff`), diff);
  bericht.push({ datei, art: 'gegen HEAD (keine frühere Änderung)', zeilen: diff.split('\n').length });
}
for (const datei of NEU) {
  const r = spawnSync('git', ['diff', '--no-index', '--', '/dev/null', datei], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(ziel, `${name(datei)}.diff`), r.stdout);
  bericht.push({ datei, art: 'neu', zeilen: r.stdout.split('\n').length });
}
for (const { datei, n1Diff } of MIT_N1) {
  const jetzt = fs.readFileSync(path.join(repo, datei));
  const crlf = jetzt.includes(Buffer.from('\r\n'));
  let basis = '';
  try {
    basis = git(['show', `HEAD:${datei}`]);
  } catch {
    basis = '';
  }
  const basisDatei = path.join(arbeit, `${name(datei)}.head`);
  const n1Datei = path.join(arbeit, `${name(datei)}.n1`);
  fs.writeFileSync(basisDatei, lf(basis));
  const p = spawnSync('patch', ['-s', '-o', n1Datei, basisDatei, path.join(repo, 'pruefunterlagen/dokumente-01/belege/nacharbeit-n/diffs', n1Diff)], { encoding: 'utf8' });
  if (p.status !== 0) {
    bericht.push({ datei, art: 'N1-Stand nicht rekonstruierbar', fehler: (p.stderr || p.stdout).slice(0, 300) });
    continue;
  }
  const n1Text = fs.readFileSync(n1Datei, 'utf8');
  const n1Bytes = Buffer.from(crlf ? n1Text.replace(/\n/g, '\r\n') : n1Text, 'utf8');
  const n1Belegt = sha(n1Bytes) === n1Summen.get(datei);
  const jetztLf = path.join(arbeit, `${name(datei)}.jetzt`);
  fs.writeFileSync(jetztLf, lf(jetzt.toString('utf8')));
  const d = spawnSync('git', ['diff', '--no-index', `--src-prefix=a/${path.dirname(datei)}/n1/`, `--dst-prefix=b/${path.dirname(datei)}/jetzt/`, '--', n1Datei, jetztLf], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(ziel, `${name(datei)}.r-anteil.diff`), d.stdout);
  bericht.push({ datei, art: 'R-Anteil gegen N1-Stand', n1StandBelegt: n1Belegt, unveraendertGegenN1: d.stdout.trim() === '', zeilen: d.stdout.split('\n').length });
}
fs.writeFileSync(path.join(ziel, 'diffs-uebersicht.json'), JSON.stringify(bericht, null, 2));
console.log(JSON.stringify(bericht, null, 2));
