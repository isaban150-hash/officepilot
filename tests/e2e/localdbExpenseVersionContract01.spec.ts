/**
 * P1 EXPENSE-SYNC-VERSIONSVERTRAG — sichtbarer Nachweis gegen die **lokale**
 * Supabase-Instanz (synthetischer Testnutzer, eigener Workspace).
 *
 * Vorher: Server v1 → lokale Bearbeitung zählte auf 2 → Versionskonflikt; im
 * Konkurrenzfall traf die erfundene 2 die echte Remote-v2 und überschrieb die
 * Fremdänderung still (Cloud v3 mit dem Wert von A).
 *
 *  N  anlegen → Sync v1 → bearbeiten → Push erwartet 1 → Server v2, Outbox erledigt
 *  R  Reload zeigt die Änderung; zweiter Browserkontext sieht sie
 *  D  Löschen einer synchronisierten Ausgabe → Push erwartet 1 → Server gelöscht
 *  K  A offline auf v1, B schreibt v2, A bearbeitet → Konflikt; Bs Wert bleibt, kein v3
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test, type Page, type Response } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const ANON_KEY = process.env.E2E_LOCALDB_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const company = loadTestWorldOperatorCompany();
let user: LocalDbUser;

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SUPABASE_URL)) throw new Error('Nur gegen die lokale Instanz.');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'expense-version-01' });
});

test.afterAll(async () => {
  if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
});

async function login(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-email').fill(user.email);
  await page.getByTestId('login-password').fill(user.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-page')).toBeHidden({ timeout: 30_000 });
}

async function loginAndSetup(page: Page): Promise<void> {
  await login(page);
  const landed = await Promise.race([
    page.getByTestId('app-shell').waitFor({ timeout: 30_000 }).then(() => 'shell' as const),
    page.getByTestId('workspace-setup-continue').waitFor({ timeout: 30_000 }).then(() => 'continue' as const),
    page.getByTestId('setup-companyName').waitFor({ timeout: 30_000 }).then(() => 'wizard' as const),
  ]);
  if (landed === 'shell') return;
  if (landed === 'continue') await page.getByTestId('workspace-setup-continue').click();
  await page.getByTestId('setup-companyName').fill(company.companyName);
  await page.getByTestId('setup-contactPerson').fill('F. Test');
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

async function createExpense(page: Page, title: string): Promise<string> {
  await page.goto('/ausgaben/neu', { waitUntil: 'domcontentloaded' });
  // Das Formular führt „Lieferant" inzwischen zweimal — eindeutig das erste exakte Feld.
  await page.getByLabel('Titel', { exact: true }).first().fill(title);
  await page.getByLabel('Lieferant', { exact: true }).first().fill('Baustoff Nord GmbH');
  await page.getByLabel('Rechnungsnummer').fill(`RE-${Date.now()}`);
  await page.getByLabel('Rechnungsdatum').fill('2026-09-01');
  await page.getByLabel('Bruttobetrag').fill('119');
  await page.getByRole('button', { name: 'Ausgabe speichern' }).click();
  await page.waitForURL(/\/ausgaben\/exp-/, { timeout: 30_000 });
  return new URL(page.url()).pathname.split('/').pop()!;
}

/** Bearbeiten auf der bereits geöffneten Detailseite — ohne Navigation. */
async function editTitleInPlace(page: Page, title: string): Promise<void> {
  await page.getByTestId('ausgabe-edit').click();
  await page.getByLabel('Titel', { exact: true }).first().fill(title);
  await page.getByRole('button', { name: 'Änderungen speichern' }).click();
  await expect(page.getByTestId('ausgabe-edit')).toBeVisible({ timeout: 10_000 });
}

type Push = { sent: number; deleted: boolean; status: number; body: { row_version?: number; message?: string } };

function isExpensePush(id: string) {
  return (response: Response) => {
    if (!response.url().includes('/rpc/upsert_workspace_expense')) return false;
    try {
      return (JSON.parse(response.request().postData() ?? '{}') as { p_payload?: { client_expense_id?: string } }).p_payload?.client_expense_id === id;
    } catch {
      return false;
    }
  };
}

async function readPush(response: Response): Promise<Push> {
  const sent = JSON.parse(response.request().postData() ?? '{}') as { p_row_version?: number; p_payload?: { deleted?: boolean } };
  const text = await response.text();
  let body: Push['body'] = {};
  try { body = JSON.parse(text) as Push['body']; } catch { /* kein JSON */ }
  return { sent: Number(sent.p_row_version), deleted: Boolean(sent.p_payload?.deleted), status: response.status(), body };
}

