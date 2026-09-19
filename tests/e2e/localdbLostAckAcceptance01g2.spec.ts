/**
 * SYNC-DURABILITY-HARDENING-01G2 — Abnahme der Lost-Ack-Wege.
 *
 * Derselbe echte Netzwerkzustand wie in der Reproduktion (der Aufruf erreicht
 * den Server, die Antwort den Browser nicht), jetzt mit Zusagen statt
 * Protokoll:
 *
 *  A  Die angelegte Notiz bleibt sichtbar, genau einmal, und der Sendeauftrag
 *     wird abgeschlossen statt blockiert.
 *  B  Die Aufgabe übersteht denselben Fall und behält danach den vom Nutzer
 *     gesetzten Status.
 *  C  Eine nie bestätigte, gelöschte Notiz bleibt gelöscht — keine
 *     Wiederbelebung, kein blockierter Auftrag.
 *
 * Läuft auf Desktop (1280) und Handy (390); die Zwei-Geräte-Semantik selbst
 * steckt im Serververtrag und in den Dienstests.
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

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    label: 'lostack-acc',
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
  await page.getByTestId('setup-contactPerson').fill('Lost Ack Abnahme');
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

/** Der Aufruf geht durch, die Antwort nicht — ein Funkloch im richtigen Moment. */
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
      /* die Antwort interessiert uns gerade nicht */
    }
    await route.abort('connectionaborted');
  });
  return async () => {
    await page.unroute(pattern);
  };
}

async function readState(page: Page): Promise<Record<string, any>> {
  const raw = await page.evaluate(() => {
    let newest: { savedAt: string; value: string } | null = null;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (!key.startsWith('officepilot-state:workspace:')) continue;
      const value = localStorage.getItem(key);
      if (!value) continue;
      let savedAt = '';
      try {
        savedAt = (JSON.parse(value) as { savedAt?: string }).savedAt ?? '';
      } catch {
        savedAt = '';
      }
      if (!newest || savedAt > newest.savedAt) newest = { savedAt, value };
    }
    return newest?.value ?? null;
  });
  return raw ? JSON.parse(raw) : {};
}

async function stuckOutbox(page: Page): Promise<Array<Record<string, unknown>>> {
  const state = await readState(page);
  return ((state.syncOutbox as Array<Record<string, any>>) ?? []).filter(
    (entry) => entry.status === 'blocked' || entry.status === 'error' || entry.status === 'failed',
  );
}

async function localNotes(page: Page) {
  const state = await readState(page);
  return ((state.vorgangNotes as Array<Record<string, any>>) ?? []).map((n) => ({
    id: n.id,
    body: n.body,
    version: n.sync?.version,
    deleted: n.sync?.deleted,
  }));
}

async function localTasks(page: Page) {
  const state = await readState(page);
  return ((state.tasks as Array<Record<string, any>>) ?? []).map((t) => ({
    id: t.id,
    status: t.status,
    version: t.sync?.version,
  }));
}

