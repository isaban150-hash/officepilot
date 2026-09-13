/**
 * SETTINGS-01B4 — Rechnungen & Zahlungen in der echten App gegen die
 * **lokale** Supabase-Instanz (synthetisches Testkonto, Kennwort nur im
 * Speicher). Kein Cloud-Auth, keine echten Zugangsdaten.
 *
 *   1. Einstellungen → Rechnungen & Zahlungen   2. vorhandene Defaults
 *   3. Zahlungsziel, Zahlungstext, Skonto, Steuerstatus, Intro, Closing
 *   4. Reload vor Save → Resume                   5. Save → Reload → Werte bleiben
 *   6. neue manuelle Rechnung: Defaults konkret im Entwurf, §13b unbestätigt
 *   7. Legacy-Hashes → neue Seite                 8. zurück zum Hub
 *   Mobile: kein Overflow, Save nicht verdeckt.
 */
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let user: LocalDbUser;

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'invoices' });
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
  await page.getByTestId('setup-companyName').fill('Invoices E2E GmbH');
  await page.getByTestId('setup-contactPerson').fill('I. Test');
  await page.getByTestId('setup-street').fill('Werkstraße 2');
  await page.getByTestId('setup-zip').fill('54321');
  await page.getByTestId('setup-city').fill('Betriebsstadt');
  await page.getByTestId('setup-email').fill('invoices@example.invalid');
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

