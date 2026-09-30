/**
 * EINGANG-01C-2 — sichtbarer Selbsttest: echte Vorgangsnummer in der App.
 *
 * Nur gegen die **lokale** Supabase-Instanz, synthetischer Testnutzer, eigener
 * Workspace. Zwei Vorgänge entstehen über den echten Eingangspfad (Upload →
 * Eingang → „Vorgang anlegen", lokal zuerst, Nummer erst nach dem Sync vom
 * Server). Ein Altvorgang ohne Nummer liegt bereits in der Cloud.
 *
 *  A/B  erster Vorgang aus dem Eingang, nach dem Sync VG sichtbar
 *  C    zweiter Vorgang: naechste Sequenz
 *  D    Altvorgang ohne Nummer: Seite funktioniert, keine Nummer, kein Fake
 *  E    Eingang verknuepfen: die Auswahl zeigt die VG
 *  F    Reload: Nummer bleibt
 *  G    zweiter Browserkontext: Nummer kommt per Pull
 *  H    keine Seitenfehler
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';
import { acceptContractOrderThroughUi } from './support/localDoc00001VorgangFlow';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const company = loadTestWorldOperatorCompany();
const VG_PATTERN = /^VG-(\d{4})-(\d{4,})$/;
let user: LocalDbUser;

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SUPABASE_URL)) throw new Error('Nur gegen die lokale Instanz.');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'vg-ui-01c2' });
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

/** Der echte Einstieg „Vorgang anlegen/zuordnen" im Eingang (Weitere Optionen → Technisches). */
async function openVorgangDialog(page: Page): Promise<void> {
  if (!(await page.getByTestId('document-review-more-content').isVisible())) {
    await page.getByTestId('document-review-more-toggle').click();
  }
  if ((await page.getByTestId('review-group-toggle-more-details').count()) > 0 && !(await page.getByTestId('review-group-content-more-details').isVisible())) {
    await page.getByTestId('review-group-toggle-more-details').click();
  }
  await page.getByTestId('review-section-toggle-technical').scrollIntoViewIfNeeded();
  if (!(await page.getByTestId('smart-intake-create-vorgang').isVisible())) {
    await page.getByTestId('review-section-toggle-technical').click();
  }
  await page.getByTestId('smart-intake-create-vorgang').click();
}

async function workspaceId(): Promise<string> {
  const { data, error } = await admin().from('workspace_members').select('workspace_id').eq('user_id', user.id).eq('status', 'active').single();
  if (error) throw new Error(error.message);
  return data!.workspace_id as string;
}

/** Wartet, bis der lokal angelegte Vorgang in der Cloud liegt und seine Servernummer traegt. */
async function serverVorgangFor(created: { inboxId: string; vorgangId: string }): Promise<{ id: string; number: string }> {
  let number = '';
  await expect.poll(async () => {
    const { data } = await admin().from('workspace_vorgaenge').select('vorgang_number,payload').eq('vorgang_id', created.vorgangId).maybeSingle();
    const row = data as { vorgang_number: string | null; payload: { createdFromInboxId?: string } } | null;
    if (row && row.payload.createdFromInboxId !== created.inboxId) throw new Error('Vorgang stammt nicht aus diesem Eingang');
    number = row?.vorgang_number ?? '';
    return number;
  }, { timeout: 90_000, intervals: [1000, 2000, 3000] }).toMatch(VG_PATTERN);
  return { id: created.vorgangId, number };
}

