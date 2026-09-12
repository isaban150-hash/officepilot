/**
 * MANUAL-INVOICE-UI-01B1B — die Rechnung ohne Auftrag in der echten App,
 * gegen die **lokale** Supabase-Instanz. Kein Mock des Finalize-RPC: Die
 * Nummer vergibt der lokale Server, der Replay läuft real.
 *
 *   Desktop:  Übersicht → Neue Rechnung → Kunde → Position → Details →
 *             Prüfen → Freigeben → (01B2) globale Detailseite → Druck/PDF,
 *             Archivlink, Teilzahlung, Reload, zurück zur Übersicht, wieder
 *             öffnen, Browser-Zurück.
 *   Reload:   Kunde + Position, Neuladen, Entwurf ist wieder da.
 *   Doppelt:  ein Doppelklick erzeugt genau eine Rechnung (und eine Detailseite).
 *   Router:   `neu`/`offen` sind keine Kennung; Unbekanntes ist „nicht gefunden".
 *   Mobile:   Felder, Tastatur-Modus, Primary Action, Scroll, lange Position,
 *             Detailseite ohne Überlauf, Aktionen erreichbar.
 */
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany, type WorkspaceCompanyIdentity } from './support/localTestWorldCompany';
import { uploadDoc00001ToAnalyzedDetail } from './support/localDoc00001Flow';
import { acceptContractOrderThroughUi } from './support/localDoc00001VorgangFlow';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let user: LocalDbUser;

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error('E2E_LOCALDB_SUPABASE_URL / E2E_LOCALDB_SERVICE_ROLE_KEY fehlen (nur lokal).');
  }
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'manual' });
});

test.afterAll(async () => {
  if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
});

async function login(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-email').fill(user.email);
  await page.getByTestId('login-password').fill(user.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-page')).toBeHidden({ timeout: 30_000 });
}

/** Der Ersteinrichtungsassistent — einmal je Konto, wie ein echter Betrieb. */
async function completeSetupIfShown(page: Page, identity?: WorkspaceCompanyIdentity): Promise<void> {
  /*
   * Ein frisches Konto sieht zuerst „kein abgeschlossener Betrieb gefunden"
   * (WorkspaceRestoreFailure) und muss die Einrichtung ausdrücklich wählen —
   * genau wie ein echter Nutzer. Danach der Assistent.
   */
  // Erst abwarten, wohin der Start führt: fertiger Betrieb, Zwischenschritt oder Assistent.
  const landed = await Promise.race([
    page.getByTestId('app-shell').waitFor({ timeout: 30_000 }).then(() => 'shell' as const),
    page.getByTestId('workspace-setup-continue').waitFor({ timeout: 30_000 }).then(() => 'continue' as const),
    page.getByTestId('setup-companyName').waitFor({ timeout: 30_000 }).then(() => 'wizard' as const),
  ]);
  if (landed === 'shell') return;
  if (landed === 'continue') await page.getByTestId('workspace-setup-continue').click();
  const company = page.getByTestId('setup-companyName');
  await expect(company).toBeVisible({ timeout: 20_000 });
  await company.fill(identity?.companyName ?? 'E2E Manual GmbH');
  await page.getByTestId('setup-contactPerson').fill('E2E Manual');
  await page.getByTestId('setup-street').fill(identity?.street ?? 'Werkstraße 2');
  await page.getByTestId('setup-zip').fill(identity?.zip ?? '54321');
  await page.getByTestId('setup-city').fill(identity?.city ?? 'Betriebsstadt');
  await page.getByTestId('setup-email').fill(identity?.email ?? 'rechnung@example.invalid');
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-taxNumber').fill(identity?.taxNumber ?? '11/222/33333');
  if (identity?.vatId) await page.getByTestId('setup-vatId').fill(identity.vatId);
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-iban').fill(identity?.iban ?? 'DE89370400440532013000');
  await page.getByTestId('setup-next').click();
  // Rechnungsgrundlagen: Vorgaben übernehmen.
  await page.getByTestId('setup-next').click();
  // Kommunikation: Vorgabe übernehmen, abschliessen.
  await page.getByTestId('setup-next').click();
  await expect(page.getByTestId('setup-companyName')).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 20_000 });
}

/**
 * Wie ein Nutzer: **in der App** zur Rechnungsübersicht — kein voller
 * Seitenaufruf unmittelbar nach der Einrichtung. Die Firmendaten werden nach
 * dem Assistenten asynchron gesichert; ein Reload in genau diesem Fenster
 * fände noch keinen abgeschlossenen Betrieb (Betriebsprüfung beim Start).
 */
