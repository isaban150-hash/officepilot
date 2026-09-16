/**
 * UIUX-FOUNDATION-01E — Kernarbeitsbereiche (lokale Supabase).
 *
 *  A  Heute: Seitenkopf mit einer Hauptaktion, Sections, Offene-Arbeit-Zeilen, kein Überlauf
 *  B  Eingang: Hauptaktion, Filter-Chips, Aufnahmewege, kein Überlauf
 *  C  Aufträge: Toolbar (Suche/Filter), Leerzustand oder Liste, kein Überlauf
 *  D  Rechnungen: Titel „Rechnungen“, Zahlungsstand, Toolbar, Hauptaktion; Back -> Aufträge
 *  E  Deep Link: /vorgaenge/:id?vtab=invoices überlebt Reload und Browser-Back
 *  F  Mobile: Touchziele der Zeilen/Back >= 44px, Bottom-Nav frei
 */
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let owner: LocalDbUser;
const company = loadTestWorldOperatorCompany();

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'core-owner' });
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
  await page.getByTestId('setup-contactPerson').fill('Core Test');
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

async function expectNoOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontaler Überlauf: ${label}`).toBeLessThanOrEqual(1);
}

async function expectTouchTarget(page: Page, testId: string): Promise<void> {
  const box = await page.getByTestId(testId).first().boundingBox();
  expect(box?.height ?? 0, `Touchziel ${testId}`).toBeGreaterThanOrEqual(44);
}

test.describe('UIUX-FOUNDATION-01E — Kernbereiche (lokal)', () => {
  test('Heute -> Eingang -> Aufträge -> Rechnungen -> Deep Link', async ({ page }) => {
    test.setTimeout(240_000);
    await login(page, owner);
    const mobile = (page.viewportSize()?.width ?? 0) < 1024;

    /* A — Heute */
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('heute-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.page-header__actions')).toHaveCount(1);
    await expect(page.getByTestId('home-card-add-document')).toBeVisible();
    for (const id of ['heute-section-attention', 'heute-section-open-work', 'heute-section-quick', 'home-card-orders', 'home-card-inbox']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await expectTouchTarget(page, 'home-card-orders');
    await expectNoOverflow(page, 'Heute');

    /* B — Eingang */
    await page.getByTestId('home-card-inbox').click();
    await expect(page).toHaveURL(/\/ablage$/);
    await expect(page.getByTestId('ablage-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('ablage-add-document')).toBeVisible();
    await expect(page.getByTestId('documents-capture-panel').first()).toBeVisible();
    await expect(page.locator('.page-header__actions')).toHaveCount(1);
    await expectNoOverflow(page, 'Eingang');
    const hasItems = (await page.getByTestId('ablage-filter-all').count()) > 0;
    if (hasItems) {
      await page.getByTestId('ablage-filter-neu').click();
      await expect(page.getByTestId('ablage-filter-neu')).toHaveAttribute('aria-pressed', 'true');
    } else {
      await expect(page.getByTestId('ablage-empty-state')).toBeVisible();
    }

    /* C — Aufträge */
    await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('vorgaenge-page')).toBeVisible({ timeout: 30_000 });
    const hasOrders = (await page.getByTestId('vorgaenge-list').count()) > 0;
    if (hasOrders) {
      await page.getByTestId('vorgaenge-search').locator('input').fill('zzz-kein-treffer');
      await expect(page.getByTestId('vorgaenge-no-matches')).toBeVisible();
      await page.getByTestId('vorgaenge-search').locator('input').fill('');
      await page.getByTestId('vorgaenge-filter-all').click();
      await expect(page.getByTestId('vorgaenge-list')).toBeVisible();
    } else {
      await expect(page.getByTestId('vorgaenge-empty-state')).toBeVisible();
    }
    await expectNoOverflow(page, 'Aufträge');

    /* D — Rechnungen */
    await page.goto('/rechnungen/offen', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('rechnungen-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('h1.page-header__title')).toHaveText('Rechnungen');
    await expect(page.getByTestId('rechnungen-summary')).toBeVisible();
    await expect(page.getByTestId('rechnungen-search')).toBeVisible();
    await expect(page.getByTestId('overview-new-invoice')).toBeVisible();
    await expect(page.locator('.page-header__actions')).toHaveCount(1);
    await page.getByTestId('rechnungen-filter-bezahlt').click();
    await expect(page.getByTestId('rechnungen-filter-bezahlt')).toHaveAttribute('aria-pressed', 'true');
    await expectTouchTarget(page, 'rechnungen-back');
    await expectNoOverflow(page, 'Rechnungen');
    await page.getByTestId('rechnungen-back').click();
    await expect(page).toHaveURL(/\/vorgaenge$/);

    /* E — Deep Link mit vtab: Reload + Browser-Back */
    const deep = '/vorgaenge/nicht-vorhanden?vtab=invoices';
    await page.goto(deep, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/vorgaenge\/nicht-vorhanden\?vtab=invoices$/, { timeout: 30_000 });
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.goBack();
    await expect(page).toHaveURL(/\/vorgaenge\/nicht-vorhanden\?vtab=invoices$/);

    /* F — Mobile: Bottom-Nav frei */
    if (mobile) {
      await expect(page.getByTestId('bottom-nav')).toBeVisible();
      const nav = await page.getByTestId('bottom-nav').boundingBox();
      expect(nav?.height ?? 0).toBeGreaterThanOrEqual(56);
    }
  });
});
