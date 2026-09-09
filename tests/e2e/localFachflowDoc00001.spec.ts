import { expect, test } from './support/localFachflowFixture';

/**
 * OFFICEPILOT-LOCAL-E2E-DOC-00001-INTAKE-01B — der erste echte Fachflow.
 *
 * Gefahren wird der Weg, den auch ein Mensch geht: Upload-Seite öffnen, Datei
 * wählen, Vorschau abwarten, dauerhaft speichern, in der Ablage öffnen, Analyse
 * abwarten. Nichts wird abgekürzt — kein Service direkt aufgerufen, kein
 * fertiger Dokumentzustand eingespielt, keine Klassifikation und keine
 * Extraktion gefälscht.
 *
 * ⚠️ Bewusst `source.pdf` und nicht `source.jpg`: Das PDF trägt eingebetteten
 * Text (1 Seite, 99 Textelemente), läuft also über die native
 * PDF-Textextraktion. Der OCR-Zweig würde Tesseract-Ressourcen aus dem Netz
 * nachladen — die sind blockiert und bleiben es.
 *
 * Datenschutz: Der Test liest keinen Dokumenttext aus, wählt nichts über
 * Kundennamen oder Titel und protokolliert keine Kennungen. Zugesichert wird
 * ausschliesslich Struktur.
 *
 * Grenze dieses Tests: Er endet **vor** der Vorgangsanlage. Kein Auftrag, keine
 * Rechnung, kein `/synchronisation`, und nach lokalen Geschäftsänderungen kein
 * Neuladen — ein erneuter Bootstrap würde die Outbox senden und am
 * Cloud-Guard zu Recht scheitern.
 */

const DOC_00001_PDF = 'test-world/documents/DOC-00001/source.pdf';

/* Echte Verarbeitung im Browser: PDF-Parsen und Klassifikation brauchen Zeit. */
test.setTimeout(120_000);

