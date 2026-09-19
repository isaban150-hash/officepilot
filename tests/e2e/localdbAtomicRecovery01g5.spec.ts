/**
 * SYNC-DURABILITY-01G5 — die drei Gegenbeispiele des 01G4-Audits.
 *
 *  A  Der Sendenachweis entstand bisher nur in einer Arbeitskopie des
 *     Sendewegs und wurde erst am Ende eines Laufs gespeichert. Stirbt die
 *     Seite zwischen „Server hat angenommen" und „Antwort verarbeitet", ist er
 *     verloren — und mit ihm die einzige Möglichkeit, den eigenen
 *     Schreibvorgang später wiederzuerkennen.
 *  B  Ein späterer Schreibvorgang überschrieb den noch ungeklärten Nachweis des
 *     vorigen. Danach ist nicht mehr feststellbar, dass die Serverfassung die
 *     eigene ist.
 *  C  Eine Wiederanlauf-Entscheidung wurde am Sendeauftrag vermerkt, das
 *     zugehörige Merge-Ergebnis aber verworfen, sobald **irgendeine** andere
 *     Entität desselben Typs in Streit lag. Der Auftrag stand dann auf
 *     „sendebereit", während die Entität noch die alte Basis trug.
 *
 * Alle Schreibvorgänge laufen über die echte Oberfläche: Aufgaben über das
 * Erledigt-Häkchen, Notizen über Speichern und Löschen. Nur das **Anlegen** der
 * Aufgabe kommt aus einem Harness — dafür gibt es keinen freien Bedienweg.
 *
 * Das Funkloch wird nicht geraten: Der Aufruf geht wirklich an den Server, sein
 * Erfolg wird geprüft, und erst danach verliert der Browser die Antwort. Greift
 * der Eingriff nicht, schlägt der Lauf fehl.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page, type Route } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';
import { uploadDoc00001ToAnalyzedDetail } from './support/localDoc00001Flow';
import { acceptContractOrderThroughUi } from './support/localDoc00001VorgangFlow';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';
const STATE_KEY_PREFIX = 'officepilot-state:workspace:';
const RPC = '**/rest/v1/rpc/upsert_workspace_sync_entity';

let owner: LocalDbUser;
const company = loadTestWorldOperatorCompany();
const admin = () =>
  createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

function log(message: string, value?: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`[01G5] ${message}${value === undefined ? '' : ` ${JSON.stringify(value)}`}`);
}

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    label: 'atomic-01g5',
  });
});
test.afterAll(async () => {
  if (owner) {
    await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: owner.id });
  }
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
  await page.getByTestId('setup-contactPerson').fill('Atomic 01G5');
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

async function reload(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
}

/** Der Server führt aus, der Browser sieht die Antwort nie. Erfolg wird geprüft. */
async function loseAcksFor(
  page: Page,
  entityType: string,
): Promise<{ restore: () => Promise<void>; accepted: () => number }> {
  let acceptedCount = 0;
  const abgewiesen: number[] = [];
  await page.route(RPC, async (route: Route) => {
    const body = route.request().postData() ?? '';
    if (!body.includes(`"${entityType}"`)) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    /*
     * Nur ein angenommener Aufruf ist ein verlorenes Funkloch. Ein abgewiesener
     * (Versionskonflikt) wird mitgezählt und ausgewiesen, bricht den Lauf aber
     * nicht ab: Ein Folgeversuch auf überholter Basis **soll** abgewiesen
     * werden. Entscheidend ist, dass mindestens einmal wirklich geschrieben
     * wurde — sonst prüfte der Lauf nichts.
     */
    if (response.ok()) {
      acceptedCount += 1;
    } else {
      abgewiesen.push(response.status());
    }
    await route.abort('connectionaborted');
  });
  return {
    restore: async () => {
      await page.unroute(RPC);
      log(`Funkloch ${entityType}: angenommen=${acceptedCount} abgewiesen=${JSON.stringify(abgewiesen)}`);
    },
    accepted: () => acceptedCount,
  };
}

async function readState(page: Page): Promise<Record<string, any>> {
  const raw = await page.evaluate((prefix) => {
    let newest: { savedAt: string; value: string } | null = null;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (!key.startsWith(prefix)) continue;
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
  }, STATE_KEY_PREFIX);
  return raw ? JSON.parse(raw) : {};
}

async function localTasks(page: Page) {
  const state = await readState(page);
  return ((state.tasks as Array<Record<string, any>>) ?? []).map((t) => ({
    id: t.id,
    status: t.status,
    version: t.sync?.version,
    deleted: t.sync?.deleted ?? false,
  }));
}

