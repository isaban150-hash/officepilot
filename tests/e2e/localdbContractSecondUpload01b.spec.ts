/**
 * INBOX-CONTRACT-SECOND-UPLOAD-01B — derselbe Werkvertrag ein zweites Mal,
 * über den echten Bedienweg gegen die lokale Supabase-Instanz.
 *
 * 1. Testfirma (Betreiber der Testwelt), erster Werkvertrag hochladen,
 *    analysieren, als Auftrag erfassen → bestehender Vorgang.
 * 2. Denselben Vertrag erneut hochladen, Dublettenentscheidung bewusst
 *    „Als weiteren Eintrag speichern", zweiten Eintrag öffnen.
 * 3. Beweis: bestehender Vorgang erkannt, kein „Als Auftrag erfassen", keine
 *    Kundenentscheidung, „Vorgang öffnen" sichtbar/erreichbar und führt exakt
 *    zum bestehenden Vorgang; kein zweiter Vorgang, kein zweiter Kunde, kein
 *    Nachtrag, kein Grund „gleicher Lieferant".
 *
 * Vor dem Fix erzeugte derselbe Ablauf lokal einen zweiten Vorgang und einen
 * zweiten Kunden (Toast „Auftrag angelegt – 0 Positionen übernommen").
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';
import { uploadDoc00001ToAnalyzedDetail } from './support/localDoc00001Flow';
import { acceptContractOrderThroughUi } from './support/localDoc00001VorgangFlow';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';
const DOC_00001_PDF = 'test-world/documents/DOC-00001/source.pdf';
const ACCEPT_LABEL = 'Als Auftrag erfassen';
const OPEN_CASE_LABEL = 'Vorgang öffnen';

let user: LocalDbUser;
const company = loadTestWorldOperatorCompany();
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'contract-2nd' });
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
  await page.getByTestId('setup-contactPerson').fill('Zweitvertrag Test');
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

/**
 * Zweiter Upload desselben Dokuments: die Ablage erkennt eine mögliche
 * Dublette; bewusst „Als weiteren Eintrag speichern" — ein eigener Inbox-Eintrag.
 */
async function uploadDoc00001AgainAsNewEntry(page: Page): Promise<void> {
  await page.goto('/dokumente/upload', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('document-upload-page')).toBeVisible();
  await page.getByTestId('document-upload-input').setInputFiles(DOC_00001_PDF);
  await expect(page.getByTestId('ocr-preview-panel')).toBeVisible();
  await expect(page.getByTestId('ocr-confirm-error')).toHaveCount(0);
  await expect(page.getByTestId('ocr-storage-decision-actions')).toBeVisible();
  await expect(page.getByTestId('storage-decision-save-duplicate-anyway')).toBeVisible();
  await page.getByTestId('storage-decision-save-duplicate-anyway').click();
  await expect(page.getByTestId('ablage-detail-page')).toBeVisible();
  await expect(page.getByTestId('eingang-detail-analysis-error')).toHaveCount(0);
  await expect(page.getByTestId('eingang-detail-analysis-loading')).toHaveCount(0);
  await expect(page.getByTestId('eingang-detail-analysis-pending')).toHaveCount(0);
  await expect(page.getByTestId('eingang-assist-flow')).toBeVisible();
}

async function workspaceIdOf(): Promise<string> {
  const { data } = await admin().from('workspace_members').select('workspace_id').eq('user_id', user.id).limit(1);
  const id = data?.[0]?.workspace_id as string | undefined;
  if (!id) throw new Error('Workspace nicht gefunden');
  return id;
}

async function cloudCounts(wsId: string): Promise<{ vorgaenge: string[]; customers: string[]; amendments: number }> {
  const v = await admin().from('workspace_vorgaenge').select('vorgang_id').eq('workspace_id', wsId);
  const c = await admin().from('workspace_customers').select('customer_id').eq('workspace_id', wsId);
  const a = await admin().from('workspace_order_amendments').select('id', { count: 'exact', head: true }).eq('workspace_id', wsId);
  return {
    vorgaenge: (v.data ?? []).map((r) => r.vorgang_id as string),
    customers: (c.data ?? []).map((r) => r.customer_id as string),
    amendments: a.count ?? 0,
  };
}

/** Lokaler Bestand (Workspace-State): Vorgänge und Kunden mit IDs. */
async function localCounts(page: Page): Promise<{ vorgaenge: string[]; customers: string[] }> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (!key.startsWith('officepilot-state:workspace:')) continue;
      const state = JSON.parse(localStorage.getItem(key)!) as { vorgaenge?: { id: string }[]; customers?: { id: string }[] };
      return { vorgaenge: (state.vorgaenge ?? []).map((v) => v.id), customers: (state.customers ?? []).map((c) => c.id) };
    }
    return { vorgaenge: [], customers: [] };
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

