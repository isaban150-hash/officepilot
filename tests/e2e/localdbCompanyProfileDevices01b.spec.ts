/**
 * PRODUCT-BASIS-FIRMENPROFIL-EINSTELLUNGEN-01B — Cloud / Multi-Device (lokale Supabase).
 *
 *  D  Geraet 1: Steuerstatus ueber die Rechnungs-Einstellungen setzen (Profilwahrheit),
 *     Firmenprofil aendern -> Sync -> Cloud traegt currency (Migration: EUR), defaultTaxStatus,
 *     Schema-Version 2; Geraet 2 (zweiter Browser-Kontext) erhaelt den identischen Stand,
 *     Legacy-Spiegel CompanySetup.taxStatus ist auf beiden Geraeten nachgefuehrt.
 *  F  Altclient gegen denselben Cloud-Stand (RPC ohne Schema-Version) loescht die Felder nicht;
 *     Geraet 2 liest sie nach erneutem Sync weiterhin.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const ANON_KEY = process.env.E2E_LOCALDB_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let owner: LocalDbUser;
const company = loadTestWorldOperatorCompany();
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'cp-dev-owner' });
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
  await page.getByTestId('setup-contactPerson').fill('Profil Test');
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

interface LocalProfile { profile: Record<string, unknown>; setup: Record<string, unknown>; profileVersion?: number }
async function localProfile(page: Page): Promise<LocalProfile> {
  const raw = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (key.startsWith('officepilot-state:workspace:')) return localStorage.getItem(key);
    }
    return null;
  });
  const s = raw ? (JSON.parse(raw) as Record<string, any>) : {};
  return { profile: s.companyProfile ?? {}, setup: s.setup ?? {}, profileVersion: s.companyProfileSync?.version };
}

async function workspaceIdOf(userId: string): Promise<string> {
  const { data } = await admin().from('workspace_members').select('workspace_id,role').eq('user_id', userId).eq('role', 'owner').limit(1);
  const id = data?.[0]?.workspace_id as string | undefined;
  if (!id) throw new Error('Workspace nicht gefunden');
  return id;
}

async function cloudProfile(wsId: string) {
  const { data } = await admin().from('workspace_company_profiles').select('payload,row_version').eq('workspace_id', wsId).single();
  return { payload: (data?.payload ?? {}) as Record<string, unknown>, rowVersion: Number(data?.row_version ?? 0) };
}

async function openSecondDevice(browser: Browser, user: LocalDbUser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, user, false);
  return { context, page };
}

test.describe('FIRMENPROFIL-01B — Geraete (lokal)', () => {
  test('D/F: Profilwahrheit auf Geraet 1 -> Cloud (Schema 2) -> Geraet 2; Altclient loescht nichts', async ({ page, browser }) => {
    test.setTimeout(300_000);
    await login(page, owner, true);
    const wsId = await workspaceIdOf(owner.id);

    /* Geraet 1: Steuerstatus als Profilwahrheit setzen, Firmenprofil aendern */
    await page.goto('/einstellungen/rechnungen', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-invoices-page')).toBeVisible({ timeout: 30_000 });
    await page.locator('#settings-invoices-defaultTaxStatus').selectOption('tax_free');
    await page.getByTestId('settings-invoices-save').click();
    await expect(page.getByTestId('settings-invoices-dirty')).toHaveCount(0, { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    await page.goto('/einstellungen/firma', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-company-page')).toBeVisible({ timeout: 30_000 });
    await page.locator('#settings-company-website').fill('https://cirmak.example');
    await page.getByTestId('settings-company-save').click();
    await page.waitForTimeout(800);

    const local1 = await localProfile(page);
    expect(local1.profile.defaultTaxStatus).toBe('tax_free');
    expect(local1.setup.taxStatus).toBe('tax_free'); // Legacy-Spiegel nachgefuehrt
    expect(local1.profile.currency).toBe('EUR'); // Migration / neues Profil
    expect(local1.profile.website).toBe('https://cirmak.example');

    await runSync(page);
    const cloud1 = await cloudProfile(wsId);
    expect(cloud1.payload).toMatchObject({ defaultTaxStatus: 'tax_free', currency: 'EUR', website: 'https://cirmak.example' });
    expect('logoDataUrl' in cloud1.payload).toBe(false);

    /* Geraet 2: identischer kanonischer Stand */
    const device2 = await openSecondDevice(browser, owner);
    try {
      await device2.page.goto('/einstellungen/firma', { waitUntil: 'domcontentloaded' });
      await expect(device2.page.getByTestId('settings-company-page')).toBeVisible({ timeout: 30_000 });
      const local2 = await localProfile(device2.page);
      expect(local2.profile).toMatchObject({ defaultTaxStatus: 'tax_free', currency: 'EUR', website: 'https://cirmak.example', companyName: company.companyName });
      expect(local2.setup.taxStatus).toBe('tax_free');
      expect(local2.profileVersion).toBe(cloud1.rowVersion);

      /* F: Altclient (RPC ohne Schema-Version, ohne neue Keys) schreibt denselben Stand */
      const legacyClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      expect((await legacyClient.auth.signInWithPassword({ email: owner.email, password: owner.password })).error).toBeNull();
      const { currency: _c, defaultTaxStatus: _t, replyToEmail: _r, senderDisplayName: _s, branding: _b, ...legacyPayload } = cloud1.payload;
      const legacy = await legacyClient.rpc('upsert_workspace_sync_entity', {
        p_workspace_id: wsId, p_entity_type: 'company_profile', p_payload: { payload: { ...legacyPayload, city: 'Detmold' } }, p_row_version: cloud1.rowVersion,
      });
      expect(legacy.error).toBeNull();
      await legacyClient.auth.signOut();
      const cloud2 = await cloudProfile(wsId);
      expect(cloud2.payload).toMatchObject({ city: 'Detmold', defaultTaxStatus: 'tax_free', currency: 'EUR' });

      await runSync(device2.page);
      const local2b = await localProfile(device2.page);
      expect(local2b.profile).toMatchObject({ city: 'Detmold', defaultTaxStatus: 'tax_free', currency: 'EUR' });
      expect(local2b.setup.taxStatus).toBe('tax_free');
    } finally {
      await device2.context.close();
    }
  });
});
