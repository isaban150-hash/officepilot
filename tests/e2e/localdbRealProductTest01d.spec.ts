/**
 * REAL-PRODUCT-TEST-01D — Browser-Abnahme der sechs Befunde gegen die echte App (lokale Supabase).
 *
 *  1  Sync: „Synchronisiert" ohne Wartehinweis; wartende Änderung sichtbar mit Grund; Konflikte verständlich
 *  2  Aufgaben: heute fällig / überfällig getrennt (Filter + Heute-Hinweis)
 *  3  Navigation: Hauptseiten und Detailseite beginnen oben; Rückweg stellt Position wieder her
 *  4  Aufträge: Anlegeweg als Hauptaktion erreichbar; „Offene Rechnungen" nur Nebenaktion
 *  5  Dokumentarchiv: eigene Ausgangsrechnung mit Nummer, Kunde, Datum, Betrag
 *  6  Kunden: gleiche Namen getrennt, Unterscheidungsmerkmale sichtbar
 */
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';
import { fillVerified } from './support/verifiedInput';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let owner: LocalDbUser;
const company = loadTestWorldOperatorCompany();

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'rpt01d' });
});
test.afterAll(async () => {
  if (owner) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: owner.id });
});

async function login(page: Page, user: LocalDbUser): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-email').fill(user.email);
  await page.getByTestId('login-password').fill(user.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-page')).toBeHidden({ timeout: 30_000 });
  const landed = await Promise.race([
    page.getByTestId('app-shell').waitFor({ timeout: 30_000 }).then(() => 'shell' as const),
    page.getByTestId('workspace-setup-continue').waitFor({ timeout: 30_000 }).then(() => 'continue' as const),
    page.getByTestId('setup-companyName').waitFor({ timeout: 30_000 }).then(() => 'wizard' as const),
  ]);
  if (landed === 'shell') return;
  if (landed === 'continue') await page.getByTestId('workspace-setup-continue').click();
  await page.getByTestId('setup-companyName').fill(company.companyName);
  await page.getByTestId('setup-contactPerson').fill('Abnahme 01D');
  await page.getByTestId('setup-street').fill(company.street);
  await page.getByTestId('setup-zip').fill(company.zip);
  await page.getByTestId('setup-city').fill(company.city);
  await page.getByTestId('setup-email').fill(company.email);
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-taxNumber').fill(company.taxNumber);
  if (company.vatId) await page.getByTestId('setup-vatId').fill(company.vatId);
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-iban').fill(company.iban);
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-next').click();
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
}

/** Aufgaben in den persistierten Workspace-Zustand einspielen (kein Anlege-UI für Aufgaben). */
async function seedTasks(page: Page, tasks: Array<{ id: string; title: string; dueDate: string }>): Promise<void> {
  await page.evaluate((seed) => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (!key.startsWith('officepilot-state:workspace:')) continue;
      const state = JSON.parse(localStorage.getItem(key) ?? '{}');
      state.tasks = [
        ...(Array.isArray(state.tasks) ? state.tasks : []),
        ...seed.map((t) => ({
          id: t.id,
          title: t.title,
          description: '',
          status: 'open',
          priority: 'mittel',
          category: 'dokumente',
          dueDate: t.dueDate,
          sourceType: 'manual',
          taskKind: 'dokument_pruefen',
          dedupeKey: t.id,
          autoCreated: false,
          createdAt: '2026-09-01T08:00:00.000Z',
          type: 'dokument_pruefen',
        })),
      ];
      localStorage.setItem(key, JSON.stringify(state));
      return;
    }
    throw new Error('Workspace-Zustand nicht gefunden');
  }, tasks);
}

