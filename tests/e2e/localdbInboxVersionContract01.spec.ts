/**
 * P1 INTAKE-VERSIONSKONFLIKT — sichtbarer Nachweis gegen die **lokale**
 * Supabase-Instanz (synthetischer Testnutzer, eigener Workspace).
 *
 * Vorher: Ein bereits synchronisierter Eingang (Server v1) wurde beim
 * Verknüpfen lokal auf v2 hochgezählt; `upsert_workspace_intake_entity`
 * meldete „Versionskonflikt inbox_item:1", der Eintrag blieb blockiert.
 *
 *  1–6  Upload → erster Sync (v1) → verknüpfen → Push erwartet 1 → Server v2 mit vorgang_id, Outbox erledigt
 *  7    Reload zeigt die Verknüpfung
 *  8    zweiter Browserkontext sieht dieselbe Verknüpfung
 *  9    Löschen eines synchronisierten Eingangs erreicht die Cloud
 *  K    echter Konkurrenzkonflikt bleibt Konflikt (kein Überschreiben)
 *  S    schneller Edit vor dem ersten Ack bleibt korrekt
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';
import { acceptContractOrderThroughUi } from './support/localDoc00001VorgangFlow';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const ANON_KEY = process.env.E2E_LOCALDB_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const company = loadTestWorldOperatorCompany();
let user: LocalDbUser;

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SUPABASE_URL)) throw new Error('Nur gegen die lokale Instanz.');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'inbox-version-01' });
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

async function pdf(lines: string[], name: string): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  lines.forEach((line, index) => page.drawText(line, { x: 60, y: 760 - index * 22, size: 12, font }));
  const file = path.join(os.tmpdir(), `${Date.now()}-${name}`);
  fs.writeFileSync(file, await doc.save());
  return file;
}

async function uploadToDetail(page: Page, file: string): Promise<string> {
  await page.goto('/dokumente/upload', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('document-upload-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('document-upload-input').setInputFiles(file);
  await expect(page.getByTestId('storage-decision-save-permanently')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('storage-decision-save-permanently').click();
  await expect(page.getByTestId('ablage-detail-page')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('eingang-detail-analysis-loading')).toHaveCount(0, { timeout: 60_000 });
  return decodeURIComponent(page.url().split('/').pop()!);
}

async function invoicePdf(tag: string): Promise<string> {
  return pdf([
    'Baustoff Meyer GmbH',
    'Rechnung',
    `An: ${company.companyName}`,
    `Rechnungsnummer: R-P1-${tag}`,
    'Baustelle: Hauptstraße 5, Essen',
    'Bauvorhaben: Badsanierung Nordlicht',
    'Gesamtbetrag 119,00 EUR',
  ], `rechnung-${tag}.pdf`);
}

async function openMoreOptions(page: Page): Promise<void> {
  if (!(await page.getByTestId('document-review-more-content').isVisible())) {
    await page.getByTestId('document-review-more-toggle').click();
  }
  if ((await page.getByTestId('review-group-toggle-more-details').count()) > 0 && !(await page.getByTestId('review-group-content-more-details').isVisible())) {
    await page.getByTestId('review-group-toggle-more-details').click();
  }
}

async function linkToVorgang(page: Page, vorgangId: string): Promise<void> {
  await openMoreOptions(page);
  await page.getByTestId('review-section-toggle-technical').scrollIntoViewIfNeeded();
  if (!(await page.getByTestId('smart-intake-create-vorgang').isVisible())) {
    await page.getByTestId('review-section-toggle-technical').click();
  }
  await page.getByTestId('smart-intake-create-vorgang').click();
  await page.locator(`input[name="similarVorgang"][value="${vorgangId}"]`).check();
  await page.getByRole('button', { name: 'Mit bestehendem Vorgang verknüpfen' }).click();
}

type CloudInbox = { row_version: number; vorgang_id: string | null; deleted: boolean; status: string; payload: Record<string, unknown> };
async function cloudInbox(id: string): Promise<CloudInbox | null> {
  const { data } = await admin().from('workspace_inbox_items').select('row_version,vorgang_id,deleted,status,payload').eq('client_inbox_id', id).maybeSingle();
  return (data as CloudInbox | null) ?? null;
}

/** Lokaler Stand eines Eingangs und seine Sendeaufträge (aus dem Arbeitsbereichsspeicher). */
async function localInbox(page: Page, id: string) {
  return page.evaluate((inboxId) => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (!key.startsWith('officepilot-state:workspace:')) continue;
      const state = JSON.parse(localStorage.getItem(key)!) as {
        inboxItems?: Array<{ id: string; vorgangId?: string; sync?: { version?: number; deleted?: boolean } }>;
        syncOutbox?: Array<{ entityType: string; entityId: string; status: string }>;
      };
      const item = (state.inboxItems ?? []).find((x) => x.id === inboxId);
      const outbox = (state.syncOutbox ?? []).filter((e) => e.entityType === 'inbox_item' && e.entityId === inboxId).map((e) => e.status);
      return { version: item?.sync?.version ?? null, vorgangId: item?.vorgangId ?? null, deleted: item?.sync?.deleted ?? false, outbox };
    }
    return null;
  }, id);
}

