// DOKUMENTE-01 R1/R2 — Mutationsgegenproben, nur in der isolierten Kopie.
// Je Mutation: eine Schutzmaßnahme entfernen, die drei neuen Testdateien laufen lassen, Datei wiederherstellen.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const kopie = process.argv[2];
const ausgabe = process.argv[3];
// Nur die isolierte Kopie: Der Arbeitsbaum wird von der Prüf-App 5232 ausgeliefert und darf nie mutiert werden.
const ISOLIERTE_KOPIE = 'C:/Users/Lenovo-ThinkPad-E590/Documents/OfficeTakt-Sicherungen/DOK01-GEGENPROBEN-20261020T021008Z/repo';
if (!kopie || path.resolve(kopie).toLowerCase() !== path.resolve(ISOLIERTE_KOPIE).toLowerCase()) {
  throw new Error('Mutationen nur in der isolierten Kopie');
}
fs.mkdirSync(ausgabe, { recursive: true });

const TESTS = [
  'src/services/sync/sendekontoR1Dokumente01.test.ts',
  'src/services/sync/altwarteschlangeR2Dokumente01.test.ts',
  'src/pages/syncHeldOrdersR2Dokumente01.test.tsx',
];

const MUTATIONEN = [
  { id: 'M1', was: 'Lauf-Bindung des Clients aus', datei: 'src/services/sync/syncRunIdentityService.ts', alt: '  if (!client) return client;', neu: '  if (!client || client) return client;' },
  { id: 'M2', was: 'geprüfter Zugang wird nicht angeheftet', datei: 'src/services/sync/syncRunIdentityService.ts', alt: "    headers.set('Authorization', authorization);", neu: "    headers.get('Authorization');" },
  { id: 'M3', was: 'Zurücknehmen des laufenden Auftrags aus', datei: 'src/services/sync/supabaseSyncAdapter.ts', alt: '      if (runGuard.tripped) {', neu: '      if (false && runGuard.tripped) {' },
  { id: 'M4', was: 'Journal wird beim Senden nicht beachtet', datei: 'src/services/sync/supabaseSyncAdapter.ts', alt: '      if (journal.has(entry)) {', neu: '      if (false && journal.has(entry)) {' },
  { id: 'M5', was: 'Journal wird am Laufende nicht geschrieben', datei: 'src/services/sync/supabaseSyncAdapter.ts', alt: '    if (!journal.flush()) journalBlocked = true;', neu: '    void journal;' },
  { id: 'M6', was: 'Abruf ungebunden', datei: 'src/services/sync/supabaseSyncAdapter.ts', alt: '    const result = await this.pullChangesWith(input, bindClientToSyncRun(this.client, runGuard), runGuard);', neu: '    const result = await this.pullChangesWith(input, this.client, null);' },
  { id: 'M7', was: 'Koordinator übergeht Wechsel im Abruf', datei: 'src/services/sync/syncCoordinator.ts', alt: '      if (pullResult.identityChanged) return this.abortForIdentityChange(state, startedAt);', neu: '      void 0;' },
  { id: 'M8', was: 'Koordinator zählt gesperrte Aufträge als offen', datei: 'src/services/sync/syncCoordinator.ts', alt: "&& !entry.hold).length;", neu: ').length;' },
  { id: 'M9', was: 'keine Sperre bei Übernahme des Altbestands', datei: 'src/services/storage/workspaceAccountStorageService.ts', alt: "    const gesperrt = holdOutboxEntriesInRawState(legacyRaw, 'legacy_adoption', now);", neu: '    const gesperrt = { raw: legacyRaw, held: [] };' },
  { id: 'M10', was: 'Sendeweg beachtet Sperre nicht', datei: 'src/services/sync/syncOutboxOriginService.ts', alt: "  if (entry.hold) return 'origin_unknown';", neu: "  if (false) return 'origin_unknown';" },
  { id: 'M11', was: 'keine Sperre beim Laden', datei: 'src/services/sync/syncOutboxOriginService.ts', alt: "  const { outbox, heldIds } = holdOutboxEntriesWithoutOrigin(journal.outbox, 'load', now);", neu: '  const { outbox, heldIds } = { outbox: journal.outbox, heldIds: [] };' },
  { id: 'M12', was: 'kein Ursprung beim Einreihen', datei: 'src/services/sync/syncOutboxService.ts', alt: '  if (origin) entry.origin = origin;', neu: '  void origin;' },
  { id: 'M13', was: 'Freigabe ohne Kontoprüfung', datei: 'src/services/sync/syncUiService.ts', alt: '  if (sessionUserId !== origin.userId || getActiveStorageKey() !== storageKey) {', neu: '  if (getActiveStorageKey() !== storageKey) {' },
  { id: 'M14', was: 'Verfolger-Grundlinie nach dem Laden roh', datei: 'src/services/storage/storageBootstrapService.ts', alt: '      seedSyncChangeTrackerFromCurrentStores();', neu: '      void 0;' },
  { id: 'M15', was: 'Wartung nach dem Laden ungesperrt', datei: 'src/services/storage/storageBootstrapService.ts', alt: '    .then(() => runAutomaticSyncWrite(() => persistAll()));', neu: '    .then(() => persistAll());' },
  { id: 'M16', was: 'eigener Token-Lieferant wird nicht gelesen', datei: 'src/services/sync/syncRunIdentityService.ts', alt: '  const provider = client.accessToken;', neu: '  const provider = undefined as unknown as typeof client.accessToken;' },
];
const nur = (process.argv[4] ?? '').split(',').filter(Boolean);
if (nur.length > 0) MUTATIONEN.splice(0, MUTATIONEN.length, ...MUTATIONEN.filter((m) => nur.includes(m.id)));

