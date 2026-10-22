// DOKUMENTE-01 — Client-Gegenproben in der isolierten Kopie (nie im Repo).
// Je Mutation: eine Schutzstelle entfernen, die zugehörigen Tests laufen lassen (sie MÜSSEN rot werden),
// Datei wiederherstellen. Vorher und nachher ein unmutierter Lauf (muss grün sein).
//   node mutationen-client.mjs <kopie-repo> <bericht.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const [kopie, bericht] = process.argv.slice(2);
if (!kopie || !/OfficeTakt-Sicherungen[\\/]DOK01-GEGENPROBEN-/.test(kopie)) throw new Error('Nur in der isolierten Kopie');

const T_REGEL = 'src/services/document/documentRetention.test.ts';
const T_DIENST = 'src/services/document/documentRetentionDeleteDokumente01.test.ts';
const T_SEITE = 'src/pages/dokumentDetailAufbewahrungDokumente01.test.tsx';

const MUTATIONEN = [
  {
    id: 'M1 deleteDocument ohne Fristsperre',
    datei: 'src/services/documentService.ts',
    alt: '  if (retentionBlocksDelete(getDocumentRetention(document))) {\r\n    return { success: false, errorKey: DOCUMENT_DELETE_RETENTION_KEY };\r\n  }\r\n  // Capture original',
    neu: '  // Capture original',
    tests: [T_DIENST],
  },
  {
    id: 'M2 Dienst ohne Fristsperre vor dem Cloud-Aufruf',
    datei: 'src/services/document/generatedInvoiceDocumentDeleteService.ts',
    alt: '  if (retentionBlocksDelete(getDocumentRetention(document))) {\n    return { ok: false, errorKey: DOCUMENT_DELETE_RETENTION_KEY };\n  }\n',
    neu: '',
    tests: [T_DIENST],
  },
  {
    id: 'M3 Dienst ohne Prüfbestätigung',
    datei: 'src/services/document/generatedInvoiceDocumentDeleteService.ts',
    alt: '  if (!options.aufbewahrungGeprueft) {\n    return { ok: false, errorKey: DOCUMENT_DELETE_RETENTION_CONFIRM_KEY };\n  }\n',
    neu: '',
    tests: [T_DIENST],
  },
  {
    id: 'M4 Bearbeiten ohne Herabstufungsschutz',
    datei: 'src/services/documentService.ts',
    alt: '  if (isRetentionDowngrade(getDocumentRetention(current), getDocumentRetention(updated))) {',
    neu: '  if (false && isRetentionDowngrade(getDocumentRetention(current), getDocumentRetention(updated))) {',
    tests: [T_DIENST],
  },
  {
    id: 'M5 Serverabweisung „Aufbewahrung" nicht erkannt',
    datei: 'src/services/document/generatedInvoiceDocumentDeleteService.ts',
    alt: "const RETENTION_SERVER_MARKER = 'Aufbewahrungs';",
    neu: "const RETENTION_SERVER_MARKER = '§§nie§§';",
    tests: [T_DIENST],
  },
  {
    id: 'M6 Sync-Grund „Aufbewahrung" fehlt',
    datei: 'src/services/sync/syncOutboxDescriptionService.ts',
    alt: "  if (message.includes('Aufbewahrungs')) return 'sync.failure.reason.retention';\n",
    neu: '',
    tests: [T_DIENST],
  },
  {
    id: 'M7 Empfehlung: abgelegt heißt wieder „entsorgen"',
    datei: 'src/services/document/documentRetention.ts',
    alt: "  if (input.isAdvertisement) return 'dispose_after_digital';\n  const { klasse }",
    neu: "  if (input.isAdvertisement || true) return 'dispose_after_digital';\n  const { klasse }",
    tests: [T_DIENST, T_REGEL],
  },
  {
    id: 'M8 Regel: Quittung kein Buchungsbeleg',
    datei: 'src/services/document/documentRetention.ts',
    alt: "  'quittung',\n",
    neu: '',
    tests: [T_REGEL, T_DIENST],
  },
  {
    id: 'M9 Regel: Frist 10 statt 8 Jahre',
    datei: 'src/services/document/documentRetention.ts',
    alt: '  buchungsbeleg: 8,',
    neu: '  buchungsbeleg: 10,',
    tests: [T_REGEL],
  },
  {
    id: 'M10 Regel: Jahr in UTC statt Berliner Zeit',
    datei: 'src/services/document/documentRetention.ts',
    alt: "const BERLIN_YEAR = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric' });",
    neu: "const BERLIN_YEAR = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric' });",
    tests: [T_REGEL],
  },
  {
    id: 'M11 Seite: „Löschen" trotz laufender Frist',
    datei: 'src/pages/DokumentDetailPage.tsx',
    alt: '  const aufbewahrungSperrt = retentionBlocksDelete(aufbewahrung);',
    neu: '  const aufbewahrungSperrt = false && retentionBlocksDelete(aufbewahrung);',
    tests: [T_SEITE],
  },
  {
    id: 'M12 Seite: Bestätigung ohne Prüftext',
    datei: 'src/pages/DokumentDetailPage.tsx',
    alt: '            <p className="hint-text" data-testid="document-detail-delete-retention-review">',
    neu: '            <p className="hint-text" hidden data-testid="document-detail-delete-retention-review-entfernt">',
    tests: [T_SEITE],
  },
  {
    id: 'M13 Seite: Löschen ohne Prüfbestätigung an den Dienst',
    datei: 'src/pages/DokumentDetailPage.tsx',
    alt: '      aufbewahrungGeprueft: true,\n    });',
    neu: '      aufbewahrungGeprueft: false,\n    });',
    tests: [T_SEITE],
  },
];

