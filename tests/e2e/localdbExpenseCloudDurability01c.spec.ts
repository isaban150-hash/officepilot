/**
 * FINANZ-CORE-DURABILITY-01C — Ausgaben in die Cloud (Desktop, lokale Supabase).
 *
 *  X1  Owner legt eine Ausgabe an -> Sync -> Zeile in workspace_expenses, Version lokal gesetzt
 *  X2  Zahlung buchen -> Sync -> Zeile in workspace_expense_payments; zweiter Sync ohne Duplikat,
 *      kein Beleg-Push durch die Zahlung
 *  X3  Geraet 2 (zweiter Browser-Kontext) sieht Ausgabe, Zahlung und abgeleiteten Zahlstatus
 *  X4  Zahlung auf Geraet 1 entfernen -> Sync -> Reversal (Grabstein); Geraet 2 verliert sie nach Pull
 *  X5  Beleg mit gebuchter Zahlung ist nicht loeschbar (UI-Regel = Cloud-Regel)
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let owner: LocalDbUser;
const company = loadTestWorldOperatorCompany();
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'exp-dur-owner' });
});
test.afterAll(async () => {
  if (owner) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: owner.id });
});

async function login(page: Page, user: LocalDbUser, setup: boolean): Promise<void> {
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
  if (!setup) throw new Error(`Unerwarteter Einrichtungsschritt fuer ${user.email}: ${landed}`);
  if (landed === 'continue') await page.getByTestId('workspace-setup-continue').click();
  await page.getByTestId('setup-companyName').fill(company.companyName);
  await page.getByTestId('setup-contactPerson').fill('Durability Test');
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

/** Sync ueber die Synchronisationsseite (sichtbarer Nutzerweg). */
async function runSync(page: Page): Promise<void> {
  await page.goto('/synchronisation', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sync-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('sync-run-button').click();
  await expect(page.getByTestId('sync-run-button')).toBeEnabled({ timeout: 60_000 });
  await page.waitForTimeout(800);
}

interface LocalExpense { id: string; title: string; paymentStatus: string; payments: { id: string; amount: number }[]; syncVersion?: number; deleted?: boolean }
async function localExpenses(page: Page): Promise<LocalExpense[]> {
  const raw = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (key.startsWith('officepilot-state:workspace:')) return localStorage.getItem(key);
    }
    return null;
  });
  const s = raw ? (JSON.parse(raw) as { expenses?: Array<Record<string, any>> }) : {};
  return (s.expenses ?? []).map((x) => ({
    id: x.id, title: x.title, paymentStatus: x.paymentStatus,
    payments: (x.payments ?? []).map((p: Record<string, any>) => ({ id: p.id, amount: p.amount })),
    syncVersion: x.sync?.version, deleted: x.sync?.deleted,
  }));
}

async function cloudExpenses(wsId: string) {
  const a = admin();
  const expenses = await a.from('workspace_expenses').select('client_expense_id,status,row_version,deleted,payload').eq('workspace_id', wsId);
  const payments = await a.from('workspace_expense_payments').select('client_expense_id,client_payment_id,amount,reversed_at').eq('workspace_id', wsId);
  return { expenses: expenses.data ?? [], payments: payments.data ?? [] };
}

async function workspaceIdOf(userId: string): Promise<string> {
  const { data } = await admin().from('workspace_members').select('workspace_id,role').eq('user_id', userId).eq('role', 'owner').limit(1);
  const id = data?.[0]?.workspace_id as string | undefined;
  if (!id) throw new Error('Workspace nicht gefunden');
  return id;
}

