/**
 * UIUX-FOUNDATION-01F — restliche Produktbereiche (lokale Supabase).
 *
 *  A  Kunden: Liste (Hauptaktion, Business-Zeilen) -> Detail (Back-Link, Sections)
 *  B  Dokumente: Toolbar (Suche, Bereichs-Chips), Upload-Seite mit Header-Back
 *  C  Aufgaben / Papierarchiv / Mail-Import / Sync: PageHeader-Back, Zeilenlisten
 *  D  Offene Ausgaben + Steuerberater: Zahlungsstand, Status im Header, eine Hauptaktion
 *  E  Mobile: Touchziele, kein horizontaler Überlauf auf allen Seiten
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
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'rest-owner' });
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
  await page.getByTestId('setup-contactPerson').fill('Rest Test');
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

async function expectTouch(page: Page, testId: string): Promise<void> {
  const box = await page.getByTestId(testId).first().boundingBox();
  expect(box?.height ?? 0, `Touchziel ${testId}`).toBeGreaterThanOrEqual(44);
}

test.describe('UIUX-FOUNDATION-01F — Restbereiche (lokal)', () => {
  test('Kunden -> Dokumente -> Aufgaben -> Finanzen -> Steuerberater -> Back-Patterns', async ({ page }) => {
    test.setTimeout(240_000);
    await login(page, owner);

    /* A — Kunden: anlegen, Zeile, Detail */
    await page.goto('/kunden', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('kunden-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.page-header__actions')).toHaveCount(1);
    await page.getByTestId('kunden-create-action').click();
    await expect(page.getByTestId('kunden-create-section')).toBeVisible();
    await page.getByTestId('kunden-edit-name').fill('Pattern Kunde GmbH');
    await page.getByTestId('kunden-edit-form').getByRole('button', { name: /Speichern|Anlegen/ }).first().click();
    await expect(page.getByTestId('kunden-list')).toBeVisible({ timeout: 20_000 });
    const row = page.locator('[data-testid^="kunde-customer-"]').first();
    await expect(row).toContainText('Pattern Kunde GmbH');
    expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expectNoOverflow(page, 'Kunden');
    await row.click();
    await expect(page.getByTestId('kunden-detail-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('h1.page-header__title')).toHaveText('Pattern Kunde GmbH');
    await expect(page.getByTestId('kunden-contact')).toBeVisible();
    await expect(page.getByTestId('kunden-edit-action')).toBeVisible();
    await expectNoOverflow(page, 'Kundendetail');
    await page.getByTestId('kunden-detail-back').click();
    await expect(page).toHaveURL(/\/kunden$/);

    /* B — Dokumente + Upload-Back */
    await page.goto('/dokumente', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('dokumente-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('document-search')).toBeVisible();
    await page.getByTestId('document-area-chip-rechnungen').click();
    await expect(page.getByTestId('document-area-chip-rechnungen')).toHaveAttribute('aria-pressed', 'true');
    await expectNoOverflow(page, 'Dokumente');
    await page.getByTestId('document-upload-link').click();
    await expect(page.getByTestId('document-upload-page')).toBeVisible({ timeout: 30_000 });
    await expectTouch(page, 'document-upload-back');
    await page.getByTestId('document-upload-back').click();
    await expect(page).toHaveURL(/\/dokumente$/);

    /* C — Aufgaben, Papierarchiv, Mail-Import, Sync */
    await page.goto('/aufgaben', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('aufgaben-page')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('aufgaben-filter-erledigt').click();
    await expect(page.getByTestId('aufgaben-filter-erledigt')).toHaveAttribute('aria-pressed', 'true');
    await expectNoOverflow(page, 'Aufgaben');
    await page.goto('/papierarchiv', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('papierarchiv-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('papierarchiv-list')).toBeVisible();
    await expectNoOverflow(page, 'Papierarchiv');
    await page.goto('/mail-import', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('mail-import-page')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('mail-import-back').click();
    await expect(page).toHaveURL(/\/mehr$/);
    await page.goto('/synchronisation', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('sync-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('sync-back')).toHaveAttribute('href', '/mehr');
    await expectNoOverflow(page, 'Sync');

    /* D — Offene Ausgaben + Steuerberater */
    await page.goto('/ausgaben/offen', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('offene-ausgaben-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('offene-ausgaben-summary')).toBeVisible();
    await expect(page.getByTestId('offene-ausgaben-search')).toBeVisible();
    await expectNoOverflow(page, 'Offene Ausgaben');
    await page.getByTestId('offene-ausgaben-back').click();
    await expect(page).toHaveURL(/\/ausgaben$/);
    await page.goto('/steuerberater', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('steuerberater-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('steuerberater-month-status')).toBeVisible();
    await expect(page.locator('.page-header__actions')).toHaveCount(1);
    await page.getByTestId('steuerberater-prepare-folder').click();
    await expect(page.getByTestId('steuerberater-documents')).toBeVisible();
    await expect(page.getByTestId('steuerberater-export-button')).toBeVisible();
    await expectNoOverflow(page, 'Steuerberater');

    /* E — Suche mit Header-Back */
    await page.goto('/suche?q=Pattern', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('search-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('search-back')).toHaveAttribute('href', '/');
  });
});
