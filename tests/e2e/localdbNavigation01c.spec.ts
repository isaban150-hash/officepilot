/**
 * UIUX-FOUNDATION-01C — AppShell & Navigation (lokale Supabase).
 *
 *  A  Shell: Desktop = Sidebar sichtbar / Bottom-Nav verborgen; Mobile umgekehrt
 *  B  Hauptziele erreichbar, aktiver Zustand per aria-current
 *  C  Mehr: gruppierte Zeilen, Finanzen & Dokumente erreichbar; Finanzen-Hub -> Steuerberater
 *  D  Header: Assistent-Werkzeug -> /assistent, Zahnrad -> /einstellungen
 *  E  Deep Link mit Query bleibt bei Reload und Browser-Back erhalten
 *  F  kein horizontaler Überlauf auf Heute / Mehr / Finanzen / Eingang
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
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'nav-owner' });
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
  await page.getByTestId('setup-contactPerson').fill('Navigation Test');
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

test.describe('UIUX-FOUNDATION-01C — Navigation (lokal)', () => {
  test('Shell -> Hauptziele -> Mehr/Finanzen -> Header-Werkzeuge -> Deep Link', async ({ page }) => {
    test.setTimeout(240_000);
    await login(page, owner);
    const width = page.viewportSize()?.width ?? 0;
    const desktop = width >= 1024;

    /* A — Shell je Gerät */
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('heute-page')).toBeVisible({ timeout: 30_000 });
    if (desktop) {
      await expect(page.getByTestId('sidebar-nav')).toBeVisible();
      await expect(page.getByTestId('bottom-nav')).toBeHidden();
      await expect(page.getByTestId('sidebar-nav-secondary')).toBeVisible();
    } else {
      await expect(page.getByTestId('bottom-nav')).toBeVisible();
      await expect(page.getByTestId('sidebar-nav')).toBeHidden();
      const links = page.getByTestId('bottom-nav').getByRole('link');
      await expect(links).toHaveCount(5);
      for (let i = 0; i < 5; i += 1) {
        const box = await links.nth(i).boundingBox();
        expect(box?.height ?? 0, `Touchziel ${i}`).toBeGreaterThanOrEqual(44);
      }
    }
    await expectNoOverflow(page, 'Heute');

    /* B — Hauptziele + aktiver Zustand */
    const prefix = desktop ? 'sidebar-nav-link-' : 'bottom-nav-link-';
    const targets: Array<[string, RegExp]> = [
      ['ablage', /\/ablage$/],
      ['vorgaenge', /\/vorgaenge$/],
      ['rechnungen-offen', /\/rechnungen\/offen$/],
      ...(desktop ? ([['finanzen', /\/finanzen$/], ['dokumente', /\/dokumente$/]] as Array<[string, RegExp]>) : []),
      ['home', /\/$/],
    ];
    for (const [id, urlPattern] of targets) {
      await page.getByTestId(`${prefix}${id}`).click();
      await expect(page).toHaveURL(urlPattern);
      await expect(page.getByTestId(`${prefix}${id}`)).toHaveAttribute('aria-current', 'page');
      await expectNoOverflow(page, id);
    }
    await expect(page.locator('[data-testid^="' + prefix + '"][aria-current="page"]')).toHaveCount(1);

    /* C — Mehr: Gruppen, Finanzen-Hub, Steuerberater */
    if (desktop) {
      await page.goto('/mehr', { waitUntil: 'domcontentloaded' });
    } else {
      await page.getByTestId('bottom-nav-link-mehr').click();
    }
    await expect(page.getByTestId('mehr-page')).toBeVisible({ timeout: 30_000 });
    for (const group of ['work', 'finance', 'officepilot', 'system']) {
      await expect(page.getByTestId(`mehr-group-${group}`)).toBeVisible();
    }
    await expect(page.locator('.mehr-link-card')).toHaveCount(0);
    await expect(page.getByTestId('mehr-link-dokumente')).toBeVisible();
    await expectNoOverflow(page, 'Mehr');
    await page.getByTestId('mehr-link-finanzen').click();
    await expect(page.getByTestId('finanzen-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('finanzen-link-ausgaben')).toBeVisible();
    await expectNoOverflow(page, 'Finanzen');
    await page.getByTestId('finanzen-link-steuerberater').click();
    await expect(page.getByTestId('steuerberater-page')).toBeVisible({ timeout: 30_000 });
    await page.goBack();
    await expect(page.getByTestId('finanzen-page')).toBeVisible({ timeout: 30_000 });

    /* D — Header-Werkzeuge */
    await page.getByTestId('assistant-entry').click();
    await expect(page.getByTestId('assistant-page')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('settings-gear').click();
    await expect(page.getByTestId('einstellungen-page')).toBeVisible({ timeout: 30_000 });

    /* E — Deep Link mit Query: Reload und Browser-Back erhalten Parameter */
    const deep = '/vorgaenge/nicht-vorhanden?vtab=invoices';
    await page.goto(deep, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/vorgaenge\/nicht-vorhanden\?vtab=invoices$/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/vorgaenge\/nicht-vorhanden\?vtab=invoices$/, { timeout: 30_000 });
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(`${prefix}home`).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/vorgaenge\/nicht-vorhanden\?vtab=invoices$/);

    /* F — Eingang ohne Überlauf */
    await page.goto('/ablage', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('ablage-page')).toBeVisible({ timeout: 30_000 });
    await expectNoOverflow(page, 'Eingang');
  });
});
