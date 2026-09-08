import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { CLOUD_AUTH_STATE } from '../../playwright.cloud.config';

/**
 * OFFICEPILOT-LIVE-AGENT-CLOUD-TEST-01B — die gespeicherte Sitzung trägt.
 *
 * Vollständig **lesend**: zwei geschützte Seiten öffnen und prüfen, dass die
 * Anwendung angemeldet bleibt. Kein Klick, der Daten ändern könnte, kein
 * Upload, kein Formular — und ausdrücklich kein Auslesen von Kunden-,
 * Rechnungs- oder Dokumentwerten.
 *
 * ⚠️ Kein Anmelde-Rückfall. Fehlt die Sitzung oder ist sie abgelaufen, bricht
 * der Test mit einer Anweisung ab, statt still ein Fenster zu öffnen oder nach
 * Zugangsdaten zu suchen. Ein stiller Neu-Login würde verdecken, dass die
 * Wiederverwendung — das eigentliche Prüfziel — nicht funktioniert.
 */

const SETUP_HINT =
  'Die lokale OfficePilot-Testsitzung fehlt. Bitte zuerst `npm run test:e2e:auth` ausführen und sich einmal manuell anmelden.';

const EXPIRED_HINT =
  'Die lokale OfficePilot-Testsitzung ist abgelaufen oder ungültig. Bitte `npm run test:e2e:auth` erneut ausführen.';

test.beforeAll(() => {
  /*
   * Vor allem anderen: Ohne Datei ist jede weitere Meldung irreführend — der
   * Test würde an der Anmeldemaske scheitern und wie ein Auth-Fehler aussehen.
   */
  expect(existsSync(CLOUD_AUTH_STATE), SETUP_HINT).toBe(true);
});

/** Öffnet eine geschützte Seite und belegt, dass die Sitzung getragen hat. */
async function openProtected(page: import('@playwright/test').Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });

  /*
   * Zuerst der Abbruchgrund, dann die Zusicherung: Erscheint die
   * Anmeldemaske, ist die Sitzung ungültig — das ist eine andere Lage als
   * „Seite lädt nicht" und verdient eine eigene Meldung.
   */
  if (await page.getByTestId('login-page').isVisible().catch(() => false)) {
    throw new Error(EXPIRED_HINT);
  }

  await expect(page.getByTestId('app-shell'), EXPIRED_HINT).toBeVisible();
  expect(page.url(), EXPIRED_HINT).not.toMatch(/\/login/);
}

test('Cloud-Sitzung: geschützte Seiten ohne erneute Anmeldung', async ({ page }) => {
  await test.step('Vorgänge öffnen', async () => {
    await openProtected(page, '/vorgaenge');
  });

  await test.step('Ablage öffnen', async () => {
    await openProtected(page, '/ablage');
  });

  await test.step('Zurück zu den Vorgängen', async () => {
    /* Belegt, dass die Sitzung mehrere volle Seitenaufbauten übersteht. */
    await openProtected(page, '/vorgaenge');
  });
});