async function openSecondDevice(browser: Browser, user: LocalDbUser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, user, false);
  return { context, page };
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
  await page.getByRole('button', { name: 'Zahlung erfassen' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Zahlungsdatum').fill('2026-09-05');
  await dialog.getByLabel('Betrag').fill(amount);
  await dialog.getByRole('button', { name: 'Zahlung speichern' }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

test.describe('FINANZ-CORE-DURABILITY-01C (lokal)', () => {
  test('X1–X5: Ausgabe -> Cloud -> Geraet 2; Zahlung append-only; Reversal; Loeschsperre', async ({ page, browser }) => {
    test.setTimeout(300_000);
    await login(page, owner, true);
    const wsId = await workspaceIdOf(owner.id);

    /* X1 — Ausgabe anlegen und sichern */
    const expenseId = await createExpense(page, 'Dachlatten Lieferung');
    await runSync(page);
    const cloud1 = await cloudExpenses(wsId);
    const row1 = cloud1.expenses.find((e) => e.client_expense_id === expenseId);
    expect(row1, 'Ausgabe fehlt in der Cloud').toBeTruthy();
    expect(row1!.status).toBe('gebucht');
    expect((row1!.payload as Record<string, unknown>).payments).toBeUndefined();
    const local1 = (await localExpenses(page)).find((e) => e.id === expenseId)!;
    expect(local1.syncVersion).toBe(1);
    // Demo-Ausgaben bleiben lokal
    expect(cloud1.expenses.some((e) => /^exp-\d{3}$/.test(e.client_expense_id))).toBe(false);

    /* X2 — Zahlung buchen, zweimal syncen: kein Duplikat, kein Beleg-Push durch die Zahlung */
    await recordPayment(page, expenseId, '50');
    await runSync(page);
    await runSync(page);
    const cloud2 = await cloudExpenses(wsId);
    const pays = cloud2.payments.filter((p) => p.client_expense_id === expenseId);
    expect(pays).toHaveLength(1);
    expect(Number(pays[0].amount)).toBe(50);
    expect(pays[0].reversed_at).toBeNull();
    expect(cloud2.expenses.find((e) => e.client_expense_id === expenseId)!.row_version).toBe(1);
    const paymentId = pays[0].client_payment_id as string;
    expect((await localExpenses(page)).find((e) => e.id === expenseId)!.paymentStatus).toBe('teilbezahlt');

    /* X3 — Geraet 2 */
    const device2 = await openSecondDevice(browser, owner);
    try {
      await device2.page.goto(`/ausgaben/${expenseId}`, { waitUntil: 'domcontentloaded' });
      await expect(device2.page.getByRole('heading', { name: 'Dachlatten Lieferung' })).toBeVisible({ timeout: 30_000 });
      const local2 = (await localExpenses(device2.page)).find((e) => e.id === expenseId)!;
      expect(local2.payments.map((p) => p.id)).toEqual([paymentId]);
      expect(local2.paymentStatus).toBe('teilbezahlt');
      expect(local2.syncVersion).toBe(1);

      /* X5 — Loeschsperre mit gebuchter Zahlung (UI-Regel = Cloud-Regel) */
      await device2.page.getByRole('button', { name: 'Löschen', exact: true }).click();
      await device2.page.getByRole('button', { name: 'Endgültig löschen' }).click();
      await expect(device2.page.getByText('gebuchte Zahlungen')).toBeVisible({ timeout: 10_000 });
      expect((await localExpenses(device2.page)).find((e) => e.id === expenseId)!.deleted).toBeFalsy();

      /* X4 — Reversal auf Geraet 1, Pull auf Geraet 2 */
      await page.goto(`/ausgaben/${expenseId}`, { waitUntil: 'domcontentloaded' });
      /* UIUX-01G — Confirm-first im kanonischen Dialog. */
      await page.getByRole('button', { name: 'Entfernen' }).first().click();
      await page.getByTestId('payment-remove-confirm').click();
      await expect(page.getByText('Zahlung entfernt.')).toBeVisible({ timeout: 10_000 });
      await runSync(page);
      const cloud4 = await cloudExpenses(wsId);
      const reversed = cloud4.payments.find((p) => p.client_payment_id === paymentId)!;
      expect(reversed.reversed_at).toBeTruthy();
      expect(cloud4.payments.filter((p) => p.client_expense_id === expenseId)).toHaveLength(1);

      await runSync(device2.page);
      const local2b = (await localExpenses(device2.page)).find((e) => e.id === expenseId)!;
      expect(local2b.payments).toEqual([]);
      expect(local2b.paymentStatus).toBe('offen');
    } finally {
      await device2.context.close();
    }
  });
});
