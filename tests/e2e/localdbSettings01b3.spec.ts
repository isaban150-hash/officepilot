/**
 * SETTINGS-01B3 — Dokumente & Design in der echten App gegen die **lokale**
 * Supabase-Instanz (synthetisches Testkonto, Kennwort nur im Speicher,
 * lokaler Storage-Bucket `branding-assets`). Kein Cloud-Auth, keine echten
 * Zugangsdaten, keine echten Bilddateien — das Testbild entsteht zur Laufzeit.
 *
 *   1. Hub → Dokumente & Design       2. Leerzustand
 *   3. grosses Bild (2400×1200) wählen → verkleinerte Pending-Vorschau
 *   4. Speichern → Upload → Reload: Logo bleibt
 *   5. Ersetzen (JPEG) → Speichern → Reload
 *   6. Entfernen → Speichern → Reload: kein Logo
 *   7. Vorlage Classic sichtbar, kein Farbfeld   8. zurück zum Hub
 *   Mobile: Vorschau ohne horizontalen Überlauf, Speichern erreichbar.
 */
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let user: LocalDbUser;

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'design' });
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
  await page.getByTestId('setup-companyName').fill('Design E2E GmbH');
  await page.getByTestId('setup-contactPerson').fill('D. Test');
  await page.getByTestId('setup-street').fill('Werkstraße 2');
  await page.getByTestId('setup-zip').fill('54321');
  await page.getByTestId('setup-city').fill('Betriebsstadt');
  await page.getByTestId('setup-email').fill('design@example.invalid');
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

/** Ein synthetisches Testbild aus dem Browser-Canvas — keine Datei aus dem Repo. */
async function makeImage(page: Page, width: number, height: number, mimeType: 'image/png' | 'image/jpeg'): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    ({ width, height, mimeType }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      if (mimeType === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
      }
      ctx.fillStyle = '#1d4ed8';
      ctx.fillRect(width * 0.1, height * 0.2, width * 0.8, height * 0.6);
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(width * 0.3, height * 0.5, height * 0.2, 0, Math.PI * 2);
      ctx.fill();
      return canvas.toDataURL(mimeType, 0.92);
    },
    { width, height, mimeType },
  );
  const base64 = dataUrl.split(',')[1] ?? '';
  return Buffer.from(base64, 'base64');
}

