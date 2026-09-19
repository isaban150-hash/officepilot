/**
 * SYNC-DURABILITY-HARDENING-01G4 — die drei Gegenbeispiele des Release-Audits.
 *
 * Gemeinsame Ausgangslage: Der Aufruf erreicht den Server und wird dort
 * ausgefuehrt, die **Antwort** erreicht den Browser nicht. Der Server ist damit
 * weiter als der Client glaubt, und der Client hat einen offenen Sendeauftrag.
 *
 *  G2  Anlegen, Bestaetigung verloren, danach **lokal weitergearbeitet**, erst
 *      dann Wiederanlauf. Der Wiederholungsversuch traegt jetzt einen anderen
 *      Inhalt als die Serverzeile, die aus dem eigenen verlorenen Anlegen
 *      stammt.
 *  G3a Aendern auf einer bestaetigten Fassung, Bestaetigung verloren. Der Server
 *      steht bereits auf dem gewuenschten Stand.
 *  G3b Loeschen auf einer bestaetigten Fassung, Bestaetigung verloren. Der
 *      Server traegt bereits den eigenen Grabstein.
 *
 * Fuer Notizen gibt es in der Oberflaeche kein Bearbeiten (anlegen und loeschen,
 * mehr nicht). Der Textwechsel wird deshalb ueber einen deterministischen
 * Harness gestellt und ist im Bericht als solcher ausgewiesen; der
 * Statuswechsel der Aufgabe laeuft dagegen ueber die echte Oberflaeche.
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
  console.log(`[01G4] ${message}${value === undefined ? '' : ` ${JSON.stringify(value)}`}`);
}

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    label: 'lostack-01g4',
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
  await page.getByTestId('setup-contactPerson').fill('Recovery 01G4');
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

/** Der Server fuehrt aus, die Antwort geht verloren — genau ein Funkloch. */
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

const STATE_KEY_PREFIX = 'officepilot-state:workspace:';

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

async function localNotes(page: Page) {
  const state = await readState(page);
  return ((state.vorgangNotes as Array<Record<string, any>>) ?? []).map((n) => ({
    id: n.id,
    body: n.body,
    version: n.sync?.version,
    deleted: n.sync?.deleted ?? false,
  }));
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

async function outboxFor(page: Page, entityType: string) {
  const state = await readState(page);
  return ((state.syncOutbox as Array<Record<string, any>>) ?? [])
    .filter((entry) => entry.entityType === entityType)
    .map((entry) => ({
      entityId: entry.entityId,
      status: entry.status,
      version: entry.version,
      op: entry.operation,
      reason: entry.blockedReason,
    }));
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
  const toggle = page.getByTestId('vorgang-detail-show-more').getByTestId('show-more-toggle');
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 20_000 });
  await expect(page.locator('textarea.input').first()).toBeVisible({ timeout: 20_000 });
}

async function addNoteThroughUi(page: Page, vorgangId: string, body: string): Promise<void> {
  await openVorgangNotes(page, vorgangId);
  await page.locator('textarea.input').first().fill(body);
  await page.getByRole('button', { name: 'Notiz speichern' }).click();
  await page.waitForTimeout(1500);
}

/*
 * HARNESS (kein Produktweg): Die Oberflaeche kennt kein Bearbeiten von Notizen.
 * Fuer die geforderte lokale Weiterarbeit wird der gespeicherte Text direkt
 * geaendert und derselbe Sendeauftrag vermerkt, den eine Bearbeitung erzeugen
 * wuerde. Danach traegt der Wiederholungsversuch einen anderen Inhalt als die
 * Serverzeile — genau der Fall des Audits.
 */
async function editNoteThroughHarness(page: Page, noteId: string, body: string): Promise<void> {
  await page.evaluate(
    ({ prefix, id, text }) => {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)!;
        if (!key.startsWith(prefix)) continue;
        const state = JSON.parse(localStorage.getItem(key)!);
        const notes = (state.vorgangNotes ?? []) as Array<Record<string, any>>;
        const note = notes.find((n) => n.id === id);
        if (!note) continue;
        note.body = text;
        note.updatedAt = new Date().toISOString();
        const outbox = (state.syncOutbox ?? []) as Array<Record<string, any>>;
        const open = outbox.find((e) => e.entityId === id && e.status !== 'completed');
        if (open) {
          open.queuedAt = new Date().toISOString();
        } else {
          outbox.unshift({
            id: `ob-01g4-${id}`,
            entityType: 'vorgang_note',
            entityId: id,
            operation: 'update',
            version: note.sync?.version ?? 0,
            queuedAt: new Date().toISOString(),
            retryCount: 0,
            status: 'pending',
          });
        }
        state.syncOutbox = outbox;
        localStorage.setItem(key, JSON.stringify(state));
        return;
      }
    },
    { prefix: STATE_KEY_PREFIX, id: noteId, text: body },
  );
}

