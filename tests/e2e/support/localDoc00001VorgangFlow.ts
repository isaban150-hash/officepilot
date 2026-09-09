import { expect, type Page } from '@playwright/test';
import { chooseNewCustomer } from './localDoc00001Flow';

/**
 * OFFICEPILOT-LOCAL-E2E-DOC-00001-INVOICE-01B — der gemeinsame Weg zum Vorgang.
 *
 * Zwei Specs brauchen inzwischen denselben Abschnitt: vom analysierten
 * Ablage-Detail über die Kundenentscheidung und die Auftragsannahme bis zur
 * Vorgangsdetailseite. Ab dem zweiten Vorkommen ist eine gemeinsame Fassung
 * besser als zwei, die auseinanderlaufen.
 *
 * ⚠️ Der Helfer bündelt ausschliesslich Klicks und Wartebedingungen. Er liest
 * und schreibt keinen Store, ruft keinen Service auf, erzeugt weder Kunde noch
 * Vorgang auf einem anderen Weg als über die Oberfläche und gibt keine
 * Kennungen zurück. Die fachlichen Endzustandsprüfungen bleiben im jeweiligen
 * Spec — dort ist die Absicht des Tests lesbar, hier wäre sie versteckt.
 */

/**
 * Führt vom analysierten Ablage-Detail bis zur Vorgangsdetailseite.
 *
 * Setzt voraus, dass `uploadDoc00001ToAnalyzedDetail` bereits gelaufen ist —
 * dort steckt der einzige vollständige Seitenaufbau. Hier wird nur noch
 * innerhalb der geladenen Anwendung navigiert; ein `reload` oder ein zweites
 * `goto` löste einen weiteren Workspace-Bootstrap aus, den der Cloud-Guard zu
 * Recht blockiert.
 */
export async function acceptContractOrderThroughUi(page: Page): Promise<void> {
  await expect(page.getByTestId('contract-order-proposal')).toBeVisible();
  await expect(page.getByTestId('contract-customer-decision')).toBeVisible();

  /*
   * Im frischen Kontext gibt es keinen Kundenbestand: „vorhanden" ist
   * deaktiviert, „keiner" weist das Produkt beim Anlegen ab. „Neu" ist damit
   * nicht bequem gewählt, sondern die einzig mögliche Entscheidung. Das
   * vorbelegte Namensfeld bleibt unangetastet — sein Wert stammt aus der
   * echten Dokumenterkennung.
   */
  await chooseNewCustomer(page);

  const primary = page.getByTestId('contract-chef-primary-action');
  await expect(primary).toBeVisible();

  /*
   * Die Freigabe ist zugleich der Relevanznachweis: Der Knopf ist nur
   * bedienbar, wenn `workflow.companyRelevant` wahr ist — entstanden im echten
   * `checkCompanyRelevance` aus Dokumenttext und Firmenprofil.
   */
  await expect(primary).toBeEnabled();

  /* Genau einmal. Doppelklickverhalten ist nicht Gegenstand dieser Tests. */
  await primary.click();

  /* React-Router-Navigation, kein Neuladen — deshalb kein zweiter Bootstrap. */
  await expect(page.getByTestId('vorgang-detail-page')).toBeVisible();
}
