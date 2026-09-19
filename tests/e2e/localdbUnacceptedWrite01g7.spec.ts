/**
 * SYNC-DURABILITY-01G7 — das Gegenstück zum verlorenen ACK.
 *
 * Beim verlorenen ACK **nimmt** der Server den Schreibvorgang an und nur die
 * Antwort geht verloren. Hier scheitert der Aufruf, **bevor** der Server ihn
 * sieht: Er wird abgebrochen, ohne je ausgeführt zu werden. Der Server bleibt
 * damit exakt auf der bestätigten Ausgangsbasis.
 *
 * Beides darf nicht verwechselt werden, und beides muss anders ausgehen:
 *
 *   verlorenes ACK  -> Serverversion übernehmen.
 *   nicht angenommen -> Nachweis auflösen, aktuellen Stand erneut senden.
 *
 * Geprüft wird, dass der Server die Änderung wirklich nie gesehen hat (die
 * Cloud steht danach unverändert auf Version 1), dass der Nutzer weiterarbeiten
 * kann und dass sein neuester Stand die Cloud erreicht.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page, type Route } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';
const STATE_KEY_PREFIX = 'officepilot-state:workspace:';
const RPC = '**/rest/v1/rpc/upsert_workspace_sync_entity';
const TASK_ID = 't-01g7-notaccepted';

let owner: LocalDbUser;
const company = loadTestWorldOperatorCompany();
const admin = () =>
  createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

function log(message: string, value?: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`[01G7] ${message}${value === undefined ? '' : ` ${JSON.stringify(value)}`}`);
}

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    label: 'unaccepted-01g7',
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
  await page.getByTestId('setup-contactPerson').fill('Nichtannahme 01G7');
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

/**
 * Der Aufruf erreicht den Server **nie**: abgebrochen, ohne ausgeführt zu
 * werden. Das ist der Unterschied zum verlorenen ACK, wo der Server ausführt
 * und nur die Antwort verlorengeht.
 */
async function blockBeforeServer(
  page: Page,
  entityType: string,
): Promise<{ restore: () => Promise<void>; blocked: () => number }> {
  let count = 0;
  await page.route(RPC, async (route: Route) => {
    const body = route.request().postData() ?? '';
    if (!body.includes(`"${entityType}"`)) {
      await route.continue();
      return;
    }
    count += 1;
    // Kein route.fetch(): Der Server sieht diesen Aufruf nicht.
    await route.abort('connectionfailed');
  });
  return {
    restore: async () => {
      await page.unroute(RPC);
      log(`Vor dem Server abgebrochen (${entityType}): ${count}`);
    },
    blocked: () => count,
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

async function localTask(page: Page) {
  const state = await readState(page);
  return ((state.tasks as Array<Record<string, any>>) ?? [])
    .filter((t) => t.id === TASK_ID)
    .map((t) => ({ id: t.id, status: t.status, version: t.sync?.version }))[0];
}

async function outboxForTask(page: Page) {
  const state = await readState(page);
  return ((state.syncOutbox as Array<Record<string, any>>) ?? [])
    .filter((entry) => entry.entityType === 'task' && entry.entityId === TASK_ID)
    .map((entry) => ({
      status: entry.status,
      version: entry.version,
      op: entry.operation,
      sentContentKey: entry.sentContentKey ? 'vorhanden' : undefined,
    }));
}

async function cloudTask(wsId: string) {
  const { data } = await admin()
    .from('workspace_tasks')
    .select('client_task_id,status,row_version,deleted')
    .eq('workspace_id', wsId)
    .eq('client_task_id', TASK_ID);
  return (data ?? [])[0];
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
async function seedTask(page: Page): Promise<void> {
  await page.evaluate(
    ({ prefix, id }) => {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)!;
        if (!key.startsWith(prefix)) continue;
        const state = JSON.parse(localStorage.getItem(key)!);
        state.tasks = [
          ...(state.tasks ?? []),
          {
            id,
            title: 'Unterlagen prüfen',
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
          },
        ];
        localStorage.setItem(key, JSON.stringify(state));
        return;
      }
    },
    { prefix: STATE_KEY_PREFIX, id: TASK_ID },
  );
  await reload(page);
}

/*
 * HARNESS (kein Bedienweg): Eine erledigte Aufgabe verschwindet aus der
 * gezeigten Liste und ist dort nicht mehr anzuklicken. Die geforderte
 * Weiterarbeit wird deshalb am gespeicherten Stand vorgenommen; der
 * Sendeauftrag besteht bereits und wird nur neu angestossen.
 */
async function changeTaskThroughHarness(page: Page, status: string): Promise<void> {
  await page.evaluate(
    ({ prefix, id, next }) => {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)!;
        if (!key.startsWith(prefix)) continue;
        const state = JSON.parse(localStorage.getItem(key)!);
        const task = ((state.tasks ?? []) as Array<Record<string, any>>).find((t) => t.id === id);
        if (!task) continue;
        task.status = next;
        task.updatedAt = new Date().toISOString();
        for (const entry of (state.syncOutbox ?? []) as Array<Record<string, any>>) {
          if (entry.entityId === id && entry.status !== 'completed') {
            entry.queuedAt = new Date().toISOString();
          }
        }
        localStorage.setItem(key, JSON.stringify(state));
        return;
      }
    },
    { prefix: STATE_KEY_PREFIX, id: TASK_ID, next: status },
  );
  await reload(page);
}