/**
 * Wartet auf den nächsten Push dieser Ausgabe und liest seine Antwort, bevor
 * die Seite wechselt. Kommt kein automatischer Push, wird der Sync über die
 * Synchronisationsseite ausgelöst und dort auf die Antwort gewartet.
 */
async function capturePush(page: Page, id: string): Promise<Push> {
  const auto = await page.waitForResponse(isExpensePush(id), { timeout: 8_000 }).catch(() => null);
  if (auto) return readPush(auto);
  await page.goto('/synchronisation', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sync-page')).toBeVisible({ timeout: 30_000 });
  const manual = page.waitForResponse(isExpensePush(id), { timeout: 45_000 });
  await page.getByTestId('sync-run-button').click();
  const response = await manual;
  await expect(page.getByTestId('sync-run-button')).toBeEnabled({ timeout: 60_000 });
  return readPush(response);
}

async function localExpense(page: Page, id: string) {
  return page.evaluate((expenseId) => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (!key.startsWith('officepilot-state:workspace:')) continue;
      const s = JSON.parse(localStorage.getItem(key)!) as {
        expenses?: Array<{ id: string; title: string; sync?: { version?: number; deleted?: boolean } }>;
        syncOutbox?: Array<{ entityType: string; entityId: string; status: string }>;
      };
      const e = (s.expenses ?? []).find((x) => x.id === expenseId);
      const outbox = (s.syncOutbox ?? []).filter((o) => o.entityType === 'expense' && o.entityId === expenseId).map((o) => o.status);
      return { version: e?.sync?.version ?? null, deleted: e?.sync?.deleted ?? false, title: e?.title ?? null, outbox };
    }
    return null;
  }, id);
}

type CloudExpense = { row_version: number; deleted: boolean; payload: { title?: string } };
async function cloudExpense(id: string): Promise<CloudExpense | null> {
  const { data } = await admin().from('workspace_expenses').select('row_version,deleted,payload').eq('client_expense_id', id).maybeSingle();
  return (data as CloudExpense | null) ?? null;
}

async function createSynced(page: Page, title: string): Promise<string> {
  const id = await createExpense(page, title);
  const created = await capturePush(page, id);
  expect(created.status, `create ${title}`).toBe(200);
  await expect.poll(async () => (await cloudExpense(id))?.row_version ?? 0, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await localExpense(page, id))?.version ?? null, { timeout: 30_000 }).toBe(1);
  return id;
}

