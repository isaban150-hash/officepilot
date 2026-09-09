import { expect, type Page } from '@playwright/test';

/**
 * OFFICEPILOT-LOCAL-E2E-DOC-00001-VORGANG-01B — der gemeinsame Bedienweg.
 *
 * Zwei Specs gehen inzwischen denselben Anfang: Datei hochladen, Vorschau
 * abwarten, dauerhaft speichern, Analyse abwarten. Ab dem zweiten Vorkommen ist
 * eine gemeinsame Fassung besser als zwei, die auseinanderlaufen können.
 *
 * ⚠️ Was dieser Helfer **nicht** darf, ist wichtiger als das, was er tut: Er
 * liest und schreibt keinen Store, ruft keinen Service auf, erzeugt weder Kunde
 * noch Vorgang, spielt keinen fertigen Dokumentzustand ein und fälscht kein
 * Ergebnis. Er bündelt ausschliesslich Klicks und Wartebedingungen — genau das,
 * was ein Mensch auch täte.
 *
 * Seine Grenze liegt beim analysierten Ablage-Detail. Alles danach ist die
 * eigentliche Absicht des jeweiligen Tests und gehört sichtbar in den Spec,
 * nicht in einen Helfer.
 */

/**
 * `source.pdf` und nicht `source.jpg`: Das PDF trägt eingebetteten Text und
 * läuft über die native Extraktion. Das Bild erzwänge OCR, und Tesseract lädt
 * Worker, Kern und Sprachdatei aus dem Netz — blockiert, und das bleibt so.
 */
const DOC_00001_PDF = 'test-world/documents/DOC-00001/source.pdf';

/**
 * Führt DOC-00001 über den echten Bedienweg bis zum analysierten Ablage-Detail.
 *
 * Enthält den **einzigen** vollständigen Seitenaufbau des Tests: Jedes weitere
 * `goto` und jedes `reload` wäre ein zweiter Workspace-Bootstrap, und den
 * blockiert der Cloud-Guard zu Recht — `ensure_personal_workspace` ist
 * serverseitig schreibfähig und gehört allein zum Hochfahren. Ab hier wird
 * ausschliesslich über die Oberfläche navigiert.
 */
export async function uploadDoc00001ToAnalyzedDetail(page: Page): Promise<void> {
  await page.goto('/dokumente/upload', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('document-upload-page')).toBeVisible();

  /* Das echte `<input type="file">` der Anwendung — keine Sonderlösung. */
  await page.getByTestId('document-upload-input').setInputFiles(DOC_00001_PDF);

  await expect(page.getByTestId('ocr-preview-panel')).toBeVisible();

  /* Ein Verarbeitungsfehler wäre das Gegenteil des Prüfziels. */
  await expect(page.getByTestId('ocr-confirm-error')).toHaveCount(0);

  await expect(page.getByTestId('storage-recommendation')).toBeVisible();
  await expect(page.getByTestId('storage-recommendation-level')).toBeVisible();
  await expect(page.getByTestId('ocr-storage-decision-actions')).toBeVisible();
  await expect(page.getByTestId('storage-decision-save-permanently')).toBeVisible();

  await page.getByTestId('storage-decision-save-permanently').click();

  /*
   * Nach dem dauerhaften Speichern führt die Anwendung von sich aus auf
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
   * Dokumentdetailseite `/dokumente/:id`, nicht zur Ablage.
   */
  await expect(page.getByTestId('eingang-assist-flow')).toBeVisible();

  /*
   * Bewusst `toBeAttached` statt `toBeVisible`: Die Hinweiskarte liegt hinter
   * einer eingeklappten Aufklappfläche. Sie aufzuklappen wäre eine
   * Bedienhandlung ohne Erkenntniswert — geprüft wird, dass die Analyse sie
   * erzeugt hat, nicht wie die Seite sie gerade anzeigt.
   */
  await expect(page.getByTestId('document-guidance-panel')).toBeAttached();
}

/**
 * Wählt „neuer Kunde" — die einzige im frischen Kontext mögliche Entscheidung.
 *
 * ⚠️ Das vorbelegte Namensfeld (`contract-customer-name-input`) wird
 * **nicht** angerührt. Sein Wert stammt aus der echten Dokumenterkennung; ihn
 * zu überschreiben hiesse, genau den Erkennungspfad zu übergehen, den der Test
 * belegen soll.
 */
export async function chooseNewCustomer(page: Page): Promise<void> {
  await expect(page.getByTestId('contract-customer-decision')).toBeVisible();
  await expect(page.getByTestId('customer-decision-choice')).toBeVisible();

  const newCustomerOption = page.getByTestId('customer-decision-new').locator('input');
  await newCustomerOption.check();
  await expect(newCustomerOption).toBeChecked();
}