function relativ(name) {
  return path.relative(kopie, name).split(path.sep).join('/');
}

const ergebnisse = [];
for (const m of MUTATIONEN) {
  const datei = path.join(kopie, m.datei);
  const original = fs.readFileSync(datei, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const alt = m.alt.replace(/\n/g, eol);
  const neu = m.neu.replace(/\n/g, eol);
  const treffer = original.split(alt).length - 1;
  if (treffer !== 1) {
    ergebnisse.push({ id: m.id, was: m.was, angewendet: false, treffer });
    console.log(JSON.stringify({ id: m.id, angewendet: false, treffer }));
    continue;
  }
  fs.writeFileSync(datei, original.replace(alt, neu));
  const json = path.join(ausgabe, `${m.id}.json`);
  try {
    spawnSync(
      'npx',
      ['vitest', 'run', '--config', 'vitest.safe.config.ts', '--maxWorkers=2', '--reporter=json', `--outputFile=${json}`, ...TESTS],
      { cwd: kopie, stdio: ['ignore', 'ignore', 'ignore'], shell: true },
    );
  } finally {
    fs.writeFileSync(datei, original);
  }
  let bericht = null;
  try {
    bericht = JSON.parse(fs.readFileSync(json, 'utf8'));
  } catch {
    bericht = null;
  }
  const rote = [];
  for (const d of (bericht && bericht.testResults) || []) {
    for (const t of d.assertionResults || []) if (t.status === 'failed') rote.push(`${relativ(d.name)} :: ${t.title}`);
  }
  const zeile = { id: m.id, was: m.was, angewendet: true, erkannt: rote.length > 0, rot: rote.length, gruen: bericht ? bericht.numPassedTests : null, rote };
  ergebnisse.push(zeile);
  console.log(JSON.stringify({ id: m.id, erkannt: zeile.erkannt, rot: zeile.rot }));
  for (const r of rote) console.log('  ROT ' + r);
}
// Wiederherstellung belegen: jede Datei wieder identisch mit dem Arbeitsbaum-Abgleich.
fs.writeFileSync(path.join(ausgabe, 'mutationen.json'), JSON.stringify(ergebnisse, null, 2));