test('P1 Expense-Versionsvertrag: Bearbeiten, Löschen und echter Konflikt nach dem ersten Sync', async ({ page, browser }) => {
  test.setTimeout(540_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 200)));
  await loginAndSetup(page);

  // N — Normalfall
  const n = await createSynced(page, 'P1 Ausgabe N');
  await page.goto(`/ausgaben/${n}`, { waitUntil: 'domcontentloaded' });
  await editTitleInPlace(page, 'P1 Ausgabe N bearbeitet');
  expect((await localExpense(page, n))?.version).toBe(1);
  const edit = await capturePush(page, n);
  console.log(`[P1-EXP] N Edit-Push: ${JSON.stringify(edit)}`);
  expect({ sent: edit.sent, status: edit.status, row: edit.body.row_version }).toEqual({ sent: 1, status: 200, row: 2 });
  await expect.poll(async () => {
    const row = await cloudExpense(n);
    return row ? `v${row.row_version}|${row.payload.title}` : '';
  }, { timeout: 30_000 }).toBe('v2|P1 Ausgabe N bearbeitet');
  await expect.poll(async () => (await localExpense(page, n))?.version ?? null, { timeout: 30_000 }).toBe(2);
  expect((await localExpense(page, n))!.outbox.filter((status) => status !== 'completed')).toEqual([]);
  await page.screenshot({ path: 'test-results/localdb/p1-expense-1-bearbeitet.png', fullPage: false });

  // R — Reload und zweiter Browserkontext
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await localExpense(page, n))?.title ?? null, { timeout: 30_000 }).toBe('P1 Ausgabe N bearbeitet');
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await login(other);
  await expect(other.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await localExpense(other, n))?.title ?? null, { timeout: 90_000 }).toBe('P1 Ausgabe N bearbeitet');
  await other.goto(`/ausgaben/${n}`, { waitUntil: 'domcontentloaded' });
  await expect(other.getByText('P1 Ausgabe N bearbeitet').first()).toBeVisible({ timeout: 30_000 });
  await other.screenshot({ path: 'test-results/localdb/p1-expense-2-zweites-geraet.png', fullPage: false });
  await otherContext.close();

  // D — Löschen einer synchronisierten Ausgabe
  const d = await createSynced(page, 'P1 Ausgabe D');
  await page.goto(`/ausgaben/${d}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Löschen', exact: true }).click();
  await page.getByRole('button', { name: 'Endgültig löschen' }).click();
  await page.waitForURL(/\/ausgaben(\?.*)?$/, { timeout: 30_000 });
  const del = await capturePush(page, d);
  console.log(`[P1-EXP] D Delete-Push: ${JSON.stringify(del)}`);
  expect({ sent: del.sent, deleted: del.deleted, status: del.status }).toEqual({ sent: 1, deleted: true, status: 200 });
  await expect.poll(async () => {
    const row = await cloudExpense(d);
    return row ? `v${row.row_version}|${row.deleted}` : '';
  }, { timeout: 30_000 }).toBe('v2|true');

  // K — Konkurrenz: A offline auf v1, B schreibt v2, A bearbeitet → Konflikt, Bs Wert bleibt
  const k = await createSynced(page, 'P1 Ausgabe K');
  await page.goto(`/ausgaben/${k}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('ausgabe-edit')).toBeVisible({ timeout: 30_000 });
  await page.context().setOffline(true);
  const b: SupabaseClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  expect((await b.auth.signInWithPassword({ email: user.email, password: user.password })).error).toBeNull();
  const { data: ws } = await admin().from('workspace_members').select('workspace_id').eq('user_id', user.id).eq('status', 'active').single();
  const { data: base } = await admin().from('workspace_expenses').select('status,dedupe_key,linked_inbox_id,archive_document_id,payload').eq('client_expense_id', k).single();
  const row = base as { status: string; dedupe_key: string; linked_inbox_id: string | null; archive_document_id: string | null; payload: Record<string, unknown> };
  const foreign = await b.rpc('upsert_workspace_expense', {
    p_workspace_id: (ws as { workspace_id: string }).workspace_id,
    p_payload: {
      client_expense_id: k, status: row.status, dedupe_key: row.dedupe_key, linked_inbox_id: row.linked_inbox_id,
      archive_document_id: row.archive_document_id, payload: { ...row.payload, title: 'Fremdaenderung Geraet B' }, deleted: false,
    },
    p_row_version: 1,
  });
  expect(foreign.error).toBeNull();
  expect(await cloudExpense(k)).toMatchObject({ row_version: 2, payload: { title: 'Fremdaenderung Geraet B' } });

  await editTitleInPlace(page, 'Lokal von A ohne B');
  expect((await localExpense(page, k))?.version).toBe(1);
  const conflictPush = page.waitForResponse(isExpensePush(k), { timeout: 60_000 });
  await page.context().setOffline(false);
  let conflict: Push;
  const auto = await Promise.race([conflictPush, page.waitForTimeout(10_000).then(() => null)]);
  if (auto) {
    conflict = await readPush(auto);
  } else {
    conflict = await capturePush(page, k);
  }
  console.log(`[P1-EXP] K Push: ${JSON.stringify(conflict)}`);
  expect(conflict.sent).toBe(1);
  expect(conflict.status).toBe(400);
  expect(conflict.body.message ?? '').toContain('Versionskonflikt');
  // Bs Wert bleibt, A erzeugt kein v3 — auch nicht nach einem weiteren Sync.
  await page.waitForTimeout(5_000);
  await page.goto('/synchronisation', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sync-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('sync-run-button').click();
  await expect(page.getByTestId('sync-run-button')).toBeEnabled({ timeout: 60_000 });
  await page.waitForTimeout(2_000);
  expect(await cloudExpense(k)).toMatchObject({ row_version: 2, deleted: false, payload: { title: 'Fremdaenderung Geraet B' } });
  const aState = (await localExpense(page, k))!;
  expect(aState.version).toBe(1);
  expect(aState.title).toBe('Lokal von A ohne B');
  expect(aState.outbox).toContain('blocked');

  expect(pageErrors).toEqual([]);
});