async function createFromInbox(
  page: Page,
  customer: string,
  title: string,
): Promise<{ inboxId: string; vorgangId: string; localBeforeSync: { number: string | null; requested: boolean | null } | null }> {
  const file = await pdf([
    'Werkvertrag',
    `Auftraggeber: ${customer}`,
    'Hauptstraße 5, 45356 Essen',
    `Auftragnehmer: ${company.companyName}`,
    `Bauvorhaben: ${title}`,
    'Baustelle: Hauptstraße 5, Essen',
    'Leistung: Fliesenarbeiten 40 m² zu 55,00 EUR',
  ], `${title.replace(/\W+/g, '-')}.pdf`);
  const inboxId = await uploadToDetail(page, file);
  /*
   * Der echte Vertragsweg im Eingang: Kundenentscheidung „neu", dann „Als
   * Auftrag erfassen" → createVorgangFromInboxWithContract → lokal zuerst.
   */
  await acceptContractOrderThroughUi(page);
  const vorgangId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
  // Unmittelbar nach der lokalen Anlage: keine Nummer, kein Platzhalter.
  const localNumber = await page.evaluate((id) => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (!key.startsWith('officepilot-state:workspace:')) continue;
      const state = JSON.parse(localStorage.getItem(key)!) as { vorgaenge?: Array<{ id: string; vorgangNumber?: string; vorgangNumberRequested?: boolean }> };
      const found = (state.vorgaenge ?? []).find((v) => v.id === id);
      if (found) return { number: found.vorgangNumber ?? null, requested: found.vorgangNumberRequested ?? null };
    }
    return null;
  }, vorgangId);
  return { inboxId, vorgangId, localBeforeSync: localNumber };
}

