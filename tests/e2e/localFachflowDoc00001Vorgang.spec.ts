import { expect, test } from './support/localTestWorldFachflowFixture';
import { chooseNewCustomer, uploadDoc00001ToAnalyzedDetail } from './support/localDoc00001Flow';

/**
 * OFFICEPILOT-LOCAL-E2E-DOC-00001-VORGANG-01B2 — vom Dokument zum Vorgang.
 *
 * Der Test führt den echten Bedienweg zu Ende: Upload, Analyse,
 * Kundenentscheidung, Bestätigung der Auftragskarte. Kunde und Vorgang
 * entstehen dabei **ausschliesslich** durch echte Klicks — kein Service wird
 * direkt aufgerufen, kein Zustand eingespielt, nichts gefälscht.
 *
 * Der erste Anlauf scheiterte nicht am Produkt, sondern an einer falschen
 * Annahme im Testaufbau: Der Workspace lief unter einer erfundenen Firma, und
 * OfficePilot hielt das Dokument deshalb zu Recht für nicht betriebsrelevant.
 * Seit dem Company-Alignment trägt der Workspace die Betreiberfirma der
 * Testwelt, und derselbe Produktpfad gibt die Auftragsannahme frei.
 *
 * ⚠️ Zwei Regeln, die diesen Test tragen:
 *
 * **Ein einziger Seitenaufbau**, und der steckt im gemeinsamen Helfer. Jedes
 * weitere `goto` und jedes `reload` löste einen zweiten Workspace-Bootstrap
 * aus; nach einer lokalen, sync-fähigen Änderung liefe der Provision- und
 * Sync-Pfad erneut an, und der Cloud-Guard blockierte ihn zu Recht. Der Test
 * umgeht das nicht — er respektiert es.
 *
 * **Mutation nur über die Oberfläche, Lesen nur zur Prüfung.** Nach dem Klick
 * darf der lokale Zustand ausgewertet werden; erzeugt oder verändert wird dort
 * nichts. Diese Linie ist der Grund, warum der Test überhaupt etwas beweist —
 * wird sie einmal überschritten, prüft er nur noch sich selbst.
 */

test.setTimeout(120_000);

/** Was die Prüfung aus dem lokalen Zustand zurückgibt — nur Zahlen und Ja/Nein. */
interface StructuralOutcome {
  customerCount: number;
  vorgangCount: number;
  customerRelationValid: boolean;
  documentLinkPresent: boolean;
  createdFromInboxPresent: boolean;
  statusExpected: boolean;
  orderPositionsIsArray: boolean;
}

