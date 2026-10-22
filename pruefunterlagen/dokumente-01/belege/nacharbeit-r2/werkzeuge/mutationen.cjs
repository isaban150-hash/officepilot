// DOKUMENTE-01 Restkorrektur (R1-WEISS-START, DOK-WEISS-DIREKT) — Mutationsgegenproben, nur in der isolierten Kopie.
// Je Mutation: eine oder mehrere Schutzstellen entfernen, die Nachweisdateien laufen lassen, alles wiederherstellen.
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
  'src/services/sync/startidentitaetR1Dokumente01.test.ts',
  'src/services/document/loeschvorgangBindungDokumente01.test.ts',
  'src/pages/syncHaltMeldungR1Dokumente01.test.tsx',
  'src/services/sync/sendekontoR1Dokumente01.test.ts',
];

const ID = 'src/services/sync/syncRunIdentityService.ts';
const ADAPTER = 'src/services/sync/supabaseSyncAdapter.ts';
const KOORDINATOR = 'src/services/sync/syncCoordinator.ts';
const SEITE = 'src/pages/SyncPage.tsx';
const LOESCHEN = 'src/services/document/generatedInvoiceDocumentDeleteService.ts';

const STARTREGEL = { datei: ID, alt: "      : !provable\n        ? 'start_unbestaetigt'", neu: "      : !provable\n        ? null" };
const RUECKFALL = {
  datei: ID,
  alt: '    if (!authorization && guard.identity.accountUserId !== null) guard.refuseWithoutVerifiedAccess();',
  neu: '    void 0;',
};
const PRUEFUNG_NACH_NACHWEIS = {
  datei: LOESCHEN,
  alt: '  if (!(await vorgang.stillValid())) return { ok: false, errorKey: DOCUMENT_DELETE_IDENTITY_CHANGED_KEY };\n  if (serverBlockiert) {',
  neu: '  if (serverBlockiert) {',
};
const BEREICH_VOR_LOKAL = {
  datei: LOESCHEN,
  alt: '  if (!vorgang.scopeStillActive()) return { ok: false, errorKey: DOCUMENT_DELETE_IDENTITY_CHANGED_KEY };',
  neu: '  void vorgang;',
};

const MUTATIONEN = [
  // R1-WEISS-START
  { id: 'S1', was: 'Startregel: nicht nachweisbare Anmeldung gilt als zusammengehörig', aenderungen: [STARTREGEL] },
  { id: 'S2', was: 'Netzaufruf ohne geprüften Zugang fällt auf die SDK-Sitzung zurück', aenderungen: [RUECKFALL] },
  { id: 'S3', was: 'S1 und S2 zusammen (Stand vor der Korrektur)', aenderungen: [STARTREGEL, RUECKFALL] },
  {
    id: 'S4',
    was: 'Frühhalt im Adapter entfernt',
    aenderungen: [
      {
        datei: ADAPTER,
        alt: '    if (runGuard.tripped) {\n      /*\n       * DOKUMENTE-01 R1-WEISS-START',
        neu: '    if (false && runGuard.tripped) {\n      /*\n       * DOKUMENTE-01 R1-WEISS-START',
      },
    ],
  },
  {
    id: 'S5',
    was: 'Halt zählt nicht als Fehler und steht nicht im Bericht',
    aenderungen: [
      {
        datei: KOORDINATOR,
        alt: '    report.errorCount = 1;\n    report.errors.push({ outboxId: SYNC_IDENTITY_CHANGED_REPORT_ID, message });',
        neu: '    void message;',
      },
    ],
  },
  {
    id: 'S6',
    was: 'Startproblem ohne Fehlerzustand des Kontos',
    aenderungen: [{ datei: KOORDINATOR, alt: "    this.syncState = startProblem ? 'error' : 'idle';", neu: "    this.syncState = 'idle';" }],
  },
  {
    id: 'S7',
    was: 'Seite: Halt nach „Jetzt synchronisieren“ wie gewöhnlicher Ausgang',
    aenderungen: [{ datei: SEITE, alt: '      } else if (isSyncIdentityHaltReport(report)) {', neu: '      } else if (false) {' }],
  },
  {
    id: 'S8',
    was: 'Seite: Halt nach „Erneut versuchen“ wie gewöhnlicher Ausgang',
    aenderungen: [
      {
        datei: SEITE,
        alt: "      if (isSyncIdentityHaltReport(report)) {\n        showToast(translate('sync.feedback.halted'));\n      } else if (report.errorCount > 0) {\n        showToast(translate('sync.feedback.retryError'));",
        neu: "      if (false) {\n        showToast(translate('sync.feedback.halted'));\n      } else if (report.errorCount > 0) {\n        showToast(translate('sync.feedback.retryError'));",
      },
    ],
  },
  // DOK-WEISS-DIREKT
  {
    id: 'D1',
    was: 'veraltete Oberfläche (Handelnder ≠ Konto des Bereichs) nicht erkannt',
    aenderungen: [{ datei: LOESCHEN, alt: '  if (startKonto && actor?.userId && actor.userId !== startKonto.userId) {', neu: '  if (false) {' }],
  },
  { id: 'D2', was: 'keine Prüfung nach der Nachweisrückfrage', aenderungen: [PRUEFUNG_NACH_NACHWEIS] },
  { id: 'D3', was: 'keine Bereichsprüfung unmittelbar vor dem lokalen Löschen', aenderungen: [BEREICH_VOR_LOKAL] },
  { id: 'D4', was: 'D2 und D3 zusammen (Stand vor der Korrektur, Nachweisweg)', aenderungen: [PRUEFUNG_NACH_NACHWEIS, BEREICH_VOR_LOKAL] },
  {
    id: 'D5',
    was: 'Cloud-Grabstein ohne bestätigte Anmeldung',
    aenderungen: [{ datei: LOESCHEN, alt: '  if (startKonto && !vorgang.confirmed) {', neu: '  if (false) {' }],
  },
  {
    id: 'D6',
    was: 'keine Prüfung nach dem Grabstein',
    aenderungen: [
      {
        datei: LOESCHEN,
        alt: '  const tombstone = await tombstoneDocumentInCloud({ clientDocumentId: documentId }, verbindung);\n  if (!(await vorgang.stillValid())) return { ok: false, errorKey: DOCUMENT_DELETE_IDENTITY_CHANGED_KEY };',
        neu: '  const tombstone = await tombstoneDocumentInCloud({ clientDocumentId: documentId }, verbindung);',
      },
    ],
  },
  {
    id: 'D7',
    was: 'direkter Vorgang ungebunden: das SDK nimmt beim Senden die Sitzung, die gerade gilt',
    aenderungen: [{ datei: ID, alt: '      client: bindClientToSyncRun(client, guard),\n      confirmed: true,', neu: '      client,\n      confirmed: true,' }],
  },
  {
    id: 'D8',
    was: 'unbestätigte Bindung übersieht eine neue Anmeldung',
    aenderungen: [
      {
        datei: ID,
        alt: '      if (now.readable && now.userId !== null && now.userId !== startSessionUserId) return anhalten();',
        neu: '      void now;',
      },
    ],
  },
];
const nur = (process.argv[4] ?? '').split(',').filter(Boolean);
if (nur.length > 0) MUTATIONEN.splice(0, MUTATIONEN.length, ...MUTATIONEN.filter((m) => nur.includes(m.id)));

