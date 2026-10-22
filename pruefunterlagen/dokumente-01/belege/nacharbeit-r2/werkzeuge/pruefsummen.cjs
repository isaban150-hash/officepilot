// DOKUMENTE-01 Restkorrektur — SHA256 der geänderten und neuen Dateien zum Abgabestand (Format wie nacharbeit-r).
// Aufruf aus dem Repo: node pruefunterlagen/dokumente-01/belege/nacharbeit-r2/werkzeuge/pruefsummen.cjs . <ziel>
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repo = process.argv[2];
const ziel = process.argv[3];
const DATEIEN = [
  'src/services/sync/syncRunIdentityService.ts',
  'src/services/sync/supabaseSyncAdapter.ts',
  'src/services/sync/syncAdapter.ts',
  'src/services/sync/syncCoordinator.ts',
  'src/pages/SyncPage.tsx',
  'src/services/document/generatedInvoiceDocumentDeleteService.ts',
  'src/i18n/locales/de/vorgangsbindung.ts',
  'src/i18n/locales/de/index.ts',
  'src/services/sync/sendekontoR1Dokumente01.test.ts',
  'src/services/sync/startidentitaetR1Dokumente01.test.ts',
  'src/services/document/loeschvorgangBindungDokumente01.test.ts',
  'src/pages/syncHaltMeldungR1Dokumente01.test.tsx',
  'pruefunterlagen/dokumente-01/03-weiss-szenarien.md',
  'pruefunterlagen/dokumente-01/04-pruefumgebung.md',
  'pruefunterlagen/dokumente-01/08-restkorrektur-r1-start-loeschung.md',
];
const zeilen = DATEIEN.map((datei) => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, datei))).digest('hex');
  return `${hash} *${datei}`;
});
fs.writeFileSync(ziel, `${zeilen.join('\n')}\n`);
console.log(`${zeilen.length} Prüfsummen geschrieben`);