async function localNotes(page: Page) {
  const state = await readState(page);
  return ((state.vorgangNotes as Array<Record<string, any>>) ?? []).map((n) => ({
    id: n.id,
    body: n.body,
    version: n.sync?.version,
    deleted: n.sync?.deleted ?? false,
  }));
}

async function outboxFor(page: Page, entityType: string) {
  const state = await readState(page);
  return ((state.syncOutbox as Array<Record<string, any>>) ?? [])
    .filter((entry) => entry.entityType === entityType)
    .map((entry) => ({
      entityId: entry.entityId,
      status: entry.status,
      version: entry.version,
      op: entry.operation,
      sentContentKey: entry.sentContentKey ? 'vorhanden' : undefined,
      sentDeleted: entry.sentDeleted,
    }));
}

async function cloudTasks(wsId: string) {
  const { data } = await admin()
    .from('workspace_tasks')
    .select('client_task_id,status,row_version,deleted')
    .eq('workspace_id', wsId);
  return data ?? [];
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

/** HARNESS: Für das Anlegen einer Aufgabe gibt es keinen freien Bedienweg. */
async function seedTasks(page: Page, ids: string[]): Promise<void> {
  await page.evaluate(
    ({ prefix, taskIds }) => {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)!;
        if (!key.startsWith(prefix)) continue;
        const state = JSON.parse(localStorage.getItem(key)!);
        state.tasks = [
          ...(state.tasks ?? []),
          ...taskIds.map((id) => ({
            id,
            title: `Unterlagen prüfen ${id}`,
            description: 'Vor dem Sync angelegt',
            status: 'open',
            priority: 'mittel',
            category: 'dokumente',
            sourceType: 'inbox',
            sourceId: id,
            taskKind: 'inbox_template:dokument_pruefen',
            dedupeKey: `inbox:${id}:follow_up`,
            autoCreated: true,
            createdAt: '2026-07-01T08:00:00.000Z',
            type: 'dokument_pruefen',
          })),
        ];
        localStorage.setItem(key, JSON.stringify(state));
        return;
      }
    },
    { prefix: STATE_KEY_PREFIX, taskIds: ids },
  );
  await reload(page);
}

/** Echter Bedienweg: das Erledigt-Häkchen an der Aufgabe. */
async function toggleTaskThroughUi(page: Page, taskId: string): Promise<void> {
  await page.goto('/aufgaben', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('aufgaben-page')).toBeVisible({ timeout: 30_000 });
  const toggle = page.getByTestId(`aufgaben-toggle-${taskId}`);
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await toggle.click();
  await page.waitForTimeout(1500);
}