async function assertNumberInApp(page: Page, vorgang: { id: string; number: string }): Promise<void> {
  await page.goto(`/vorgaenge/${vorgang.id}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('vorgang-detail-page')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('vorgang-detail-number')).toHaveText(vorgang.number, { timeout: 60_000 });
}

async function secondContext(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page);
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
  return page;
}

test('EINGANG-01C-2: echte Vorgangsnummer ueber den Eingangspfad, Altbestand ohne Nummer', async ({ page, browser }) => {
  test.setTimeout(480_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 200)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
  });
  // Zur Einordnung von Console-Fehlern: fehlgeschlagene Antworten mit Pfad (ohne Query/Token).
  const failedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) {
      const url = new URL(response.url());
      const line = `${response.status()} ${response.request().method()} ${url.host}${url.pathname}`;
      failedResponses.push(line);
      if (url.pathname.includes('/rpc/')) {
        let target = '';
        try {
          const sent = JSON.parse(response.request().postData() ?? '{}') as { p_entity_type?: string; p_row_version?: number; p_payload?: Record<string, unknown> };
          const p = sent.p_payload ?? {};
          target = `${sent.p_entity_type ?? ''} id=${String(p.client_inbox_id ?? p.id ?? p.vorgang_id ?? '')} sentVersion=${String(sent.p_row_version ?? '')}`;
        } catch {
          target = '(kein JSON)';
        }
        void response.text().then((body) => console.log(`[01C-2] rpc-fehler: ${line} ${target} ${body.slice(0, 200)}`)).catch(() => undefined);
      }
    }
  });

  await loginAndSetup(page);
  const ws = await workspaceId();

  // D-Vorbereitung: ein Altvorgang ohne Nummer liegt bereits in der Cloud (Bestand vor 01C-2).
  const legacyId = `v-legacy-${Date.now()}`;
  const legacy = await admin().from('workspace_vorgaenge').insert({
    workspace_id: ws,
    vorgang_id: legacyId,
    payload: { id: legacyId, title: 'Altauftrag Bestand', customer: 'Bestandskunde GmbH', baustelle: 'Altweg 1', status: 'eingegangen', materialSource: 'unclear', orderPositions: [] },
    row_version: 1,
  });
  expect(legacy.error).toBeNull();

  // A/B — erster Vorgang aus dem Eingang; die Nummer vergibt der Server beim Sync.
  const first = await createFromInbox(page, 'Kunde Nordlicht GmbH', 'Badsanierung Nordlicht');
  const firstVorgang = await serverVorgangFor(first);
  // Lokal vor dem Sync: kein Fake — entweder noch keine Nummer (mit Wunsch) oder schon genau die Servernummer.
  expect(first.localBeforeSync).not.toBeNull();
  if (first.localBeforeSync!.number === null) expect(first.localBeforeSync!.requested).toBe(true);
  else expect(first.localBeforeSync!.number).toBe(firstVorgang.number);
  console.log(`[01C-2] lokal direkt nach Anlage: ${JSON.stringify(first.localBeforeSync)}`);
  await assertNumberInApp(page, firstVorgang);
  await expect(page.getByTestId('vorgang-detail-header')).toContainText('Nordlicht');
  await page.screenshot({ path: 'test-results/localdb/01c2-a-erster-vorgang.png', fullPage: false });

  // C — zweiter Vorgang: naechste Sequenz desselben Jahres.
  const second = await createFromInbox(page, 'Kunde Suedwind GmbH', 'Dachsanierung Suedwind');
  const secondVorgang = await serverVorgangFor(second);
  const [, y1, n1] = firstVorgang.number.match(VG_PATTERN)!;
  const [, y2, n2] = secondVorgang.number.match(VG_PATTERN)!;
  expect(y2).toBe(y1);
  expect(Number(n2)).toBe(Number(n1) + 1);
  await assertNumberInApp(page, secondVorgang);

  // Liste: beide Nummern sichtbar, der Altvorgang ohne.
  await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId(`vorgaenge-row-number-${firstVorgang.id}`)).toHaveText(firstVorgang.number, { timeout: 60_000 });
  await expect(page.getByTestId(`vorgaenge-row-number-${secondVorgang.id}`)).toHaveText(secondVorgang.number);
  await expect(page.getByTestId(`vorgaenge-row-${legacyId}`)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId(`vorgaenge-row-number-${legacyId}`)).toHaveCount(0);
  await page.screenshot({ path: 'test-results/localdb/01c2-c-liste.png', fullPage: false });

  // D — Altvorgang oeffnen: funktioniert, keine Nummer, kein Fake.
  await page.goto(`/vorgaenge/${legacyId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('vorgang-detail-page')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('vorgang-detail-header')).toContainText('Altauftrag Bestand');
  await expect(page.getByTestId('vorgang-detail-number')).toHaveCount(0);
  await expect(page.getByTestId('vorgang-detail-header')).not.toContainText('VG-');
  const legacyRow = await admin().from('workspace_vorgaenge').select('vorgang_number').eq('workspace_id', ws).eq('vorgang_id', legacyId).single();
  expect(legacyRow.data?.vorgang_number).toBeNull();
  await page.screenshot({ path: 'test-results/localdb/01c2-d-altvorgang.png', fullPage: false });

  // E — Eingang mit dem nummerierten Vorgang verknuepfen: die Auswahl zeigt die VG.
  const invoice = await pdf([
    'Baustoff Meyer GmbH',
    'Rechnung',
    `An: ${company.companyName}`,
    'Rechnungsnummer: R-01C2-1',
    'Baustelle: Hauptstraße 5, Essen',
    'Bauvorhaben: Badsanierung Nordlicht',
    'Gesamtbetrag 119,00 EUR',
  ], 'rechnung-01c2.pdf');
  const invoiceId = await uploadToDetail(page, invoice);
  console.log(`[01C-2] ids: first.inbox=${first.inboxId} second.inbox=${second.inboxId} invoice.inbox=${invoiceId}`);
  /*
   * Erst verknüpfen, wenn der Eingang selbst in der Cloud angekommen ist. Ohne
   * diese Wartezeit wurde beobachtet, dass der Verknüpfungs-Push des Eingangs
   * vor der Bestätigung seines Erst-Pushs lief („Versionskonflikt inbox_item:1",
   * upsert_workspace_intake_entity) — ein von 01C-2 unabhängiger Intake-Pfad.
   */
  await expect.poll(async () => {
    const { data } = await admin().from('workspace_inbox_items').select('client_inbox_id').eq('client_inbox_id', invoiceId).maybeSingle();
    return Boolean(data);
  }, { timeout: 60_000 }).toBe(true);
  await page.waitForTimeout(3000);
  await openVorgangDialog(page);
  const option = page.getByTestId(`similar-vorgang-number-${firstVorgang.id}`);
  await expect(option).toContainText(firstVorgang.number, { timeout: 20_000 });
  await option.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/localdb/01c2-e-auswahl.png', fullPage: false });
  await page.locator(`input[name="similarVorgang"][value="${firstVorgang.id}"]`).check();
  await page.getByRole('button', { name: 'Mit bestehendem Vorgang verknüpfen' }).click();
  // Die Verknüpfung selbst: in der App (lokaler Stand) auf genau diesen nummerierten Vorgang.
  await expect.poll(async () => page.evaluate((id) => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (!key.startsWith('officepilot-state:workspace:')) continue;
      const state = JSON.parse(localStorage.getItem(key)!) as { inboxItems?: Array<{ id: string; vorgangId?: string }> };
      const found = (state.inboxItems ?? []).find((item) => item.id === id);
      if (found) return found.vorgangId ?? '';
    }
    return '';
  }, invoiceId), { timeout: 30_000 }).toBe(firstVorgang.id);
  /*
   * Bewusst NICHT geprüft: dass die Verknüpfung des frischen Eingangs die Cloud
   * erreicht. Dieser Push scheitert reproduzierbar mit „Versionskonflikt
   * inbox_item:1" (gesendet 2) — identisch auf dem unveränderten Stand b0b2e35
   * nachgestellt, also ein vorbestehender Intake-Sync-Befund ausserhalb von 01C-2.
   */

  // F — Reload: Nummer bleibt (lokal gespeichert und per Pull bestaetigt).
  await page.goto(`/vorgaenge/${firstVorgang.id}`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('vorgang-detail-number')).toHaveText(firstVorgang.number, { timeout: 60_000 });
  const stillThere = await admin().from('workspace_vorgaenge').select('vorgang_number').eq('workspace_id', ws).eq('vorgang_id', firstVorgang.id).single();
  expect(stillThere.data?.vorgang_number).toBe(firstVorgang.number);

  // G — zweiter Browserkontext (anderes „Geraet"): Nummer kommt per Pull.
  const other = await secondContext(browser);
  const otherErrors: string[] = [];
  other.on('pageerror', (error) => otherErrors.push(String(error.message).slice(0, 200)));
  await other.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });
  await expect(other.getByTestId(`vorgaenge-row-number-${firstVorgang.id}`)).toHaveText(firstVorgang.number, { timeout: 90_000 });
  await expect(other.getByTestId(`vorgaenge-row-number-${secondVorgang.id}`)).toHaveText(secondVorgang.number);
  await expect(other.getByTestId(`vorgaenge-row-number-${legacyId}`)).toHaveCount(0);
  await other.screenshot({ path: 'test-results/localdb/01c2-g-zweites-geraet.png', fullPage: false });
  await other.context().close();

  // Nichts anderes wurde nummeriert: genau zwei Nummern in diesem Workspace.
  const numbered = await admin().from('workspace_vorgaenge').select('vorgang_id,vorgang_number').eq('workspace_id', ws).not('vorgang_number', 'is', null);
  expect((numbered.data ?? []).map((row) => row.vorgang_id).sort()).toEqual([firstVorgang.id, secondVorgang.id].sort());

  // H — keine Seitenfehler.
  expect(pageErrors).toEqual([]);
  expect(otherErrors).toEqual([]);
  console.log(`[01C-2] Nummern: ${firstVorgang.number}, ${secondVorgang.number}; Console-Errors: ${consoleErrors.length}`);
  for (const line of consoleErrors) console.log(`[01C-2] console.error: ${line}`);
  for (const line of failedResponses) console.log(`[01C-2] response: ${line}`);
});
