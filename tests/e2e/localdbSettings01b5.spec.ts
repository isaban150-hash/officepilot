/**
 * SETTINGS-01B5 — Betrieb und Legacy-Ablösung in der echten App gegen die
 * **lokale** Supabase-Instanz (synthetisches Testkonto, Kennwort nur im
 * Speicher). Kein Cloud-Auth, keine echten Zugangsdaten.
 *
 *   1. Benutzermenü → Einstellungen   2. Hub zeigt vier Bereiche
 *   3. Betrieb öffnen                 4. Sprache prüfen/ändern (sofort wirksam)
 *   5. Datensicherung erreichbar      6. Sync-Link   7. Benutzer/Betrieb
 *   8. zurück zum Hub                 9. alle vier Bereiche nacheinander
 *  10. keine Legacy-Duplikate        11./12. Legacy-URLs landen richtig
 *   Mobile: kein Overflow, Bottom-Nav verdeckt nichts.
 */
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let user: LocalDbUser;

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'operating' });
});
test.afterAll(async () => {
  if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
});

async function loginAndSetup(page: Page): Promise<void> {
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
  await page.getByTestId('setup-companyName').fill('Betrieb E2E GmbH');
  await page.getByTestId('setup-contactPerson').fill('B. Test');
  await page.getByTestId('setup-street').fill('Werkstraße 2');
  await page.getByTestId('setup-zip').fill('54321');
  await page.getByTestId('setup-city').fill('Betriebsstadt');
  await page.getByTestId('setup-email').fill('betrieb@example.invalid');
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-taxNumber').fill('11/222/33333');
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-iban').fill('DE89370400440532013000');
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

/** Das letzte Bedienelement der Seite muss erreichbar sein und nicht unter der Bottom-Nav liegen. */
async function expectReachable(page: Page, testId: string): Promise<void> {
  const el = page.getByTestId(testId);
  await el.scrollIntoViewIfNeeded();
  await expect(el).toBeVisible();
  const box = await el.boundingBox();
  expect(box).not.toBeNull();
  const nav = page.locator('.bottom-nav');
  if (await nav.isVisible().catch(() => false)) {
    const navBox = await nav.boundingBox();
    expect(navBox).not.toBeNull();
    expect(box!.y + box!.height, `${testId} liegt unter der Bottom-Nav`).toBeLessThanOrEqual(navBox!.y + 0.5);
  }
}

async function expectNoLegacyDuplicates(page: Page, label: string): Promise<void> {
  await expect(page.locator('#profile-companyName'), label).toHaveCount(0);
  await expect(page.locator('#profile-logo-file'), label).toHaveCount(0);
  await expect(page.locator('#profile-payment-days'), label).toHaveCount(0);
  await expect(page.getByTestId('pilot-hints-panel'), label).toHaveCount(0);
  await expect(page.locator('a[href^="/firmendaten"]'), label).toHaveCount(0);
}

test.describe('Einstellungen — Betrieb und Legacy-Ablösung (lokale Datenbank)', () => {
  test('Hub, Betrieb, Sprache, Backup, Sync, Verwaltung, vier Bereiche, Legacy-URLs', async ({ page }) => {
    test.setTimeout(240_000);
    await loginAndSetup(page);

    /* 1./2. Benutzermenü → Einstellungen; vier Bereiche */
    await page.getByTestId('user-menu').getByRole('button').first().click();
    await page.getByTestId('user-menu-einstellungen').click();
    await expect(page).toHaveURL(/\/einstellungen$/);
    await expect(page.locator('.settings-group')).toHaveCount(4);
    await expect(page.getByTestId('settings-entry-company-profile')).toBeVisible();
    await expect(page.getByTestId('settings-entry-invoices')).toBeVisible();
    await expect(page.getByTestId('settings-entry-logo')).toBeVisible();
    await expect(page.getByTestId('settings-entry-operations')).toContainText('Betrieb');
    await expectNoLegacyDuplicates(page, 'Hub');
    await expectNoOverflow(page, 'Hub');
    // Mitarbeiterverwaltung gibt es nur für App-Admins — dieselbe Regel gilt auf der Betriebsseite.
    const isAppAdmin = (await page.getByTestId('settings-entry-users').count()) > 0;

    /* 3. Betrieb */
    await page.getByTestId('settings-entry-operations').click();
    await expect(page).toHaveURL(/\/einstellungen\/betrieb$/);
    await expect(page.getByTestId('settings-operating-page')).toBeVisible();
    await expectNoOverflow(page, 'Betrieb');

    /* 4. Sprache: bestehender Wert, Wechsel wirkt sofort, zurück */
    const switcher = page.getByTestId('settings-operating-language-switcher');
    await expect(switcher.getByTestId('language-option-de')).toHaveClass(/chip--active/);
    await switcher.getByTestId('language-option-tr').click();
    await expect(switcher.getByTestId('language-option-tr')).toHaveClass(/chip--active/);
    await expect(page.getByTestId('settings-operating-page')).toContainText('İşletme');
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-operating-language-switcher').getByTestId('language-option-tr')).toHaveClass(/chip--active/, { timeout: 30_000 });
    await page.getByTestId('settings-operating-language-switcher').getByTestId('language-option-de').click();
    await expect(page.getByTestId('settings-operating-page')).toContainText('Betrieb');
    await expectNoOverflow(page, 'Betrieb nach Sprachwechsel');

    /* 5. Datensicherung erreichbar (Export-Knopf, Datei-Auswahl) */
    await expect(page.getByTestId('backup-section')).toBeVisible();
    await expect(page.getByTestId('backup-export-panel').getByRole('button').first()).toBeVisible();
    await expect(page.getByTestId('backup-export-panel').locator('input[type="file"]')).toBeAttached();

    /* 6. Sync-Status + Link */
    await expect(page.getByTestId('settings-operating-sync-status')).not.toBeEmpty();
    await expect(page.getByTestId('settings-operating-sync-link')).toHaveAttribute('href', '/synchronisation');

    /* 7. Verwaltung: Mitarbeiter-Link nur für App-Admins (dieselbe Regel wie im Hub); Rollenhinweis; letzte Aktion erreichbar */
    await expect(page.getByTestId('settings-operating-role')).toContainText('kannst');
    await expect(page.getByTestId('settings-operating-users-link')).toHaveCount(isAppAdmin ? 1 : 0);
    await expectReachable(page, 'settings-operating-more-link');
    await page.getByTestId('settings-operating-sync-link').click();
    await expect(page).toHaveURL(/\/synchronisation$/);

    /* 8. zurück zum Hub */
    await page.goto('/einstellungen/betrieb', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('settings-operating-back').click();
    await expect(page).toHaveURL(/\/einstellungen$/);

    /* 9./10. alle vier Bereiche ohne Legacy-Duplikate */
    const areas: [string, RegExp, string][] = [
      ['settings-entry-company-profile', /\/einstellungen\/firma$/, 'settings-company-page'],
      ['settings-entry-invoices', /\/einstellungen\/rechnungen$/, 'settings-invoices-page'],
      ['settings-entry-logo', /\/einstellungen\/design$/, 'settings-design-page'],
      ['settings-entry-operations', /\/einstellungen\/betrieb$/, 'settings-operating-page'],
    ];
    for (const [entry, url, pageId] of areas) {
      await page.goto('/einstellungen', { waitUntil: 'domcontentloaded' });
      await page.getByTestId(entry).click();
      await expect(page).toHaveURL(url);
      await expect(page.getByTestId(pageId)).toBeVisible({ timeout: 30_000 });
      await expectNoLegacyDuplicates(page, pageId);
      await expectNoOverflow(page, pageId);
    }
    // taxFreeNotice lebt auf der Rechnungsseite (Steuer).
    await page.goto('/einstellungen/rechnungen', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-invoices-section-tax').getByTestId('settings-invoices-taxFreeNotice')).toBeVisible();

    /* 11./12. Legacy-URLs landen am richtigen Ort */
    const legacy: [string, RegExp][] = [
      ['/firmendaten', /\/einstellungen\/firma$/],
      ['/firmendaten#logo', /\/einstellungen\/design$/],
      ['/firmendaten#zahlungsbedingungen', /\/einstellungen\/rechnungen$/],
      ['/firmendaten#rechnungstexte', /\/einstellungen\/rechnungen$/],
      ['/firmendaten#datensicherung', /\/einstellungen\/betrieb#datensicherung$/],
    ];
    for (const [from, to] of legacy) {
      await page.goto(from, { waitUntil: 'domcontentloaded' });
      await expect(page, from).toHaveURL(to, { timeout: 30_000 });
      await expectNoLegacyDuplicates(page, from);
    }
    await expect(page.getByTestId('backup-section')).toBeVisible();
  });
});
