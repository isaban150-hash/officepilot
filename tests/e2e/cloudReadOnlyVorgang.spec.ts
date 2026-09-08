import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { CLOUD_AUTH_STATE } from '../../playwright.cloud.config';

/**
 * OFFICEPILOT-LIVE-AGENT-READONLY-FACHFLOW-01B — der erste echte Fachtest.
 *
 * Geprüft wird mit **vorhandenen** Daten, aber ausschliesslich lesend: Liste
 * öffnen, den ersten Vorgang rein strukturell auswählen, die Seitenstruktur
 * belegen, zurückgehen. Kein Klick, der etwas ändern könnte.
 *
 * ⚠️ Datenschutz ist hier kein Nebenaspekt, sondern die Bauvorschrift:
 *
 * Der Workspace ist **nicht** als dedizierter Testworkspace nachgewiesen — es
 * können echte Kunden, Vorgänge und Beträge sichtbar sein. Deshalb liest
 * dieser Test keinen einzigen Text aus, wählt nichts über Namen oder Beträge
 * aus und schreibt weder URL noch Kennungen ins Protokoll. Zugesichert wird
 * nur Struktur: Sichtbarkeit, Anzahl, Ja/Nein.
 *
 * Auch die Routenprüfung läuft deshalb über einen Wahrheitswert im Browser
 * statt über `toHaveURL` — schlüge jene fehl, stünde die echte Vorgangskennung
 * im Fehlerbericht.
 */

const SETUP_HINT =
  'Die lokale OfficePilot-Testsitzung fehlt. Bitte zuerst `npm run test:e2e:auth` ausführen und sich einmal manuell anmelden.';

const EXPIRED_HINT =
  'Die lokale OfficePilot-Testsitzung ist abgelaufen oder ungültig. Bitte `npm run test:e2e:auth` erneut ausführen.';

test.beforeAll(() => {
  expect(existsSync(CLOUD_AUTH_STATE), SETUP_HINT).toBe(true);
});

/** Belegt, dass die Sitzung getragen hat — ohne die Adresse zu verraten. */
async function expectSignedIn(page: import('@playwright/test').Page) {
  if (await page.getByTestId('login-page').isVisible().catch(() => false)) {
    throw new Error(EXPIRED_HINT);
  }
  await expect(page.getByTestId('app-shell'), EXPIRED_HINT).toBeVisible();
}

test('Fachflow: einen vorhandenen Vorgang read-only öffnen', async ({ page }) => {
  await test.step('Vorgangsliste öffnen', async () => {
    await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });
    await expectSignedIn(page);
  });

  /*
   * Ein leerer Bestand ist kein Defekt, aber auch kein bestandener Fachtest.
   * Deshalb wird ausdrücklich übersprungen statt grün gemeldet.
   */
  const isEmpty = await page
    .getByTestId('vorgaenge-empty-state')
    .isVisible()
    .catch(() => false);
  test.skip(isEmpty, 'Fachtest nicht ausgeführt, weil kein Vorgang vorhanden ist.');

  /*
   * Auswahl rein strukturell: erste Karte der Liste. Niemals über Text,
   * Kundennamen, Titel, Betrag oder Status — die Reihenfolge der Liste ist
   * eine Struktureigenschaft, ihr Inhalt nicht.
   */
  const cards = page.locator('.card-list a.card-link');
  const cardCountBefore = await cards.count();
  expect(cardCountBefore, 'Keine Vorgangskarte gefunden').toBeGreaterThan(0);

  await test.step('Ersten Vorgang öffnen', async () => {
    await cards.first().click();
    await expect(page.getByTestId('vorgang-detail-page')).toBeVisible();
  });

  await test.step('Route ist die Detailseite — ohne die Kennung preiszugeben', async () => {
    /*
     * Nur ein Wahrheitswert verlässt den Browser. Im Fehlerfall erscheint
     * `false`, niemals `/vorgaenge/<id>`.
     */
    const isVorgangDetailRoute = await page.evaluate(() =>
      /^\/vorgaenge\/[^/]+$/.test(window.location.pathname),
    );
    expect(isVorgangDetailRoute).toBe(true);
  });

  await test.step('Übersicht ist die Standardsektion', async () => {
    await expect(page.getByTestId('vorgang-overview-status')).toBeVisible();
  });

  await test.step('Rechnungsbereich ist erreichbar', async () => {
    /*
     * Der Rechnungsbereich liegt in einem eigenen Tab-Panel
     * (`hidden: !selected`) und ist beim Öffnen der Seite nicht sichtbar. Der
     * Bereichswechsel ist reine Ansichtsnavigation — `setActiveSection` setzt
     * ausschliesslich einen Suchparameter in der Adresse und verändert keine
     * Daten. Er steht deshalb auf keiner Verbotsliste.
     */
    await page.getByTestId('vorgang-section-tab-invoices').click();
    await expect(page.getByTestId('vorgang-invoices-section')).toBeVisible();
  });

  await test.step('Zurück zur Liste — der Bestand ist unverändert', async () => {
    await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });
    await expectSignedIn(page);

    const backOnList = await page.evaluate(() => window.location.pathname === '/vorgaenge');
    expect(backOnList).toBe(true);

    /*
     * Gegenprobe zur Read-only-Zusicherung: Ein versehentlich ausgelöster
     * Schreibvorgang — etwa ein angelegter Entwurf oder Vorgang — würde die
     * Anzahl verändern. Gezählt wird, nicht gelesen.
     */
    expect(await cards.count(), 'Der Bestand hat sich verändert').toBe(cardCountBefore);
  });
});