test.describe('INBOX-CONTRACT-SECOND-UPLOAD-01B — zweiter identischer Werkvertrag (lokal)', () => {
  test('bestehender Vertragsvorgang wird weiterverwendet: kein „Als Auftrag erfassen", „Vorgang öffnen" führt zum bestehenden Vorgang', async ({ page }) => {
    test.setTimeout(300_000);
    await loginAndSetup(page);

    /* A. erster Werkvertrag → bestehender Vorgang */
    await uploadDoc00001ToAnalyzedDetail(page);
    await acceptContractOrderThroughUi(page);
    await expect(page.getByTestId('vorgang-detail-page')).toBeVisible();
    const vorgangId = new URL(page.url()).pathname.split('/').pop()!;
    expect(vorgangId).toMatch(/^v-/);
    // Sync fachlich abwarten: Die Outbox wird beim Workspace-Bootstrap (Seitenaufbau) gepusht —
    // wie beim Nutzer, der die App neu oeffnet. Vorgang und Kunde muessen danach in der Cloud sein.
    await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    const wsId = await workspaceIdOf();
    await expect.poll(async () => (await cloudCounts(wsId)).vorgaenge, { timeout: 60_000 }).toEqual([vorgangId]);
    await expect.poll(async () => (await cloudCounts(wsId)).customers.length, { timeout: 60_000 }).toBe(1);
    const before = await cloudCounts(wsId);
    const localBefore = await localCounts(page);
    expect(localBefore.vorgaenge).toEqual([vorgangId]);
    expect(localBefore.customers).toHaveLength(1);

    /* B. derselbe Vertrag erneut, als eigener Eintrag */
    await uploadDoc00001AgainAsNewEntry(page);
    const secondItemId = new URL(page.url()).pathname.split('/').pop()!;
    expect(secondItemId).toMatch(/^inbox-/);

    /* Beweis auf der Detailseite */
    const match = page.getByTestId('document-case-match').first();
    await expect(match).toBeVisible({ timeout: 30_000 });
    await expect(match).toHaveAttribute('data-match-status', 'exact');
    await expect(match).toContainText('Sägewerk Ernst Flisch – Heizzentrale');
    const reasons = await page.getByTestId('document-case-match-reasons').first().locator('li').allTextContents();
    expect(reasons.join(' | ')).not.toContain('Lieferant');
    expect(reasons).toContain('gleicher Kunde');
    await expect(page.getByRole('button', { name: ACCEPT_LABEL })).toHaveCount(0);
    await expect(page.getByTestId('contract-customer-decision')).toHaveCount(0);
    await expect(page.getByTestId('customer-decision-choice')).toHaveCount(0);
    await expect(page.getByText('Dieser Vertrag ist bereits als Auftrag erfasst.', { exact: false })).toBeVisible();
    await expectReachable(page, 'document-review-apply-button');
    await expect(page.getByTestId('document-review-apply-button')).toHaveText(OPEN_CASE_LABEL);

    /* Klick → exakt der bestehende Vorgang; nichts angelegt, nichts verknüpft */
    await page.getByTestId('document-review-apply-button').click();
    await expect(page).toHaveURL(new RegExp(`/vorgaenge/${vorgangId}$`), { timeout: 30_000 });
    await expect(page.getByTestId('vorgang-detail-page')).toBeVisible();
    await page.waitForTimeout(1500);
    const localAfter = await localCounts(page);
    expect(localAfter.vorgaenge).toEqual([vorgangId]);
    expect(localAfter.customers).toEqual(localBefore.customers);
    // Erneuter Seitenaufbau = erneuter Sync-Lauf: auch danach nichts Neues in der Cloud.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('vorgang-detail-page')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(4000);
    const after = await cloudCounts(wsId);
    expect(after.vorgaenge).toEqual([vorgangId]);
    expect(after.customers).toEqual(before.customers);
    expect(after.amendments).toBe(before.amendments);
    // Confirm-first: der zweite Eintrag bleibt ohne persistenten Link.
    const linkState = await page.evaluate((itemId) => {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)!;
        if (!key.startsWith('officepilot-state:workspace:')) continue;
        const state = JSON.parse(localStorage.getItem(key)!) as { inboxItems?: { id: string; vorgangId?: string }[] };
        return state.inboxItems?.find((entry) => entry.id === itemId)?.vorgangId ?? null;
      }
      return 'no-state';
    }, secondItemId);
    expect(linkState).toBeNull();
  });
});