/** Erfasst die beim Eingangs-Push gesendete Erwartung und die Serverantwort. */
function recordInboxPushes(page: Page, sent: Array<{ id: string; expected: number; status?: number; message?: string }>): void {
  page.on('response', async (response) => {
    if (!response.url().includes('/rpc/upsert_workspace_intake_entity')) return;
    try {
      const body = JSON.parse(response.request().postData() ?? '{}') as { p_entity_type?: string; p_row_version?: number; p_payload?: { client_inbox_id?: string } };
      if (body.p_entity_type !== 'inbox_item') return;
      const text = await response.text().catch(() => '');
      let message: string | undefined;
      try { message = (JSON.parse(text) as { message?: string }).message; } catch { /* kein JSON */ }
      sent.push({ id: String(body.p_payload?.client_inbox_id ?? ''), expected: Number(body.p_row_version), status: response.status(), message });
    } catch {
      /* fremder Aufruf */
    }
  });
}

test('P1 Intake-Versionskonflikt: Verknüpfen, Löschen und echter Konflikt nach dem ersten Sync', async ({ page, browser }) => {
  test.setTimeout(540_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 200)));
  const pushes: Array<{ id: string; expected: number; status?: number; message?: string }> = [];
  recordInboxPushes(page, pushes);

  await loginAndSetup(page);
  // Verknüpfungsziel: ein echter Vorgang aus einem Werkvertrag.
  const contract = await pdf([
    'Werkvertrag', 'Auftraggeber: Kunde Nordlicht GmbH', 'Hauptstraße 5, 45356 Essen',
    `Auftragnehmer: ${company.companyName}`, 'Bauvorhaben: Badsanierung Nordlicht', 'Baustelle: Hauptstraße 5, Essen',
    'Leistung: Fliesenarbeiten 40 m² zu 55,00 EUR',
  ], 'werkvertrag-p1.pdf');
  await uploadToDetail(page, contract);
  await acceptContractOrderThroughUi(page);
  const vorgangId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
  await expect.poll(async () => {
    const { data } = await admin().from('workspace_vorgaenge').select('vorgang_id').eq('vorgang_id', vorgangId).maybeSingle();
    return Boolean(data);
  }, { timeout: 90_000 }).toBe(true);

  // 1/2 — Upload, erster Sync vollständig: Server v1, Client v1, Auftrag erledigt.
  const invoiceId = await uploadToDetail(page, await invoicePdf('A'));
  await expect.poll(async () => (await cloudInbox(invoiceId))?.row_version ?? 0, { timeout: 90_000 }).toBe(1);
  await expect.poll(async () => (await localInbox(page, invoiceId))?.version ?? null, { timeout: 30_000 }).toBe(1);
  expect((await localInbox(page, invoiceId))!.outbox.every((status) => status === 'completed')).toBe(true);

  // 3–6 — verknüpfen: lokal bleibt v1, Push erwartet 1, Server v2 mit vorgang_id, Auftrag erledigt.
  await linkToVorgang(page, vorgangId);
  await expect.poll(async () => (await localInbox(page, invoiceId))?.vorgangId ?? null, { timeout: 30_000 }).toBe(vorgangId);
  await expect.poll(async () => {
    const row = await cloudInbox(invoiceId);
    return row ? `v${row.row_version}|${row.vorgang_id ?? ''}` : '';
  }, { timeout: 90_000 }).toBe(`v2|${vorgangId}`);
  const linkPush = pushes.filter((p) => p.id === invoiceId && p.expected >= 1);
  expect(linkPush.map((p) => `${p.expected}:${p.status}`)).toEqual(['1:200']);
  await expect.poll(async () => (await localInbox(page, invoiceId))?.version ?? null, { timeout: 30_000 }).toBe(2);
  const afterLink = (await localInbox(page, invoiceId))!;
  expect(afterLink.outbox.filter((status) => status !== 'completed')).toEqual([]);
  await page.screenshot({ path: 'test-results/localdb/p1-inbox-1-verknuepft.png', fullPage: false });

  // 7 — Reload: Verknüpfung bleibt.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await localInbox(page, invoiceId))?.vorgangId ?? null, { timeout: 30_000 }).toBe(vorgangId);

  // 8 — zweiter Browserkontext sieht dieselbe Verknüpfung.
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await login(other);
  await expect(other.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await localInbox(other, invoiceId))?.vorgangId ?? null, { timeout: 90_000 }).toBe(vorgangId);
  await other.goto(`/ablage/${invoiceId}`, { waitUntil: 'domcontentloaded' });
  await expect(other.getByTestId('ablage-detail-page')).toBeVisible({ timeout: 30_000 });
  await expect(other.getByText('Badsanierung Nordlicht').first()).toBeVisible({ timeout: 30_000 });
  await other.screenshot({ path: 'test-results/localdb/p1-inbox-2-zweites-geraet.png', fullPage: false });
  await otherContext.close();

  // 9 — Löschen eines synchronisierten Eingangs erreicht die Cloud.
  const deleteId = await uploadToDetail(page, await invoicePdf('D'));
  await expect.poll(async () => (await cloudInbox(deleteId))?.row_version ?? 0, { timeout: 90_000 }).toBe(1);
  await expect.poll(async () => (await localInbox(page, deleteId))?.version ?? null, { timeout: 30_000 }).toBe(1);
  await openMoreOptions(page);
  await page.getByTestId('review-section-toggle-administration').scrollIntoViewIfNeeded();
  if (!(await page.getByTestId('inbox-delete-trigger').isVisible())) {
    await page.getByTestId('review-section-toggle-administration').click();
  }
  await page.getByTestId('inbox-delete-trigger').click();
  await page.getByTestId('inbox-delete-confirm').click();
  await expect.poll(async () => {
    const row = await cloudInbox(deleteId);
    return row ? `v${row.row_version}|${row.deleted}` : '';
  }, { timeout: 90_000 }).toBe('v2|true');
  expect(pushes.filter((p) => p.id === deleteId && p.expected >= 1).map((p) => `${p.expected}:${p.status}`)).toEqual(['1:200']);

  // K — echter Konkurrenzkonflikt: A offline auf Basis v1, anderer Client schreibt v2, A verknüpft → Konflikt, kein Überschreiben.
  const conflictId = await uploadToDetail(page, await invoicePdf('K'));
  await expect.poll(async () => (await cloudInbox(conflictId))?.row_version ?? 0, { timeout: 90_000 }).toBe(1);
  await expect.poll(async () => (await localInbox(page, conflictId))?.version ?? null, { timeout: 30_000 }).toBe(1);
  await page.context().setOffline(true);
  const otherClient: SupabaseClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await otherClient.auth.signInWithPassword({ email: user.email, password: user.password });
  expect(signIn.error).toBeNull();
  const { data: wsRow } = await admin().from('workspace_members').select('workspace_id').eq('user_id', user.id).eq('status', 'active').single();
  const base = (await cloudInbox(conflictId))!;
  const foreign = await otherClient.rpc('upsert_workspace_intake_entity', {
    p_workspace_id: (wsRow as { workspace_id: string }).workspace_id,
    p_entity_type: 'inbox_item',
    p_payload: {
      client_inbox_id: conflictId,
      status: 'geprueft',
      vorgang_link_status: 'none',
      client_file_ref_id: (base.payload as { fileRefId?: string }).fileRefId ?? null,
      archive_document_id: null,
      vorgang_id: null,
      expense_id: null,
      payload: { ...base.payload, title: 'Fremdänderung Gerät B' },
      deleted: false,
    },
    p_row_version: 1,
  });
  expect(foreign.error).toBeNull();
  expect((await cloudInbox(conflictId))!.row_version).toBe(2);
  await linkToVorgang(page, vorgangId);
  await expect.poll(async () => (await localInbox(page, conflictId))?.vorgangId ?? null, { timeout: 30_000 }).toBe(vorgangId);
  await page.context().setOffline(false);
  await page.waitForTimeout(15_000);
  const conflictRow = (await cloudInbox(conflictId))!;
  expect(conflictRow.row_version).toBe(2);
  expect(conflictRow.vorgang_id).toBeNull();
  expect((conflictRow.payload as { title?: string }).title).toBe('Fremdänderung Gerät B');
  const conflictLocal = (await localInbox(page, conflictId))!;
  expect(conflictLocal.version).toBe(1);
  expect(conflictLocal.outbox).toContain('blocked');
  console.log(`[P1] Konflikt: Pushes=${JSON.stringify(pushes.filter((p) => p.id === conflictId))} lokal=${JSON.stringify(conflictLocal)}`);

  // S — schneller Edit vor dem ersten Ack: sofort verknüpfen, ohne auf den ersten Sync zu warten.
  const quickId = await uploadToDetail(page, await invoicePdf('S'));
  await linkToVorgang(page, vorgangId);
  await expect.poll(async () => {
    const row = await cloudInbox(quickId);
    return row?.vorgang_id ?? '';
  }, { timeout: 90_000 }).toBe(vorgangId);
  await expect.poll(async () => (await localInbox(page, quickId))?.outbox.filter((status) => status !== 'completed') ?? ['?'], { timeout: 60_000 }).toEqual([]);
  expect(pushes.filter((p) => p.id === quickId && p.status !== 200)).toEqual([]);

  expect(pageErrors).toEqual([]);
  console.log(`[P1] Eingangs-Pushes gesamt: ${pushes.length}, Fehler ausser K: ${pushes.filter((p) => p.status !== 200 && p.id !== conflictId).length}`);
});
