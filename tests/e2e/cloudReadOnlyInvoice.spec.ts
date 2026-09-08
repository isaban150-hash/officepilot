import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { CLOUD_AUTH_STATE } from '../../playwright.cloud.config';

/**
 * OFFICEPILOT-LIVE-AGENT-READONLY-INVOICE-01B — erster Rechnungs-Fachtest.
 *
 * Öffnet eine **vorhandene** Rechnung und belegt ihre Seitenstruktur — rein
 * lesend. Geklickt werden nur Navigationselemente: Vorgangskarten, der
 * Rechnungs-Tab und genau ein Öffnen-Knopf.
 *
 * 01B2 — die Suche geht über **alle** Vorgänge.
 *
 * Zuerst prüfte der Test nur den strukturell ersten Vorgang. Der hatte keine
 * Rechnung, und der Test übersprang sich — dauerhaft und unbemerkt, obwohl
 * anderswo Rechnungen liegen konnten. Ein Test, der sich immer überspringt,
 * sieht aus wie Abdeckung und ist keine.
 *
 * Die Suche bleibt rein strukturell: Karten werden über ihre Position
 * durchlaufen, nie über Kunde, Titel, Betrag, Datum, Status oder
 * Rechnungsnummer. Entschieden wird allein daran, **ob** ein Öffnen-Knopf
 * existiert — nicht, was auf der Karte steht.
 *
 * ⚠️ Der Workspace ist nicht als Testworkspace nachgewiesen. Deshalb liest
 * dieser Test keinen Text aus und bringt weder Adresse noch Kennungen ins
 * Protokoll; zugesichert wird ausschliesslich Struktur.
 */

const SETUP_HINT =
  'Die lokale OfficePilot-Testsitzung fehlt. Bitte zuerst `npm run test:e2e:auth` ausführen und sich einmal manuell anmelden.';

const EXPIRED_HINT =
  'Die lokale OfficePilot-Testsitzung ist abgelaufen oder ungültig. Bitte `npm run test:e2e:auth` erneut ausführen.';

const CARD_SELECTOR = '.card-list a.card-link';

test.beforeAll(() => {
  expect(existsSync(CLOUD_AUTH_STATE), SETUP_HINT).toBe(true);
});

async function expectSignedIn(page: import('@playwright/test').Page) {
  if (await page.getByTestId('login-page').isVisible().catch(() => false)) {
    throw new Error(EXPIRED_HINT);
  }
  await expect(page.getByTestId('app-shell'), EXPIRED_HINT).toBeVisible();
}

async function openVorgangList(page: import('@playwright/test').Page) {
  await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });
  await expectSignedIn(page);
}

test('Fachflow: eine vorhandene Rechnung read-only öffnen', async ({ page }) => {
  await test.step('Vorgangsliste öffnen', async () => {
    await openVorgangList(page);
  });

  const isEmpty = await page
    .getByTestId('vorgaenge-empty-state')
    .isVisible()
    .catch(() => false);
  test.skip(isEmpty, 'Fachtest nicht ausgeführt, weil kein Vorgang vorhanden ist.');

  const totalCards = await page.locator(CARD_SELECTOR).count();
  expect(totalCards, 'Keine Vorgangskarte gefunden').toBeGreaterThan(0);

  /*
   * Vollständiger Durchlauf, keine willkürliche Obergrenze: Der Bestand
   * bestimmt den Umfang. Die Vorgangsdetailseite ruft die Cloud nicht auf, die
   * Suche ist deshalb rein lokal und günstig.
   */
  let checkedVorgaenge = 0;
  let foundOpenableInvoice = false;

  for (let index = 0; index < totalCards; index += 1) {
    if (index > 0) await openVorgangList(page);

    await page.locator(CARD_SELECTOR).nth(index).click();
    await expect(page.getByTestId('vorgang-detail-page')).toBeVisible();

    /*
     * Der Rechnungsbereich liegt in einem Tab-Panel (`hidden: !selected`). Der
     * Wechsel setzt nur einen Suchparameter in der Adresse — reine
     * Ansichtsnavigation, kein Datenzugriff.
     */
    await page.getByTestId('vorgang-section-tab-invoices').click();
    await expect(page.getByTestId('vorgang-invoices-section')).toBeVisible();
    checkedVorgaenge += 1;

    /*
     * Drei Lagen, eine Entscheidung: Ohne Öffnen-Knopf ist dieser Vorgang
     * ungeeignet — gleich ob er gar keine Rechnung trägt oder nur Entwürfe.
     * `invoice-list-card-open` erscheint ausschliesslich bei finalisierten
     * Rechnungen.
     */
    const openableCount = await page.getByTestId('invoice-list-card-open').count();
    if (openableCount > 0) {
      foundOpenableInvoice = true;
      break;
    }
  }

  /* Nur eine Anzahl — kein Inhalt. */
  console.log(`  Strukturell geprüfte Vorgänge: ${checkedVorgaenge} von ${totalCards}`);

  test.skip(
    !foundOpenableInvoice,
    'Fachtest nicht ausgeführt, weil in keinem vorhandenen Vorgang eine finalisierte oder öffnbare Rechnung vorhanden ist.',
  );

  await test.step('Erste öffnbare Rechnung öffnen', async () => {
    /* Wir stehen bereits auf dem gefundenen Vorgang — nicht neu navigieren. */
    await page.getByTestId('invoice-list-card-open').first().click();

    /*
     * Erscheint hier nichts, ist das ein echter Fehlschlag — auch bei
     * fehlenden historischen Snapshots. Für diesen Zustand gibt es keinen
     * eigenen Selektor, und ein Textabgleich käme als Behelf nicht in Frage:
     * Er holte Geschäftstext in den Test.
     */
    await expect(page.getByTestId('invoice-detail-page')).toBeVisible();
  });

  await test.step('Route ist die Rechnungsdetailseite — ohne Kennungen preiszugeben', async () => {
    /* Die Adresse trägt zwei Kennungen; nur ein Wahrheitswert verlässt den Browser. */
    const isInvoiceDetailRoute = await page.evaluate(() =>
      /^\/vorgaenge\/[^/]+\/rechnungen\/[^/]+$/.test(window.location.pathname),
    );
    expect(isInvoiceDetailRoute).toBe(true);
  });

  await test.step('Struktur der Rechnungsseite', async () => {
    await expect(page.getByTestId('invoice-sent-panel')).toBeVisible();

    /*
     * Ausdrücklich **keine** Sichtbarkeitsprüfung: Das Rechnungsdokument trägt
     * beim Laden `invoice-print-document--screen-hidden` und ist am Bildschirm
     * bewusst verborgen, solange „Mehr anzeigen" geschlossen ist. Es muss im
     * DOM stehen — genau darauf beruht der Druckpfad.
     */
    await expect(page.getByTestId('invoice-print-document')).toHaveCount(1);
    await expect(page.getByTestId('invoice-print-document')).toBeAttached();
  });

  await test.step('Zurück zur Liste', async () => {
    await openVorgangList(page);

    const backOnList = await page.evaluate(() => window.location.pathname === '/vorgaenge');
    expect(backOnList).toBe(true);

    /*
     * Zusatz-Gegenprobe, kein Beweis: Die eigentliche Read-only-Zusicherung
     * liegt darin, dass ausschliesslich Navigationselemente geklickt wurden.
     */
    expect(await page.locator(CARD_SELECTOR).count(), 'Der Bestand hat sich verändert').toBe(
      totalCards,
    );
  });
});