test('Fachflow: DOC-00001 über den echten Upload- und Analysepfad', async ({ page, guard }) => {
  await test.step('Upload-Seite öffnen und die Datei über das echte Eingabefeld wählen', async () => {
    /*
     * Genau **ein** vollständiger Seitenaufbau im ganzen Test.
     *
     * Jedes weitere `goto` wäre ein Neuladen und damit ein zweiter
     * Workspace-Bootstrap — den blockiert der Cloud-Guard zu Recht, weil
     * `ensure_personal_workspace` serverseitig schreibfähig ist und nur zum
     * Hochfahren gehört. Ab hier wird deshalb ausschliesslich über die
     * Oberfläche navigiert, so wie ein Mensch es auch täte.
     */
    await page.goto('/dokumente/upload', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByTestId('document-upload-page')).toBeVisible();

    /* Das echte `<input type="file">` der Anwendung — keine Sonderlösung. */
    await page.getByTestId('document-upload-input').setInputFiles(DOC_00001_PDF);
  });

  await test.step('Echte PDF-Verarbeitung und Vorschau', async () => {
    await expect(page.getByTestId('ocr-preview-panel')).toBeVisible();

    /* Ein Verarbeitungsfehler wäre das Gegenteil des Prüfziels. */
    await expect(page.getByTestId('ocr-confirm-error')).toHaveCount(0);

    await expect(page.getByTestId('storage-recommendation')).toBeVisible();
    await expect(page.getByTestId('storage-recommendation-level')).toBeVisible();
    await expect(page.getByTestId('ocr-storage-decision-actions')).toBeVisible();
    await expect(page.getByTestId('storage-decision-save-permanently')).toBeVisible();
  });

  await test.step('Dauerhaft speichern — über den echten Knopf', async () => {
    await page.getByTestId('storage-decision-save-permanently').click();
  });

  await test.step('Die Anwendung führt selbst zur Detailseite und die Analyse läuft', async () => {
    /*
     * Nach dem dauerhaften Speichern navigiert die Anwendung von sich aus auf
     * `/ablage/<id>` — die Liste wird übersprungen. Das ist der echte
     * Produktpfad; er wird hier nicht umgangen.
     */
    await expect(page.getByTestId('ablage-detail-page')).toBeVisible();

    /* Erst der Fehlerfall, dann die Zustände: Ein Fehler wäre ein echter Befund. */
    await expect(page.getByTestId('eingang-detail-analysis-error')).toHaveCount(0);
    await expect(page.getByTestId('eingang-detail-analysis-loading')).toHaveCount(0);
    await expect(page.getByTestId('eingang-detail-analysis-pending')).toHaveCount(0);

    /*
     * Belege für eine wirklich abgeschlossene Analyse — und zwar die, die auf
     * **dieser** Seite existieren. `document-understanding-card` gehört zur
     * Dokumentdetailseite `/dokumente/:id`, nicht zur Ablage; sie hier zu
     * erwarten war ein Fehler meiner Vorabanalyse.
     */
    await expect(page.getByTestId('eingang-assist-flow')).toBeVisible();

    /*
     * Bewusst `toBeAttached` statt `toBeVisible`: Die Hinweiskarte liegt hinter
     * einer eingeklappten Aufklappfläche. Sie aufzuklappen wäre eine
     * Bedienhandlung ohne Erkenntniswert — geprüft wird, dass die Analyse sie
     * erzeugt hat, nicht wie die Seite sie gerade anzeigt.
     */
    await expect(page.getByTestId('document-guidance-panel')).toBeAttached();
  });

  await test.step('Kundenentscheidung über den echten Bedienpfad treffen', async () => {
    /*
     * ⚠️ Hier liegt die Grenze dieses Tests, und sie ist eine Eigenschaft des
     * Produkts, keine Bequemlichkeit:
     *
     * Die Kundenentscheidung ist im OfficePilot kein eigener Schritt. Sie ist
     * eine Auswahl **innerhalb** der Auftragsannahme — der Kunde entsteht erst
     * gemeinsam mit dem Vorgang, wenn die Karte bestätigt wird. Getroffen wird
     * die Entscheidung deshalb hier; bestätigt wird sie nicht, denn das wäre
     * die Vorgangsanlage, die dieser Block ausdrücklich ausschliesst.
     */
    await expect(page.getByTestId('contract-customer-decision')).toBeVisible();
    await expect(page.getByTestId('customer-decision-choice')).toBeVisible();

    const newCustomerOption = page.getByTestId('customer-decision-new').locator('input');
    await newCustomerOption.check();
    await expect(newCustomerOption).toBeChecked();
  });

  await test.step('Strukturbefund des Detailzustands', async () => {
    /*
     * Nur Vorhandensein, keine Inhalte. Der Befund entscheidet, wie weit
     * dieser Fachflow überhaupt reichen kann: Die Kundenentscheidung liegt im
     * Produkt innerhalb der Auftragsannahme.
     */
    const present = async (testId: string) =>
      (await page.getByTestId(testId).count()) > 0 ? 'ja' : 'nein';

    for (const id of [
      'contract-order-proposal',
      'contract-customer-decision',
      'customer-decision-choice',
      'document-review-more-options',
      'document-understanding-card',
      'document-guidance-panel',
      'document-assistant-panel',
      'document-lifecycle-card',
      'eingang-assist-flow',
      'document-experience-guidance',
      'document-review-ocr-content',
      'action-filing-confirm',
      'inbox-import-to-archive-primary-button',
    ]) {
      console.log(`  ${id}: ${await present(id)}`);
    }
    console.log(`  blockierte Fremd-Hosts: ${guard.blockedExternal.length}`);
  });

  await test.step('Zurück zur Ablage — genau ein Eintrag', async () => {
    /*
     * Über den Zurück-Knopf der Seite, nicht über `goto`: Das ist eine
     * Navigation innerhalb derselben geladenen Anwendung und löst keinen
     * zweiten Bootstrap aus.
     */
    await page.locator('button.back-link').first().click();
    await expect(page.getByTestId('eingang-list')).toBeVisible();
    await expect(page.getByTestId('ablage-empty-state')).toHaveCount(0);

    /*
     * Gezählt, nicht gelesen: Der Eintrag wird über seine Struktur erfasst,
     * nie über Titel, Absender oder Datum. Dass vorher nichts da war,
     * garantiert der frische BrowserContext mit leerem localStorage und
     * leerem IndexedDB.
     */
    await expect(page.locator('[data-testid^="inbox-open-document-"]')).toHaveCount(1);
  });

  /*
   * `forbiddenWrites` und `unexpected` prüft die Fixture nach jedem Test von
   * selbst — hier steht bewusst keine Wiederholung von Hand.
   */
});
