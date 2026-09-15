/**
 * PRODUCT-BASIS-FIRMENPROFIL-01C2 — Nummernformat auf dem Zweitgeraet ohne
 * Settings-Besuch (lokale Supabase).
 *
 *  Geraet 1: Format RE/Jahr/4 setzen (Server) -> Geraet 2: frischer Bootstrap,
 *  direkt Rechnung anlegen -> Format-Cache = Serverformat -> Finalisieren ->
 *  Servernummer RE-YYYY-0001. Danach: Geraet 1 aendert den Standard (RG) ->
 *  Geraet 2 nach Sync: Cache traegt Standard RG + eingefrorene Kopie RE; die
 *  naechste Nummer des laufenden Jahres bleibt RE-YYYY-0002.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const ANON_KEY = process.env.E2E_LOCALDB_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';
const YEAR = new Date().getFullYear();

let owner: LocalDbUser;
const company = loadTestWorldOperatorCompany();
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'nf-dev-owner' });
});
test.afterAll(async () => {
  if (owner) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: owner.id });
});

async function login(page: Page, setup: boolean): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-email').fill(owner.email);
  await page.getByTestId('login-password').fill(owner.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-page')).toBeHidden({ timeout: 30_000 });
  const landed = await Promise.race([
    page.getByTestId('app-shell').waitFor({ timeout: 30_000 }).then(() => 'shell' as const),
    page.getByTestId('workspace-setup-continue').waitFor({ timeout: 30_000 }).then(() => 'continue' as const),
    page.getByTestId('setup-companyName').waitFor({ timeout: 30_000 }).then(() => 'wizard' as const),
  ]);
  if (landed === 'shell') return;
  if (!setup) throw new Error(`Unerwarteter Einrichtungsschritt: ${landed}`);
  if (landed === 'continue') await page.getByTestId('workspace-setup-continue').click();
  await page.getByTestId('setup-companyName').fill(company.companyName);
  await page.getByTestId('setup-contactPerson').fill('Nummern Test');
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

async function runSync(page: Page): Promise<void> {
  await page.goto('/synchronisation', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sync-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('sync-run-button').click();
  await expect(page.getByTestId('sync-run-button')).toBeEnabled({ timeout: 60_000 });
  await page.waitForTimeout(800);
}

async function localSequence(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i)!; if (k.startsWith('officepilot-state:workspace:')) return JSON.parse(localStorage.getItem(k)!).invoiceNumberSequence ?? null; }
    return null;
  });
}

async function draftToReview(page: Page, customerName = 'Kunde Zweitgeraet GmbH'): Promise<string> {
  await page.goto('/rechnungen/neu', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('1/4', { timeout: 30_000 });
  await page.getByTestId('customer-decision-new').locator('input').check();
  await page.getByTestId('manual-invoice-customer-name').fill(customerName);
  await page.getByTestId('customer-decision-street').fill('Hauptstraße 12');
  await page.getByTestId('customer-decision-zip').fill('45356');
  await page.getByTestId('customer-decision-city').fill('Essen');
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('2/4');
  await page.getByTestId('manual-position-description').fill('Leistung');
  await page.getByTestId('manual-position-quantity').fill('1');
  await page.getByTestId('manual-position-unit-price').fill('100');
  await page.getByTestId('manual-position-commit').click();
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('3/4');
  await page.getByTestId('invoice-edit-service-from').fill(`${YEAR}-09-01`);
  await page.getByTestId('invoice-edit-service-to').fill(`${YEAR}-09-05`);
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('4/4');
  return (await page.evaluate(() => (document.querySelector('[data-testid="invoice-approve"]') ? 'ready' : 'missing')));
}

async function openSecondDevice(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, false);
  return { context, page };
}

test.describe('FIRMENPROFIL-01C2 — Zweitgeraet-Vorschau (lokal)', () => {
  test('Geraet 1 setzt Format -> Geraet 2 Bootstrap ohne Settings -> Vorschau = Serverformat = finale Nummer', async ({ page, browser }) => {
    test.setTimeout(300_000);
    await login(page, true);
    const { data: members } = await admin().from('workspace_members').select('workspace_id').eq('user_id', owner.id).eq('role', 'owner').limit(1);
    const wsId = members![0].workspace_id as string;

    /* Geraet 1 setzt das Format (Server) */
    await page.goto('/einstellungen/rechnungen', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-invoices-section-number')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('settings-invoices-number-prefix').fill('RE');
    await page.getByTestId('settings-invoices-number-save').click();
    await expect(page.getByTestId('settings-invoices-number-save')).toBeDisabled({ timeout: 15_000 });

    /* Geraet 2: frischer Bootstrap, keine Settings-Seite, direkt Rechnung */
    const device2 = await openSecondDevice(browser);
    try {
      const seq = await localSequence(device2.page);
      expect(seq, 'Format-Cache fehlt nach Bootstrap').toMatchObject({ format: { prefix: 'RE', yearInNumber: true, padding: 4 } });
      // Vorschau-Cache ist gesetzt (der Assistent zeigt bewusst ENTWURF; die Vorschau-Nummer lebt auf der Auftrags-Rechnungsseite)
      await draftToReview(device2.page);
      const button = device2.page.getByTestId('invoice-approve');
      await button.scrollIntoViewIfNeeded();
      await button.click();
      await device2.page.waitForURL(/\/rechnungen\/inv-[^/]+$/, { timeout: 30_000 });
      const invoiceId = new URL(device2.page.url()).pathname.split('/').pop()!;
      const row = await admin().from('workspace_invoices').select('invoice_number').eq('client_invoice_id', invoiceId).single();
      expect(row.data!.invoice_number).toBe(`RE-${YEAR}-0001`);

      /* Geraet 1 aendert den Standard -> gilt ab Folgejahr; Geraet 2 sieht nach Sync die eingefrorene Kopie */
      await page.goto('/einstellungen/rechnungen', { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('settings-invoices-number-locked')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('settings-invoices-number-prefix').fill('RG');
      await page.getByTestId('settings-invoices-number-save').click();
      await expect(page.getByTestId('settings-invoices-number-save')).toBeDisabled({ timeout: 15_000 });
      const fmt = await admin().from('workspace_invoice_number_formats').select('number_prefix').eq('workspace_id', wsId).single();
      expect(fmt.data!.number_prefix).toBe('RG');

      await runSync(device2.page);
      const seq2 = await localSequence(device2.page);
      expect(seq2).toMatchObject({ format: { prefix: 'RG' }, lockedFormat: { prefix: 'RE' } });
      // zweite Rechnung des laufenden Jahres: eingefrorene Kopie (RE) gewinnt ueber den neuen Standard (RG)
      await draftToReview(device2.page, 'Kunde Zweitgeraet Zwei GmbH');
      const button2 = device2.page.getByTestId('invoice-approve');
      await button2.scrollIntoViewIfNeeded();
      await button2.click();
      await device2.page.waitForURL(/\/rechnungen\/inv-[^/]+$/, { timeout: 30_000 });
      const invoiceId2 = new URL(device2.page.url()).pathname.split('/').pop()!;
      const row2 = await admin().from('workspace_invoices').select('invoice_number').eq('client_invoice_id', invoiceId2).single();
      expect(row2.data!.invoice_number).toBe(`RE-${YEAR}-0002`);
      await expect(device2.page.getByText(`RE-${YEAR}-0002`).first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await device2.context.close();
    }
  });
});