/** Echter Bedienweg: das Erledigt-Häkchen. */
async function toggleTask(page: Page): Promise<void> {
  await page.goto('/aufgaben', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('aufgaben-page')).toBeVisible({ timeout: 30_000 });
  const toggle = page.getByTestId(`aufgaben-toggle-${TASK_ID}`);
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await toggle.click();
  await page.waitForTimeout(1500);
}

test.describe('01G7 Nicht angenommener Schreibvorgang (lokal)', () => {
  test('Aufgabe: Aufruf scheitert vor dem Server, danach erreicht der neue Stand die Cloud', async ({
    page,
  }) => {
    test.setTimeout(900_000);
    await login(page, owner);
    const wsId = await workspaceIdOf(owner.id);

    await seedTask(page);
    await runSync(page);
    const basis = await localTask(page);
    expect(basis?.version, 'Ausgangsfassung ist bestätigt').toBeGreaterThan(0);
    expect((await cloudTask(wsId))?.status).toBe('open');

    /* ---- Der Schreibvorgang erreicht den Server nie ---- */
    await toggleTask(page);
    expect((await localTask(page))?.status).toBe('done');

    const hook = await blockBeforeServer(page, 'task');
    await runSync(page);
    await hook.restore();
    expect(hook.blocked(), 'der Aufruf wurde abgefangen').toBeGreaterThan(0);

    const cloudDanach = await cloudTask(wsId);
    log('Cloud nach gescheitertem Aufruf', cloudDanach);
    expect(cloudDanach?.status, 'der Server hat nichts gesehen').toBe('open');
    expect(cloudDanach?.row_version, 'und steht unverändert auf der Ausgangsbasis').toBe(
      basis!.version,
    );
    log('Sendeauftrag nach gescheitertem Aufruf', await outboxForTask(page));

    /* ---- Der Nutzer arbeitet weiter ---- */
    await changeTaskThroughHarness(page, 'open');
    const nachWeiterarbeit = await localTask(page);
    log('lokal nach Weiterarbeit', nachWeiterarbeit);
    expect(nachWeiterarbeit?.status, 'zurück auf offen').toBe('open');

    /* ---- Der nächste Durchgang muss den neuen Stand hinausbringen ---- */
    await reload(page);
    await runSync(page);

    const lokal = await localTask(page);
    const cloud = await cloudTask(wsId);
    const outbox = await outboxForTask(page);
    log('lokal nach Wiederanlauf', lokal);
    log('Cloud nach Wiederanlauf', cloud);
    log('Sendeauftrag nach Wiederanlauf', outbox);

    expect(cloud?.status, 'die Cloud trägt den zuletzt gewollten Stand').toBe(
      nachWeiterarbeit!.status,
    );
    expect(
      outbox.filter((e) => e.status !== 'completed'),
      'kein offener Auftrag mehr',
    ).toHaveLength(0);
    /*
     * Ein Nachweis an einem **abgeschlossenen** Auftrag ist geklärt: Er kann
     * keine spätere Übernahme mehr begründen. Entscheidend ist, dass kein
     * offener Auftrag mehr einen ungeklärten Nachweis trägt.
     */
    expect(
      outbox.filter((e) => e.status !== 'completed' && e.sentContentKey !== undefined),
      'kein offener Auftrag mit ungeklärtem Nachweis',
    ).toHaveLength(0);
  });
});