test('Fachflow: DOC-00001 wird über den echten Bedienweg zum Vorgang', async ({ page, guard }) => {
  await test.step('Upload bis zum analysierten Ablage-Detail', async () => {
    await uploadDoc00001ToAnalyzedDetail(page);
  });

  await test.step('Der Vertragsvorschlag steht bereit', async () => {
    await expect(page.getByTestId('contract-order-proposal')).toBeVisible();
    await expect(page.getByTestId('contract-customer-decision')).toBeVisible();
  });

  await test.step('Kundenentscheidung „neu" treffen', async () => {
    /*
     * Im frischen Kontext gibt es keinen Kundenbestand: „vorhanden" ist
     * deaktiviert, „keiner" weist das Produkt beim Anlegen ab. „Neu" ist damit
     * nicht bequem gewählt, sondern die einzig mögliche Entscheidung. Das
     * vorbelegte Namensfeld bleibt unangetastet — sein Wert stammt aus der
     * echten Dokumenterkennung.
     */
    await chooseNewCustomer(page);
  });

  await test.step('Auftragskarte bestätigen — genau einmal', async () => {
    const primary = page.getByTestId('contract-chef-primary-action');
    await expect(primary).toBeVisible();

    /*
     * Die Freigabe ist zugleich der Relevanznachweis: Der Knopf ist nur
     * bedienbar, wenn `workflow.companyRelevant` wahr ist — entstanden im
     * echten `checkCompanyRelevance` aus Dokumenttext und Firmenprofil.
     */
    await expect(primary).toBeEnabled();

    /*
     * Ein Klick. Der Produktcode sperrt zwar synchron gegen ein zweites
     * Ereignis derselben Runde, aber Doppelklickverhalten ist nicht Gegenstand
     * dieses Tests — hier soll genau ein Auftrag entstehen.
     */
    await primary.click();
  });

  await test.step('Die Anwendung führt auf die Vorgangsdetailseite', async () => {
    /* React-Router-Navigation, kein Neuladen — deshalb kein zweiter Bootstrap. */
    await expect(page.getByTestId('vorgang-detail-page')).toBeVisible();

    /*
     * Die Adresse trägt die Vorgangskennung; nur ein Wahrheitswert verlässt
     * den Browser. `toHaveURL` schiede aus — sein Fehlertext zeigte die echte
     * Kennung.
     */
    const onVorgangDetail = await page.evaluate(() =>
      /^\/vorgaenge\/[^/]+$/.test(window.location.pathname),
    );
    expect(onVorgangDetail).toBe(true);
  });

  await test.step('Endzustand in der Oberfläche', async () => {
    await expect(page.getByTestId('vorgang-overview-status')).toBeVisible();

    /*
     * Der Zuweisungsknopf erscheint nur bei einem Vorgang **ohne** Kunden.
     * Sein Fehlen ist damit der strukturelle Beleg, dass die Entscheidung
     * angekommen ist — ohne einen einzigen Kundenwert zu lesen.
     */
    await expect(page.getByTestId('vorgang-assign-customer')).toHaveCount(0);
  });

  await test.step('Struktureller Endzustand — gelesen, nicht verändert', async () => {
    /*
     * Warum überhaupt in den Zustand geschaut wird: Die Oberfläche zeigt weder,
     * dass **genau ein** Kunde entstanden ist, noch ob die Beziehung stimmt.
     * Ausserdem liegen `archiveForAccept` und das Nachtragen der Vertragsfelder
     * ausserhalb des rollback-fähigen Kerns — ein Erfolgstoast allein wäre
     * deshalb kein Beleg für einen konsistenten Endzustand.
     */
    const outcome = await page.evaluate((prefix): StructuralOutcome => {
      const empty: StructuralOutcome = {
        customerCount: -1,
        vorgangCount: -1,
        customerRelationValid: false,
        documentLinkPresent: false,
        createdFromInboxPresent: false,
        statusExpected: false,
        orderPositionsIsArray: false,
      };

      let key: string | null = null;
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const name = window.localStorage.key(index);
        if (name && name.startsWith(`${prefix}:workspace:`)) key = name;
      }
      if (!key) return empty;

      const raw = window.localStorage.getItem(key);
      if (!raw) return empty;

      const state = JSON.parse(raw) as {
        customers?: Array<{ id?: string }>;
        vorgaenge?: Array<{
          customerId?: string;
          createdFromInboxId?: string;
          status?: string;
          documents?: unknown[];
          orderPositions?: unknown;
        }>;
      };

      const customers = state.customers ?? [];
      const vorgaenge = state.vorgaenge ?? [];
      const vorgang = vorgaenge[0];

      /* Kennungen werden nur hier drinnen verglichen — sie verlassen die Seite nie. */
      return {
        customerCount: customers.length,
        vorgangCount: vorgaenge.length,
        customerRelationValid:
          customers.length === 1 &&
          vorgaenge.length === 1 &&
          typeof vorgang?.customerId === 'string' &&
          vorgang.customerId.length > 0 &&
          vorgang.customerId === customers[0]?.id,
        documentLinkPresent: Array.isArray(vorgang?.documents) && vorgang.documents.length > 0,
        createdFromInboxPresent:
          typeof vorgang?.createdFromInboxId === 'string' &&
          vorgang.createdFromInboxId.length > 0,
        statusExpected: vorgang?.status === 'eingegangen',
        orderPositionsIsArray: Array.isArray(vorgang?.orderPositions),
      };
    }, 'officepilot-state');

    /* Nur Zahlen und Wahrheitswerte — keine Kennung, kein Wert. */
    console.log(`  customerCount: ${outcome.customerCount}`);
    console.log(`  vorgangCount: ${outcome.vorgangCount}`);
    console.log(`  customerRelationValid: ${outcome.customerRelationValid}`);
    console.log(`  documentLinkPresent: ${outcome.documentLinkPresent}`);
    console.log(`  createdFromInboxPresent: ${outcome.createdFromInboxPresent}`);
    console.log(`  statusExpected: ${outcome.statusExpected}`);
    console.log(`  orderPositionsIsArray: ${outcome.orderPositionsIsArray}`);
    console.log(`  blockierte Fremd-Hosts: ${guard.blockedExternal.length}`);

    /* Genau einer von beiden — damit ist auch ein Duplikat ausgeschlossen. */
    expect(outcome.customerCount).toBe(1);
    expect(outcome.vorgangCount).toBe(1);

    expect(outcome.customerRelationValid).toBe(true);
    expect(outcome.documentLinkPresent).toBe(true);
    expect(outcome.createdFromInboxPresent).toBe(true);
    expect(outcome.statusExpected).toBe(true);

    /*
     * Nur die Struktur, kein Sollwert: Ein Vertrag ohne Leistungsverzeichnis
     * darf produktseitig 0 Positionen haben. Ob die richtigen erkannt wurden,
     * prüft der Gold-Test — nicht der Browser.
     */
    expect(outcome.orderPositionsIsArray).toBe(true);
  });

  /*
   * Ab hier nichts mehr: kein Neuladen, kein zweiter Seitenaufbau, kein
   * `/synchronisation`, keine Rechnung. Der Beweis „lokal entstanden, aber
   * nicht in die Cloud geschoben" führt die Fixture selbst — `forbiddenWrites`
   * und `unexpected` müssen leer sein, und sie prüft das nach jedem Test von
   * sich aus.
   */
});