function vitest(tests, ausgabe) {
  const r = spawnSync(process.execPath, [join(kopie, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.safe.config.ts', '--reporter=json', `--outputFile=${ausgabe}`, ...tests], {
    cwd: kopie,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GOLD_WRITE_REPORT: '' },
  });
  let j = null;
  try { j = JSON.parse(readFileSync(ausgabe, 'utf8')); } catch { /* */ }
  const rot = (j?.testResults ?? []).flatMap((t) => (t.assertionResults ?? []).filter((a) => a.status === 'failed').map((a) => a.fullName));
  return { exit: r.status, gesamt: j?.numTotalTests ?? 0, rot };
}

const alleTests = [T_REGEL, T_DIENST, T_SEITE];
const ergebnis = { vorher: null, mutationen: [], nachher: null };
const tmp = join(kopie, '..', 'vitest-tmp.json');

ergebnis.vorher = vitest(alleTests, tmp);
console.log(`Vorher (unmutiert): ${ergebnis.vorher.gesamt} Tests, rot ${ergebnis.vorher.rot.length}`);
if (ergebnis.vorher.rot.length > 0 || ergebnis.vorher.gesamt === 0) throw new Error('Ausgangslauf nicht grün');

for (const m of MUTATIONEN) {
  const pfad = join(kopie, m.datei);
  const original = readFileSync(pfad, 'utf8');
  const treffer = original.split(m.alt).length - 1;
  if (treffer !== 1) {
    ergebnis.mutationen.push({ id: m.id, fehler: `Anker ${treffer}× gefunden` });
    console.log(`${m.id}: ANKER ${treffer}×`);
    continue;
  }
  writeFileSync(pfad, original.replace(m.alt, m.neu));
  try {
    const lauf = vitest(m.tests, tmp);
    const erkannt = lauf.rot.length > 0;
    ergebnis.mutationen.push({ id: m.id, erkannt, rot: lauf.rot.slice(0, 8), gesamt: lauf.gesamt });
    console.log(`${m.id}: ${erkannt ? 'ERKANNT' : 'NICHT ERKANNT'} (${lauf.rot.length} rot von ${lauf.gesamt})`);
    for (const name of lauf.rot.slice(0, 3)) console.log(`    - ${name.slice(0, 150)}`);
  } finally {
    writeFileSync(pfad, original);
  }
}

ergebnis.nachher = vitest(alleTests, tmp);
console.log(`Nachher (wiederhergestellt): ${ergebnis.nachher.gesamt} Tests, rot ${ergebnis.nachher.rot.length}`);
writeFileSync(bericht, JSON.stringify(ergebnis, null, 2));
const nicht = ergebnis.mutationen.filter((m) => !m.erkannt);
console.log(nicht.length === 0 ? 'Alle Mutationen erkannt.' : `Nicht erkannt: ${nicht.map((m) => m.id).join(', ')}`);
process.exit(nicht.length === 0 && ergebnis.nachher.rot.length === 0 ? 0 : 1);