async function expectSaveReachable(page: Page): Promise<void> {
  const save = page.getByTestId('settings-invoices-save');
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

const INTRO = 'Vielen Dank für Ihren Auftrag — wir berechnen wie folgt:';
const CLOSING = 'Wir freuen uns auf die weitere Zusammenarbeit.';

test.describe('Einstellungen — Rechnungen & Zahlungen (lokale Datenbank)', () => {
  test('Hub, Defaults, Skonto, §13b, Texte, Resume, Save, Reload, neue Rechnung, zurück', async ({ page }) => {
    test.setTimeout(240_000);
    await loginAndSetup(page);

    /* 1./2. Hub → Rechnungen & Zahlungen mit vorhandenen Defaults */
    await page.goto('/einstellungen', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-group-documents')).toContainText('Rechnungen & Zahlungen');
    await page.getByTestId('settings-entry-invoices').click();
    await expect(page).toHaveURL(/\/einstellungen\/rechnungen$/);
    await expect(page.getByTestId('settings-invoices-page')).toBeVisible();
    await expect(page.getByTestId('settings-invoices-readonly')).toHaveCount(0);
    await expect(page.getByTestId('settings-invoices-defaultPaymentDays')).toHaveValue('14');
    await expect(page.getByTestId('settings-invoices-defaultPaymentTerms')).toHaveValue('Zahlbar innerhalb von 14 Tagen ohne Abzug.');
    await expect(page.getByTestId('settings-invoices-skontoEnabled')).not.toBeChecked();
    await expect(page.getByTestId('settings-invoices-skontoPercent')).toBeDisabled();
    await expect(page.getByTestId('settings-invoices-defaultTaxStatus')).toHaveValue('standard_19');
    await expect(page.getByTestId('settings-invoices-tax-fallback')).toBeVisible();
    await expect(page.getByTestId('settings-invoices-save')).toBeDisabled();
    await expect(page.getByTestId('settings-invoices-preview-due')).toContainText('14 Tage');
    await expectNoOverflow(page, 'Rechnungen leer');

    /* 3. Zahlungsziel → Standardsatz folgt; Skonto; §13b; Texte */
    await page.getByTestId('settings-invoices-defaultPaymentDays').fill('21');
    await expect(page.getByTestId('settings-invoices-defaultPaymentTerms')).toHaveValue('Zahlbar innerhalb von 21 Tagen ohne Abzug.');
    await expect(page.getByTestId('settings-invoices-preview-due')).toContainText('21 Tage');
    await page.getByTestId('settings-invoices-skontoEnabled').check();
    await expect(page.getByTestId('settings-invoices-skontoPercent')).toBeEnabled();
    await page.getByTestId('settings-invoices-skontoPercent').fill('2');
    await page.getByTestId('settings-invoices-skontoDays').fill('7');
    await expect(page.getByTestId('settings-invoices-skonto-sentence')).toContainText('2 % Skonto');
    await expect(page.getByTestId('settings-invoices-preview-terms')).toHaveText('Zahlbar innerhalb von 21 Tagen.');
    await page.getByTestId('settings-invoices-defaultTaxStatus').selectOption('reverse_charge_13b');
    await expect(page.getByTestId('settings-invoices-tax-13b-hint')).toBeVisible();
    await expect(page.getByTestId('settings-invoices-preview-tax')).toContainText('§13b');
    await page.getByTestId('settings-invoices-defaultIntroText').fill(INTRO);
    await page.getByTestId('settings-invoices-defaultClosingText').fill(CLOSING);
    await expect(page.getByTestId('settings-invoices-preview-intro')).toHaveText(INTRO);
    await expect(page.getByTestId('settings-invoices-dirty')).toHaveText('Ungespeicherte Änderungen');
    await expectNoOverflow(page, 'Rechnungen dirty');

    /* 4. Reload vor Save → Resume */
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-invoices-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('settings-invoices-defaultPaymentDays')).toHaveValue('21');
    await expect(page.getByTestId('settings-invoices-skontoEnabled')).toBeChecked();
    await expect(page.getByTestId('settings-invoices-skontoPercent')).toHaveValue('2');
    await expect(page.getByTestId('settings-invoices-defaultTaxStatus')).toHaveValue('reverse_charge_13b');
    await expect(page.getByTestId('settings-invoices-defaultIntroText')).toHaveValue(INTRO);

    /* 5. Save → Reload → Werte bleiben */
    await expectSaveReachable(page);
    await page.getByTestId('settings-invoices-save').click();
    await expect(page.getByText('Rechnungseinstellungen gespeichert.')).toBeVisible();
    await expect(page.getByTestId('settings-invoices-save')).toBeDisabled();
    await page.waitForTimeout(1200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-invoices-defaultPaymentDays')).toHaveValue('21', { timeout: 30_000 });
    await expect(page.getByTestId('settings-invoices-skontoDays')).toHaveValue('7');
    await expect(page.getByTestId('settings-invoices-defaultTaxStatus')).toHaveValue('reverse_charge_13b');
    await expect(page.getByTestId('settings-invoices-tax-fallback')).toHaveCount(0);
    await expect(page.getByTestId('settings-invoices-defaultClosingText')).toHaveValue(CLOSING);
    await expect(page.getByTestId('settings-invoices-dirty')).toHaveText('Keine Änderungen');

    /* Validierung: Skontofrist über Zahlungsziel blockiert am Feld */
    await page.getByTestId('settings-invoices-skontoDays').fill('30');
    await page.getByTestId('settings-invoices-save').click();
    await expect(page.getByTestId('settings-invoices-skontoDays-error')).toBeVisible();
    await page.getByTestId('settings-invoices-skontoDays').fill('7');
    await expect(page.getByTestId('settings-invoices-skontoDays-error')).toHaveCount(0);

    /* 6. Neue manuelle Rechnung: Defaults konkret im Entwurf, §13b unbestätigt */
    await page.goto('/rechnungen/neu', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('manual-invoice-progress')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('customer-decision-new').locator('input').check();
    await page.getByTestId('manual-invoice-customer-name').fill('Defaults Kunde GmbH');
    await page.getByTestId('customer-decision-street').fill('Hauptstraße 12');
    await page.getByTestId('customer-decision-zip').fill('45356');
    await page.getByTestId('customer-decision-city').fill('Essen');
    await page.getByTestId('manual-invoice-next').click();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('2/4');
    await page.getByTestId('manual-position-description').fill('Anfahrt');
    await page.getByTestId('manual-position-quantity').fill('1');
    await page.getByTestId('manual-position-unit-price').fill('45');
    await page.getByTestId('manual-position-commit').click();
    await page.getByTestId('manual-invoice-next').click();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('3/4');

    const issueDate = await page.getByTestId('invoice-edit-issue-date').inputValue();
    const due = new Date(`${issueDate}T00:00:00.000Z`);
    due.setUTCDate(due.getUTCDate() + 21);
    await expect(page.getByTestId('invoice-edit-payment-due')).toHaveValue(due.toISOString().slice(0, 10));
    await expect(page.getByTestId('invoice-edit-payment-terms')).toHaveValue('Zahlbar innerhalb von 21 Tagen.');
    await expect(page.getByTestId('invoice-edit-skonto')).toHaveValue(/7 Tagen.*2 % Skonto/);
    await expect(page.getByTestId('invoice-edit-intro')).toHaveValue(INTRO);
    await expect(page.getByTestId('invoice-edit-closing')).toHaveValue(CLOSING);
    // §13b ist vorbelegt, aber NICHT bestätigt — Confirm-first bleibt.
    await expect(page.getByTestId('invoice-tax-reverse_charge_13b')).toHaveClass(/chip--active/);
    await expect(page.getByTestId('invoice-13b-confirm')).toBeVisible();
    await expect(page.getByTestId('invoice-13b-confirm-checkbox')).not.toBeChecked();

    /* 7. Legacy-Hashes → neue Seite */
    await page.goto('/firmendaten#zahlungsbedingungen', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/einstellungen\/rechnungen$/, { timeout: 30_000 });
    await page.goto('/firmendaten#rechnungstexte', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/einstellungen\/rechnungen$/, { timeout: 30_000 });
    await expect(page.getByTestId('settings-invoices-page')).toBeVisible();

    /* 8. zurück zum Hub */
    await page.getByTestId('settings-invoices-back').click();
    await expect(page).toHaveURL(/\/einstellungen$/);
    await expect(page.getByTestId('einstellungen-page')).toBeVisible();
  });
});