async function openNewInvoice(page: Page): Promise<void> {
  await page.getByRole('link', { name: /Mehr/ }).first().click();
  await expect(page.getByTestId('mehr-page')).toBeVisible();
  await page.getByRole('link', { name: /^Rechnungen/ }).first().click();
  await expect(page.getByTestId('overview-new-invoice')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('overview-new-invoice').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('1/4');
}

async function chooseNewCustomer(page: Page, name: string): Promise<void> {
  await page.getByTestId('customer-decision-new').locator('input').check();
  await page.getByTestId('manual-invoice-customer-name').fill(name);
  await page.getByTestId('customer-decision-street').fill('Hauptstraße 12');
  await page.getByTestId('customer-decision-zip').fill('45356');
  await page.getByTestId('customer-decision-city').fill('Essen');
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('2/4');
}

async function addPosition(page: Page, description: string, quantity: string, price: string): Promise<void> {
  await page.getByTestId('manual-position-description').fill(description);
  await page.getByTestId('manual-position-quantity').fill(quantity);
  await page.getByTestId('manual-position-unit-price').fill(price);
  await page.getByTestId('manual-position-commit').click();
  await expect(page.getByTestId('manual-positions-list')).toContainText(description.slice(0, 20));
}

async function fillDetails(page: Page): Promise<void> {
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('3/4');
  await page.getByTestId('invoice-edit-service-from').fill('2026-09-01');
  await page.getByTestId('invoice-edit-service-to').fill('2026-09-05');
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('4/4');
}

test.describe('Rechnung ohne Auftrag — echte App, lokale Datenbank', () => {
  test('Desktop/Mobile: kompletter Weg bis zur freigegebenen Rechnung in der Übersicht', async ({ page }, testInfo) => {
    await login(page);
    await completeSetupIfShown(page);
    await openNewInvoice(page);

    await chooseNewCustomer(page, `Müller Bau GmbH ${testInfo.project.name}`);
    await addPosition(
      page,
      'Anfahrt, Fehlersuche an der Heizungsanlage und Austausch des Ausdehnungsgefäßes inkl. Entlüftung aller Heizkörper',
      '1',
      '45',
    );
    await addPosition(page, 'Ausdehnungsgefäß 18 l', '1', '60');
    await addPosition(page, 'Monteurstunden', '2.5', '58');
    await expect(page.getByTestId('manual-positions-list').locator('li')).toHaveCount(3);
    // Zwischensumme: 45 + 60 + 145 = 250,00
    await expect(page.getByTestId('manual-invoice-positions-total')).toContainText('250,00');
    // Lange Position: bricht um, keine horizontale Scrollbar.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'horizontaler Überlauf').toBeLessThanOrEqual(1);

    // Zahlenfelder: dezimale Tastatur auf dem Gerät.
    await expect(page.getByTestId('manual-position-quantity')).toHaveAttribute('inputmode', /decimal|numeric/);
    await expect(page.getByTestId('manual-position-unit-price')).toHaveAttribute('inputmode', /decimal|numeric/);

    await fillDetails(page);

    // Prüfung: Summen sichtbar (250,00 netto / 47,50 MwSt. / 297,50 brutto), kein Projektblock.
    await expect(page.getByTestId('manual-invoice-review-totals')).toContainText('250,00');
    await expect(page.getByTestId('manual-invoice-review-totals')).toContainText('297,50');
    await expect(page.locator('.invoice-project')).toHaveCount(0);
    const approve = page.getByTestId('invoice-approve');
    await approve.scrollIntoViewIfNeeded();
    await expect(approve).toBeVisible();
    await expect(approve).toBeEnabled();

    const before = await countFinalizedOnServer();
    await approve.click();
    /*
     * MANUAL-INVOICE-UI-01B2 — nach bewiesener Freigabe automatisch auf die
     * globale Detailseite `/rechnungen/<invoiceId>`; nie `neu` oder `offen`.
     */
    await expect(page).toHaveURL(DETAIL_URL, { timeout: 45_000 });
    const detailUrl = page.url();

    // Exakt eine Rechnung auf dem lokalen Server, mit Archivdokument.
    expect((await countFinalizedOnServer()) - before, 'neue Rechnungen auf dem Server').toBe(1);
    expect(await countGeneratedDocumentsOnServer(), 'Archivdokument in der Cloud-Tabelle').toBeGreaterThanOrEqual(1);

    /* ---- Detailseite der freien Rechnung ---- */
    await expectFreeInvoiceDetail(page, 'Müller Bau GmbH');
    await expect(page.getByTestId('invoice-detail-experience')).toContainText('297,50');
    await expect(page.getByTestId('invoice-detail-experience')).toContainText('Offen');

    // Druck/PDF erreichbar und nicht abgeschnitten (auch mobil).
    await expectActionReachable(page, 'invoice-print');
    await expectActionReachable(page, 'invoice-download-pdf');
    const overflowDetail = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflowDetail, 'horizontaler Überlauf Detailseite').toBeLessThanOrEqual(1);

    // Archivlink hinter „Mehr anzeigen" — führt zum Archivdokument.
    await page.getByTestId('invoice-detail-show-more').getByRole('button').click();
    const archiveLink = page.getByTestId('invoice-detail-archive-link');
    await expect(archiveLink).toBeVisible();
    await expect(archiveLink).toHaveAttribute('href', /\/dokumente\/.+/);
    // Rechnungsinhalt: Positionen und Summen im Dokument.
    const doc = page.getByTestId('invoice-print-document');
    await expect(doc).toContainText('Ausdehnungsgefäß 18 l');
    await expect(doc).toContainText('250,00');
    await expect(doc).toContainText('297,50');
    await expect(page.locator('.invoice-project')).toHaveCount(0);

    /* ---- Teilzahlung erfassen ---- */
    await recordPartialPayment(page, '100');
    await expect(page.getByTestId('invoice-detail-experience')).toContainText('Teilbezahlt');
    await expect(page.getByTestId('invoice-detail-experience')).toContainText('197,50');

    /* ---- Reload: Rechnung wieder gefunden, Zahlung und Archivlink bleiben ---- */
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(detailUrl);
    await expectFreeInvoiceDetail(page, 'Müller Bau GmbH');
    await expect(page.getByTestId('invoice-detail-experience')).toContainText('Teilbezahlt');
    await expect(page.getByTestId('invoice-detail-experience')).toContainText('197,50');
    await page.getByTestId('invoice-detail-show-more').getByRole('button').click();
    await expect(page.getByTestId('invoice-detail-archive-link')).toBeVisible();
    await expect(page.locator('.invoice-payment-history')).toContainText('100,00');

    /* ---- zurück zur Übersicht, Rechnung dort, wieder öffnen ---- */
    await page.getByTestId('invoice-detail-back').click();
    await expect(page).toHaveURL(/\/rechnungen\/offen$/);
    const card = page.getByTestId('invoice-overview-card').first();
    await expect(card).toContainText(/2026-\d{4}/);
    await expect(card).toContainText('Müller Bau GmbH');
    await expect(card).toContainText('197,50');
    await expect(card.getByRole('link', { name: /Archiv/ })).toBeVisible();
    await expect(card.locator('a[href^="/vorgaenge/"]')).toHaveCount(0);
    await card.getByTestId('invoice-overview-card-open').click();
    await expect(page).toHaveURL(DETAIL_URL);
    await expectFreeInvoiceDetail(page, 'Müller Bau GmbH');

    // Browser-Zurück von der Detailseite → Übersicht.
    await page.goBack();
    await expect(page).toHaveURL(/\/rechnungen\/offen$/);
    await expect(page.getByTestId('invoice-overview-card').first()).toBeVisible();
  });

  test('Reload: Kunde und Position sind nach dem Neuladen wieder da', async ({ page }) => {
    await login(page);
    await completeSetupIfShown(page);
    await openNewInvoice(page);
    await chooseNewCustomer(page, 'Reload Kunde GmbH');
    await addPosition(page, 'Wartung Gastherme', '2', '80');

    /*
     * Browser-Zurück innerhalb des Flows (gleiches Dokument, popstate): Jeder
     * Schrittwechsel ist ein Verlaufseintrag; zurück heisst „vorheriger
     * Schritt", die Daten bleiben, weil sie im dauerhaften Entwurf liegen.
     */
    await expect(page).toHaveURL(/step=positions/);
    await page.goBack();
    await expect(page).toHaveURL(/step=customer/);
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('1/4');
    await expect(page.getByTestId('manual-invoice-customer-chosen')).toContainText('Reload Kunde GmbH');
    await page.goForward();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('2/4');
    await expect(page.getByTestId('manual-positions-list')).toContainText('Wartung Gastherme');

    // Der Speicherlauf ist entprellt — kurz warten, wie ein Nutzer es täte.
    await page.waitForTimeout(800);

    // Reload mitten im Entwurf: Kunde, Position und Schritt sind wieder da.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('manual-invoice-page')).toBeVisible();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('2/4');
    await expect(page.getByTestId('manual-positions-list')).toContainText('Wartung Gastherme');
    await page.getByTestId('manual-invoice-stepper-customer').click();
    await expect(page.getByTestId('manual-invoice-customer-chosen')).toContainText('Reload Kunde GmbH');
  });

  test('Doppelklick: genau eine Rechnung', async ({ page }) => {
    await login(page);
    await completeSetupIfShown(page);
    await openNewInvoice(page);
    await chooseNewCustomer(page, 'Doppel Kunde GmbH');
    await addPosition(page, 'Kleinreparatur', '1', '30');
    await fillDetails(page);

    const before = await countFinalizedOnServer();
    const approve = page.getByTestId('invoice-approve');
    await approve.scrollIntoViewIfNeeded();
    await approve.click();
    /*
     * Die Wiederholungsklicks treffen einen gesperrten oder bereits
     * verschwundenen Knopf. Kurzes Timeout statt Warten bis zum Test-Timeout —
     * geprüft wird unten die Anzahl der Rechnungen auf dem Server.
     */
    await approve.click({ force: true, timeout: 500 }).catch(() => undefined);
    await approve.click({ force: true, timeout: 500 }).catch(() => undefined);
    // 01B2 — auch der Doppelklick landet auf genau einer Detailseite.
    await expect(page).toHaveURL(DETAIL_URL, { timeout: 45_000 });
    await expectFreeInvoiceDetail(page, 'Doppel Kunde GmbH');

    const after = await countFinalizedOnServer();
    expect(after - before, 'Anzahl neuer Rechnungen auf dem lokalen Server').toBe(1);
  });

  test('NORMAL-INVOICE-CANCELLATION-01B: versendete freie Rechnung stornieren → Korrekturbeleg, Original bleibt, Reload', async ({ page }) => {
    await login(page);
    await completeSetupIfShown(page);
    await openNewInvoice(page);
    await chooseNewCustomer(page, 'Storno Kunde GmbH');
    await addPosition(page, 'Wartung Heizung', '1', '100');
    await fillDetails(page);
    await page.getByTestId('invoice-approve').click();
    await expect(page).toHaveURL(DETAIL_URL, { timeout: 45_000 });
    await expectFreeInvoiceDetail(page, 'Storno Kunde GmbH');
    const invoiceNumber = (await page.getByTestId('invoice-detail-experience').textContent())?.match(/2026-\d{4}/)?.[0] ?? '';
    expect(invoiceNumber).not.toBe('');

    /* ---- als versendet markieren (bestehender lokaler Versandpfad, lokale Cloud) ---- */
    await markAsSent(page);

    /* ---- Storno: Confirm-first, Grund, Bestätigung ---- */
    await page.getByTestId('invoice-cancel-action').click();
    await expect(page.getByTestId('invoice-cancel-dialog')).toBeVisible();
    await expect(page.getByTestId('invoice-cancel-kind-correction')).toBeVisible();
    await expect(page.getByTestId('invoice-cancel-submit')).toBeDisabled();
    await page.getByTestId('invoice-cancel-reason-input').fill('Leistung nicht erbracht');
    await page.getByTestId('invoice-cancel-submit').click();

    await expect(page.getByTestId('invoice-cancelled-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('invoice-cancelled-kind-correction')).toBeVisible();
    await expect(page.getByTestId('invoice-cancelled-reason')).toContainText('Leistung nicht erbracht');
    await expect(page.getByTestId('invoice-cancel-action')).toHaveCount(0);
    await expect(page.getByTestId('invoice-correction-archive-pending')).toHaveCount(0);
    // Offene Forderung = 0, Status storniert.
    await expect(page.getByTestId('invoice-detail-experience')).toContainText('Storniert');
    await expect(page.getByTestId('invoice-detail-experience')).not.toContainText('Noch offen');
    // Genau ein Korrekturbeleg auf dem lokalen Server.
    expect(await countCorrectionDocumentsOnServer(page)).toBe(1);

    /* ---- Korrekturbeleg öffnen, drucken/PDF, zurück ---- */
    await page.getByTestId('invoice-open-correction').click();
    await expect(page).toHaveURL(/doc=korrektur/);
    await expect(page.getByTestId('invoice-correction-page')).toBeVisible();
    await expect(page.getByTestId('invoice-correction-reference')).toContainText(invoiceNumber);
    await expect(page.getByTestId('invoice-correction-document')).toContainText('-119,00');
    await expectActionReachable(page, 'invoice-print');
    await expectActionReachable(page, 'invoice-download-pdf');
    await expect(page.getByTestId('invoice-correction-archive-link')).toHaveAttribute('href', /\/dokumente\/corr-/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'horizontaler Überlauf Korrekturansicht').toBeLessThanOrEqual(1);
    await page.getByTestId('invoice-correction-back').click();
    await expect(page.getByTestId('invoice-detail-page')).toBeVisible();
    // Original weiterhin: eigener Druck/PDF, Dokument unverändert mit Originalnummer.
    await expectActionReachable(page, 'invoice-print');
    await expect(page.getByTestId('invoice-print-document')).toContainText(invoiceNumber);
    await expect(page.getByTestId('invoice-print-document')).not.toContainText('Rechnungskorrektur');

    /* ---- Reload: Zustand bleibt ---- */
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('invoice-detail-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('invoice-cancelled-kind-correction')).toBeVisible();
    await expect(page.getByTestId('invoice-open-correction')).toBeVisible();
    await expect(page.getByTestId('invoice-correction-archive-pending')).toHaveCount(0);
    await page.getByTestId('invoice-open-correction').click();
    await expect(page.getByTestId('invoice-correction-page')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('invoice-detail-page')).toBeVisible();

    // Übersicht: storniert, nicht mehr offen.
    await page.getByTestId('invoice-detail-back').click();
    await expect(page).toHaveURL(/\/rechnungen\/offen$/);
    // Die Karte **dieser** Rechnung (im Gesamtlauf liegen weitere Rechnungen im Workspace).
    await expect(
      page.getByTestId('invoice-overview-card').filter({ hasText: invoiceNumber }).first(),
    ).toContainText('Storniert');
  });

  test('NORMAL-INVOICE-CANCELLATION-01B: Teilzahlung blockiert das Storno, nach Rücknahme ist es möglich (intern, vor Versand)', async ({ page }) => {
    await login(page);
    await completeSetupIfShown(page);
    await openNewInvoice(page);
    await chooseNewCustomer(page, 'Zahlung Kunde GmbH');
    await addPosition(page, 'Kleinreparatur', '1', '50');
    await fillDetails(page);
    await page.getByTestId('invoice-approve').click();
    await expect(page).toHaveURL(DETAIL_URL, { timeout: 45_000 });
    await expectFreeInvoiceDetail(page, 'Zahlung Kunde GmbH');

    await recordPartialPayment(page, '20');
    await expect(page.getByTestId('invoice-detail-experience')).toContainText('Teilbezahlt');

    // Blocker: aktive Zahlung.
    await page.getByTestId('invoice-cancel-action').click();
    await expect(page.getByTestId('invoice-cancel-payment-block')).toBeVisible();
    await expect(page.getByTestId('invoice-cancel-submit')).toBeDisabled();
    await page.getByTestId('invoice-cancel-abort').click();

    // Zahlung über den bestehenden Reversal-Weg zurücknehmen (lokale Cloud bestätigt).
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByTestId('invoice-detail-show-more').getByRole('button').click();
    await page.locator('.invoice-payment-history').getByRole('button', { name: 'Entfernen' }).first().click();
    await expect(page.getByTestId('invoice-detail-experience')).not.toContainText('Teilbezahlt', { timeout: 20_000 });

    // Jetzt stornierbar: vorbereitet → internes Storno ohne Korrekturbeleg.
    await page.getByTestId('invoice-cancel-action').click();
    await expect(page.getByTestId('invoice-cancel-kind-internal')).toBeVisible();
    await expect(page.getByTestId('invoice-cancel-payment-block')).toHaveCount(0);
    await page.getByTestId('invoice-cancel-reason-input').fill('Doppelt erfasst');
    await page.getByTestId('invoice-cancel-submit').click();
    await expect(page.getByTestId('invoice-cancelled-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('invoice-cancelled-kind-internal')).toBeVisible();
    await expect(page.getByTestId('invoice-open-correction')).toHaveCount(0);
    await expect(page.getByTestId('invoice-detail-experience')).toContainText('Storniert');
    // Zahlungshistorie bleibt sichtbar (reversiert), keine neue Zahlung mehr.
    await expect(page.getByRole('button', { name: 'Zahlung erfassen' })).toHaveCount(0);
  });

  test('NORMAL-INVOICE-CANCELLATION-01B: Vorgangsrechnung über die bestehende Route stornieren → Korrekturbeleg, Billingwirkung', async ({ page }) => {
    /*
     * Bewusst übersprungen, nicht gelöscht: Der einzige echte Bedienweg zu
     * einem Vorgang in der lokalen Testwelt (DOC-00001 → Auftragsannahme)
     * liefert einen Vorgang mit **bestätigtem Plan ohne Leistungspositionen**
     * (Planänderung nur über Nachtrag). Ohne Positionen gibt es keine
     * Vorgangsrechnung — und Positionen dürfen hier nicht eingespielt werden.
     * Die Vorgangsrechnungs-Stornierung ist stattdessen belegt durch
     * `invoice_cancellation_correction_01b.sql` (T6/T7, echte lokale DB) und
     * `invoiceCancellationCorrection01b.test.tsx` (S2/M5, echte Seite).
     */
    test.skip(true, 'Testwelt liefert keinen Vorgang mit abrechenbaren Positionen ohne Nachtragsweg');
    test.setTimeout(240_000);
    /*
     * Ein eigenes Konto mit der Betreiberfirma der Testwelt: Nur so hält
     * OfficePilot DOC-00001 für betriebsrelevant und lässt die Auftragsannahme
     * zu (siehe localTestWorldCompany). Der Vorgang entsteht ausschliesslich
     * über echte Klicks — kein Zustand wird eingespielt.
     */
    const operator = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'vorgang' });
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.getByTestId('login-email').fill(operator.email);
      await page.getByTestId('login-password').fill(operator.password);
      await page.getByTestId('login-submit').click();
      await expect(page.getByTestId('login-page')).toBeHidden({ timeout: 30_000 });
      await completeSetupIfShown(page, loadTestWorldOperatorCompany());
      // Firmendaten werden nach dem Assistenten asynchron gesichert — kurz warten vor dem Seitenaufruf.
      await page.waitForTimeout(1500);

      await uploadDoc00001ToAnalyzedDetail(page);
      await acceptContractOrderThroughUi(page);
      await expect(page.getByTestId('vorgang-detail-page')).toBeVisible();
      const vorgangPath = new URL(page.url()).pathname;

      /* ---- Rechnung über den bestehenden Vorgangsweg vorbereiten und freigeben ---- */
      await page.getByTestId('vorgang-prepare-invoice').click();
      await expect(page.getByTestId('rechnung-page')).toBeVisible();
      await page.getByTestId('invoice-type-rechnung').click();
      await page.getByTestId('invoice-apply-all-positions').click();
      const tax = page.getByTestId('invoice-tax-standard_19');
      if (await tax.isVisible().catch(() => false)) await tax.click();
      await page.getByTestId('invoice-service-period-from').fill('2026-09-01');
      await page.getByTestId('invoice-service-period-to').fill('2026-09-05');
      const confirmPeriod = page.getByTestId('invoice-confirm-service-period');
      if (await confirmPeriod.isVisible().catch(() => false)) await confirmPeriod.click();
      await expect(page.getByTestId('invoice-continue-preview')).toBeEnabled();
      await page.getByTestId('invoice-continue-preview').click();
      const approve = page.getByTestId('invoice-approve');
      await approve.scrollIntoViewIfNeeded();
      await expect(approve).toBeEnabled();
      await approve.click();
      await expect(page).toHaveURL(new RegExp(`${vorgangPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/rechnungen/inv-[0-9a-f-]{36}`), { timeout: 45_000 });
      await expect(page.getByTestId('invoice-detail-page')).toBeVisible();
      const invoiceDetailUrl = page.url();
      // Vorgangsweg: Projektblock vorhanden.
      await expect(page.locator('.invoice-project')).toHaveCount(1);
      const invoiceNumber = (await page.getByTestId('invoice-detail-experience').textContent())?.match(/2026-\d{4}/)?.[0] ?? '';
      expect(invoiceNumber).not.toBe('');

      /* ---- Billing vor dem Storno: Positionen sind abgerechnet ---- */
      await page.waitForTimeout(800);
      await page.goto(`${vorgangPath}/rechnung?type=rechnung`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('rechnung-page')).toBeVisible({ timeout: 30_000 });
      const billedBefore = await page.locator('.invoice-leistungsstand').first().textContent();
      expect(billedBefore).toContain('Bereits abgerechnet');
      expect(billedBefore).not.toMatch(/Bereits abgerechnet\s*0 /);

      /* ---- versenden, stornieren → Korrekturbeleg mit Vorgangsbezug ---- */
      await page.goto(invoiceDetailUrl, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('invoice-detail-page')).toBeVisible({ timeout: 30_000 });
      await markAsSent(page);
      await page.getByTestId('invoice-cancel-action').click();
      await expect(page.getByTestId('invoice-cancel-kind-correction')).toBeVisible();
      await page.getByTestId('invoice-cancel-reason-input').fill('Auftrag storniert');
      await page.getByTestId('invoice-cancel-submit').click();
      await expect(page.getByTestId('invoice-cancelled-kind-correction')).toBeVisible({ timeout: 30_000 });
      expect(await countCorrectionDocumentsOnServer(page)).toBe(1);
      await page.getByTestId('invoice-open-correction').click();
      await expect(page.getByTestId('invoice-correction-page')).toBeVisible();
      await expect(page.getByTestId('invoice-correction-reference')).toContainText(invoiceNumber);
      await expectActionReachable(page, 'invoice-download-pdf');
      await page.getByTestId('invoice-correction-back').click();
      await expect(page.getByTestId('invoice-detail-page')).toBeVisible();

      /* ---- Billingwirkung: die stornierte Rechnung zählt nicht mehr ---- */
      await page.goto(`${vorgangPath}/rechnung?type=rechnung`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('rechnung-page')).toBeVisible({ timeout: 30_000 });
      const billedAfter = await page.locator('.invoice-leistungsstand').first().textContent();
      expect(billedAfter).toMatch(/Bereits abgerechnet\s*0 /);
    } finally {
      await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: operator.id });
    }
  });

  test('MANUAL-INVOICE-FINAL-ACCEPTANCE-01: kompletter Produktweg — Kunde, Positionen, Skonto, §13b, Freigabe, Zahlung, Reversal, Versand, Korrektur, Reload, Archiv', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    await login(page);
    await completeSetupIfShown(page);

    /* ---- 1. Rechnung: neuer Kunde, mehrere Positionen (Menge/Einheit/Preis) ---- */
    await openNewInvoice(page);
    const customerName = `Abnahme Kunde GmbH ${testInfo.project.name}`;
    await chooseNewCustomer(page, customerName);
    await addPosition(page, 'Anfahrt', '1', '45');
    await addPosition(page, 'Monteurstunden', '2.5', '58');
    await expect(page.getByTestId('manual-positions-list').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('manual-invoice-positions-total')).toContainText('190,00');

    // Browser Zurück/Vor im Entwurf: Schritt wechselt, Daten bleiben.
    await page.goBack();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('1/4');
    await expect(page.getByTestId('manual-invoice-customer-chosen')).toContainText(customerName);
    await page.goForward();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('2/4');

    /* ---- Rechnungsdetails: Leistungszeitraum, Zahlungsziel, Skonto, §13b Confirm-first ---- */
    await page.getByTestId('manual-invoice-next').click();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('3/4');
    await page.getByTestId('invoice-edit-service-from').fill('2026-09-01');
    await page.getByTestId('invoice-edit-service-to').fill('2026-09-05');
    await page.getByTestId('invoice-edit-payment-due').fill('2026-10-05');
    await page.getByTestId('invoice-edit-skonto').fill('2 % Skonto bei Zahlung innerhalb von 7 Tagen');
    // §13b: erst bestätigen, dann weiter; danach zurück auf 19 % (Confirm-first sichtbar geprüft).
    await page.getByTestId('invoice-tax-reverse_charge_13b').click();
    await expect(page.getByTestId('invoice-13b-confirm')).toBeVisible();
    await page.getByTestId('invoice-13b-confirm-checkbox').check();
    await page.getByTestId('invoice-tax-standard_19').click();
    await expect(page.getByTestId('invoice-13b-confirm')).toHaveCount(0);
    // Reload in den Rechnungsdetails: Entwurf bleibt.
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('manual-invoice-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('3/4');
    await expect(page.getByTestId('invoice-edit-skonto')).toHaveValue('2 % Skonto bei Zahlung innerhalb von 7 Tagen');
    await page.getByTestId('manual-invoice-next').click();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('4/4');
    // Reload auf Review.
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('4/4', { timeout: 30_000 });
    await expect(page.getByTestId('manual-invoice-review-totals')).toContainText('190,00');
    await expect(page.getByTestId('manual-invoice-review-totals')).toContainText('226,10');

    /* ---- Freigabe → globale Detailroute; Duplicate-Submit erzeugt genau eine Rechnung ---- */
    const before = await countFinalizedOnServer();
    const approve = page.getByTestId('invoice-approve');
    await approve.scrollIntoViewIfNeeded();
    await approve.click();
    await approve.click({ force: true, timeout: 500 }).catch(() => undefined);
    await expect(page).toHaveURL(DETAIL_URL, { timeout: 45_000 });
    expect((await countFinalizedOnServer()) - before).toBe(1);
    await expectFreeInvoiceDetail(page, customerName);
    const detailUrl = page.url();
    const invoiceNumber = (await page.getByTestId('invoice-detail-experience').textContent())?.match(/2026-\d{4}/)?.[0] ?? '';
    expect(invoiceNumber).not.toBe('');
    await expectActionReachable(page, 'invoice-print');
    await expectActionReachable(page, 'invoice-download-pdf');
    await page.getByTestId('invoice-detail-show-more').getByRole('button').click();
    await expect(page.getByTestId('invoice-detail-archive-link')).toHaveAttribute('href', /\/dokumente\/.+/);
    const doc = page.getByTestId('invoice-print-document');
    await expect(doc).toContainText('Monteurstunden');
    await expect(doc).toContainText('2 % Skonto');
    await expect(doc).toContainText('5.10.2026');

    /* ---- Zahlung, Teilzahlung, Reversal ---- */
    await recordPartialPayment(page, '100');
    await expect(page.getByTestId('invoice-detail-experience')).toContainText('Teilbezahlt');
    await expect(page.getByTestId('invoice-detail-experience')).toContainText('126,10');
    page.once('dialog', (dialog) => void dialog.accept());
    await page.locator('.invoice-payment-history').getByRole('button', { name: 'Entfernen' }).first().click();
    await expect(page.getByTestId('invoice-detail-experience')).not.toContainText('Teilbezahlt', { timeout: 20_000 });
    await expect(page.getByTestId('invoice-detail-experience')).toContainText('226,10');

    /* ---- Versand, Storno mit Korrekturbeleg ---- */
    await markAsSent(page);
    await page.getByTestId('invoice-cancel-action').click();
    await expect(page.getByTestId('invoice-cancel-kind-correction')).toBeVisible();
    await page.getByTestId('invoice-cancel-reason-input').fill('Abnahme: Leistung storniert');
    await page.getByTestId('invoice-cancel-submit').click();
    await expect(page.getByTestId('invoice-cancelled-kind-correction')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('invoice-detail-experience')).toContainText('Storniert');
    await expect(page.getByTestId('invoice-detail-experience')).not.toContainText('Noch offen');
    expect(await countCorrectionDocumentsOnServer(page)).toBe(1);
    // Original unverändert: Nummer, Dokument, eigener Druck/PDF.
    await expect(page.getByTestId('invoice-print-document')).toContainText(invoiceNumber);
    await expect(page.getByTestId('invoice-print-document')).not.toContainText('Rechnungskorrektur');
    await expectActionReachable(page, 'invoice-download-pdf');
    // Korrekturbeleg: Bezug, Gegenwerte, eigener Druck/PDF, Archivlink.
    await page.getByTestId('invoice-open-correction').click();
    await expect(page.getByTestId('invoice-correction-page')).toBeVisible();
    await expect(page.getByTestId('invoice-correction-reference')).toContainText(invoiceNumber);
    await expect(page.getByTestId('invoice-correction-document')).toContainText('-226,10');
    await expect(page.getByTestId('invoice-correction-document')).toContainText('-190,00');
    await expectActionReachable(page, 'invoice-download-pdf');
    await expect(page.getByTestId('invoice-correction-archive-link')).toHaveAttribute('href', /\/dokumente\/corr-/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.getByTestId('invoice-correction-back').click();
    await expect(page.getByTestId('invoice-detail-page')).toBeVisible();

    /* ---- Reload: Storno, Korrekturlink und beide Archivdokumente bleiben ---- */
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(detailUrl);
    await expect(page.getByTestId('invoice-cancelled-kind-correction')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('invoice-correction-archive-pending')).toHaveCount(0);
    await page.getByTestId('invoice-detail-show-more').getByRole('button').click();
    await expect(page.getByTestId('invoice-detail-archive-link')).toBeVisible();
    // Bestehende Reversal-Semantik: lokal keine aktive Zahlung mehr, die Historie bleibt
    // als Grabstein auf dem Server erhalten (kein stilles Löschen).
    await expect(page.locator('.invoice-payment-history')).not.toContainText('100,00');
    expect(await countPaymentRowsOnServer(page)).toEqual({ total: 1, reversed: 1 });
    // Dokumentdetail des Korrekturbelegs verlinkt zurück in die Korrekturansicht.
    await page.getByTestId('invoice-open-correction').click();
    await page.getByTestId('invoice-correction-archive-link').click();
    await expect(page).toHaveURL(/\/dokumente\/corr-/);
    await expect(page.getByText('Rechnungskorrektur zu Rechnung')).toBeVisible();
    await expect(page.getByText('classifiedKind.rechnungskorrektur')).toHaveCount(0);
    const showMore = page.getByTestId('document-detail-show-more').getByRole('button');
    if (await showMore.isVisible().catch(() => false)) await showMore.click();
    await page.getByTestId('document-open-invoice').click();
    await expect(page).toHaveURL(/doc=korrektur/);
    await expect(page.getByTestId('invoice-correction-page')).toBeVisible();

    /* ---- 2. Rechnung: bestehenden Kunden wählen; Kundenhistorie ---- */
    await page.goto('/rechnungen/offen', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('overview-new-invoice')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('invoice-overview-card').filter({ hasText: invoiceNumber })).toContainText('Storniert');
    await page.getByTestId('overview-new-invoice').click();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('1/4');
    await page.getByTestId('customer-decision-existing').locator('input').check();
    await page.locator('[data-testid^="customer-option-"]').filter({ hasText: customerName }).first().click();
    await page.getByTestId('manual-invoice-next').click();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('2/4');
    await expect(page.getByTestId('manual-invoice-stepper-customer')).toBeVisible();
    // Reload im Kundenschritt: Auswahl bleibt.
    await page.getByTestId('manual-invoice-stepper-customer').click();
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('manual-invoice-customer-chosen')).toContainText(customerName, { timeout: 30_000 });
  });

  test('Router: /rechnungen/neu und /rechnungen/offen sind keine Rechnungskennung, Unbekanntes ist „nicht gefunden"', async ({ page }) => {
    await login(page);
    await completeSetupIfShown(page);
    await page.getByRole('link', { name: /Mehr/ }).first().click();
    await page.getByRole('link', { name: /^Rechnungen/ }).first().click();
    await expect(page).toHaveURL(/\/rechnungen\/offen$/);
    await expect(page.getByTestId('overview-new-invoice')).toBeVisible();
    await expect(page.getByTestId('invoice-detail-not-found')).toHaveCount(0);

    await page.getByTestId('overview-new-invoice').click();
    await expect(page).toHaveURL(/\/rechnungen\/neu/);
    await expect(page.getByTestId('manual-invoice-page')).toBeVisible();
    await expect(page.getByTestId('invoice-detail-not-found')).toHaveCount(0);

    // Direktaufruf einer unbekannten Kennung: sauberes „nicht gefunden", keine leere Seite.
    await page.waitForTimeout(800);
    await page.goto('/rechnungen/gibt-es-nicht', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('invoice-detail-not-found')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('invoice-detail-not-found')).toContainText('Rechnung nicht gefunden');
    await page.getByTestId('invoice-detail-not-found').getByRole('button').click();
    await expect(page).toHaveURL(/\/rechnungen\/offen$/);
  });
});