async function cloudNotes(wsId: string) {
  const { data } = await admin()
    .from('workspace_vorgang_notes')
    .select('client_note_id,row_version,deleted')
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

async function openVorgangNotes(page: Page, vorgangId: string): Promise<void> {
  await page.goto(`/vorgaenge/${vorgangId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('vorgang-detail-page')).toBeVisible({ timeout: 60_000 });
  /*
   * SYNC-DURABILITY-HARDENING-01G3 — der Notizbereich liegt im ausklappbaren
   * Teil des Vorgangs. Frueher wurde hier blind auf einen Knopf mit der
   * Aufschrift „Mehr anzeigen“ geklickt und danach geprueft, ob das Eingabefeld
   * sichtbar ist. Verzoegerte sich der Neuaufbau der Seite, klickte der naechste
   * Durchgang denselben Knopf erneut und schloss den Bereich wieder — die Notiz
   * schien dann zu fehlen, obwohl sie vorhanden war. Der Bereich sagt selbst, ob
   * er offen ist; danach richten wir uns.
   */
  const toggle = page.getByTestId('vorgang-detail-show-more').getByTestId('show-more-toggle');
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 20_000 });
  await expect(page.locator('textarea.input').first()).toBeVisible({ timeout: 20_000 });
}

test.describe('01G2 Abnahme (lokal)', () => {
  test('verlorene Bestätigungen führen zu keinem Verlust und zu keiner Blockade', async ({ page }) => {
    test.setTimeout(900_000);
    await login(page, owner);
    const wsId = await workspaceIdOf(owner.id);

    await uploadDoc00001ToAnalyzedDetail(page);
    await acceptContractOrderThroughUi(page);
    await expect(page.getByTestId('vorgang-detail-page')).toBeVisible({ timeout: 60_000 });
    const vorgangId = new URL(page.url()).pathname.split('/').pop()!;
    await runSync(page);

    /* ---------------- A: Notiz, Bestätigung verloren ---------------- */
    await openVorgangNotes(page, vorgangId);
    await page.locator('textarea.input').first().fill('Kunde bittet um Rückruf');
    await page.getByRole('button', { name: 'Notiz speichern' }).click();
    await page.waitForTimeout(1200);
    const created = (await localNotes(page)).find((n) => n.body === 'Kunde bittet um Rückruf');
    expect(created, 'Notiz wurde nicht angelegt').toBeTruthy();

    const restoreA = await loseAcksFor(page, 'vorgang_note');
    await runSync(page);
    await restoreA();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    await runSync(page);

    // Genau eine Notiz — in der Cloud, im Bestand und auf der Seite.
    expect((await cloudNotes(wsId)).filter((row) => !row.deleted)).toHaveLength(1);
    const notesAfterA = (await localNotes(page)).filter((n) => !n.deleted);
    expect(notesAfterA).toHaveLength(1);
    expect(notesAfterA[0].body).toBe('Kunde bittet um Rückruf');
    // Kein Sendeauftrag bleibt hängen.
    expect(await stuckOutbox(page)).toEqual([]);

    await openVorgangNotes(page, vorgangId);
    // Geprueft wird der sichtbare Inhalt, nicht die technische Kennung.
    await expect(page.getByText('Kunde bittet um Rückruf').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid^="vorgang-note-delete-"]')).toHaveCount(1);
    const overflowNotes = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowNotes).toBeLessThanOrEqual(1);

    /* ---------------- B: Aufgabe, Bestätigung verloren, danach erledigt ---------------- */
    await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)!;
        if (!key.startsWith('officepilot-state:workspace:')) continue;
        const state = JSON.parse(localStorage.getItem(key)!);
        state.tasks = [
          ...(state.tasks ?? []).filter((t: { id: string }) => t.id !== 't-01g2-acc'),
          {
            id: 't-01g2-acc',
            title: 'Unterlagen prüfen',
            description: 'Vor dem Sync angelegt',
            status: 'open',
            priority: 'mittel',
            category: 'dokumente',
            sourceType: 'inbox',
            sourceId: 'acc-01g2',
            taskKind: 'inbox_template:dokument_pruefen',
            dedupeKey: 'inbox:acc-01g2:follow_up',
            autoCreated: true,
            createdAt: '2026-07-01T08:00:00.000Z',
            type: 'dokument_pruefen',
          },
        ];
        localStorage.setItem(key, JSON.stringify(state));
        return;
      }
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1500);

    const restoreB = await loseAcksFor(page, 'task');
    await runSync(page);
    await restoreB();

    await page.goto('/aufgaben', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('aufgaben-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('aufgaben-row-t-01g2-acc')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('aufgaben-toggle-t-01g2-acc').click();
    await page.waitForTimeout(1200);
    await runSync(page);

    const taskAfter = (await localTasks(page)).find((t) => t.id === 't-01g2-acc');
    expect(taskAfter?.status, 'die Entscheidung des Nutzers ging verloren').toBe('done');
    expect(await stuckOutbox(page)).toEqual([]);

    /* ---------------- C: Löschen vor der ersten Bestätigung ---------------- */
    await openVorgangNotes(page, vorgangId);
    await page.locator('textarea.input').first().fill('Nur zum Löschen');
    await page.getByRole('button', { name: 'Notiz speichern' }).click();
    await page.waitForTimeout(1200);
    const doomed = (await localNotes(page)).find((n) => n.body === 'Nur zum Löschen');
    expect(doomed).toBeTruthy();

    await page.getByTestId(`vorgang-note-delete-${doomed!.id}`).click();
    const confirm = page.getByRole('button', { name: 'Löschen', exact: true }).last();
    if (await confirm.count()) await confirm.click();
    await page.waitForTimeout(1200);

    const restoreC = await loseAcksFor(page, 'vorgang_note');
    await runSync(page);
    await restoreC();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    await runSync(page);

    // Der Löschwunsch ist erfüllt und bleibt erfüllt.
    const cloudAfterC = await cloudNotes(wsId);
    // Genau ein Grabstein (der Löschwunsch) und genau eine aktive Notiz.
    expect(cloudAfterC.filter((row) => row.deleted)).toHaveLength(1);
    expect(cloudAfterC.filter((row) => !row.deleted)).toHaveLength(1);
    expect((await localNotes(page)).filter((n) => !n.deleted && n.body === 'Nur zum Löschen')).toEqual([]);
    // Und nichts bleibt hängen.
    expect(await stuckOutbox(page)).toEqual([]);

    /*
     * Die überlebende Notiz muss am Beleg stehen — und zwar sie allein. Der
     * Notizbereich baut sich nach mehreren Neustarts spürbar langsam auf,
     * deshalb wird auf die Liste gewartet statt sofort gezählt.
     */
    await openVorgangNotes(page, vorgangId);
    const noteRows = page.locator('[data-testid^="vorgang-note-delete-"]');
    await expect(noteRows).toHaveCount(1, { timeout: 30_000 });
    // Geprueft wird, was der Nutzer liest — nicht die technische Kennung.
    await expect(page.getByText('Kunde bittet um Rückruf').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Nur zum Löschen')).toHaveCount(0);
    const overflowEnd = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowEnd).toBeLessThanOrEqual(1);
  });
});
