/**
 * CLOUD-DURABILITY-CORE-01C — Aufgaben auf zwei Geräten (lokale Supabase).
 *
 * Geprüft wird der Fall, der diesen Block trägt: **Zwei Geräte tragen dieselbe
 * automatische Aufgabe mit verschiedenen Kennungen** — weil beide sie selbst
 * erzeugt haben oder weil beide sie aus der Zeit vor 01C mitbringen. Nach dem
 * Sync darf es genau eine geben, überall.
 *
 *  B  Beide Geräte haben ihre eigene Aufgabe (gleicher `dedupeKey`, andere
 *     Kennung, keine Sync-Meta, kein Sendeauftrag). A synchronisiert, dann B.
 *     Ergebnis: eine aktive Cloud-Zeile, eine Aufgabe auf A, eine auf B, keine
 *     liegengebliebene Sendeaufgabe, keine zweite nach Neustart und erneutem
 *     Engine-Lauf.
 *  A  Die überlebende Aufgabe ist auf beiden Geräten sichtbar und bedienbar:
 *     erledigen auf Gerät 2 -> Sync -> Gerät 1 zeigt sie erledigt.
 *  C  Altbestand: Derselbe Ausgangszustand ohne Sync-Meta und ohne
 *     Sendeauftrag ist genau das, was der Change-Tracker beim Start zur
 *     Basislinie macht und nie nachmeldet — nur der Backfill bringt ihn in die
 *     Cloud. Er wird hier gemeinsam mit B nachgewiesen.
 *
 * Der Ausgangszustand wird in den lokalen Speicher geschrieben, nicht über die
 * Oberfläche erzeugt: Der einzige Generator, der ohne Nutzeraktion feuert,
 * hängt an einer überfälligen Rechnung, und eine heute erstellte Rechnung kann
 * heute nicht überfällig sein (das Produkt weist ein Zahlungsziel vor dem
 * Rechnungsdatum zu Recht ab). Gespiegelt wird ausschliesslich der **lokale
 * Vorzustand**; Sync, Server-Entdopplung, Auflösung und Oberfläche laufen
 * danach vollständig echt.
 *
 * Nicht hier, sondern serverseitig und im Dienst geprüft: dass zwei
 * gleichnamige **manuelle** Aufgaben getrennt bleiben (das Produkt hat keine
 * Oberfläche, die eine Aufgabe frei anlegt, und dieser Block baut keine), und
 * dass nach dem Erledigen eine neue Episode desselben Schlüssels entstehen darf.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let owner: LocalDbUser;
const company = loadTestWorldOperatorCompany();
const admin = () =>
  createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const DEDUPE_KEY = 'inbox:lieferschein-01c:follow_up';

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    label: 'task-dedupe-owner',
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
  await page.getByTestId('setup-contactPerson').fill('Aufgaben Test');
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

/** Sync über die Synchronisationsseite (sichtbarer Nutzerweg). */
async function runSync(page: Page): Promise<void> {
  await page.goto('/synchronisation', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sync-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('sync-run-button').click();
  await expect(page.getByTestId('sync-run-button')).toBeEnabled({ timeout: 60_000 });
  await page.waitForTimeout(1200);
}

/** Die Aufgabenseite — ihr blosses Öffnen lässt die Engine laufen. */
async function openTasks(page: Page): Promise<void> {
  await page.goto('/aufgaben', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('aufgaben-page')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1200);
}

interface LocalTask {
  id: string;
  title: string;
  status: string;
  dedupeKey: string;
  autoCreated: boolean;
  syncVersion?: number;
  deleted?: boolean;
}

async function readState(page: Page): Promise<Record<string, unknown>> {
  const raw = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (key.startsWith('officepilot-state:workspace:')) return localStorage.getItem(key);
    }
    return null;
  });
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function localTasks(page: Page): Promise<LocalTask[]> {
  const state = await readState(page);
  return ((state.tasks as Array<Record<string, any>>) ?? []).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    dedupeKey: t.dedupeKey,
    autoCreated: t.autoCreated,
    syncVersion: t.sync?.version,
    deleted: t.sync?.deleted,
  }));
}

