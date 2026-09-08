import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';
import { CLOUD_AUTH_STATE } from '../../playwright.cloud.config';
import {
  CLOUD_WRITE_AUTHORIZATION_FILE,
  CLOUD_WRITE_AUTHORIZATION_SCHEMA_VERSION,
  isValidWorkspaceFingerprint,
  readCloudScopeSnapshot,
  readCloudWriteAuthorization,
  validateAuthorizationShape,
} from './support/cloudWriteGate';

/**
 * OFFICEPILOT-E2E-CLOUD-WRITE-GATE-01B — die einmalige, bewusste Autorisierung.
 *
 * Läuft ausschliesslich auf Zuruf über ein eigenes npm-Script und ist
 * **Abhängigkeit von nichts**. Genau das ist der Punkt: Würde ein Cloud-Test
 * diese Autorisierung selbst auslösen können, wäre das Gate wertlos — es
 * autorisierte dann stets den Workspace, in dem es gerade steht.
 *
 * ⚠️ Die rohe Workspace-Kennung verlässt den Browser nicht. Geschrieben wird
 * nur ihr SHA-256-Fingerprint; ausgegeben wird selbst der nicht.
 *
 * Der Nutzer hat ausdrücklich bestätigt, dass der derzeit angemeldete Account
 * und der aufgelöste Workspace ausschliesslich Testdaten enthalten. Dieser Lauf
 * hält genau diese Zusage technisch fest — er prüft sie nicht nach und kann das
 * auch nicht.
 */

const SETUP_HINT =
  'Die lokale OfficePilot-Testsitzung fehlt. Bitte zuerst `npm run test:e2e:auth` ausführen und sich einmal manuell anmelden.';

const EXPIRED_HINT =
  'Die lokale OfficePilot-Testsitzung ist abgelaufen oder ungültig. Bitte `npm run test:e2e:auth` erneut ausführen.';

test.beforeAll(() => {
  expect(existsSync(CLOUD_AUTH_STATE), SETUP_HINT).toBe(true);
});

test('Autorisierung: aktuellen Workspace einmalig als E2E-Schreibworkspace hinterlegen', async ({
  page,
}) => {
  await test.step('Angemeldete Sitzung belegen', async () => {
    await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });

    if (await page.getByTestId('login-page').isVisible().catch(() => false)) {
      throw new Error(EXPIRED_HINT);
    }
    await expect(page.getByTestId('app-shell'), EXPIRED_HINT).toBeVisible();
  });

  const scope = await readCloudScopeSnapshot(page);

  /* Nur Zahlen und Ja/Nein — nie eine Kennung, nie ein Fingerprint. */
  console.log(`  Auth erkannt: ${scope.authKeys === 1 ? 'ja' : 'nein'}`);
  console.log(`  Anzahl workspace-Scope: ${scope.workspaceKeys}`);
  console.log(`  user-Scope: ${scope.userKeys}`);
  console.log(`  guest-Scope: ${scope.guestKeys}`);
  console.log(`  Auth-Key-Anzahl: ${scope.authKeys}`);
  console.log(`  Web Crypto verfügbar: ${scope.cryptoAvailable ? 'ja' : 'nein'}`);

  /*
   * Dieselben Bedingungen wie im Gate, hier schon beim Erteilen. Eine
   * Autorisierung, die aus einem mehrdeutigen Zustand entsteht, wäre für immer
   * fragwürdig — und die Datei überlebt den Lauf.
   */
  expect(scope.workspaceKeys, 'Kein eindeutiger Workspace-Scope').toBe(1);
  expect(scope.userKeys, 'Es liegt ein user-Scope vor').toBe(0);
  expect(scope.guestKeys, 'Es liegt ein guest-Scope vor').toBe(0);
  expect(scope.authKeys, 'Kein eindeutiger Supabase-Auth-Eintrag').toBe(1);
  expect(
    scope.cryptoAvailable,
    'Web Crypto steht im Browserkontext nicht zur Verfügung — es wird nichts geschrieben.',
  ).toBe(true);
  expect(
    isValidWorkspaceFingerprint(scope.workspaceFingerprint),
    'Der im Browser gebildete Fingerprint hat kein gültiges Format.',
  ).toBe(true);

  const authorization = {
    schemaVersion: CLOUD_WRITE_AUTHORIZATION_SCHEMA_VERSION,
    workspaceFingerprint: scope.workspaceFingerprint,
    /* Unkritisch und nützlich: Er sagt, wann autorisiert wurde, nicht wofür. */
    createdAt: new Date().toISOString(),
  };

  mkdirSync(dirname(CLOUD_WRITE_AUTHORIZATION_FILE), { recursive: true });
  writeFileSync(CLOUD_WRITE_AUTHORIZATION_FILE, JSON.stringify(authorization), 'utf8');

  /*
   * Gegenprobe am geschriebenen Ergebnis, nicht an der Absicht — gelesen wird
   * die Datei, geprüft wird ihre Struktur, ausgegeben wird nichts davon.
   */
  const shape = validateAuthorizationShape(readCloudWriteAuthorization());
  expect(shape.ok, 'Die geschriebene Autorisierungsdatei ist strukturell ungültig.').toBe(true);

  console.log(`  Autorisierungsdatei geschrieben: ja (${CLOUD_WRITE_AUTHORIZATION_FILE})`);
  console.log('  strukturell nur Schema/Fingerprint/Zeitstempel: ja');
  console.log('  Inhalt wird bewusst nicht ausgegeben.');
});