test.describe('01G4 Lost-ACK-Recovery (lokal)', () => {
  test('G2/G3: Wiederanlauf nach verlorener Bestaetigung', async ({ page }) => {
    test.setTimeout(1_200_000);
    await login(page, owner);
    const wsId = await workspaceIdOf(owner.id);
    await uploadDoc00001ToAnalyzedDetail(page);
    await acceptContractOrderThroughUi(page);
    await expect(page.getByTestId('vorgang-detail-page')).toBeVisible({ timeout: 60_000 });
    const vorgangId = new URL(page.url()).pathname.split('/').pop()!;
    await runSync(page);
    log('Ausgang: Workspace/Vorgang', { wsId, vorgangId });

    /* ============================================================
     * G2 — Notiz: Anlegen, Bestaetigung verloren, danach Text geaendert.
     * ============================================================ */
    await addNoteThroughUi(page, vorgangId, 'G2 Erstfassung');
    const created = (await localNotes(page)).find((n) => n.body === 'G2 Erstfassung')!;
    expect.soft(created, 'G2: Notiz wurde angelegt').toBeTruthy();

    const restoreNote = await loseAcksFor(page, 'vorgang_note');
    await runSync(page);
    await restoreNote();
    log('G2-1 Cloud nach verlorener Bestaetigung', await cloudNotes(wsId));
    log('G2-1 Outbox', await outboxFor(page, 'vorgang_note'));

    // Der Nutzer arbeitet weiter, bevor irgendetwas wiederhergestellt wurde.
    await editNoteThroughHarness(page, created.id, 'G2 Zweitfassung nach Funkloch');
    await reload(page);
    log('G2-2 lokal nach Weiterarbeit', await localNotes(page));
    log('G2-2 Outbox nach Weiterarbeit', await outboxFor(page, 'vorgang_note'));

    await runSync(page);
    const g2Local = await localNotes(page);
    const g2Cloud = await cloudNotes(wsId);
    const g2Outbox = await outboxFor(page, 'vorgang_note');
    log('G2-3 lokal nach Wiederanlauf', g2Local);
    log('G2-3 Cloud nach Wiederanlauf', g2Cloud);
    log('G2-3 Outbox nach Wiederanlauf', g2Outbox);

    expect.soft(g2Local.filter((n) => !n.deleted), 'G2: keine Dublette').toHaveLength(1);
    expect.soft(g2Local[0]?.body, 'G2: die spaetere Fassung bleibt erhalten').toBe(
      'G2 Zweitfassung nach Funkloch',
    );
    expect.soft(g2Cloud.filter((n) => !n.deleted), 'G2: eine aktive Cloud-Zeile').toHaveLength(1);
    expect.soft(g2Cloud[0]?.body, 'G2: die Cloud traegt die spaetere Fassung').toBe(
      'G2 Zweitfassung nach Funkloch',
    );
    expect.soft(
      g2Outbox.filter((e) => e.status === 'blocked' || e.status === 'error'),
      'G2: kein haengender Sendeauftrag',
    ).toHaveLength(0);

    /* ============================================================
     * G3a — Notiz: Aenderung auf bestaetigter Fassung, Bestaetigung verloren.
     * ============================================================ */
    const g3Base = (await localNotes(page))[0]!;
    expect.soft(g3Base.version, 'G3a: Ausgangsfassung ist bestaetigt').toBeGreaterThan(0);

    await editNoteThroughHarness(page, g3Base.id, 'G3a Geaenderte Fassung');
    await reload(page);
    const restoreG3 = await loseAcksFor(page, 'vorgang_note');
    await runSync(page);
    await restoreG3();
    log('G3a-1 Cloud nach verlorener Bestaetigung', await cloudNotes(wsId));
    log('G3a-1 Outbox', await outboxFor(page, 'vorgang_note'));

    await reload(page);
    await runSync(page);
    const g3Local = await localNotes(page);
    const g3Cloud = await cloudNotes(wsId);
    const g3Outbox = await outboxFor(page, 'vorgang_note');
    log('G3a-2 lokal nach Wiederanlauf', g3Local);
    log('G3a-2 Cloud nach Wiederanlauf', g3Cloud);
    log('G3a-2 Outbox nach Wiederanlauf', g3Outbox);

    expect.soft(g3Local[0]?.body, 'G3a: die Aenderung bleibt').toBe('G3a Geaenderte Fassung');
    expect.soft(g3Cloud.filter((n) => !n.deleted)[0]?.body, 'G3a: die Cloud traegt sie ebenfalls').toBe(
      'G3a Geaenderte Fassung',
    );
    expect.soft(
      g3Outbox.filter((e) => e.status === 'blocked' || e.status === 'error'),
      'G3a: kein haengender Sendeauftrag',
    ).toHaveLength(0);
    expect.soft(
      g3Cloud.filter((n) => !n.deleted)[0]?.version,
      'G3a: kein unnoetiger Versionssprung',
    ).toBeLessThanOrEqual(3);

    /* ============================================================
     * G3b — Notiz: Loeschen auf bestaetigter Fassung, Bestaetigung verloren.
     * ============================================================ */
    const doomed = (await localNotes(page)).find((n) => !n.deleted)!;
    await openVorgangNotes(page, vorgangId);
    await page.getByTestId(`vorgang-note-delete-${doomed.id}`).click();
    const confirm = page.getByRole('button', { name: 'Löschen' });
    if (await confirm.count()) await confirm.last().click();
    await page.waitForTimeout(1500);
    log('G3b-0 lokal nach Loeschen', await localNotes(page));

    const restoreDel = await loseAcksFor(page, 'vorgang_note');
    await runSync(page);
    await restoreDel();
    log('G3b-1 Cloud nach verlorener Bestaetigung', await cloudNotes(wsId));
    log('G3b-1 Outbox', await outboxFor(page, 'vorgang_note'));

    await reload(page);
    await runSync(page);
    const delLocal = await localNotes(page);
    const delCloud = await cloudNotes(wsId);
    const delOutbox = await outboxFor(page, 'vorgang_note');
    log('G3b-2 lokal nach Wiederanlauf', delLocal);
    log('G3b-2 Cloud nach Wiederanlauf', delCloud);
    log('G3b-2 Outbox nach Wiederanlauf', delOutbox);

    expect.soft(delLocal.filter((n) => !n.deleted), 'G3b: bleibt geloescht').toHaveLength(0);
    expect.soft(delCloud.filter((n) => !n.deleted), 'G3b: auch in der Cloud geloescht').toHaveLength(0);
    expect.soft(
      delOutbox.filter((e) => e.status === 'blocked' || e.status === 'error'),
      'G3b: kein haengender Sendeauftrag',
    ).toHaveLength(0);

    /* ============================================================
     * G2-Aufgabe — Anlegen, Bestaetigung verloren, danach Status ueber die
     * echte Oberflaeche geaendert.
     * ============================================================ */
    await page.evaluate((prefix) => {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)!;
        if (!key.startsWith(prefix)) continue;
        const state = JSON.parse(localStorage.getItem(key)!);
        state.tasks = [
          ...(state.tasks ?? []),
          {
            id: 't-01g4-lostack',
            title: 'Unterlagen prüfen',
            description: 'Vor dem Sync angelegt',
            status: 'open',
            priority: 'mittel',
            category: 'dokumente',
            sourceType: 'inbox',
            sourceId: 'lostack-01g4',
            taskKind: 'inbox_template:dokument_pruefen',
            dedupeKey: 'inbox:lostack-01g4:follow_up',
            autoCreated: true,
            createdAt: '2026-07-01T08:00:00.000Z',
            type: 'dokument_pruefen',
          },
        ];
        localStorage.setItem(key, JSON.stringify(state));
        return;
      }
    }, STATE_KEY_PREFIX);
    await reload(page);

    const restoreTask = await loseAcksFor(page, 'task');
    await runSync(page);
    await restoreTask();
    log('T-1 Cloud nach verlorener Bestaetigung', await cloudTasks(wsId));
    log('T-1 lokal', await localTasks(page));
    log('T-1 Outbox', await outboxFor(page, 'task'));

    // Weiterarbeit ueber die echte Oberflaeche, bevor irgendetwas erholt wurde.
    await page.goto('/aufgaben', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('aufgaben-page')).toBeVisible({ timeout: 30_000 });
    const toggle = page.getByTestId('aufgaben-toggle-t-01g4-lostack');
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await toggle.click();
    await page.waitForTimeout(1500);
    log('T-2 lokal nach Statuswechsel', await localTasks(page));
    log('T-2 Outbox nach Statuswechsel', await outboxFor(page, 'task'));

    await reload(page);
    await runSync(page);
    const tLocal = await localTasks(page);
    const tCloud = await cloudTasks(wsId);
    const tOutbox = await outboxFor(page, 'task');
    log('T-3 lokal nach Wiederanlauf', tLocal);
    log('T-3 Cloud nach Wiederanlauf', tCloud);
    log('T-3 Outbox nach Wiederanlauf', tOutbox);

    const mine = tLocal.filter((t) => t.id === 't-01g4-lostack');
    expect.soft(mine, 'Aufgabe: keine Dublette').toHaveLength(1);
    expect.soft(mine[0]?.status, 'Aufgabe: der spaetere Status bleibt').toBe('done');
    const mineCloud = (tCloud as Array<Record<string, any>>).filter(
      (t) => t.client_task_id === 't-01g4-lostack',
    );
    expect.soft(mineCloud, 'Aufgabe: genau eine Cloud-Zeile').toHaveLength(1);
    expect.soft(mineCloud[0]?.status, 'Aufgabe: die Cloud traegt den spaeteren Status').toBe('done');
    expect.soft(
      tOutbox.filter((e) => e.status === 'blocked' || e.status === 'error'),
      'Aufgabe: kein haengender Sendeauftrag',
    ).toHaveLength(0);
  });
});
