/**
 * UIUX-FOUNDATION-01D — Page Patterns (lokale Supabase).
 *
 *  A  Ausgabenliste: PageHeader mit Primäraktion, Toolbar (Suche, Chips), BusinessList-Zeile mit Status/Betrag
 *  B  Ausgabendetail: Back im Header (from-Parameter), Status, Hauptaktion "Zahlung erfassen", Sections
 *  C  Back: Detail -> Liste; Browser-Back bringt zurück; Reload hält Route
 *  D  Mehr / Finanzen: RowList-Zeilen als Links (Touchziel >= 44px)
 *  E  Einstellungen-Unterseite: Back im PageHeader führt zum Hub
 *  F  kein horizontaler Überlauf auf Liste, Detail, Mehr, Finanzen
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
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'pat-owner' });
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
  await page.getByTestId('setup-contactPerson').fill('Pattern Test');
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

async function createExpense(page: Page, title: string): Promise<string> {
  await page.goto('/ausgaben/neu', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Titel').fill(title);
  await page.getByLabel('Lieferant').fill('Baustoff Nord GmbH');
  await page.getByLabel('Rechnungsnummer').fill(`RE-${Date.now()}`);
  await page.getByLabel('Rechnungsdatum').fill('2026-09-01');
  await page.getByLabel('Bruttobetrag').fill('119');
  await page.getByRole('button', { name: 'Ausgabe speichern' }).click();
  await page.waitForURL(/\/ausgaben\/exp-/, { timeout: 30_000 });
  return new URL(page.url()).pathname.split('/').pop()!;
}

test.describe('UIUX-FOUNDATION-01D — Page Patterns (lokal)', () => {
  test('Liste -> Detail -> Back -> Reload -> Mehr/Finanzen -> Settings-Back', async ({ page }) => {
    test.setTimeout(240_000);
    await login(page, owner);
    const expenseId = await createExpense(page, 'Pattern Dachlatten');

    /* B — Detail nach dem Anlegen */
    await expect(page.getByTestId('ausgabe-detail-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('ausgabe-payment-status')).toContainText('Offen');
    await expect(page.getByTestId('ausgabe-record-payment')).toBeVisible();
    await expect(page.getByTestId('ausgabe-section-payment')).toBeVisible();
    await expect(page.getByTestId('ausgabe-section-details')).toContainText('119,00');
    await expect(page.locator('.page-header__actions')).toHaveCount(1);
    await expectNoOverflow(page, 'Detail');
    const backBox = await page.getByTestId('ausgabe-detail-back').boundingBox();
    expect(backBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    /* C — Back im Header */
    await page.getByTestId('ausgabe-detail-back').click();
    await expect(page).toHaveURL(/\/ausgaben$/);

    /* A — Liste */
    await expect(page.getByTestId('ausgaben-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('ausgaben-list')).toBeVisible();
    const row = page.getByTestId(`ausgaben-row-${expenseId}`);
    await expect(row).toContainText('Pattern Dachlatten');
    await expect(row).toContainText('119,00');
    await expect(row.locator('.business-list__status')).toContainText('Gebucht');
    await page.getByTestId('ausgaben-search').locator('input').fill('nicht-vorhanden-xyz');
    await expect(page.getByTestId('ausgaben-empty')).toBeVisible();
    await page.getByTestId('ausgaben-search').locator('input').fill('');
    await page.getByTestId('ausgaben-category-fahrzeug').click();
    await expect(page.getByTestId('ausgaben-category-fahrzeug')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('ausgaben-category-all').click();
    await expect(row).toBeVisible();
    await expectNoOverflow(page, 'Liste');

    /* C — Zeile klickbar, Browser-Back, Reload */
    await row.getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/ausgaben/${expenseId}$`));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('ausgabe-detail-page')).toBeVisible({ timeout: 30_000 });
    await page.goBack();
    await expect(page).toHaveURL(/\/ausgaben$/);

    /* B — from=overview steuert das Back-Ziel */
    await page.goto(`/ausgaben/${expenseId}?from=overview`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('ausgabe-detail-back')).toHaveAttribute('href', '/ausgaben/offen');

    /* D — Mehr / Finanzen als RowList */
    await page.goto('/mehr', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('mehr-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.row-list').first()).toBeVisible();
    const mehrRow = page.getByTestId('mehr-link-finanzen');
    expect((await mehrRow.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expectNoOverflow(page, 'Mehr');
    await mehrRow.click();
    await expect(page.getByTestId('finanzen-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('finanzen-link-ausgaben')).toBeVisible();
    await expectNoOverflow(page, 'Finanzen');

    /* E — Einstellungen-Unterseite: Back im PageHeader */
    await page.goto('/einstellungen/kommunikation', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-communication-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.page-header__back[data-testid="settings-communication-back"]')).toBeVisible();
    await page.getByTestId('settings-communication-back').click();
    await expect(page.getByTestId('einstellungen-page')).toBeVisible({ timeout: 30_000 });
  });
});
