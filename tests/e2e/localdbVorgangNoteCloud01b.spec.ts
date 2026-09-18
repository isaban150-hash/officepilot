/**
 * CLOUD-DURABILITY-CORE-01B — Vorgangsnotizen in die Cloud (lokale Supabase).
 *
 *  N1  Gerät 1 legt eine Notiz an -> Sync -> Zeile in workspace_vorgang_notes,
 *      Version lokal gesetzt, Vorgangsbezug in der Spalte
 *  N2  Gerät 2 (zweiter Browser-Kontext) sieht die Notiz nach dem Pull
 *  N3  Gerät 2 löscht die Notiz -> Sync -> Grabstein in der Cloud
 *  N4  Gerät 1 verliert sie nach dem Pull — und ein weiterer Sync belebt sie
 *      nicht wieder (keine Auferstehung über den Altbestand-Backfill)
 *
 * Bewusst **kein** Bearbeiten im Browser: Der Block darf kein neues Notiz-UI
 * anlegen, und die Vorgangsakte kennt heute nur Anlegen und Löschen. Die
 * Änderung über das zweite Gerät ist serverseitig (row_version 2) und im
 * Merge (`mergeVorgangNotesFromPull`) geprüft.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';
import { uploadDoc00001ToAnalyzedDetail } from './support/localDoc00001Flow';
import { acceptContractOrderThroughUi } from './support/localDoc00001VorgangFlow';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let owner: LocalDbUser;
const company = loadTestWorldOperatorCompany();
const admin = () =>
  createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    label: 'note-dur-owner',
  });
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
  await page.getByTestId('setup-contactPerson').fill('Notiz Test');
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

interface LocalNote {
  id: string;
  vorgangId: string;
  body: string;
  syncVersion?: number;
  deleted?: boolean;
}

async function localNotes(page: Page): Promise<LocalNote[]> {
  const raw = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (key.startsWith('officepilot-state:workspace:')) return localStorage.getItem(key);
    }
    return null;
  });
  const state = raw ? (JSON.parse(raw) as { vorgangNotes?: Array<Record<string, any>> }) : {};
  return (state.vorgangNotes ?? []).map((n) => ({
    id: n.id,
    vorgangId: n.vorgangId,
    body: n.body,
    syncVersion: n.sync?.version,
    deleted: n.sync?.deleted,
  }));
}

async function cloudNotes(wsId: string) {
  const { data } = await admin()
    .from('workspace_vorgang_notes')
    .select('client_note_id,client_vorgang_id,row_version,deleted,payload')
    .eq('workspace_id', wsId);
  return data ?? [];
}

async function workspaceIdOf(userId: string): Promise<string> {
  const { data } = await admin()
    .from('workspace_members')
    .select('workspace_id,role')
    .eq('user_id', userId)
    .eq('role', 'owner')
    .limit(1);
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

/**
 * Der Vorgang entsteht auf dem vorhandenen Weg: Dokument hochladen, Analyse,
 * Auftragsannahme. Kein Store-Schreiben, keine Abkuerzung — die Notiz braucht
 * eine echte Akte, die auch auf dem zweiten Geraet ankommt.
 */
async function createVorgangThroughUi(page: Page): Promise<string> {
  await uploadDoc00001ToAnalyzedDetail(page);
  await acceptContractOrderThroughUi(page);
  await expect(page.getByTestId('vorgang-detail-page')).toBeVisible({ timeout: 30_000 });
  return new URL(page.url()).pathname.split('/').pop()!;
}

/** Die Notizen liegen hinter "Mehr anzeigen" — derselbe Weg wie fuer den Nutzer. */
async function openNotes(page: Page): Promise<void> {
  await expect(page.getByTestId("vorgang-detail-page")).toBeVisible({ timeout: 30_000 });
  const toggle = page.getByRole("button", { name: "Mehr anzeigen" });
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await toggle.click();
  await expect(page.locator("textarea.input").first()).toBeVisible({ timeout: 15_000 });
}

async function addNote(page: Page, body: string): Promise<void> {
  await openNotes(page);
  const area = page.locator('textarea.input').first();
  await area.fill(body);
  await page.getByRole('button', { name: 'Notiz speichern' }).click();
  await expect(page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
}

test.describe('CLOUD-DURABILITY-CORE-01B (lokal)', () => {
  test('N1–N4: Notiz -> Cloud -> Geraet 2 -> Loeschung -> keine Auferstehung', async ({ page, browser }) => {
    test.setTimeout(300_000);
    await login(page, owner, true);
    const wsId = await workspaceIdOf(owner.id);

    /* N1 — Notiz anlegen und sichern */
    const vorgangId = await createVorgangThroughUi(page);
    const body = `Rueckruf vereinbart ${Date.now()}`;
    await addNote(page, body);
    await runSync(page);

    const cloud1 = await cloudNotes(wsId);
    const row1 = cloud1.find((n) => (n.payload as Record<string, unknown>)?.body === body);
    expect(row1, 'Notiz fehlt in der Cloud').toBeTruthy();
    expect(row1!.client_vorgang_id).toBe(vorgangId);
    expect(row1!.deleted).toBe(false);
    const noteId = row1!.client_note_id as string;

    const local1 = (await localNotes(page)).find((n) => n.id === noteId)!;
    expect(local1.syncVersion).toBe(1);

    // Zweiter Sync ohne Inhaltsaenderung erzeugt keine neue Version.
    await runSync(page);
    expect((await cloudNotes(wsId)).find((n) => n.client_note_id === noteId)!.row_version).toBe(1);

    /* N2 — Geraet 2 sieht die Notiz */
    const device2 = await openSecondDevice(browser, owner);
    try {
      await device2.page.goto(`/vorgaenge/${vorgangId}`, { waitUntil: 'domcontentloaded' });
      await openNotes(device2.page);
      await expect(device2.page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
      expect((await localNotes(device2.page)).find((n) => n.id === noteId)?.syncVersion).toBe(1);

      /* N3 — Loeschung auf Geraet 2 */
      await device2.page.getByTestId(`vorgang-note-delete-${noteId}`).click();
      const confirm = device2.page.getByRole('button', { name: 'Löschen', exact: true }).last();
      if (await confirm.count()) await confirm.click();
      await expect(device2.page.getByText(body, { exact: false })).toHaveCount(0, { timeout: 15_000 });
      await runSync(device2.page);

      const cloud3 = (await cloudNotes(wsId)).find((n) => n.client_note_id === noteId)!;
      expect(cloud3.deleted).toBe(true);
      // Der Vorgangsbezug ueberlebt den Grabstein.
      expect(cloud3.client_vorgang_id).toBe(vorgangId);

      /* N4 — Geraet 1 verliert sie und belebt sie nicht wieder */
      await runSync(page);
      await page.goto(`/vorgaenge/${vorgangId}`, { waitUntil: 'domcontentloaded' });
      await openNotes(page);
      await expect(page.getByText(body, { exact: false })).toHaveCount(0, { timeout: 15_000 });
      expect((await localNotes(page)).some((n) => n.id === noteId && !n.deleted)).toBe(false);

      await runSync(page);
      await runSync(device2.page);
      const cloud4 = (await cloudNotes(wsId)).filter((n) => n.client_note_id === noteId);
      expect(cloud4).toHaveLength(1);
      expect(cloud4[0].deleted).toBe(true);
      await page.goto(`/vorgaenge/${vorgangId}`, { waitUntil: 'domcontentloaded' });
      await openNotes(page);
      await expect(page.getByText(body, { exact: false })).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await device2.context.close();
    }
  });
});
