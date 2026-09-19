/**
 * SYNC-DURABILITY-HARDENING-01G2 — Produktreproduktion der Lost-Ack-Fälle.
 *
 * Kein simuliertes Modell, sondern der echte Netzwerkzustand: Der Aufruf geht
 * an den Server und wird dort ausgeführt; die **Antwort** erreicht den Browser
 * nicht. Genau das ist ein verlorener ACK — ein Funkloch im richtigen Moment.
 *
 * Beobachtet werden drei Wege, jeweils über die echte Oberfläche:
 *
 *  A  Notiz anlegen -> Push angenommen, Antwort verloren -> Neustart -> erneuter
 *     Sync. Bleibt die Notiz? Entsteht eine zweite? Bleibt der Sendeauftrag
 *     hängen?
 *  B  Aufgabe: derselbe verlorene ACK, danach Statuswechsel und erneuter Sync.
 *  C  Notiz löschen, bevor sie je bestätigt wurde; der Tombstone kommt an, die
 *     Antwort nicht. Wird der Löschwunsch beim Wiederholen erkannt?
 *
 * Dieser Lauf protokolliert nur; er behauptet nichts. Die Zusagen prüft der
 * Abnahmelauf nach dem Fix.
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

function log(message: string, value?: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`[01G2] ${message}${value === undefined ? '' : ` ${JSON.stringify(value)}`}`);
}

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    label: 'lostack-01g2',
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
  if (!setup) throw new Error(`Unerwarteter Einrichtungsschritt: ${landed}`);
  if (landed === 'continue') await page.getByTestId('workspace-setup-continue').click();
  await page.getByTestId('setup-companyName').fill(company.companyName);
  await page.getByTestId('setup-contactPerson').fill('Lost Ack Test');
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

/**
 * Das Funkloch: Der Aufruf für genau einen Entitätstyp geht an den Server, die
 * Antwort wird verworfen. Alles andere läuft normal weiter.
 */
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
      /* der Server hat den Aufruf gesehen; die Antwort interessiert uns nicht */
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

async function outboxFor(page: Page, entityType: string) {
  const state = await readState(page);
  return ((state.syncOutbox as Array<Record<string, any>>) ?? [])
    .filter((entry) => entry.entityType === entityType)
    .map((entry) => ({ entityId: entry.entityId, status: entry.status, version: entry.version, op: entry.operation }));
}

async function cloudNotes(wsId: string) {
  const { data } = await admin()
    .from('workspace_vorgang_notes')
    .select('client_note_id,row_version,deleted,payload')
    .eq('workspace_id', wsId);
  return (data ?? []).map((row) => ({
    id: row.client_note_id,
    version: row.row_version,
    deleted: row.deleted,
    body: (row.payload as Record<string, unknown>)?.body,
  }));
}

