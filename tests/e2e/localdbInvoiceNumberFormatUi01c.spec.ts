/**
 * PRODUCT-BASIS-FIRMENPROFIL-01C — Nummernformat ueber die Oberflaeche (lokale Supabase).
 *
 *  A  Rechnungen & Zahlungen -> Rechnungsnummer: RE, Jahr, 4 Stellen; Vorschau RE-YYYY-0001
 *  B/K Rechnung finalisieren -> Server vergibt RE-YYYY-0001; Detail und Cloud-Zeile tragen sie
 *  E  danach: Abschnitt gesperrt, Hinweis sichtbar, Felder nicht editierbar
 *  M  Steuerberater-Monatsmappe exportiert die Rechnung mit exakt dieser Nummer (PDF-Datei)
 */
import JSZip from 'jszip';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';
const YEAR = new Date().getFullYear();

let owner: LocalDbUser;
const company = loadTestWorldOperatorCompany();
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'nf-ui-owner' });
});
test.afterAll(async () => {
  if (owner) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: owner.id });
});

async function loginAndSetup(page: Page): Promise<void> {
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

async function createFinalizedInvoice(page: Page): Promise<string> {
  await page.goto('/rechnungen/neu', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('1/4', { timeout: 30_000 });
  await page.getByTestId('customer-decision-new').locator('input').check();
  await page.getByTestId('manual-invoice-customer-name').fill('Kunde Nummernformat GmbH');
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
  const button = page.getByTestId('invoice-approve');
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await page.waitForURL(/\/rechnungen\/inv-[^/]+$/, { timeout: 30_000 });
  await page.waitForTimeout(800);
  return new URL(page.url()).pathname.split('/').pop()!;
}

test.describe('FIRMENPROFIL-01C — Nummernformat UI (lokal)', () => {
  test('A/B/E/K/M: Format setzen -> finalisieren -> RE-YYYY-0001 -> Sperre -> Monatsmappe', async ({ page }) => {
    test.setTimeout(300_000);
    await loginAndSetup(page);

    /* A — Format setzen */
    await page.goto('/einstellungen/rechnungen', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-invoices-section-number')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('settings-invoices-number-locked')).toHaveCount(0);
    await page.getByTestId('settings-invoices-number-prefix').fill('re');
    await expect(page.getByTestId('settings-invoices-number-preview')).toContainText(`RE-${YEAR}-0001`);
    await page.getByTestId('settings-invoices-number-save').click();
    await expect(page.getByTestId('settings-invoices-number-save')).toBeDisabled({ timeout: 15_000 });
    const { data: members } = await admin().from('workspace_members').select('workspace_id').eq('user_id', owner.id).eq('role', 'owner').limit(1);
    const wsId = members![0].workspace_id as string;
    const fmt = await admin().from('workspace_invoice_number_formats').select('number_prefix,year_in_number,number_padding').eq('workspace_id', wsId).single();
    expect(fmt.data).toEqual({ number_prefix: 'RE', year_in_number: true, number_padding: 4 });

    /* B/K — Server vergibt die Nummer im Format */
    const invoiceId = await createFinalizedInvoice(page);
    await expect(page.getByText(`RE-${YEAR}-0001`).first()).toBeVisible({ timeout: 15_000 });
    const row = await admin().from('workspace_invoices').select('invoice_number,payload').eq('client_invoice_id', invoiceId).single();
    expect(row.data!.invoice_number).toBe(`RE-${YEAR}-0001`);
    expect((row.data!.payload as { number: string }).number).toBe(`RE-${YEAR}-0001`);

    /* E (01C2) — laufendes Jahr eingefroren; Standard bleibt aenderbar und gilt ab dem Folgejahr */
    await page.goto('/einstellungen/rechnungen', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-invoices-number-locked')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('settings-invoices-number-locked')).toContainText(String(YEAR));
    await expect(page.getByTestId('settings-invoices-number-locked')).toContainText(String(YEAR + 1));
    await expect(page.getByTestId('settings-invoices-number-locked-years')).toContainText(`RE-${YEAR}-0001`);
    await expect(page.getByTestId('settings-invoices-number-preview')).toContainText(`RE-${YEAR + 1}-0001`);
    await page.getByTestId('settings-invoices-number-prefix').fill('RG');
    await expect(page.getByTestId('settings-invoices-number-preview')).toContainText(`RG-${YEAR + 1}-0001`);
    await page.getByTestId('settings-invoices-number-save').click();
    await expect(page.getByTestId('settings-invoices-number-save')).toBeDisabled({ timeout: 15_000 });
    const seqRow = await admin().from('workspace_invoice_sequences').select('number_prefix').eq('workspace_id', wsId).eq('invoice_year', YEAR).single();
    expect(seqRow.data!.number_prefix).toBe('RE'); // eingefrorene Kopie unberuehrt
    // Lokaler Cache: Standard RG, eingefrorene Kopie RE fuer das laufende Jahr
    const cache = await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i)!; if (k.startsWith('officepilot-state:workspace:')) return JSON.parse(localStorage.getItem(k)!).invoiceNumberSequence; }
      return null;
    });
    expect(cache).toMatchObject({ format: { prefix: 'RG' }, lockedFormat: { prefix: 'RE' } });

    /* M — Monatsmappe mit exakt dieser Nummer */
    await page.goto('/steuerberater', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('steuerberater-month-input').selectOption(`${YEAR}-${String(new Date().getMonth() + 1).padStart(2, '0')}`);
    await page.getByTestId('steuerberater-prepare-folder').click();
    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByTestId('steuerberater-export-button').click();
    const download = await downloadPromise;
    const zip = await JSZip.loadAsync(await (await import('node:fs/promises')).readFile((await download.path())!));
    const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
    expect(paths.some((p) => p.includes(`/Ausgangsrechnungen/RE-${YEAR}-0001_`) && p.endsWith('.pdf'))).toBe(true);
    const csv = await zip.file(paths.find((p) => p.endsWith('Uebersicht.csv'))!)!.async('string');
    expect(csv).toContain(`Ausgangsrechnung;${invoiceId};RE-${YEAR}-0001;`);
  });
});
