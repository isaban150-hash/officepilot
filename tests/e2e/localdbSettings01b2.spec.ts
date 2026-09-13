/**
 * SETTINGS-01B2 — Settings-Hub, Zahnrad und Firmenprofil in der echten App,
 * gegen die **lokale** Supabase-Instanz (synthetisches Testkonto, Kennwort
 * nur im Speicher). Kein Cloud-Auth, keine echten Zugangsdaten.
 *
 *   1. Benutzermenü → Einstellungen   2. Zahnrad → Einstellungen
 *   3. Firmenprofil                   4. vorhandene Daten sichtbar
 *   5. Feld ändern                    6. Reload vor Speichern → Resume
 *   7. Speichern                      8. Reload → persistiert
 *   9. accountHolder                 10. zurück zum Hub
 *   Mobile: kein Bottom-Nav-Overlay, kein horizontaler Überlauf.
 */
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let user: LocalDbUser;

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'settings' });
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
  await page.getByTestId('setup-companyName').fill('Settings E2E GmbH');
  await page.getByTestId('setup-contactPerson').fill('S. Test');
  await page.getByTestId('setup-street').fill('Werkstraße 2');
  await page.getByTestId('setup-zip').fill('54321');
  await page.getByTestId('setup-city').fill('Betriebsstadt');
  await page.getByTestId('setup-email').fill('settings@example.invalid');
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-taxNumber').fill('11/222/33333');
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-iban').fill('DE89370400440532013000');
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-next').click();
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 20_000 });
  // Firmendaten werden nach dem Assistenten asynchron gesichert.
  await page.waitForTimeout(1500);
}

async function expectNoOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontaler Überlauf: ${label}`).toBeLessThanOrEqual(1);
}

/** Der Speichern-Knopf muss vollständig sichtbar sein und nicht unter der Bottom-Nav liegen. */
async function expectSaveReachable(page: Page): Promise<void> {
  const save = page.getByTestId('settings-company-save');
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeVisible();
  const box = await save.boundingBox();
  expect(box).not.toBeNull();
  const nav = page.locator('.bottom-nav');
  if (await nav.isVisible().catch(() => false)) {
    const navBox = await nav.boundingBox();
    expect(navBox).not.toBeNull();
    expect(box!.y + box!.height, 'Speichern liegt unter der Bottom-Nav').toBeLessThanOrEqual(navBox!.y + 0.5);
  }
}

test.describe('Einstellungen — Hub und Firmenprofil (lokale Datenbank)', () => {
  test('Hub, Zahnrad, Firmenprofil, Resume, Speichern, Reload, Kontoinhaber, zurück', async ({ page }) => {
    test.setTimeout(180_000);
    await loginAndSetup(page);

    /* 1. Benutzermenü → Einstellungen */
    await page.getByTestId('user-menu').getByRole('button').first().click();
    await page.getByTestId('user-menu-einstellungen').click();
    await expect(page).toHaveURL(/\/einstellungen$/);
    await expect(page.getByTestId('einstellungen-page')).toBeVisible();
    await expectNoOverflow(page, 'Hub');

    /* 2. Zahnrad → Einstellungen (von einer anderen Seite aus) */
    await page.getByRole('link', { name: /Schreibtisch/ }).first().click();
    await page.getByTestId('settings-gear').click();
    await expect(page).toHaveURL(/\/einstellungen$/);

    /* 3./4. Firmenprofil mit vorhandenen Daten */
    await page.getByTestId('settings-entry-company-profile').click();
    await expect(page).toHaveURL(/\/einstellungen\/firma$/);
    await expect(page.getByTestId('settings-company-page')).toBeVisible();
    await expect(page.getByTestId('settings-company-companyName')).toHaveValue('Settings E2E GmbH');
    await expect(page.getByTestId('settings-company-iban')).toHaveValue('DE89370400440532013000');
    await expect(page.getByTestId('settings-company-save')).toBeDisabled();
    await expect(page.getByTestId('settings-company-readonly')).toHaveCount(0);
    // Keine Vorbelegungen/Logo auf dieser Seite.
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(page.getByText('Skonto')).toHaveCount(0);
    await expectNoOverflow(page, 'Firmenprofil');

    /* 5./9. Feld ändern + Kontoinhaber */
    await page.getByTestId('settings-company-accountHolder').fill('Settings E2E GmbH – Geschäftskonto');
    await page.getByTestId('settings-company-phone').fill('+49 5222 9800-0');
    await expect(page.getByTestId('settings-company-dirty')).toHaveText('Ungespeicherte Änderungen');
    await expect(page.getByTestId('settings-company-save')).toBeEnabled();

    /* 6. Reload vor dem Speichern → Entwurf bleibt */
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-company-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('settings-company-accountHolder')).toHaveValue('Settings E2E GmbH – Geschäftskonto');
    await expect(page.getByTestId('settings-company-phone')).toHaveValue('+49 5222 9800-0');

    /* 7. Speichern */
    await expectSaveReachable(page);
    await page.getByTestId('settings-company-save').click();
    await expect(page.getByText('Firmenprofil gespeichert.')).toBeVisible();
    await expect(page.getByTestId('settings-company-save')).toBeDisabled();

    /* 8. Reload → persistiert, kein Entwurf mehr */
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-company-accountHolder')).toHaveValue('Settings E2E GmbH – Geschäftskonto', { timeout: 30_000 });
    await expect(page.getByTestId('settings-company-phone')).toHaveValue('+49 5222 9800-0');
    await expect(page.getByTestId('settings-company-dirty')).toHaveText('Keine Änderungen');

    /* Validierung am Feld */
    await page.getByTestId('settings-company-email').fill('keine-mail');
    await page.getByTestId('settings-company-save').click();
    await expect(page.getByTestId('settings-company-email-error')).toBeVisible();
    await page.getByTestId('settings-company-email').fill('settings@example.invalid');
    await expect(page.getByTestId('settings-company-email-error')).toHaveCount(0);

    /* /firmendaten-Alias und Legacy-Hash */
    await page.goto('/firmendaten', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/einstellungen\/firma$/, { timeout: 30_000 });
    // Seit SETTINGS-01B3/01B4 führen #logo → Design und #zahlungsbedingungen → Rechnungen; #datensicherung bleibt Legacy.
    await page.goto('/firmendaten#logo', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/einstellungen\/design$/, { timeout: 30_000 });
    await expect(page.getByTestId('settings-design-page')).toBeVisible();
    await page.goto('/firmendaten#zahlungsbedingungen', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/einstellungen\/rechnungen$/, { timeout: 30_000 });
    await page.goto('/firmendaten#datensicherung', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#datensicherung')).toBeVisible({ timeout: 30_000 });

    /* 10. zurück zum Hub */
    await page.goto('/einstellungen/firma', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('settings-company-back').click();
    await expect(page).toHaveURL(/\/einstellungen$/);
    await expect(page.getByTestId('einstellungen-page')).toBeVisible();
  });
});
