/**
 * INVOICE-SECOND-FINALIZATION-CONFLICT-01A — zwei eigenständige manuelle
 * Rechnungen für denselben Kunden gegen die lokale Supabase-Instanz.
 *
 * Nebenbefund aus CUSTOMER-IDENTITY-DUPLICATE-01A: „Konflikt bei der
 * Rechnungsfreigabe" bei der zweiten Rechnung. App-first reproduziert:
 * Auslöser war nicht der gleiche Kunde, sondern ein inhaltlich **identischer**
 * Entwurf (gleiche Position, Menge, Preis, Leistungszeitraum, Tag) — der
 * lokale Preflight-Guard `possible_existing_invoice` hält eine mutmaßliche
 * Doppelrechnung an, ohne einen Finalize-RPC auszulösen.
 *
 * Dieser Test sichert beide Seiten:
 *  NORMAL   zwei verschiedene Rechnungen für denselben Kunden → beide finalisiert,
 *           eigene invoiceIds und Nummern, Rechnung 1 unverändert.
 *  GUARD    inhaltlich identischer zweiter Entwurf → Konflikthinweis, kein
 *           Finalize-Aufruf, keine dritte Rechnung, Rechnung 1 unverändert.
 * Die echte Request-Idempotenz (derselbe Finalize-Request zweimal) ist in den
 * SQL-/Coordinator-Suiten belegt (manualInvoiceCloudSql01b2b, invoicePreparedFinalize01).
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let user: LocalDbUser;
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'second-inv' });
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
  await page.getByTestId('setup-companyName').fill('Zweitrechnung E2E GmbH');
  await page.getByTestId('setup-contactPerson').fill('Z. Test');
  await page.getByTestId('setup-street').fill('Werkstraße 2');
  await page.getByTestId('setup-zip').fill('54321');
  await page.getByTestId('setup-city').fill('Betriebsstadt');
  await page.getByTestId('setup-email').fill('zweit@example.invalid');
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

interface LocalInvoice { id: string; number: string; status: string; customerId: string | null; amount: number }

async function localInvoices(page: Page): Promise<LocalInvoice[]> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (!key.startsWith('officepilot:state:workspace:') && !key.startsWith('officepilot-state:workspace:')) continue;
      const state = JSON.parse(localStorage.getItem(key)!) as { invoiceEntries?: { invoice: { id: string; number: string; status: string; customerId?: string; amount: number } }[] };
      return (state.invoiceEntries ?? []).map((e) => ({ id: e.invoice.id, number: e.invoice.number, status: e.invoice.status, customerId: e.invoice.customerId ?? null, amount: e.invoice.amount }));
    }
    return [];
  });
}

async function localCustomerId(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (!key.startsWith('officepilot-state:workspace:')) continue;
      const state = JSON.parse(localStorage.getItem(key)!) as { customers?: { id: string }[] };
      return state.customers?.[0]?.id ?? '';
    }
    return '';
  });
}

/** Entwurf bis zur Prüfen-Seite; Kunde neu (erste Rechnung) oder bestehend. */
async function draftUntilReview(page: Page, customer: 'new' | string, position: { description: string; unitPrice: string }): Promise<void> {
  await page.goto('/rechnungen/neu', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('1/4', { timeout: 30_000 });
  if (customer === 'new') {
    await page.getByTestId('customer-decision-new').locator('input').check();
    await page.getByTestId('manual-invoice-customer-name').fill('Kunde A GmbH');
    await page.getByTestId('customer-decision-street').fill('Hauptstraße 12');
    await page.getByTestId('customer-decision-zip').fill('45356');
    await page.getByTestId('customer-decision-city').fill('Essen');
  } else {
    await page.getByTestId('customer-decision-existing').locator('input').check();
    await page.getByTestId(`customer-option-${customer}`).locator('input').check();
  }
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('2/4');
  await page.getByTestId('manual-position-description').fill(position.description);
  await page.getByTestId('manual-position-quantity').fill('1');
  await page.getByTestId('manual-position-unit-price').fill(position.unitPrice);
  await page.getByTestId('manual-position-commit').click();
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('3/4');
  await page.getByTestId('invoice-edit-service-from').fill('2026-09-01');
  await page.getByTestId('invoice-edit-service-to').fill('2026-09-05');
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('4/4');
}

async function approve(page: Page): Promise<{ finalized: boolean; finalizeCalls: number; url: string }> {
  let finalizeCalls = 0;
  const onRequest = (request: { url: () => string; method: () => string }) => {
    if (request.method() === 'POST' && request.url().includes('/rpc/finalize_workspace_invoice')) finalizeCalls += 1;
  };
  page.on('request', onRequest);
  const button = page.getByTestId('invoice-approve');
  await button.scrollIntoViewIfNeeded();
  await button.click();
  const finalized = await page
    .waitForURL(/\/rechnungen\/inv-[^/]+$/, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(1000);
  page.off('request', onRequest);
  return { finalized, finalizeCalls, url: page.url() };
}

test.describe('INVOICE-SECOND-FINALIZATION-CONFLICT-01A — zweite Rechnung für denselben Kunden', () => {
  test('NORMAL: zwei verschiedene Rechnungen → beide finalisiert; GUARD: identischer Entwurf → Konflikthinweis ohne Finalize, Rechnung 1 unverändert', async ({ page }) => {
    test.setTimeout(300_000);
    await loginAndSetup(page);

    /* Rechnung 1 */
    await draftUntilReview(page, 'new', { description: 'Leistung R1', unitPrice: '100' });
    const r1 = await approve(page);
    expect(r1.finalized, 'Rechnung 1 wurde nicht finalisiert').toBe(true);
    expect(r1.finalizeCalls).toBe(1);
    const customerId = await localCustomerId(page);
    expect(customerId).toMatch(/^cust-/);
    const afterR1 = await localInvoices(page);
    expect(afterR1).toHaveLength(1);
    const invoice1 = afterR1[0]!;
    expect(invoice1.customerId).toBe(customerId);
    expect(invoice1.number).toMatch(/^\d{4}-\d{4}$/);

    /* Rechnung 2 — derselbe Kunde, eigener Inhalt */
    await draftUntilReview(page, customerId, { description: 'Leistung R2', unitPrice: '200' });
    const r2 = await approve(page);
    expect(r2.finalized, 'Rechnung 2 für denselben Kunden wurde blockiert').toBe(true);
    expect(r2.finalizeCalls).toBe(1);
    const afterR2 = await localInvoices(page);
    expect(afterR2).toHaveLength(2);
    const invoice2 = afterR2.find((entry) => entry.id !== invoice1.id)!;
    expect(invoice2.customerId).toBe(customerId);
    expect(invoice2.id).not.toBe(invoice1.id);
    expect(invoice2.number).not.toBe(invoice1.number);
    expect(invoice2.number).toMatch(/^\d{4}-\d{4}$/);
    // Rechnung 1 unverändert
    expect(afterR2.find((entry) => entry.id === invoice1.id)).toEqual(invoice1);

    /* Cloud: zwei Zeilen, zwei Nummern, gleicher Kunde, Version 1 (keine Überschreibung) */
    const { data: ws } = await admin().from('workspace_members').select('workspace_id').eq('user_id', user.id).limit(1);
    const wsId = ws?.[0]?.workspace_id as string;
    const cloud = await admin().from('workspace_invoices').select('client_invoice_id,invoice_number,row_version,payload').eq('workspace_id', wsId);
    const rows = (cloud.data ?? []) as { client_invoice_id: string; invoice_number: string; row_version: number; payload: { customerId?: string } }[];
    expect(rows.map((row) => row.client_invoice_id).sort()).toEqual([invoice1.id, invoice2.id].sort());
    expect(new Set(rows.map((row) => row.invoice_number)).size).toBe(2);
    expect(rows.every((row) => row.payload.customerId === customerId)).toBe(true);
    expect(rows.find((row) => row.client_invoice_id === invoice1.id)?.row_version).toBe(1);

    /* GUARD: inhaltlich identischer Entwurf zu Rechnung 2 → angehalten, kein Finalize-Aufruf, keine dritte Rechnung */
    await draftUntilReview(page, customerId, { description: 'Leistung R2', unitPrice: '200' });
    const r3 = await approve(page);
    expect(r3.finalized).toBe(false);
    expect(r3.finalizeCalls, 'Doppelrechnung erreichte den Server').toBe(0);
    await expect(page.getByText('Konflikt bei der Rechnungsfreigabe. Bitte Entwurf prüfen.')).toBeVisible();
    expect(await localInvoices(page)).toHaveLength(2);
    const cloudAfterGuard = await admin().from('workspace_invoices').select('client_invoice_id', { count: 'exact', head: true }).eq('workspace_id', wsId);
    expect(cloudAfterGuard.count).toBe(2);
  });
});
