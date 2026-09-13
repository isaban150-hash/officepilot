/**
 * CUSTOMER-IDENTITY-DUPLICATE-01A — Kundendubletten bei der Neuanlage
 * (confirm-first, kein Merge) über echte Bedienwege gegen die lokale
 * Supabase-Instanz.
 *
 * Vor dem Fix: „Westfalen Projektbau GmbH, Industriestraße 27, 33689 Bielefeld"
 * ließ sich über die manuelle Rechnung ohne Warnung ein zweites Mal anlegen
 * (auch als „westfalen projektbau gmbh "), und die Kundenwahl zeigte zwei
 * ununterscheidbare Einträge.
 *
 * Test 1 (manuelle Rechnung): Warnung, „Vorhandenen verwenden" ohne zweiten
 * Datensatz mit bestehender ID, „Trotzdem neu anlegen" bewusst möglich,
 * gleichnamige Kunden danach unterscheidbar; mobil erreichbar, kein Überlauf.
 * Test 2 (Vertragsflow DOC-00001): bestehender Kunde wird beim „Neuer Kunde"
 * erkannt, „Vorhandenen verwenden" → Vorgang mit bestehender Kunden-ID.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';
import { uploadDoc00001ToAnalyzedDetail } from './support/localDoc00001Flow';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let user: LocalDbUser;
const company = loadTestWorldOperatorCompany();
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'cust-dup' });
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
  await page.getByTestId('setup-companyName').fill(company.companyName);
  await page.getByTestId('setup-contactPerson').fill('Dubletten Test');
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

interface CustomerInputUi { name: string; street?: string; zip?: string; city?: string }

async function fillNewCustomer(page: Page, input: CustomerInputUi): Promise<void> {
  await page.goto('/rechnungen/neu', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('1/4', { timeout: 30_000 });
  await page.getByTestId('customer-decision-new').locator('input').check();
  await page.getByTestId('manual-invoice-customer-name').fill(input.name);
  if (input.street) await page.getByTestId('customer-decision-street').fill(input.street);
  if (input.zip) await page.getByTestId('customer-decision-zip').fill(input.zip);
  if (input.city) await page.getByTestId('customer-decision-city').fill(input.city);
}

async function finishInvoice(page: Page): Promise<void> {
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('2/4');
  await page.getByTestId('manual-position-description').fill('Anfahrt');
  await page.getByTestId('manual-position-quantity').fill('1');
  await page.getByTestId('manual-position-unit-price').fill('45');
  await page.getByTestId('manual-position-commit').click();
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('3/4');
  await page.getByTestId('invoice-edit-service-from').fill('2026-09-01');
  await page.getByTestId('invoice-edit-service-to').fill('2026-09-05');
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('4/4');
  const approve = page.getByTestId('invoice-approve');
  await approve.scrollIntoViewIfNeeded();
  await approve.click();
  await expect(page).toHaveURL(/\/rechnungen\/inv-[^/]+$/, { timeout: 45_000 });
  await page.waitForTimeout(800);
}

async function localCustomers(page: Page): Promise<{ id: string; name: string }[]> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (!key.startsWith('officepilot-state:workspace:')) continue;
      const state = JSON.parse(localStorage.getItem(key)!) as { customers?: { id: string; name: string }[] };
      return (state.customers ?? []).map((c) => ({ id: c.id, name: c.name }));
    }
    return [];
  });
}

async function expectReachable(page: Page, testId: string): Promise<void> {
  const action = page.getByTestId(testId);
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeVisible();
  const box = await action.boundingBox();
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  const nav = page.locator('.bottom-nav');
  if (await nav.isVisible().catch(() => false)) {
    const navBox = await nav.boundingBox();
    expect(box!.y + box!.height, `${testId} liegt unter der Bottom-Nav`).toBeLessThanOrEqual(navBox!.y + 0.5);
  }
}

async function expectNoOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontaler Überlauf: ${label}`).toBeLessThanOrEqual(1);
}

test.describe('CUSTOMER-IDENTITY-DUPLICATE-01A (lokal)', () => {
  test('manuelle Rechnung: Warnung, vorhandenen verwenden, bewusst trotzdem anlegen, gleichnamige unterscheidbar', async ({ page }) => {
    test.setTimeout(300_000);
    await loginAndSetup(page);

    /* 1. Kunde existiert bereits */
    await fillNewCustomer(page, { name: 'Westfalen Projektbau GmbH', street: 'Industriestraße 27', zip: '33689', city: 'Bielefeld' });
    await page.getByTestId('manual-invoice-next').click();
    await finishInvoice(page);
    const first = await localCustomers(page);
    expect(first).toHaveLength(1);
    const existingId = first[0]!.id;

    /* 2./3. dieselben Daten erneut → Warnung statt stiller Neuanlage */
    await fillNewCustomer(page, { name: 'westfalen projektbau gmbh ', street: 'Industriestr. 27', zip: '33689', city: 'bielefeld' });
    await page.getByTestId('manual-invoice-next').click();
    const decision = page.getByTestId('customer-duplicate-decision');
    await expect(decision).toBeVisible();
    await expect(decision).toContainText('Kunde existiert möglicherweise bereits');
    await expect(decision).toContainText('Westfalen Projektbau GmbH');
    await expect(decision).toContainText('Industriestraße 27, 33689 Bielefeld');
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('1/4');
    expect(await localCustomers(page)).toHaveLength(1);
    // Ein erneuter normaler „Weiter"-Klick legt nichts an — nur die bewusste Aktion.
    await page.getByTestId('manual-invoice-next').click();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('1/4');
    expect(await localCustomers(page)).toHaveLength(1);
    await expectReachable(page, `customer-duplicate-use-existing-${existingId}`);
    await expectReachable(page, 'customer-duplicate-create-anyway');
    await expectNoOverflow(page, 'Dubletten-Entscheidung');

    /* 4. Vorhandenen verwenden → bestehende ID, kein zweiter Kunde */
    await page.getByTestId(`customer-duplicate-use-existing-${existingId}`).click();
    await expect(page.getByTestId('customer-duplicate-decision')).toHaveCount(0);
    await expect(page.getByTestId(`customer-option-${existingId}`).locator('input')).toBeChecked();
    await page.getByTestId('manual-invoice-next').click();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('2/4');
    expect(await localCustomers(page)).toHaveLength(1);
    const draftCustomerId = await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)!;
        const raw = localStorage.getItem(key)!;
        if (!raw.includes('"customerId"')) continue;
        const match = raw.match(/"customerId":"(cust-[0-9a-f-]{36})"/);
        if (match) return match[1];
      }
      return null;
    });
    expect(draftCustomerId).toBe(existingId);

    /* 5. Trotzdem neu anlegen → bewusst zweiter Datensatz (im selben Entwurf: Kunde ändern) */
    await page.getByTestId('manual-invoice-stepper-customer').click();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('1/4');
    await page.getByTestId('manual-invoice-customer-change').click();
    await page.getByTestId('customer-decision-new').locator('input').check();
    await page.getByTestId('manual-invoice-customer-name').fill('Westfalen Projektbau GmbH');
    await page.getByTestId('customer-decision-street').fill('Industriestraße 27');
    await page.getByTestId('customer-decision-zip').fill('33689');
    await page.getByTestId('customer-decision-city').fill('Bielefeld');
    await page.getByTestId('manual-invoice-next').click();
    await expect(page.getByTestId('customer-duplicate-decision')).toBeVisible();
    expect(await localCustomers(page)).toHaveLength(1);
    await page.getByTestId('customer-duplicate-create-anyway').click();
    await expect(page.getByTestId('manual-invoice-progress')).toHaveText('2/4');
    const afterAnyway = await localCustomers(page);
    expect(afterAnyway).toHaveLength(2);
    expect(afterAnyway.map((c) => c.id)).toContain(existingId);

    /* 6. gleichnamige Kunden sind in der Auswahl unterscheidbar */
    await page.getByTestId('manual-invoice-stepper-customer').click();
    await page.getByTestId('manual-invoice-customer-change').click();
    await page.getByTestId('customer-decision-existing').locator('input').check();
    const options = page.locator('[data-testid^="customer-option-cust-"]');
    await expect(options).toHaveCount(2);
    const texts = await options.allTextContents();
    expect(texts[0]).not.toBe(texts[1]);
    await expect(page.locator('[data-testid^="customer-distinguisher-"]')).toHaveCount(2);
    for (const text of texts) expect(text).not.toMatch(/cust-[0-9a-f-]{36}/);
    await expectNoOverflow(page, 'Kundenauswahl');

    /* Cloud: zwei getrennte Zeilen, keine ID umgeschrieben (nach Bootstrap-Sync). */
    await page.goto('/kunden', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('kunden-page')).toBeVisible({ timeout: 30_000 });
    const { data: ws } = await admin().from('workspace_members').select('workspace_id').eq('user_id', user.id).limit(1);
    const wsId = ws?.[0]?.workspace_id as string;
    await expect.poll(async () => (await admin().from('workspace_customers').select('customer_id').eq('workspace_id', wsId)).data?.length ?? 0, { timeout: 60_000 }).toBe(2);
  });

  test('Vertragsflow: vorhandener Kunde wird bei „Neuer Kunde" erkannt; „Vorhandenen verwenden" nutzt die bestehende ID', async ({ page }) => {
    test.setTimeout(300_000);
    await loginAndSetup(page);

    // Bestehender Kunde mit dem Namen der Vertragsgegenpartei (Anschrift aus der Erkennung liegt nicht vor → unsicherer Kandidat).
    await fillNewCustomer(page, { name: 'Sägewerk Ernst Flisch GmbH', street: 'Sägewerkstraße 1', zip: '32657', city: 'Lemgo' });
    await page.getByTestId('manual-invoice-next').click();
    await finishInvoice(page);
    // Derselbe Testnutzer wie in Test 1 — deshalb nach Namen zaehlen, nicht global.
    const saegewerk = async () => (await localCustomers(page)).filter((c) => c.name === 'Sägewerk Ernst Flisch GmbH');
    const existing = (await saegewerk())[0];
    expect(existing).toBeDefined();

    await uploadDoc00001ToAnalyzedDetail(page);
    await expect(page.getByTestId('contract-customer-decision')).toBeVisible();
    await page.getByTestId('customer-decision-new').locator('input').check();
    const primary = page.getByTestId('contract-chef-primary-action');
    await primary.scrollIntoViewIfNeeded();
    await expect(primary).toBeEnabled();
    await primary.click();

    const decision = page.getByTestId('customer-duplicate-decision');
    await expect(decision).toBeVisible({ timeout: 30_000 });
    await expect(decision).toContainText('Sägewerk Ernst Flisch GmbH');
    expect(await saegewerk()).toHaveLength(1);
    await expect(page.getByTestId('vorgang-detail-page')).toHaveCount(0);
    await expectReachable(page, `customer-duplicate-use-existing-${existing!.id}`);
    await expectReachable(page, 'customer-duplicate-create-anyway');
    await expectNoOverflow(page, 'Vertrag Dubletten-Entscheidung');

    await page.getByTestId(`customer-duplicate-use-existing-${existing!.id}`).click();
    await expect(page.getByTestId(`customer-option-${existing!.id}`).locator('input')).toBeChecked();
    await expect(primary).toBeEnabled();
    await primary.click();
    await expect(page.getByTestId('vorgang-detail-page')).toBeVisible({ timeout: 45_000 });
    expect(await saegewerk()).toHaveLength(1);
    const vorgangCustomerIds = await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)!;
        if (!key.startsWith('officepilot-state:workspace:')) continue;
        const state = JSON.parse(localStorage.getItem(key)!) as { vorgaenge?: { customerId?: string }[] };
        return (state.vorgaenge ?? []).map((v) => v.customerId ?? null);
      }
      return [];
    });
    expect(vorgangCustomerIds).toEqual([existing!.id]);
  });
});