/** Die globale Detailroute — die Rechnungskennung (`inv-<uuid>`), nie `neu`/`offen`. */
const DETAIL_URL = /\/rechnungen\/inv-[0-9a-f-]{36}(\?.*)?$/;

async function expectFreeInvoiceDetail(page: Page, customer: string): Promise<void> {
  await expect(page.getByTestId('invoice-detail-page')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('invoice-detail-not-found')).toHaveCount(0);
  const experience = page.getByTestId('invoice-detail-experience');
  await expect(experience).toContainText(/2026-\d{4}/);
  await expect(experience).toContainText(customer);
  // Ohne Vorgang: keine Kommunikationsaktion mit erfundener Kennung, kein Vorgangslink.
  // (Storno ist seit NORMAL-INVOICE-CANCELLATION-01B für die normale freie Rechnung erlaubt.)
  await expect(page.getByTestId('invoice-communication-unavailable')).toBeVisible();
  await expect(page.locator('a[href^="/vorgaenge/"]')).toHaveCount(0);
}

/** Sichtbar, im Viewport erreichbar und nicht abgeschnitten. */
async function expectActionReachable(page: Page, testId: string): Promise<void> {
  const action = page.getByTestId(testId);
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeVisible();
  await expect(action).toBeEnabled();
  const box = await action.boundingBox();
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  expect(box, `${testId} hat keine Box`).not.toBeNull();
  expect(box!.x, `${testId} links abgeschnitten`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${testId} rechts abgeschnitten`).toBeLessThanOrEqual(width + 1);
}

/** Bestehender lokaler Versandpfad: markieren → Formular → bestätigen (lokale Cloud sichert). */
async function markAsSent(page: Page): Promise<void> {
  await page.getByTestId('invoice-sent-mark').click();
  await expect(page.getByTestId('invoice-sent-form')).toBeVisible();
  await page.getByTestId('invoice-sent-date-input').fill('2026-09-05');
  await page.getByTestId('invoice-sent-via-input').selectOption('email');
  await page.getByTestId('invoice-sent-continue').click();
  await expect(page.getByTestId('invoice-sent-confirm')).toBeVisible();
  await page.getByTestId('invoice-sent-confirm-submit').click();
  await expect(page.getByTestId('invoice-sent-status')).toBeVisible({ timeout: 20_000 });
}

/**
 * Korrekturbelege zu **dieser** Rechnung auf dem lokalen Server (service_role,
 * nur lokal). Adressiert über die Rechnungskennung aus der URL — die Nummer
 * wiederholt sich je Workspace (jeder Lauf hat einen eigenen).
 */
async function countCorrectionDocumentsOnServer(page: Page): Promise<number> {
  const invoiceId = page.url().match(/\/rechnungen\/(inv-[0-9a-f-]{36})/)?.[1] ?? '';
  expect(invoiceId, 'Rechnungskennung in der URL').not.toBe('');
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/workspace_documents?select=id&document_kind=eq.generated_invoice_correction&linked_invoice_id=eq.${invoiceId}`,
    { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } },
  );
  const rows = (await response.json()) as unknown[];
  return rows.length;
}

