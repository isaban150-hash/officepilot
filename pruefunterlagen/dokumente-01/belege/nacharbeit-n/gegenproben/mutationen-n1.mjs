// DOKUMENTE-01 N1 — Gegenproben der Kontotrennung in der isolierten Kopie (nie im Repo).
// Je Mutation: eine Schutzstelle entfernen, die zugehörigen Tests laufen lassen (sie MÜSSEN rot werden),
// Datei wiederherstellen. Vorher und nachher ein unmutierter Lauf (muss grün sein).
//   node mutationen-n1.mjs <kopie-repo> <bericht.json>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const [kopie, bericht] = process.argv.slice(2);
if (!kopie || !/OfficeTakt-Sicherungen[\\/]DOK01-GEGENPROBEN-/.test(kopie)) throw new Error('Nur in der isolierten Kopie');

const T_DIENST = 'src/services/storage/kontoTrennungDokumente01.test.ts';
const T_GATE = 'src/kontoTrennungGateDokumente01.test.tsx';
const T_ERSTZUGANG = 'src/memberFirstAccessFc01a.test.tsx';

const MUTATIONEN = [
  {
    id: 'M1 Zustand ohne Kontotrennung (gemeinsamer Betriebsschlüssel wie vor N1)',
    datei: 'src/services/storage/storageScopeService.ts',
    alt: '        ? `${STORAGE_KEY_PREFIX}:workspace:${scope.workspaceId}:account:${account.userId}:${account.access}`',
    neu: '        ? `${STORAGE_KEY_PREFIX}:workspace:${scope.workspaceId}`',
    tests: [T_DIENST, T_GATE],
  },
  {
    id: 'M2 Dateien ohne Kontotrennung (gemeinsamer Blob-Bereich)',
    datei: 'src/services/storage/documentBlobScopeService.ts',
    alt: '        ? `workspace:${scope.workspaceId}:account:${account.userId}:${account.access}`',
    neu: '        ? `workspace:${scope.workspaceId}`',
    tests: [T_DIENST],
  },
  {
    id: 'M3 Sicht nicht im Schlüssel (Admin- und Mitgliedsbestand gemeinsam)',
    datei: 'src/services/storage/storageScopeService.ts',
    alt: '        ? `${STORAGE_KEY_PREFIX}:workspace:${scope.workspaceId}:account:${account.userId}:${account.access}`',
    neu: '        ? `${STORAGE_KEY_PREFIX}:workspace:${scope.workspaceId}:account:${account.userId}`',
    tests: [T_DIENST, T_GATE],
  },
  {
    id: 'M4 Cloud-Bootstrap wechselt wie vor N1 mit der Inhaberkennung',
    datei: 'src/services/workspace/workspaceCloudBootstrapService.ts',
    alt: '    if (account) {\n      switchToWorkspaceScope(account.userId, workspaceId, account.access, ownerUserId);',
    neu: '    if (account && false) {\n      switchToWorkspaceScope(account.userId, workspaceId, account.access, ownerUserId);',
    tests: [T_GATE],
  },
  {
    id: 'M5 Mitgliedschaft im Abzug nicht geprüft (kein Sperren)',
    datei: 'src/services/workspace/workspaceCloudBootstrapService.ts',
    alt: "    if (sessionUserId && !account) {\n      return { status: 'failed', reason: 'auth', localWorkspaceCandidate: hasLocalWorkspaceCompany };\n    }\n",
    neu: '',
    tests: [T_GATE],
  },
  {
    id: 'M6 Kein Aufräumen beim direkten Kontowechsel',
    datei: 'src/components/system/BusinessStateGate.tsx',
    alt: '      if (bootstrappedUserRef.current && nextUserId && bootstrappedUserRef.current !== nextUserId) {',
    neu: '      if (false && bootstrappedUserRef.current && nextUserId && bootstrappedUserRef.current !== nextUserId) {',
    tests: [T_GATE],
  },
  {
    id: 'M7 Mitglied übernimmt den Altbestand des Betriebs',
    datei: 'src/services/storage/workspaceAccountStorageService.ts',
    alt: "  if (account.access === 'member') {\n    return legacyRaw !== null ? { action: 'kept_legacy' } : { action: 'none' };\n  }\n",
    neu: '',
    tests: [T_DIENST],
  },
  {
    id: 'M8 Mitglied fasst den globalen Altbestand an (Quarantäne)',
    datei: 'src/services/storage/legacyMigrationService.ts',
    alt: "  if (scope.type === 'workspace' && scope.account?.access === 'member') {\n    return { action: 'none' };\n  }\n",
    neu: '',
    tests: [T_DIENST],
  },
  {
    id: 'M9 Nutzerbereich eines Nicht-Inhabers wird mit Geschäftsdaten übernommen',
    datei: 'src/services/storage/legacyMigrationService.ts',
    alt: '  if (account && account.userId !== ownerUserId) {',
    neu: '  if (false && account && account.userId !== ownerUserId) {',
    tests: [T_DIENST, T_GATE],
  },
  {
    id: 'M10 Hinweis-Auswahl wieder gerätweit',
    datei: 'src/services/homeHintDismissalService.ts',
    alt: '  return getActiveStorageAccount() ? `${getActiveStorageKey()}:home-hint-dismissals` : STORAGE_KEY;',
    neu: '  return STORAGE_KEY;',
    tests: [T_DIENST],
  },
  {
    id: 'M11 Rolle member ergibt volle Sicht',
    datei: 'src/services/storage/workspaceAccountStorageService.ts',
    alt: "  if (member.role === 'member') return 'member';",
    neu: "  if (member.role === 'member') return 'full';",
    tests: [T_DIENST, T_GATE, T_ERSTZUGANG],
  },
  {
    id: 'M12 Inaktive Mitgliedschaft gilt als Zugang',
    datei: 'src/services/storage/workspaceAccountStorageService.ts',
    alt: "  if (!member || member.status !== 'active') return null;",
    neu: '  if (!member) return null;',
    tests: [T_DIENST, T_GATE],
  },
  {
    id: 'M13 Doppelte Mitgliedszeile wird akzeptiert',
    datei: 'src/services/storage/workspaceAccountStorageService.ts',
    alt: '  if (eigene.length !== 1) return null;',
    neu: '  if (eigene.length === 0) return null;',
    tests: [T_DIENST],
  },
  {
    id: 'M15 Lauf über einen Kontowechsel wird trotzdem angewendet',
    datei: 'src/services/sync/syncPullPersistService.ts',
    alt: '  if (input.base?.storageKey !== undefined && input.base.storageKey !== getActiveStorageKey()) {',
    neu: '  if (false && input.base?.storageKey !== undefined && input.base.storageKey !== getActiveStorageKey()) {',
    tests: [T_DIENST, T_GATE],
  },
  {
    id: 'M16 Navigationszustand ohne Bereichsprüfung (Vorbelegung über „Zurück“)',
    datei: 'src/services/storage/storageScopeService.ts',
    alt: '  return (state as Record<string, unknown>)[NAVIGATION_STATE_SCOPE_KEY] === getActiveStorageKey();',
    neu: '  return true;',
    tests: [T_DIENST],
  },
  {
    id: 'M17 Rückkehr aus dem Seiten-Cache lädt trotz anderem Konto nicht neu',
    datei: 'src/services/auth/pageCacheAccountGuard.ts',
    alt: '      if (storedUserId !== boundUserId) pageCacheAccountDeps.reload();',
    neu: '      if (false && storedUserId !== boundUserId) pageCacheAccountDeps.reload();',
    tests: [T_GATE],
  },
  {
    id: 'M18 Seiten-Cache-Schutz im Gate nicht eingebunden',
    datei: 'src/components/system/BusinessStateGate.tsx',
    alt: '  useEffect(() => watchPageCacheAccount(() => bootstrappedUserRef.current), []);',
    neu: '  useEffect(() => undefined, []);',
    tests: [T_GATE],
  },
  {
    id: 'M14 Notfall-Inventar erkennt Kontobestände nicht',
    datei: 'src/services/storage/localScopeInventoryService.ts',
    alt: '    const konto = id.match(/^([^:]+):account:([^:]+):(full|member)$/);',
    neu: '    const konto = id.match(/^([^:]+):account:([^:]+):(nie)$/);',
    tests: [T_DIENST],
  },
];

