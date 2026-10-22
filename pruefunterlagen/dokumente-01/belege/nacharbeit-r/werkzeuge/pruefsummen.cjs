// DOKUMENTE-01 R1/R2 — SHA256 der geänderten und neuen Dateien zum Abgabestand (Format wie nacharbeit-n).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repo = process.argv[2];
const ziel = process.argv[3];
const DATEIEN = [
  'src/services/sync/syncRunIdentityService.ts',
  'src/services/sync/syncConfirmationJournal.ts',
  'src/services/sync/syncOutboxOriginService.ts',
  'src/i18n/locales/de/syncHeldOrders.ts',
  'src/services/sync/supabaseSyncAdapter.ts',
  'src/services/sync/syncAdapter.ts',
  'src/services/sync/syncCoordinator.ts',
  'src/services/sync/syncOutboxService.ts',
  'src/services/sync/syncUiService.ts',
  'src/services/sync/syncIndicatorService.ts',
  'src/services/persistenceService.ts',
  'src/services/storage/storageBootstrapService.ts',
  'src/services/storage/workspaceAccountStorageService.ts',
  'src/services/orderAmendment/orderAmendmentCloudPullOrchestrator.ts',
  'src/types/sync.ts',
  'src/pages/SyncPage.tsx',
  'src/i18n/locales/de/index.ts',
  'src/services/sync/sendekontoR1Dokumente01.test.ts',
  'src/services/sync/altwarteschlangeR2Dokumente01.test.ts',
  'src/pages/syncHeldOrdersR2Dokumente01.test.tsx',
  'src/companyIdentityRecovery02.test.tsx',
  'src/services/sync/syncPullPersistService.ts',
  'pruefunterlagen/dokumente-01/03-weiss-szenarien.md',
  'pruefunterlagen/dokumente-01/04-pruefumgebung.md',
  'pruefunterlagen/dokumente-01/07-nacharbeit-r1-r2.md',
];
const zeilen = DATEIEN.map((datei) => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, datei))).digest('hex');
  return `${hash} *${datei}`;
});
fs.writeFileSync(ziel, `${zeilen.join('\n')}\n`);
console.log(`${zeilen.length} Prüfsummen geschrieben`);
