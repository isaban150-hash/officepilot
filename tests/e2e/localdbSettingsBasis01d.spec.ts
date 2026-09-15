/**
 * PRODUCT-BASIS-FIRMENPROFIL-01D — Einstellungen als Produktbasis (lokale Supabase).
 *
 *  A  Hub: Firma, Rechnungen & Zahlungen, Design, E-Mail & Kommunikation, Betrieb
 *  B/D/E/K  Kommunikation: Fallbacks sichtbar, Anzeigename/Reply-To/Standardtexte speichern
 *  F  ungueltige Reply-To -> Fehler, nichts gespeichert
 *  G/M  Rechnungen & Zahlungen: Waehrung EUR (nur Anzeige), Nummernformat eingebettet, kein E-Mail-Abschnitt mehr
 *  N  Entwurf ueberlebt Navigation weg und zurueck (Resume), ohne zu speichern
 *  P  Geraet 2 sieht die Kommunikationseinstellungen nach Bootstrap
 *  Q  Desktop / Android / WebKit; kein horizontaler Ueberlauf
 *  C  Member: serverseitig gesperrt (RPC), Cloud unveraendert
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const ANON_KEY = process.env.E2E_LOCALDB_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let owner: LocalDbUser;
let member: LocalDbUser;
const company = loadTestWorldOperatorCompany();
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'set-owner' });
  member = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'set-member' });
});
test.afterAll(async () => {
  for (const user of [owner, member]) if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
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
  if (!setup) throw new Error(`Unerwarteter Einrichtungsschritt: ${landed}`);
  if (landed === 'continue') await page.getByTestId('workspace-setup-continue').click();
  await page.getByTestId('setup-companyName').fill(company.companyName);
  await page.getByTestId('setup-contactPerson').fill('Settings Test');
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

async function expectNoOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontaler Überlauf: ${label}`).toBeLessThanOrEqual(1);
}

async function openSecondDevice(browser: Browser, user: LocalDbUser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, user, false);
  return { context, page };
}

test.describe('FIRMENPROFIL-01D — Einstellungen (lokal)', () => {
  test('Hub -> Kommunikation -> Rechnungen & Zahlungen -> Geraet 2 -> Member gesperrt', async ({ page, browser }) => {
    test.setTimeout(300_000);
    await login(page, owner, true);
    const { data: members } = await admin().from('workspace_members').select('workspace_id').eq('user_id', owner.id).eq('role', 'owner').limit(1);
    const wsId = members![0].workspace_id as string;

    /* A — Hub */
    await page.goto('/einstellungen', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('einstellungen-page')).toBeVisible({ timeout: 30_000 });
    for (const id of ['company', 'documents', 'design', 'communication', 'team']) {
      await expect(page.getByTestId(`settings-group-${id}`)).toBeVisible();
    }
    await expectNoOverflow(page, 'Hub');
    await page.getByTestId('settings-entry-communication').click();
    await expect(page.getByTestId('settings-communication-page')).toBeVisible({ timeout: 30_000 });

    /* D/E — Fallbacks sichtbar; L — technischer From nicht editierbar */
    await expect(page.getByTestId('settings-communication-identity-name')).toHaveText(company.companyName);
    await expect(page.getByTestId('settings-communication-identity-replyTo')).toHaveText(company.email.toLowerCase());
    await expect(page.getByTestId('settings-communication-identity-from')).toContainText('nicht änderbar');

    /* F — ungueltig */
    await page.getByTestId('settings-communication-replyToEmail').fill('kein-mail');
    await page.getByTestId('settings-communication-save').click();
    await expect(page.getByTestId('settings-communication-error')).toBeVisible();

    /* N — Entwurf ueberlebt Navigation weg und zurueck */
    await page.getByTestId('settings-communication-replyToEmail').fill('rechnung@cirmak.example');
    await page.getByTestId('settings-communication-senderDisplayName').fill('Cirmak Service');
    await page.getByTestId('settings-communication-back').click();
    await expect(page.getByTestId('einstellungen-page')).toBeVisible();
    await page.getByTestId('settings-entry-communication').click();
    await expect(page.getByTestId('settings-communication-replyToEmail')).toHaveValue('rechnung@cirmak.example', { timeout: 15_000 });
    await expect(page.getByTestId('settings-communication-dirty')).toContainText('Ungespeicherte');

    /* B/K — speichern */
    await page.getByTestId('settings-communication-defaultInvoiceEmailSubject').fill('Ihre Rechnung {invoiceNumber}');
    await page.getByTestId('settings-communication-save').scrollIntoViewIfNeeded();
    await page.getByTestId('settings-communication-save').click();
    await expect(page.getByText('Kommunikationseinstellungen gespeichert.')).toBeVisible();
    await expect(page.getByTestId('settings-communication-identity-name')).toHaveText('Cirmak Service');
    await expectNoOverflow(page, 'Kommunikation');

    /* G/M — Rechnungen & Zahlungen */
    await page.goto('/einstellungen/rechnungen', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-invoices-currency')).toContainText('EUR', { timeout: 30_000 });
    await expect(page.getByTestId('settings-invoices-section-number')).toBeVisible();
    await expect(page.getByTestId('settings-invoices-number-preview')).toBeVisible();
    await expect(page.getByTestId('settings-invoices-section-email')).toHaveCount(0);
    await expect(page.getByTestId('settings-invoices-email-moved-link')).toHaveAttribute('href', '/einstellungen/kommunikation');
    await expectNoOverflow(page, 'Rechnungen');

    await runSync(page);
    const cloud = await admin().from('workspace_company_profiles').select('payload').eq('workspace_id', wsId).single();
    expect(cloud.data!.payload).toMatchObject({ replyToEmail: 'rechnung@cirmak.example', senderDisplayName: 'Cirmak Service', defaultInvoiceEmailSubject: 'Ihre Rechnung {invoiceNumber}', currency: 'EUR' });

    /* P — Geraet 2 */
    const device2 = await openSecondDevice(browser, owner);
    try {
      await device2.page.goto('/einstellungen/kommunikation', { waitUntil: 'domcontentloaded' });
      await expect(device2.page.getByTestId('settings-communication-replyToEmail')).toHaveValue('rechnung@cirmak.example', { timeout: 30_000 });
      await expect(device2.page.getByTestId('settings-communication-identity-name')).toHaveText('Cirmak Service');
    } finally {
      await device2.context.close();
    }

    /* C — Member serverseitig gesperrt */
    const { error: memberErr } = await admin().from('workspace_members').insert({ workspace_id: wsId, user_id: member.id, role: 'member', status: 'active' });
    expect(memberErr).toBeNull();
    const memberClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await memberClient.auth.signInWithPassword({ email: member.email, password: member.password })).error).toBeNull();
    const write = await memberClient.rpc('upsert_workspace_sync_entity', { p_workspace_id: wsId, p_entity_type: 'company_profile', p_payload: { payload: { ...(cloud.data!.payload as object), replyToEmail: 'hack@x.de' }, profile_schema_version: 2 }, p_row_version: 0 });
    expect(write.error?.message).toContain('Keine Schreibberechtigung');
    await memberClient.auth.signOut();
    const after = await admin().from('workspace_company_profiles').select('payload').eq('workspace_id', wsId).single();
    expect((after.data!.payload as { replyToEmail: string }).replyToEmail).toBe('rechnung@cirmak.example');
  });
});