function vitest(tests, ausgabe) {
  const r = spawnSync(process.execPath, [join(kopie, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.safe.config.ts', '--maxWorkers=2', '--reporter=json', `--outputFile=${ausgabe}`, ...tests], {
    cwd: kopie,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GOLD_WRITE_REPORT: '' },
  });
  let j = null;
  try { j = JSON.parse(readFileSync(ausgabe, 'utf8')); } catch { /* */ }
  const rot = (j?.testResults ?? []).flatMap((t) => (t.assertionResults ?? []).filter((a) => a.status === 'failed').map((a) => ({
    test: a.fullName,
    grund: String((a.failureMessages ?? [])[0] ?? '').split('\n')[0].slice(0, 220),
  })));
  return { exit: r.status, gesamt: j?.numTotalTests ?? 0, rot };
}

function zeilenende(text, muster) {
  return text.includes('\r\n') ? muster.replace(/\r?\n/g, '\r\n') : muster;
}

const alleTests = [T_DIENST, T_GATE, T_ERSTZUGANG];
const ergebnis = { start: new Date().toISOString(), vorher: null, mutationen: [], nachher: null };
const tmp = join(kopie, '..', 'vitest-tmp.json');

ergebnis.vorher = vitest(alleTests, tmp);
console.log(`Vorher (unmutiert): ${ergebnis.vorher.gesamt} Tests, rot ${ergebnis.vorher.rot.length}`);
if (ergebnis.vorher.rot.length > 0 || ergebnis.vorher.gesamt === 0) throw new Error('Ausgangslauf nicht grün');