function relativ(name) {
  return path.relative(kopie, name).split(path.sep).join('/');
}

const ergebnisse = [];
for (const m of MUTATIONEN) {
  // Alle Änderungen einer Mutation vorbereiten; greift eine nicht genau einmal, wird nichts verändert.
  const originale = new Map();
  const geaendert = new Map();
  let fehler = null;
  for (const a of m.aenderungen) {
    const datei = path.join(kopie, a.datei);
    if (!originale.has(datei)) originale.set(datei, fs.readFileSync(datei, 'utf8'));
    const text = geaendert.get(datei) ?? originale.get(datei);
    const eol = originale.get(datei).includes('\r\n') ? '\r\n' : '\n';
    const alt = a.alt.replace(/\n/g, eol);
    const neu = a.neu.replace(/\n/g, eol);
    const treffer = text.split(alt).length - 1;
    if (treffer !== 1) {
      fehler = { datei: a.datei, treffer };
      break;
    }
    geaendert.set(datei, text.replace(alt, () => neu));
  }
  if (fehler) {
    ergebnisse.push({ id: m.id, was: m.was, angewendet: false, ...fehler });
    console.log(JSON.stringify({ id: m.id, angewendet: false, ...fehler }));
    continue;
  }
  const json = path.join(ausgabe, `${m.id}.json`);
  try {
    for (const [datei, text] of geaendert) fs.writeFileSync(datei, text);
    spawnSync(
      'npx',
      ['vitest', 'run', '--config', 'vitest.safe.config.ts', '--maxWorkers=2', '--reporter=json', `--outputFile=${json}`, ...TESTS],
      { cwd: kopie, stdio: ['ignore', 'ignore', 'ignore'], shell: true },
    );
  } finally {
    for (const [datei, text] of originale) fs.writeFileSync(datei, text);
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
    if ((d.assertionResults || []).length === 0 && d.status === 'failed') rote.push(`${relativ(d.name)} :: (Datei) ${String(d.message).slice(0, 200)}`);
  }
  const zeile = {
    id: m.id,
    was: m.was,
    angewendet: true,
    erkannt: rote.length > 0,
    rot: rote.length,
    gruen: bericht ? bericht.numPassedTests : null,
    rote,
  };
  ergebnisse.push(zeile);
  console.log(JSON.stringify({ id: m.id, erkannt: zeile.erkannt, rot: zeile.rot, gruen: zeile.gruen }));
  for (const r of rote) console.log('  ROT ' + r);
}
fs.writeFileSync(path.join(ausgabe, 'mutationen.json'), JSON.stringify(ergebnisse, null, 2));