/** Zahlungszeilen dieser Rechnung auf dem lokalen Server — Grabsteine eingeschlossen. */
async function countPaymentRowsOnServer(page: Page): Promise<{ total: number; reversed: number }> {
  const invoiceId = page.url().match(/\/rechnungen\/(inv-[0-9a-f-]{36})/)?.[1] ?? '';
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/workspace_invoice_payments?select=id,reversed_at&client_invoice_id=eq.${invoiceId}`,
    { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } },
  );
  const rows = (await response.json()) as { reversed_at: string | null }[];
  return { total: rows.length, reversed: rows.filter((row) => row.reversed_at !== null).length };
}

/** Teilzahlung über das bestehende Zahlungsformular; die Rechnung ist noch nicht versendet → Rückfrage bestätigen. */
async function recordPartialPayment(page: Page, amount: string): Promise<void> {
  await page.getByRole('button', { name: 'Zahlung erfassen' }).first().click();
  const form = page.locator('form.invoice-payment-form');
  await expect(form).toBeVisible();
  const amountInput = form.locator('input[type="number"]').first();
  await amountInput.fill(amount);
  await page.getByTestId('payment-save').click();
  // Bestehende Regel: noch nicht als versendet markiert → ausdrückliche Rückfrage.
  await expect(page.getByTestId('payment-confirm-submit')).toBeVisible();
  await page.getByTestId('payment-confirm-submit').click();
  // Lokal gebucht und in der lokalen Cloud gesichert → das Formular schliesst sich.
  await expect(form).toHaveCount(0, { timeout: 20_000 });
}

/** Erzeugte Rechnungsdokumente ohne Vorgang auf dem lokalen Server. */
async function countGeneratedDocumentsOnServer(): Promise<number> {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/workspace_documents?select=id&document_kind=eq.generated_invoice&linked_vorgang_id=is.null`,
    { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } },
  );
  const rows = (await response.json()) as unknown[];
  return rows.length;
}

/** Zählt die Rechnungen des Testnutzers real auf dem lokalen Server (service_role, nur lokal). */
async function countFinalizedOnServer(): Promise<number> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/workspace_invoices?select=id&vorgang_id=is.null`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  const rows = (await response.json()) as unknown[];
  return rows.length;
}
