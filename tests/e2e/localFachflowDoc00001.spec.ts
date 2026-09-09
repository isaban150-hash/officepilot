import { expect, test } from './support/localTestWorldFachflowFixture';
import { chooseNewCustomer, uploadDoc00001ToAnalyzedDetail } from './support/localDoc00001Flow';

/**
 * OFFICEPILOT-LOCAL-E2E-DOC-00001-INTAKE-01B — der erste echte Fachflow.
 *
 * Gefahren wird der Weg, den auch ein Mensch geht: Upload-Seite öffnen, Datei
 * wählen, Vorschau abwarten, dauerhaft speichern, in der Ablage öffnen, Analyse
 * abwarten. Nichts wird abgekürzt — kein Service direkt aufgerufen, kein
 * fertiger Dokumentzustand eingespielt, keine Klassifikation und keine
 * Extraktion gefälscht.
 *
 * VORGANG-01B — die gemeinsamen Bedienschritte liegen jetzt in
 * `localDoc00001Flow`, damit Intake- und Vorgangstest denselben Weg gehen und
 * nicht zwei Fassungen desselben Ablaufs entstehen. Die Absicht **dieses**
 * Tests bleibt unverändert: Er endet vor der Vorgangsanlage.
 *
 * Datenschutz: Der Test liest keinen Dokumenttext aus, wählt nichts über
 * Kundennamen oder Titel und protokolliert keine Kennungen. Zugesichert wird
 * ausschliesslich Struktur.
 */

/* Echte Verarbeitung im Browser: PDF-Parsen und Klassifikation brauchen Zeit. */
test.setTimeout(120_000);

test('Fachflow: DOC-00001 über den echten Upload- und Analysepfad', async ({ page, guard }) => {
  await test.step('Upload bis zum analysierten Ablage-Detail', async () => {
    await uploadDoc00001ToAnalyzedDetail(page);
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
     * die Vorgangsanlage. Sie ist Gegenstand des eigenen Vorgang-Tests.
     */
    await chooseNewCustomer(page);
  });

  await test.step('Die Auftragsannahme ist freigegeben — der Relevanzbeweis', async () => {
    /*
     * ⚠️ Der eigentliche Nachweis dieses Blocks, und er ist indirekt aus gutem
     * Grund:
     *
     * `contract-chef-primary-action` ist nur freigegeben, wenn
     * `primaryDisabled` falsch ist — und das setzt `workflow.companyRelevant`
     * voraus. Dieser Wert entsteht in `checkCompanyRelevance` aus dem echten
     * Dokumenttext und dem `CompanyProfile` des Workspace. Nichts daran wird
     * gesetzt, gemockt oder umgangen.
     *
     * Mit einer erfundenen Betreiberfirma war dieser Knopf nachweislich
     * gesperrt: Das Dokument gehörte schlicht zu einer anderen Firma. Seit der
     * Workspace die Betreiberfirma der Testwelt trägt, greift derselbe
     * Produktpfad und gibt ihn frei.
     *
     * Geklickt wird hier **nicht** — das wäre die Vorgangsanlage.
     */
    const primary = page.getByTestId('contract-chef-primary-action');
    await expect(primary).toBeVisible();
    await expect(primary).toBeEnabled();
  });

  await test.step('Strukturbefund des Detailzustands', async () => {
    /* Nur Vorhandensein, keine Inhalte. */
    const present = async (testId: string) =>
      (await page.getByTestId(testId).count()) > 0 ? 'ja' : 'nein';

    for (const id of [
      'contract-order-proposal',
      'contract-customer-decision',
      'customer-decision-choice',
      'document-review-more-options',
      'eingang-assist-flow',
      'document-experience-guidance',
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