async function openVorgangNotes(page: Page, vorgangId: string): Promise<void> {
  await page.goto(`/vorgaenge/${vorgangId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('vorgang-detail-page')).toBeVisible({ timeout: 60_000 });
  const toggle = page.getByTestId('vorgang-detail-show-more').getByTestId('show-more-toggle');
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 20_000 });
  await expect(page.locator('textarea.input').first()).toBeVisible({ timeout: 20_000 });
}

async function addNoteThroughUi(page: Page, vorgangId: string, body: string): Promise<void> {
  await openVorgangNotes(page, vorgangId);
  await page.locator('textarea.input').first().fill(body);
  await page.getByRole('button', { name: 'Notiz speichern' }).click();
  await page.waitForTimeout(1500);
}

async function deleteNoteThroughUi(page: Page, vorgangId: string, noteId: string): Promise<void> {
  await openVorgangNotes(page, vorgangId);
  await page.getByTestId(`vorgang-note-delete-${noteId}`).click();
  const confirm = page.getByRole('button', { name: 'Löschen' });
  if (await confirm.count()) await confirm.last().click();
  await page.waitForTimeout(1500);
}

async function setupVorgang(page: Page): Promise<string> {
  await uploadDoc00001ToAnalyzedDetail(page);
  await acceptContractOrderThroughUi(page);
  await expect(page.getByTestId('vorgang-detail-page')).toBeVisible({ timeout: 60_000 });
  const vorgangId = new URL(page.url()).pathname.split('/').pop()!;
  await runSync(page);
  return vorgangId;
}

/** Ein anderes Gerät schreibt an der Aufgabe vorbei — echter Streitfall. */
async function foreignTaskWrite(wsId: string, taskId: string): Promise<void> {
  const { data } = await admin()
    .from('workspace_tasks')
    .select('row_version,payload')
    .eq('workspace_id', wsId)
    .eq('client_task_id', taskId)
    .single();
  await admin()
    .from('workspace_tasks')
    .update({
      status: 'archived',
      payload: { ...(data?.payload as Record<string, unknown>), status: 'archived' },
      row_version: Number(data?.row_version ?? 1) + 1,
    })
    .eq('workspace_id', wsId)
    .eq('client_task_id', taskId);
}

test.describe('01G5 Atomarer Wiederanlauf (lokal)', () => {
  test('B — der Sendenachweis liegt nach dem Funkloch dauerhaft vor', async ({ page }) => {
    test.setTimeout(900_000);
    await login(page, owner);
    const wsId = await workspaceIdOf(owner.id);

    const taskId = 't-01g5-b';
    await seedTasks(page, [taskId]);
    await runSync(page);
    const basis = (await localTasks(page)).find((t) => t.id === taskId)!;
    expect(basis.version).toBeGreaterThan(0);

    // Echter Bedienweg: erledigt setzen. Der Server nimmt an, die Antwort geht verloren.
    await toggleTaskThroughUi(page, taskId);
    const hook = await loseAcksFor(page, 'task');
    await runSync(page);
    await hook.restore();
    expect(hook.accepted(), 'der Schreibvorgang muss den Server erreicht haben').toBeGreaterThan(0);

    const cloud = (await cloudTasks(wsId)) as Array<Record<string, any>>;
    log('B-1 Cloud nach verlorener Bestätigung', cloud);
    expect(
      cloud.find((t) => t.client_task_id === taskId)?.status,
      'der Server hat den Statuswechsel übernommen',
    ).toBe('done');

    /*
     * Die Zusage von Befund A im laufenden Produkt: Der Nachweis wurde **vor**
     * dem Absenden gespeichert und liegt deshalb jetzt im Bestand — obwohl die
     * Antwort nie ankam.
     */
    const outbox = await outboxFor(page, 'task');
    log('B-1 Sendeauftrag', outbox);
    const offen = outbox.find((e) => e.entityId === taskId && e.status !== 'completed');
    expect(offen, 'der Auftrag ist noch offen').toBeTruthy();
    expect(offen?.sentContentKey, 'der Nachweis ist dauerhaft vorhanden').toBe('vorhanden');

    // Und der Wiederanlauf klärt ihn auf.
    await reload(page);
    await runSync(page);
    const lokal = (await localTasks(page)).find((t) => t.id === taskId)!;
    const nachher = await outboxFor(page, 'task');
    log('B-2 lokal nach Wiederanlauf', lokal);
    log('B-2 Sendeauftrag nach Wiederanlauf', nachher);

    expect(lokal.status, 'der Statuswechsel bleibt').toBe('done');
    expect(lokal.version, 'auf bestätigter Basis').toBeGreaterThan(basis.version!);
    expect(
      nachher.filter((e) => e.entityId === taskId && e.status !== 'completed'),
      'kein offener Auftrag mehr',
    ).toHaveLength(0);
  });

  test('E — Notiz: Löschen, Bestätigung verloren, Wiederanlauf', async ({ page }) => {
    test.setTimeout(900_000);
    await login(page, owner);
    const wsId = await workspaceIdOf(owner.id);
    const vorgangId = await setupVorgang(page);

    await addNoteThroughUi(page, vorgangId, 'E Wird gelöscht');
    await runSync(page);
    const bestaetigt = (await localNotes(page)).find((n) => n.body === 'E Wird gelöscht')!;
    expect(bestaetigt.version).toBeGreaterThan(0);

    await deleteNoteThroughUi(page, vorgangId, bestaetigt.id);
    const hook = await loseAcksFor(page, 'vorgang_note');
    await runSync(page);
    await hook.restore();
    expect(hook.accepted(), 'E: die Löschung muss den Server erreicht haben').toBeGreaterThan(0);

    await reload(page);
    await runSync(page);
    const lokal = await localNotes(page);
    const cloud = await cloudNotes(wsId);
    const outbox = await outboxFor(page, 'vorgang_note');
    log('E-1 lokal', lokal);
    log('E-1 Cloud', cloud);
    log('E-1 Sendeauftrag', outbox);

    expect(lokal.filter((n) => !n.deleted && n.id === bestaetigt.id), 'E: bleibt gelöscht').toHaveLength(0);
    expect(
      cloud.filter((n) => !n.deleted && n.id === bestaetigt.id),
      'E: auch in der Cloud gelöscht',
    ).toHaveLength(0);
    expect(
      outbox.filter((e) => e.entityId === bestaetigt.id && e.status !== 'completed'),
      'E: kein offener Auftrag',
    ).toHaveLength(0);
  });
});