async function cloudTasks(wsId: string) {
  const { data } = await admin()
    .from('workspace_tasks')
    .select('client_task_id,status,row_version,deleted')
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

test.describe('01G2 Produktreproduktion (lokal)', () => {
  test('Lost-Ack an Notiz, Aufgabe und Tombstone', async ({ page }) => {
    test.setTimeout(900_000);
    await login(page, owner, true);
    const wsId = await workspaceIdOf(owner.id);

    /* Ein echter Vorgang über den Dokumentweg. */
    await uploadDoc00001ToAnalyzedDetail(page);
    await acceptContractOrderThroughUi(page);
    await expect(page.getByTestId('vorgang-detail-page')).toBeVisible({ timeout: 60_000 });
    const vorgangId = new URL(page.url()).pathname.split('/').pop()!;
    await runSync(page);
    log('Vorgang angelegt', vorgangId);

    /* ---------------- A: Notiz mit verlorener Bestätigung ---------------- */
    await openVorgangNotes(page, vorgangId);
    await page.locator('textarea.input').first().fill('Kunde bittet um Rückruf');
    await page.getByRole('button', { name: 'Notiz speichern' }).click();
    await page.waitForTimeout(1200);
    log('A1 lokal nach Anlage', await localNotes(page));

    const restoreA = await loseAcksFor(page, 'vorgang_note');
    await runSync(page);
    await restoreA();

    log('A2 Cloud nach verlorenem ACK', await cloudNotes(wsId));
    log('A2 lokal nach verlorenem ACK', await localNotes(page));
    log('A2 Outbox', await outboxFor(page, 'vorgang_note'));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    log('A3 lokal nach Neustart', await localNotes(page));
    log('A3 Outbox nach Neustart', await outboxFor(page, 'vorgang_note'));

    await runSync(page);
    log('A4 Cloud nach erneutem Sync', await cloudNotes(wsId));
    log('A4 lokal nach erneutem Sync', await localNotes(page));
    log('A4 Outbox nach erneutem Sync', await outboxFor(page, 'vorgang_note'));

    await openVorgangNotes(page, vorgangId);
    const visibleNotes = await page.getByText('Kunde bittet um Rückruf').count();
    log('A5 sichtbare Notizen mit diesem Text', visibleNotes);

    /* ---------------- B: Aufgabe mit verlorener Bestätigung ---------------- */
    /*
     * Der Auftrag aus dem Dokumentweg erzeugt keine Aufgabe; die Engine feuert
     * ohne überfällige Rechnung nicht. Der lokale Vorzustand wird deshalb
     * geschrieben — genau in der Form, die die Engine erzeugt. Alles danach
     * (Push, verlorene Antwort, Neustart, Statuswechsel, Sync) ist echt.
     */
    await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)!;
        if (!key.startsWith('officepilot-state:workspace:')) continue;
        const state = JSON.parse(localStorage.getItem(key)!);
        state.tasks = [
          ...(state.tasks ?? []),
          {
            id: 't-01g2-lostack',
            title: 'Unterlagen prüfen',
            description: 'Vor dem Sync angelegt',
            status: 'open',
            priority: 'mittel',
            category: 'dokumente',
            sourceType: 'inbox',
            sourceId: 'lostack-01g2',
            taskKind: 'inbox_template:dokument_pruefen',
            dedupeKey: 'inbox:lostack-01g2:follow_up',
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

    await page.goto('/aufgaben', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('aufgaben-page')).toBeVisible({ timeout: 30_000 });
    const tasksBefore = await localTasks(page);
    log('B1 lokale Aufgaben', tasksBefore);

    if (tasksBefore.length > 0) {
      const restoreB = await loseAcksFor(page, 'task');
      await runSync(page);
      await restoreB();
      log('B2 Cloud-Aufgaben nach verlorenem ACK', await cloudTasks(wsId));
      log('B2 Outbox', await outboxFor(page, 'task'));

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(1500);

      await page.goto('/aufgaben', { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('aufgaben-page')).toBeVisible({ timeout: 30_000 });
      const first = (await localTasks(page))[0];
      if (first) {
        const toggle = page.getByTestId(`aufgaben-toggle-${first.id}`);
        if (await toggle.count()) {
          await toggle.click();
          await page.waitForTimeout(1200);
          log('B3 lokal nach Statuswechsel', await localTasks(page));
        }
      }
      await runSync(page);
      log('B4 Cloud nach erneutem Sync', await cloudTasks(wsId));
      log('B4 lokal nach erneutem Sync', await localTasks(page));
      log('B4 Outbox nach erneutem Sync', await outboxFor(page, 'task'));
    } else {
      log('B übersprungen: keine Aufgabe vorhanden');
    }

    /* ---------------- C: Tombstone mit verlorener Bestätigung ---------------- */
    await openVorgangNotes(page, vorgangId);
    await page.locator('textarea.input').first().fill('Nur zum Löschen');
    await page.getByRole('button', { name: 'Notiz speichern' }).click();
    await page.waitForTimeout(1200);
    const fresh = (await localNotes(page)).find((n) => n.body === 'Nur zum Löschen');
    log('C1 neue Notiz (noch nie bestätigt)', fresh);

    if (fresh) {
      await page.getByTestId(`vorgang-note-delete-${fresh.id}`).click();
      const confirm = page.getByRole('button', { name: 'Löschen', exact: true }).last();
      if (await confirm.count()) await confirm.click();
      await page.waitForTimeout(1200);
      log('C2 lokal nach Löschen', await localNotes(page));

      const restoreC = await loseAcksFor(page, 'vorgang_note');
      await runSync(page);
      await restoreC();
      log('C3 Cloud nach verlorenem ACK', await cloudNotes(wsId));
      log('C3 Outbox', await outboxFor(page, 'vorgang_note'));

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(1500);
      await runSync(page);
      log('C4 Cloud nach erneutem Sync', await cloudNotes(wsId));
      log('C4 lokal nach erneutem Sync', await localNotes(page));
      log('C4 Outbox nach erneutem Sync', await outboxFor(page, 'vorgang_note'));

      await openVorgangNotes(page, vorgangId);
      log('C5 sichtbar "Nur zum Löschen"', await page.getByText('Nur zum Löschen').count());
      log('C5 sichtbar "Kunde bittet um Rückruf"', await page.getByText('Kunde bittet um Rückruf').count());
    }
  });
});