for (const m of MUTATIONEN) {
  const pfad = join(kopie, m.datei);
  const original = readFileSync(pfad, 'utf8');
  const alt = zeilenende(original, m.alt);
  const neu = zeilenende(original, m.neu);
  const treffer = original.split(alt).length - 1;
  if (treffer !== 1) {
    ergebnis.mutationen.push({ id: m.id, fehler: `Anker ${treffer}× gefunden` });
    console.log(`${m.id}: ANKER ${treffer}×`);
    continue;
  }
  writeFileSync(pfad, original.replace(alt, neu));
  try {
    const lauf = vitest(m.tests, tmp);
    const erkannt = lauf.rot.length > 0;
    ergebnis.mutationen.push({ id: m.id, datei: m.datei, erkannt, gesamt: lauf.gesamt, rot: lauf.rot.slice(0, 12) });
    console.log(`${m.id}: ${erkannt ? 'ERKANNT' : 'NICHT ERKANNT'} (${lauf.rot.length} rot von ${lauf.gesamt})`);
    for (const f of lauf.rot.slice(0, 4)) console.log(`    - ${f.test.slice(0, 120)}\n        ${f.grund.slice(0, 160)}`);
  } finally {
    writeFileSync(pfad, original);
  }
}

ergebnis.nachher = vitest(alleTests, tmp);
console.log(`Nachher (wiederhergestellt): ${ergebnis.nachher.gesamt} Tests, rot ${ergebnis.nachher.rot.length}`);
mkdirSync(dirname(bericht), { recursive: true });
writeFileSync(bericht, JSON.stringify(ergebnis, null, 2));
const nicht = ergebnis.mutationen.filter((m) => !m.erkannt);
console.log(nicht.length === 0 ? 'Alle Mutationen erkannt.' : `Nicht erkannt: ${nicht.map((m) => m.id).join(', ')}`);
process.exit(nicht.length === 0 && ergebnis.nachher.rot.length === 0 ? 0 : 1);