function activeFor(tasks: LocalTask[], dedupeKey: string): LocalTask[] {
  return tasks.filter(
    (t) => t.dedupeKey === dedupeKey && !t.deleted && ['open', 'in_progress'].includes(t.status),
  );
}

async function openTaskOutbox(page: Page): Promise<Array<Record<string, unknown>>> {
  const state = await readState(page);
  return ((state.syncOutbox as Array<Record<string, any>>) ?? []).filter(
    (entry) => entry.entityType === 'task' && entry.status !== 'completed',
  );
}

async function cloudTasks(wsId: string) {
  const { data } = await admin()
    .from('workspace_tasks')
    .select('client_task_id,status,dedupe_key,auto_created,row_version,deleted')
    .eq('workspace_id', wsId);
  return data ?? [];
}

function activeAutoRows(rows: Awaited<ReturnType<typeof cloudTasks>>, dedupeKey: string) {
  return rows.filter(
    (row) =>
      row.dedupe_key === dedupeKey &&
      row.auto_created === true &&
      row.deleted === false &&
      ['open', 'in_progress'].includes(row.status as string),
  );
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
 * Der lokale Vorzustand eines Geräts: eine automatische Aufgabe ohne Sync-Meta
 * und ohne Sendeauftrag. Genau so sieht eine Aufgabe aus, die dieses Gerät
 * selbst erzeugt hat oder aus der Zeit vor 01C mitbringt.
 */
async function seedDeviceTask(page: Page, taskId: string, createdAt: string): Promise<void> {
  await page.evaluate(
    ({ id, key, created }) => {
      for (let i = 0; i < localStorage.length; i += 1) {
        const storageKey = localStorage.key(i)!;
        if (!storageKey.startsWith('officepilot-state:workspace:')) continue;
        const state = JSON.parse(localStorage.getItem(storageKey)!);
        state.tasks = [
          ...(state.tasks ?? []),
          {
            id,
            title: 'Lieferschein prüfen',
            description: 'Lieferung SanitärPartner — Mengen prüfen',
            status: 'open',
            priority: 'mittel',
            category: 'dokumente',
            sourceType: 'inbox',
            sourceId: 'lieferschein-01c',
            taskKind: 'inbox_template:dokument_pruefen',
            dedupeKey: key,
            autoCreated: true,
            createdAt: created,
            type: 'dokument_pruefen',
          },
        ];
        localStorage.setItem(storageKey, JSON.stringify(state));
        return;
      }
    },
    { id: taskId, key: DEDUPE_KEY, created: createdAt },
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
}

test.describe('CLOUD-DURABILITY-CORE-01C (lokal)', () => {
  test('A–C: dieselbe Aufgabe auf zwei Geräten bleibt eine', async ({ page, browser }) => {
    test.setTimeout(600_000);
    await login(page, owner, true);
    const wsId = await workspaceIdOf(owner.id);
    await runSync(page);

    const device2 = await openSecondDevice(browser, owner);
    try {
      /* ---------------- Ausgangszustand: beide Geräte, eine Sache ---------------- */
      await seedDeviceTask(page, 't-device-a', '2026-05-01T08:00:00.000Z');
      await seedDeviceTask(device2.page, 't-device-b', '2026-05-01T08:00:05.000Z');

      const before1 = activeFor(await localTasks(page), DEDUPE_KEY);
      const before2 = activeFor(await localTasks(device2.page), DEDUPE_KEY);
      /*
       * Gerät 1 trägt seine eigene Kennung. Gerät 2 zeigt bereits hier **genau eine** Aufgabe:
       * Sein Neustart zieht den Stand von Gerät 1, und die Auflösung nach dem
       * Pull räumt die eigene, noch nie gesendete Zweitfassung sofort weg. Der
       * Nutzer sieht die Dublette also zu keinem Zeitpunkt.
       */
      expect(before1.map((t) => t.id)).toEqual(['t-device-a']);
      expect(before2).toHaveLength(1);
      expect(await openTaskOutbox(device2.page)).toEqual([]);

      /* ---------------- Fall B/C: Sync, Backfill, Entdopplung ---------------- */
      await runSync(page);
      const afterFirst = activeAutoRows(await cloudTasks(wsId), DEDUPE_KEY);
      expect(afterFirst, 'Altbestand von Gerät 1 ist nicht in der Cloud').toHaveLength(1);
      expect(afterFirst[0].client_task_id).toBe('t-device-a');

      await runSync(device2.page);

      // Cloud: weiterhin genau eine aktive automatische Aufgabe.
      expect(activeAutoRows(await cloudTasks(wsId), DEDUPE_KEY)).toHaveLength(1);

      // Gerät 2: eigene Kennung weg, kanonische da, kein offener Sendeauftrag.
      const tasks2 = await localTasks(device2.page);
      expect(activeFor(tasks2, DEDUPE_KEY).map((t) => t.id)).toEqual(['t-device-a']);
      expect(tasks2.some((t) => t.id === 't-device-b' && !t.deleted)).toBe(false);
      expect(await openTaskOutbox(device2.page)).toEqual([]);

      // Gerät 1: unverändert genau eine.
      await runSync(page);
      expect(activeFor(await localTasks(page), DEDUPE_KEY).map((t) => t.id)).toEqual(['t-device-a']);
      expect(await openTaskOutbox(page)).toEqual([]);

      /* ---------------- Fall A: sichtbar und bedienbar auf beiden Geräten ---------------- */
      await openTasks(page);
      await expect(page.getByTestId('aufgaben-row-t-device-a')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('aufgaben-row-t-device-b')).toHaveCount(0);

      await openTasks(device2.page);
      await expect(device2.page.getByTestId('aufgaben-row-t-device-a')).toBeVisible({ timeout: 30_000 });
      await expect(device2.page.getByTestId('aufgaben-row-t-device-b')).toHaveCount(0);
      // Kein horizontaler Ueberlauf — auf dem Handy die eigentliche Pruefung.
      const overflow = await device2.page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      // Keine technische Kennung in der sichtbaren Zeile.
      await expect(device2.page.getByTestId('aufgaben-row-t-device-a')).not.toContainText('t-device-a');

      // Erledigen auf Gerät 2 ...
      // click statt check: Die Liste baut sich nach dem Erledigen neu auf, und
      // ein wartendes check() käme auf der entfernten Zeile nie zur Ruhe.
      await device2.page.getByTestId('aufgaben-toggle-t-device-a').click();
      await device2.page.waitForTimeout(1500);
      expect((await localTasks(device2.page)).find((t) => t.id === 't-device-a')?.status).toBe('done');
      await runSync(device2.page);
      expect(
        (await cloudTasks(wsId)).find((row) => row.client_task_id === 't-device-a')?.status,
      ).toBe('done');

      // ... kommt auf Gerät 1 an.
      await runSync(page);
      expect((await localTasks(page)).find((t) => t.id === 't-device-a')?.status).toBe('done');
      await openTasks(page);
      await expect(page.getByTestId('aufgaben-row-t-device-a')).toHaveCount(0);
      await page.getByTestId('aufgaben-filter-erledigt').click();
      await expect(page.getByTestId('aufgaben-row-t-device-a')).toBeVisible({ timeout: 15_000 });

      /* ---------------- Neustart und erneuter Engine-Lauf ---------------- */
      await device2.page.reload({ waitUntil: 'domcontentloaded' });
      await openTasks(device2.page);
      await openTasks(device2.page);
      const afterReload = (await localTasks(device2.page)).filter(
        (t) => t.dedupeKey === DEDUPE_KEY && !t.deleted,
      );
      expect(afterReload).toHaveLength(1);
      expect(afterReload[0].id).toBe('t-device-a');
      expect(afterReload[0].status).toBe('done');

      const finalCloud = await cloudTasks(wsId);
      expect(finalCloud.filter((row) => row.dedupe_key === DEDUPE_KEY)).toHaveLength(1);
      // Demo-Aufgaben haben die Cloud nie erreicht.
      expect(finalCloud.some((row) => ['t-001', 't-002', 't-003'].includes(row.client_task_id as string))).toBe(false);
    } finally {
      await device2.context.close();
    }
  });
});
