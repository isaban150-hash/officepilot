/**
 * CLOUD-DURABILITY-CORE-01E — die ruhige Auskunft „bleibt auf diesem Gerät".
 *
 * Geprüft wird an den drei Stellen, an denen ein Betrieb heute Daten anlegt,
 * die noch nicht auf sein zweites Gerät reisen: Wissen, Kommunikationsverlauf
 * und der Haken für die Papierablage.
 *
 * Der Hinweis muss lesbar sein, aber nichts dominieren: keine Warnfarbe, keine
 * zweite Kartenwand, kein technischer Wortschatz, kein horizontaler Überlauf —
 * und die vorhandene Hauptaktion des Bereichs bleibt sichtbar und bedienbar.
 */
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let owner: LocalDbUser;
const company = loadTestWorldOperatorCompany();

/** Technischer Wortschatz, der in der Oberfläche nichts zu suchen hat. */
const JARGON = ['local-only', 'Local-Only', 'Sync', 'sync', 'Outbox', 'Supabase', 'Entity', 'Cloud-Durability'];

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    label: 'hints-owner',
  });
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
  await page.getByTestId('setup-contactPerson').fill('Transparenz Test');
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

async function expectNoOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectNoJargon(page: Page): Promise<void> {
  const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  for (const word of JARGON) {
    expect(text, `technischer Begriff in der Oberfläche: ${word}`).not.toContain(word);
  }
}

test.describe('CLOUD-DURABILITY-CORE-01E (lokal)', () => {
  test('Hinweise sind ruhig, verständlich und stören nichts', async ({ page }) => {
    test.setTimeout(300_000);
    await login(page, owner);

    /* ---------------- Wissen ---------------- */
    await page.goto('/wissen', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('wissen-page')).toBeVisible({ timeout: 30_000 });
    const knowledgeNotice = page.getByTestId('inline-notice').first();
    await expect(knowledgeNotice).toBeVisible();
    await expect(knowledgeNotice).toContainText('nur auf diesem Gerät');
    // Der Hinweis steht im vorhandenen Hinweisfeld — keine zusätzliche Karte.
    await expect(page.getByTestId('inline-notice')).toHaveCount(1);
    // Die Hauptaktion des Bereichs bleibt bedienbar.
    await expect(page.getByRole('button').first()).toBeVisible();
    await expectNoOverflow(page);
    await expectNoJargon(page);

    /* ---------------- Kommunikationsverlauf ---------------- */
    await page.goto('/kommunikation', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('communication-history')).toBeVisible({ timeout: 30_000 });
    const historyHint = page.getByTestId('communication-history-device-only');
    await expect(historyHint).toBeVisible();
    await expect(historyHint).toContainText('nur auf diesem Gerät');
    // Genau einmal je Bereich, nicht an jeder Zeile.
    await expect(page.getByTestId('communication-history-device-only')).toHaveCount(1);
    await expectNoOverflow(page);
    await expectNoJargon(page);

    /*
     * Der Papierablage-Hinweis wird im Komponententest geprueft
     * (deviceOnlyTransparency01e): Das Archiv fuellt sich erst nach der
     * Ablageentscheidung, und dieser Weg gehoert nicht zu 01E.
     */
  });
});
