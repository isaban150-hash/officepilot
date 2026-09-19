/**
 * SYNC-DURABILITY-HARDENING-01G3 — Beweisaufnahme zum Desktop-Anzeigebefund.
 *
 * Nach dem Recovery aus 01G2 führen Cloud und persistierter Bestand die Notiz
 * aktiv, die Desktop-Oberfläche zeigte sie nicht. Dieser Lauf behauptet nichts
 * und repariert nichts — er sammelt die Fakten, die die Ursache entscheiden:
 *
 *  * alle Persistenzschlüssel mit ihrem Inhalt,
 *  * **welchen** Schlüssel die laufende Oberfläche tatsächlich beschreibt
 *    (bewiesen über eine Markierung, die nur die UI anlegen kann),
 *  * den Cloud-Zustand derselben Notiz,
 *  * und das, was am Ende wirklich im Bildschirm steht.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
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

function log(label: string, value?: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`[01G3] ${label}${value === undefined ? '' : ` ${JSON.stringify(value)}`}`);
}

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    label: 'recovery-diag',
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
  await page.getByTestId('setup-contactPerson').fill('Recovery Diagnose');
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
  await expect(page.getByTestId('sync-run-button')).toBeEnabled({ timeout: 90_000 });
  await page.waitForTimeout(1500);
}

async function loseAcksFor(page: Page, entityType: string): Promise<() => Promise<void>> {
  const pattern = '**/rest/v1/rpc/upsert_workspace_sync_entity';
  await page.route(pattern, async (route) => {
    const body = route.request().postData() ?? '';
    if (!body.includes(`"${entityType}"`)) {
      await route.continue();
      return;
    }
    try {
      await route.fetch();
    } catch {
      /* die Antwort geht absichtlich verloren */
    }
    await route.abort('connectionaborted');
  });
  return async () => {
    await page.unroute(pattern);
  };
}

/** Vollständiges Inventar aller Persistenzschlüssel — ohne Auswahl, ohne Vermutung. */
async function storageInventory(page: Page, vorgangId: string) {
  return page.evaluate((vid) => {
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (!key.startsWith('officepilot-state')) continue;
      const raw = localStorage.getItem(key) ?? '';
      let parsed: Record<string, any> = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        rows.push({ key, parseError: true, bytes: raw.length });
        continue;
      }
      const notes = (parsed.vorgangNotes ?? []) as Array<Record<string, any>>;
      rows.push({
        key,
        savedAt: parsed.savedAt,
        syncWorkspaceId: parsed.syncClient?.workspaceId,
        serverWorkspaceId: parsed.syncClient?.serverWorkspaceId,
        workspaceStoreId: parsed.workspace?.id,
        hasVorgang: (parsed.vorgaenge ?? []).some((v: { id: string }) => v.id === vid),
        noteCount: notes.length,
        notes: notes.map((n) => ({
          id: n.id,
          body: n.body,
          vorgangId: n.vorgangId,
          deleted: n.sync?.deleted ?? false,
          version: n.sync?.version,
        })),
      });
    }
    return rows;
  }, vorgangId);
}

