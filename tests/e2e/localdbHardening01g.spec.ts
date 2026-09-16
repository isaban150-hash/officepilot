/**
 * UIUX-FOUNDATION-01G — Mobile-/Responsive-Gesamthärtung (lokale Supabase).
 *
 *  A  Alle sichtbaren Bereiche: kein horizontaler Überlauf, h1 vorhanden, Header-Aktionen im Viewport
 *  B  Bottom-Nav (mobil): exakt 5, Safe-Area, verdeckt keinen Seitenkopf; Sidebar (Desktop) sichtbar
 *  C  Confirm-Dialog: Zahlung entfernen öffnet Dialog (Fokus, Buttons >= 44px, Escape bricht ab), Bestätigen entfernt
 *  D  Deep Links: vtab / from-Parameter / Settings-Unterseite überleben Reload + Back
 *  E  Tastatur/Viewport: Eingabefeld in Ausgabe-Formular bleibt nach Fokus sichtbar; Save-Aktion erreichbar
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
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'hard-owner' });
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
  await page.getByTestId('setup-contactPerson').fill('Hard Test');
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

async function recordPayment(page: Page, expenseId: string, amount: string): Promise<void> {
  await page.goto(`/ausgaben/${expenseId}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('ausgabe-record-payment').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Zahlungsdatum').fill('2026-09-05');
  await dialog.getByLabel('Betrag').fill(amount);
  await dialog.getByRole('button', { name: 'Zahlung speichern' }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

const PAGES: Array<[string, string]> = [
  ['/', 'heute-page'],
  ['/ablage', 'ablage-page'],
  ['/vorgaenge', 'vorgaenge-page'],
  ['/rechnungen/offen', 'rechnungen-page'],
  ['/kunden', 'kunden-page'],
  ['/dokumente', 'dokumente-page'],
  ['/aufgaben', 'aufgaben-page'],
  ['/finanzen', 'finanzen-page'],
  ['/ausgaben', 'ausgaben-page'],
  ['/ausgaben/offen', 'offene-ausgaben-page'],
  ['/steuerberater', 'steuerberater-page'],
  ['/mehr', 'mehr-page'],
  ['/einstellungen', 'einstellungen-page'],
  ['/einstellungen/firma', 'settings-company-page'],
  ['/kommunikation', 'kommunikation-page'],
  ['/assistent', 'assistant-page'],
  ['/wissen', 'wissen-page'],
  ['/synchronisation', 'sync-page'],
  ['/papierarchiv', 'papierarchiv-page'],
];

test.describe('UIUX-FOUNDATION-01G — Härtung (lokal)', () => {
  test('Audit aller Bereiche -> Dialog -> Deep Links -> Formular/Viewport', async ({ page }) => {
    test.setTimeout(300_000);
    await login(page, owner);
    const viewport = page.viewportSize()!;
    const mobile = viewport.width < 1024;

    /* A/B — jede Seite: Overflow, h1, Bottom-Nav/Sidebar, Safe-Area */
    for (const [route, testId] of PAGES) {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId(testId)).toBeVisible({ timeout: 30_000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `Überlauf ${route}`).toBeLessThanOrEqual(1);
      await expect(page.locator('h1').first(), `h1 ${route}`).toBeVisible();
      const h1Box = await page.locator('h1').first().boundingBox();
      expect(h1Box?.width ?? 0, `Titelbreite ${route}`).toBeLessThanOrEqual(viewport.width);
      if (mobile) {
        const nav = page.getByTestId('bottom-nav');
        await expect(nav).toBeVisible();
        await expect(nav.getByRole('link')).toHaveCount(5);
        const navBox = (await nav.boundingBox())!;
        expect(navBox.y + navBox.height, `BottomNav im Viewport ${route}`).toBeLessThanOrEqual(viewport.height + 1);
        expect(h1Box!.y + h1Box!.height, `Titel nicht unter BottomNav ${route}`).toBeLessThan(navBox.y);
        const primary = page.locator('.page-header__primary .btn').first();
        if ((await primary.count()) > 0) {
          const b = (await primary.boundingBox())!;
          expect(b.height, `Primäraktion Touchziel ${route}`).toBeGreaterThanOrEqual(44);
          expect(b.y + b.height, `Primäraktion über BottomNav ${route}`).toBeLessThanOrEqual(navBox.y + 1);
        }
      } else {
        await expect(page.getByTestId('sidebar-nav')).toBeVisible();
        await expect(page.getByTestId('bottom-nav')).toBeHidden();
      }
    }

    /* C — Confirm-Dialog für Geldaktion */
    const expenseId = await createExpense(page, 'Härtung Beleg');
    await recordPayment(page, expenseId, '19');
    await expect(page.getByTestId('ausgabe-payment-status')).toContainText('Teilbezahlt');
    const removeButton = page.locator('.invoice-payment-history').getByRole('button', { name: 'Entfernen' }).first();
    await removeButton.click();
    const dialog = page.getByTestId('payment-remove-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('19,00');
    await expect(page.getByTestId('payment-remove-cancel')).toBeFocused();
    for (const id of ['payment-remove-cancel', 'payment-remove-confirm']) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.height, `Dialog-Button ${id}`).toBeGreaterThanOrEqual(44);
      expect(b.y + b.height, `Dialog-Button im Viewport ${id}`).toBeLessThanOrEqual(viewport.height + 1);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('ausgabe-payment-status')).toContainText('Teilbezahlt');
    await removeButton.click();
    await page.getByTestId('payment-remove-confirm').click();
    await expect(page.getByText('Zahlung entfernt.')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('ausgabe-payment-status')).toContainText('Offen');

    /* D — Deep Links */
    await page.goto('/vorgaenge/nicht-vorhanden?vtab=invoices', { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/vtab=invoices$/, { timeout: 30_000 });
    await page.goto(`/ausgaben/${expenseId}?from=overview`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('ausgabe-detail-back')).toHaveAttribute('href', '/ausgaben/offen');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('ausgabe-detail-back')).toHaveAttribute('href', '/ausgaben/offen', { timeout: 30_000 });
    await page.goto('/einstellungen/kommunikation', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-communication-page')).toBeVisible({ timeout: 30_000 });
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/ausgaben/${expenseId}\\?from=overview$`));

    /* E — Formular: fokussiertes Feld sichtbar, Speichern erreichbar */
    await page.goto('/ausgaben/neu', { waitUntil: 'domcontentloaded' });
    const amount = page.getByLabel('Bruttobetrag');
    await amount.scrollIntoViewIfNeeded();
    await amount.focus();
    const box = (await amount.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    const save = page.getByRole('button', { name: 'Ausgabe speichern' });
    await save.scrollIntoViewIfNeeded();
    /* Nutzer scrollt ans Ende: die Aktion muss vollständig über der Bottom-Nav liegen. */
    await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); document.querySelector('.app-shell__main')?.scrollTo(0, 1e6); });
    await page.waitForTimeout(200);
    await expect(save).toBeVisible();
    const saveBox = (await save.boundingBox())!;
    expect(saveBox.height).toBeGreaterThanOrEqual(44);
    if (mobile) {
      const navBox = (await page.getByTestId('bottom-nav').boundingBox())!;
      expect(saveBox.y + saveBox.height, 'Speichern nicht hinter BottomNav').toBeLessThanOrEqual(navBox.y + 1);
    }
  });
});