async function createCustomerViaUi(page: Page, name: string, street: string, city: string, email: string, allowDuplicate: boolean): Promise<void> {
  await page.goto('/kunden', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('kunden-create-action').click();
  await fillVerified(page.getByTestId('kunden-edit-name'), name);
  await fillVerified(page.getByTestId('kunden-edit-street'), street);
  await fillVerified(page.getByTestId('kunden-edit-zip'), '45356');
  await fillVerified(page.getByTestId('kunden-edit-city'), city);
  await fillVerified(page.getByTestId('kunden-edit-email'), email);
  await page.getByTestId('kunden-edit-save').click();
  if (allowDuplicate) {
    // Dublettenwarnung erscheint nur bei erkannter Dublette (bestehende Regel); dann bewusst bestätigen.
    const anyway = page.getByTestId('customer-duplicate-create-anyway');
    if (await anyway.isVisible({ timeout: 3_000 }).catch(() => false)) await anyway.click();
  }
  await expect(page.getByTestId('kunden-list')).toContainText(street, { timeout: 15_000 });
}

function todayLocalIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test.describe('REAL-PRODUCT-TEST-01D — Browser-Abnahme', () => {
  test('1–6: Sync, Aufgaben, Navigation, Aufträge, Dokumentarchiv, Kunden', async ({ page, context }, testInfo) => {
    test.setTimeout(300_000);
    await login(page, owner);
    const mobile = page.viewportSize()!.width < 1024;

    /* ---------- 4. Aufträge: Hauptaktion ---------- */
    await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('vorgaenge-page')).toBeVisible();
    const newFromDoc = page.getByTestId('vorgaenge-new-from-document');
    await expect(newFromDoc).toBeVisible();
    await expect(newFromDoc).toContainText('Auftrag aus Dokument anlegen');
    await expect(page.locator('.page-header__primary')).toContainText('Auftrag aus Dokument anlegen');
    await expect(page.locator('.page-header__primary')).not.toContainText('Offene Rechnungen');
    await newFromDoc.click();
    await expect(page.getByTestId('document-add-page')).toBeVisible();
    await expect(page.getByTestId('document-add-page-actions')).toBeVisible();

    /* ---------- 6. Kunden: gleiche Namen ---------- */
    await createCustomerViaUi(page, 'Müller Bau GmbH', 'Industrieweg 3', 'Essen', 'anna@mueller.example', false);
    await expect(page.getByTestId('kunden-list')).toContainText('Müller Bau GmbH');
    await createCustomerViaUi(page, 'Müller Bau GmbH', 'Seeufer 9', 'Essen', 'bernd@mueller.example', true);
    const rows = page.locator('[data-testid^="kunde-customer-"]');
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId('kunden-list')).toContainText('Industrieweg 3');
    await expect(page.getByTestId('kunden-list')).toContainText('Seeufer 9');
    await expect(page.getByTestId('kunden-list')).toContainText('anna@mueller.example');
    await expect(page.getByTestId('kunden-list')).toContainText('bernd@mueller.example');

    /* ---------- 5. Dokumentarchiv: eigene Ausgangsrechnung ---------- */
    await page.goto('/rechnungen/offen', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('overview-new-invoice').click();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('1/4');
    await page.getByTestId('customer-decision-existing').locator('input').check();
    await page.locator('[data-testid^="customer-option-"]').filter({ hasText: 'Industrieweg 3' }).first().click();
    await page.getByTestId('manual-invoice-next').click();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('2/4');
    await fillVerified(page.getByTestId('manual-position-description'), 'Kleinreparatur Heizung');
    await fillVerified(page.getByTestId('manual-position-quantity'), '1', { expectAfterBlur: '1' });
    await fillVerified(page.getByTestId('manual-position-unit-price'), '100', { expectAfterBlur: '100' });
    await page.getByTestId('manual-position-commit').click();
    await expect(page.getByTestId('manual-positions-list').locator('li')).toHaveCount(1);
    await page.getByTestId('manual-invoice-next').click();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('3/4');
    await fillVerified(page.getByTestId('invoice-edit-service-from'), '2026-09-01');
    await fillVerified(page.getByTestId('invoice-edit-service-to'), '2026-09-05');
    await page.getByTestId('manual-invoice-next').click();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('4/4');
    const confirmPeriod = page.getByTestId('invoice-confirm-service-period');
    if (await confirmPeriod.isVisible().catch(() => false)) await confirmPeriod.click();
    await page.getByTestId('invoice-approve').click();
    await expect(page).toHaveURL(/\/rechnungen\/inv-[0-9a-f-]{36}(\?.*)?$/, { timeout: 45_000 });
    const invoiceNumber = (await page.getByTestId('invoice-detail-header').textContent()) ?? '';
    const numberMatch = invoiceNumber.match(/\d{4}-\d{4}|[A-Z]{2}-\d{4}-\d{4,5}/);
    expect(numberMatch, 'Rechnungsnummer im Kopf').not.toBeNull();
    await page.goto('/dokumente', { waitUntil: 'domcontentloaded' });
    const invoiceRow = page.locator('[data-testid^="document-summary-list-"]').filter({ hasText: `Rechnung ${numberMatch![0]}` });
    await expect(invoiceRow).toHaveCount(1);
    await expect(invoiceRow).toContainText('Müller Bau GmbH');
    await expect(invoiceRow).toContainText(/119,00\s?€/);
    await expect(invoiceRow.locator('[data-testid^="document-card-date-"]')).toContainText(/\d{1,2}\.\d{1,2}\.\d{4}/);

    /* ---------- 3. Navigation: Scrollregel (die App scrollt im Fenster) ---------- */
    const scrollTop = async () => page.evaluate(() => Math.max(window.scrollY, document.querySelector('.app-shell__main')?.scrollTop ?? 0));
    /* Hohe Seite simulieren — als Stylesheet, damit es die SPA-Navigation überlebt. */
    /* Hohe Seite simulieren: Inhalt weit unten, damit der Klick auf eine Zeile ohne Nachscrollen möglich ist. */
    const makeTall = async () => page.addStyleTag({ content: '.app-shell__main { padding-top: 1400px; min-height: 3400px; }' });
    const scrollTo = async (y: number) => page.evaluate((top) => { window.scrollTo(0, top); document.querySelector('.app-shell__main')?.scrollTo(0, top); }, y);
    await page.goto('/dokumente', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('dokumente-page')).toBeVisible();
    await makeTall();
    await scrollTo(1300);
    expect(await scrollTop(), 'Vorbedingung: Seite ist gescrollt').toBeGreaterThan(1000);
    await page.getByTestId(mobile ? 'bottom-nav' : 'sidebar-nav').getByRole('link', { name: /Aufträge/ }).first().click();
    await expect(page.getByTestId('vorgaenge-page')).toBeVisible();
    expect(await scrollTop(), 'Hauptseite beginnt oben').toBe(0);
    await page.goto('/dokumente', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('dokumente-page')).toBeVisible();
    await makeTall();
    // so scrollen, dass die Zeile sichtbar ist — der Klick darf die Position nicht mehr verändern
    const rowTop = await invoiceRow.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    await scrollTo(rowTop - 120);
    expect(await scrollTop()).toBeGreaterThan(1000);
    await expect(invoiceRow.locator('a').first()).toBeInViewport();
    await invoiceRow.locator('a').first().click();
    await expect(page.getByTestId('document-detail-page')).toBeVisible();
    expect(await scrollTop(), 'Detailseite beginnt oben').toBe(0);
    await page.goBack();
    await expect(page.getByTestId('dokumente-page')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await scrollTop(), 'Rückweg stellt Position wieder her').toBeGreaterThan(1000);

    /* ---------- 2. Aufgaben: heute / überfällig ---------- */
    const today = todayLocalIso();
    await seedTasks(page, [
      { id: 'task-01d-today', title: 'Heute fällige Aufgabe 01D', dueDate: today },
      { id: 'task-01d-overdue', title: 'Überfällige Aufgabe 01D', dueDate: '2026-09-07' },
    ]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.goto('/aufgaben', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('aufgaben-page')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('aufgaben-filter-heute').click();
    await expect(page.getByTestId('aufgaben-row-task-01d-today')).toBeVisible();
    await expect(page.getByTestId('aufgaben-row-task-01d-overdue')).toHaveCount(0);
    await page.getByTestId('aufgaben-filter-ueberfaellig').click();
    await expect(page.getByTestId('aufgaben-row-task-01d-overdue')).toBeVisible();
    await expect(page.getByTestId('aufgaben-row-task-01d-today')).toHaveCount(0);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('heute-page')).toBeVisible();
    const heuteText = (await page.getByTestId('heute-page').textContent()) ?? '';
    expect(heuteText, 'Heute nennt Überfälliges').toContain('1 Aufgabe überfällig');
    expect(heuteText, 'Heute nennt heute Fälliges').toContain('1 Aufgabe heute fällig');
    expect(heuteText).not.toContain('2 Aufgaben heute fällig');

    /* ---------- 1. Sync: synchronisiert / wartend / Konflikte ---------- */
    await page.goto('/synchronisation', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('sync-page')).toBeVisible();
    await page.getByTestId('sync-run-button').click();
    await expect(page.getByTestId('sync-run-button')).toBeEnabled({ timeout: 60_000 });
    await expect(page.getByTestId('sync-status-badge')).toContainText('Synchronisiert', { timeout: 30_000 });
    /* Nach dem Lauf: entweder wirklich alles übertragen (kein Wartehinweis) oder wartende Einträge
       ehrlich benannt — nie schlicht grün mit stiller Warteschlange. */
    const pendingAfterRun = await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)!;
        if (!key.startsWith('officepilot-state:workspace:')) continue;
        const state = JSON.parse(localStorage.getItem(key) ?? '{}');
        return (state.syncOutbox ?? [])
          // nach einem erfolgreichen Lauf darf nichts mehr ausstehen — auch keine nur-lokalen Entitäten
          // (ihr Sendeauftrag wird beim Lauf abgeschlossen)
          .filter((e: { status: string }) => e.status === 'pending' || e.status === 'blocked')
          .map((e: { entityType: string; status: string; operation: string; blockedReason?: string }) => `${e.entityType}:${e.operation}:${e.status}${e.blockedReason ? ':' + e.blockedReason : ''}`);
      }
      return [];
    });
    testInfo.annotations.push({ type: 'sync-pending-after-run', description: pendingAfterRun.join(', ') || 'keine' });
    const badgeAfterRun = (await page.getByTestId('sync-status-badge').textContent()) ?? '';
    if (pendingAfterRun.length === 0) {
      expect(badgeAfterRun).toBe('Synchronisiert');
      await expect(page.getByTestId('sync-waiting-notice')).toHaveCount(0);
      await expect(page.getByTestId('sync-outbox-pending-list')).toHaveCount(0);
    } else {
      expect(badgeAfterRun).toMatch(/Synchronisiert – \d+ Änderung(en)? wart/);
      await expect(page.getByTestId('sync-waiting-notice')).toBeVisible();
      await expect(page.getByTestId('sync-outbox-pending-list')).toBeVisible();
    }
    await expect(page.getByTestId('sync-report-section')).toContainText('Automatisch zusammengeführt');
    await expect(page.getByTestId('sync-report-section')).not.toContainText(' ms');
    const mergedNotice = page.getByTestId('sync-merged-notice');
    testInfo.annotations.push({
      type: 'sync-merged-notice',
      description: (await mergedNotice.count()) > 0 ? await mergedNotice.textContent() ?? '' : 'keine Konflikte im Lauf',
    });

    /* wartende Änderung: offline eine Ausgabe anlegen → Outbox wartet */
    await page.goto('/ausgaben/neu', { waitUntil: 'domcontentloaded' });
    await expect(page.getByLabel('Titel')).toBeVisible();
    await context.setOffline(true);
    await fillVerified(page.getByLabel('Titel'), 'Offline-Beleg 01D');
    await fillVerified(page.getByLabel('Lieferant'), 'Baustoff Nord GmbH');
    await fillVerified(page.getByLabel('Rechnungsnummer'), `RE-01D-${Date.now()}`);
    await fillVerified(page.getByLabel('Rechnungsdatum'), '2026-09-10');
    await fillVerified(page.getByLabel('Bruttobetrag'), '59');
    await page.getByRole('button', { name: 'Ausgabe speichern' }).click();
    await page.waitForURL(/\/ausgaben\/exp-/, { timeout: 30_000 });
    // offline nur innerhalb der App navigieren (kein Reload ohne Netz): Verlaufseintrag wie ein App-Link
    await page.evaluate(() => {
      history.pushState({ idx: history.length }, '', '/synchronisation');
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    });
    await expect(page.getByTestId('sync-page')).toBeVisible({ timeout: 15_000 });
    const waitingBadge = (await page.getByTestId('sync-status-badge').textContent()) ?? '';
    const waitingVisible = (await page.getByTestId('sync-waiting-notice').count()) > 0;
    testInfo.annotations.push({ type: 'sync-offline-badge', description: waitingBadge });
    expect(
      /wartet|warten|Offline|nicht übertragen|Fehler/.test(waitingBadge) || waitingVisible,
      `Wartende Änderung muss sichtbar sein (Badge: „${waitingBadge}")`,
    ).toBe(true);
    expect(waitingBadge === 'Synchronisiert', 'nicht schlicht grün „Synchronisiert"').toBe(false);
    await context.setOffline(false);
    await page.getByTestId('sync-run-button').click();
    await expect(page.getByTestId('sync-run-button')).toBeEnabled({ timeout: 60_000 });
    await expect(page.getByTestId('sync-status-badge')).toContainText('Synchronisiert', { timeout: 30_000 });
    testInfo.annotations.push({ type: 'sync-badge-final', description: (await page.getByTestId('sync-status-badge').textContent()) ?? '' });
  });
});