async function cloudNotes(wsId: string) {
  const { data } = await admin()
    .from('workspace_vorgang_notes')
    .select('client_note_id,client_vorgang_id,row_version,deleted,payload')
    .eq('workspace_id', wsId);
  return (data ?? []).map((row) => ({
    id: row.client_note_id,
    vorgangId: row.client_vorgang_id,
    version: row.row_version,
    deleted: row.deleted,
    body: (row.payload as Record<string, unknown>)?.body,
  }));
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

async function openVorgangNotes(page: Page, vorgangId: string): Promise<void> {
  await page.goto(`/vorgaenge/${vorgangId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('vorgang-detail-page')).toBeVisible({ timeout: 60_000 });
  await openDetailsSection(page);
}

/*
 * Der Notizbereich liegt im ausklappbaren Teil des Vorgangs. Dieser Bereich
 * traegt ein eigenes Kennzeichen und sagt selbst, ob er offen ist — danach
 * richten wir uns, statt blind auf einen Knopf mit passender Aufschrift zu
 * klicken. Auf der Seite gibt es mehrere solcher Knoepfe.
 */
async function openDetailsSection(page: Page): Promise<void> {
  const toggle = page.getByTestId('vorgang-detail-show-more').getByTestId('show-more-toggle');
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 });
}

/** Bestandsaufnahme: wie viele Aufklapp-Knoepfe gibt es, und was ist offen? */
async function toggleInventory(page: Page) {
  const labelled = page.getByRole('button', { name: 'Mehr anzeigen' });
  const areas = page.locator('textarea.input');
  const areaVisible: boolean[] = [];
  const areaCount = await areas.count();
  for (let i = 0; i < areaCount; i += 1) {
    areaVisible.push(await areas.nth(i).isVisible().catch(() => false));
  }
  const section = page.getByTestId('vorgang-detail-show-more').getByTestId('show-more-toggle');
  return {
    buttonsLabelledMehrAnzeigen: await labelled.count(),
    vorgangSectionExpanded: await section.getAttribute('aria-expanded').catch(() => null),
    textareaCount: areaCount,
    textareaVisible: areaVisible,
  };
}
/** Was steht wirklich auf dem Bildschirm? */
async function screenState(page: Page) {
  const rows = page.locator('[data-testid^="vorgang-note-delete-"]');
  const count = await rows.count();
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push((await rows.nth(i).getAttribute('data-testid')) ?? '');
  }
  return {
    url: page.url(),
    heading: (await page.locator('h1').first().textContent().catch(() => null))?.trim() ?? null,
    noteRows: count,
    noteRowIds: ids,
    mainText: (await page.locator('main').innerText().catch(() => ''))
      .replace(/\s+/g, ' ')
      .slice(0, 400),
  };
}

test.describe('01G3 Beweisaufnahme (lokal)', () => {
  test('Desktop: wo verschwindet die Notiz?', async ({ page }) => {
    test.setTimeout(900_000);
    await login(page, owner);
    const wsId = await workspaceIdOf(owner.id);
    log('Server-Workspace', wsId);

    await uploadDoc00001ToAnalyzedDetail(page);
    await acceptContractOrderThroughUi(page);
    await expect(page.getByTestId('vorgang-detail-page')).toBeVisible({ timeout: 60_000 });
    const vorgangId = new URL(page.url()).pathname.split('/').pop()!;
    log('Vorgang', vorgangId);
    await runSync(page);

    /* ---------------- Notiz über die Oberfläche ---------------- */
    await openVorgangNotes(page, vorgangId);
    await page.locator('textarea.input').first().fill('Kunde bittet um Rückruf');
    await page.getByRole('button', { name: 'Notiz speichern' }).click();
    await page.waitForTimeout(1500);
    log('1) Inventar nach Anlage', await storageInventory(page, vorgangId));
    log('1) Bildschirm', await screenState(page));

    /* ---------------- Verlorene Bestätigung + Recovery ---------------- */
    const restore = await loseAcksFor(page, 'vorgang_note');
    await runSync(page);
    await restore();
    log('2) Cloud nach verlorenem ACK', await cloudNotes(wsId));
    log('2) Inventar nach verlorenem ACK', await storageInventory(page, vorgangId));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    await runSync(page);
    log('3) Cloud nach Recovery', await cloudNotes(wsId));
    log('3) Inventar nach Recovery', await storageInventory(page, vorgangId));

    /* ---------------- Der Bildschirm zum Fehlerzeitpunkt ---------------- */
    await page.goto(`/vorgaenge/${vorgangId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('vorgang-detail-page')).toBeVisible({ timeout: 60_000 });
    log('4a) Aufklapp-Bestand vor Oeffnen', await toggleInventory(page));
    await openDetailsSection(page);
    log('4b) Aufklapp-Bestand nach Oeffnen', await toggleInventory(page));
    log('4) Bildschirm nach Recovery', await screenState(page));

    /*
     * Der eigentliche Nachweis: Nach dem Wiederanlauf steht die Notiz am Beleg —
     * genau eine, mit ihrem Text. Genau das wurde zuvor vermisst.
     */
    const noteId = (await storageInventory(page, vorgangId)).flatMap((row) =>
      (row.notes as Array<{ id: string }>) ?? [],
    )[0]?.id;
    expect(noteId).toBeTruthy();
    await expect(page.getByTestId(`vorgang-note-delete-${noteId}`)).toHaveCount(1);
    await expect(page.getByText('Kunde bittet um Rückruf')).toBeVisible();
    log('4) Inventar beim Anschauen', await storageInventory(page, vorgangId));

    /*
     * Der Beweis, welchen Schlüssel die laufende Oberfläche benutzt: Sie legt
     * eine Markierung an, die es sonst nirgends gibt. Wo sie auftaucht, dort
     * schreibt die UI.
     */
    const area = page.locator('textarea.input').first();
    if (await area.isVisible().catch(() => false)) {
      await area.fill('MARKER-UI-01G3');
      await page.getByRole('button', { name: 'Notiz speichern' }).click();
      await page.waitForTimeout(1500);
      log('5) Inventar nach Markierung', await storageInventory(page, vorgangId));
      log('5) Bildschirm nach Markierung', await screenState(page));
    } else {
      log('5) Notizfeld nicht bedienbar — Markierung nicht möglich');
    }
  });
});