async function expectNoOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontaler Überlauf: ${label}`).toBeLessThanOrEqual(1);
}

async function expectSaveReachable(page: Page): Promise<void> {
  const save = page.getByTestId('settings-design-save');
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

async function saveAndReload(page: Page): Promise<void> {
  await expectSaveReachable(page);
  await page.getByTestId('settings-design-save').click();
  await expect(page.getByText('Design gespeichert.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('settings-design-save')).toBeDisabled();
  await page.waitForTimeout(1200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('settings-design-page')).toBeVisible({ timeout: 30_000 });
}

test.describe('Einstellungen — Dokumente & Design (lokale Datenbank)', () => {
  test('Hub, Leerzustand, grosses Logo, Speichern, Ersetzen, Entfernen, Vorlage, zurück', async ({ page }) => {
    test.setTimeout(240_000);
    await loginAndSetup(page);

    /* 1. Hub → Dokumente & Design */
    await page.goto('/einstellungen', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-group-design')).toContainText('Dokumente & Design');
    await page.getByTestId('settings-entry-logo').click();
    await expect(page).toHaveURL(/\/einstellungen\/design$/);
    await expect(page.getByTestId('settings-design-page')).toBeVisible();

    /* 2. Leerzustand */
    await expect(page.getByTestId('settings-design-logo-none')).toBeVisible();
    await expect(page.getByTestId('settings-design-logo-remove')).toHaveCount(0);
    await expect(page.getByTestId('settings-design-save')).toBeDisabled();
    await expect(page.getByTestId('settings-design-readonly')).toHaveCount(0);
    await expect(page.getByTestId('settings-design-template-classic')).toContainText('Standardvorlage');
    await expect(page.getByText('Weitere Vorlagen folgen')).toBeVisible();
    await expect(page.locator('input[type="color"]')).toHaveCount(0);
    await expect(page.getByTestId('settings-design-preview-sheet').locator('.invoice-document')).toBeVisible();
    await expect(page.getByTestId('settings-design-preview-sheet')).toContainText('Design E2E GmbH');
    await expect(page.getByTestId('settings-design-preview-sheet')).toContainText('VORSCHAU-0001');
    await expect(page.getByTestId('invoice-header-logo')).toHaveCount(0);
    await expectNoOverflow(page, 'Design leer');

    /* 3. grosses Bild → verkleinert, Pending-Vorschau, noch nichts gespeichert */
    const large = await makeImage(page, 2400, 1200, 'image/png');
    await page.getByTestId('settings-design-logo-input').setInputFiles({ name: 'kamera.png', mimeType: 'image/png', buffer: large });
    await expect(page.getByTestId('settings-design-logo-pending')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('settings-design-logo-pending-hint')).toContainText('2400×1200');
    await expect(page.getByTestId('settings-design-logo-pending-hint')).toContainText('1600×800');
    await expect(page.getByTestId('settings-design-logo-error')).toHaveCount(0);
    await expect(page.getByTestId('invoice-header-logo')).toBeVisible();
    await expect(page.getByTestId('settings-design-dirty')).toHaveText('Ungespeicherte Änderungen');
    await expectNoOverflow(page, 'Design pending');

    /* 4. Speichern → Upload → Reload */
    await saveAndReload(page);
    await expect(page.getByTestId('settings-design-logo-current')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('settings-design-logo-upload-label')).toContainText('Logo ersetzen');
    await expect(page.getByTestId('invoice-header-logo')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('invoice-header-logo')).toHaveAttribute('data-logo-kind', 'asset');
    await expectNoOverflow(page, 'Design gespeichert');

    /* 5. Ersetzen mit JPEG (klein, bleibt unverändert) */
    const small = await makeImage(page, 600, 300, 'image/jpeg');
    await page.getByTestId('settings-design-logo-input').setInputFiles({ name: 'neu.jpg', mimeType: 'image/jpeg', buffer: small });
    await expect(page.getByTestId('settings-design-logo-pending')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('settings-design-logo-pending-hint')).not.toContainText('verkleinert');
    await saveAndReload(page);
    await expect(page.getByTestId('settings-design-logo-current')).toBeVisible({ timeout: 30_000 });

    /* Ungültige Datei: verständliche Meldung, Logo bleibt */
    await page.getByTestId('settings-design-logo-input').setInputFiles({ name: 'falsch.png', mimeType: 'image/png', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
    await expect(page.getByTestId('settings-design-logo-error')).toBeVisible();
    await expect(page.getByTestId('settings-design-logo-current')).toBeVisible();
    await expect(page.getByTestId('settings-design-save')).toBeDisabled();

    /* 6. Entfernen → Speichern → Reload */
    await page.getByTestId('settings-design-logo-remove').click();
    await expect(page.getByTestId('settings-design-logo-removed-hint')).toBeVisible();
    await expect(page.getByTestId('invoice-header-logo')).toHaveCount(0);
    await page.getByTestId('settings-design-logo-keep').click();
    await expect(page.getByTestId('settings-design-logo-current')).toBeVisible();
    await page.getByTestId('settings-design-logo-remove').click();
    await saveAndReload(page);
    await expect(page.getByTestId('settings-design-logo-none')).toBeVisible();
    await expect(page.getByTestId('invoice-header-logo')).toHaveCount(0);

    /* 7. Vorlage & Legacy-Alias */
    await expect(page.getByTestId('settings-design-template-classic')).toBeVisible();
    await page.goto('/firmendaten#logo', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/einstellungen\/design$/, { timeout: 30_000 });

    /* 8. zurück zum Hub */
    await page.getByTestId('settings-design-back').click();
    await expect(page).toHaveURL(/\/einstellungen$/);
    await expect(page.getByTestId('einstellungen-page')).toBeVisible();
  });
});
