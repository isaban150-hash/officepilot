/**
 * EINGANG-01C-1 — sichtbarer Selbsttest: deterministische Zuordnungskette.
 *
 * Nur gegen die **lokale** Supabase-Instanz mit synthetischem Testnutzer und
 * eigenem Workspace. Zwei echte Aufträge entstehen über die Oberfläche
 * (serverseitige Auftragsnummern AU-…), zwei echte PDFs laufen durch den
 * normalen Upload:
 *  1. Kollision: ein Werkvertrag nennt „Auftragsnummer 4711", Vorgang A heißt
 *     „Badsanierung 4711" — früher ein loser Teilstring-Treffer mit „exact".
 *  2. Sichere Referenz: eine Lieferantenrechnung nennt die echte Auftragsnummer
 *     von Vorgang B.
 * Keine produktiven Daten, kein Versand.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const company = loadTestWorldOperatorCompany();
let user: LocalDbUser;

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SUPABASE_URL)) throw new Error('Nur gegen die lokale Instanz.');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'ref-integrity-01c1' });
});

test.afterAll(async () => {
  if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
});

async function loginAndSetup(page: Page): Promise<void> {
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

/** Echter Auftrag über die Oberfläche; die Auftragsnummer vergibt der Server. */
async function createOrder(page: Page, input: { customer: string; title: string; site: string }): Promise<{ vorgangId: string; orderNumber: string }> {
  await page.goto('/auftraege/neu', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('order-editor-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('order-customer-name').fill(input.customer);
  await page.getByTestId('order-customer-street').fill('Hauptstraße 1');
  await page.getByTestId('order-customer-zip').fill('45356');
  await page.getByTestId('order-customer-city').fill('Essen');
  await page.getByTestId('order-title').fill(input.title);
  await page.getByTestId('order-baustelle').fill(input.site);
  if ((await page.getByTestId('order-position-0-description').count()) === 0) await page.getByTestId('order-position-add').click();
  await page.getByTestId('order-position-0-description').fill('Montage');
  await page.getByTestId('order-position-0-quantity').fill('1');
  await page.getByTestId('order-position-0-unit-price').fill('500');
  await page.getByTestId('order-confirm').click();
  // Die Oberfläche fragt vor der verbindlichen Anlage nach — ausdrücklich bestätigen.
  await page.getByTestId('order-confirm-confirm').click();
  await expect(page).toHaveURL(/\/vorgaenge\/[^/]+$/, { timeout: 45_000 });
  const vorgangId = decodeURIComponent(page.url().split('/').pop()!);
  const row = await admin().from('workspace_vorgaenge').select('order_number').eq('vorgang_id', vorgangId).single();
  expect(row.error).toBeNull();
  const orderNumber = row.data!.order_number as string;
  expect(orderNumber).toMatch(/^AU-\d{4}-\d{4}$/);
  return { vorgangId, orderNumber };
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

/** Fallabgleich und Workflow-Aktion aus derselben Modulinstanz, die die App verwendet. */
async function caseMatchOf(page: Page, inboxId: string) {
  return page.evaluate(async (id) => {
    const loaded = performance.getEntriesByType('resource').map((entry) => entry.name);
    const url = (suffix: string) => {
      const hit = loaded.find((name) => name.split('?')[0].endsWith(suffix));
      if (!hit) throw new Error(`Modulinstanz nicht gefunden: ${suffix}`);
      return hit;
    };
    const inbox = await import(/* @vite-ignore */ url('/src/services/inboxService.ts'));
    const caseMatch = await import(/* @vite-ignore */ url('/src/services/documentCaseMatchService.ts'));
    const workflow = await import(/* @vite-ignore */ url('/src/services/intakeWorkflowService.ts'));
    const item = inbox.getInboxItemById(id);
    if (!item) throw new Error(`Eingang fehlt: ${id}`);
    const match = caseMatch.buildDocumentCaseMatch(item);
    const analysed = workflow.analyzeUploadedDocument(id);
    return {
      status: match.matchStatus as string,
      caseId: match.matchedCaseId as string | null,
      candidates: (match.candidates as Array<{ caseId: string }>).map((candidate) => candidate.caseId),
      reference: match.reference ?? null,
      linkAction: Boolean(analysed?.nextActions.some((action: { id: string; enabled: boolean }) => action.id === 'link_vorgang' && action.enabled)),
    };
  }, inboxId);
}

async function uploadToDetail(page: Page, file: string): Promise<string> {
  await page.goto('/dokumente/upload', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('document-upload-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('document-upload-input').setInputFiles(file);
  await expect(page.getByTestId('storage-decision-save-permanently')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('storage-decision-save-permanently').click();
  await expect(page.getByTestId('ablage-detail-page')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('eingang-detail-analysis-error')).toHaveCount(0);
  await expect(page.getByTestId('eingang-detail-analysis-loading')).toHaveCount(0, { timeout: 60_000 });
  return decodeURIComponent(page.url().split('/').pop()!);
}

test('EINGANG-01C-1: lose Nummer verknüpft nicht, echte Auftragsnummer ist sicher', async ({ page }) => {
  // Zwei echte Aufträge und vier echte Uploads — länger als der 120-s-Standard.
  test.setTimeout(420_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 200)));
  // Genug Resource-Timing-Einträge, damit die Prüfung dieselbe Modulinstanz wie die App liest.
  await page.addInitScript(() => performance.setResourceTimingBufferSize(10000));

  await loginAndSetup(page);
  const a = await createOrder(page, { customer: 'Kunde Alpha GmbH', title: 'Badsanierung 4711', site: 'Alphaweg 1, Essen' });
  const b = await createOrder(page, { customer: 'Kunde Beta GmbH', title: 'Dachsanierung Beta', site: 'Betaweg 2, Essen' });
  expect(a.orderNumber).not.toBe(b.orderNumber);

  // 1.–4. Kollision: loser Nummern-Teilstring — kein bestätigter Vorgang
  const collision = await pdf([
    'Werkvertrag',
    'Auftraggeber: Firma Zeta GmbH',
    `Auftragnehmer: ${company.companyName}`,
    'Auftragsnummer: 4711',
    'Leistung: Fliesenarbeiten',
  ], 'kollision.pdf');
  const collisionId = await uploadToDetail(page, collision);
  // Die Vertragsansicht zeigt keinen Fallabgleich — deshalb direkt die laufende Modulinstanz lesen.
  const collisionMatch = await caseMatchOf(page, collisionId);
  expect(collisionMatch.status, JSON.stringify(collisionMatch)).not.toBe('exact');
  // Der Fixture-Beweis: der lose Treffer auf Vorgang A existiert — nur noch als Vorschlag.
  expect(collisionMatch.candidates).toContain(a.vorgangId);
  expect(collisionMatch.linkAction).toBe(false);
  // Sichtbar: dieselbe Einstufung, kein „exact".
  const collisionCard = page.getByTestId('document-case-match');
  await expect(collisionCard).toHaveAttribute('data-match-status', collisionMatch.status);
  await expect(collisionCard).not.toContainText('Passender Vorgang gefunden');
  await collisionCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/localdb/01c1-1-kollision.png', fullPage: false });

  // 5./6. Sichere Referenz: echte Auftragsnummer von B
  const reference = await pdf([
    'Baustoff Meyer GmbH',
    'Rechnung',
    `An: ${company.companyName}`,
    'Rechnungsnummer: LM-88231',
    `Ihr Auftrag: ${b.orderNumber}`,
    'Gesamtbetrag 119,00 EUR',
  ], 'referenz.pdf');
  const referenceId = await uploadToDetail(page, reference);
  const referenceMatch = page.getByTestId('document-case-match');
  await expect(referenceMatch).toHaveAttribute('data-match-status', 'exact', { timeout: 30_000 });
  await expect(referenceMatch).toContainText('Dachsanierung Beta');
  await expect(referenceMatch).toContainText('eigene Auftrags- oder Angebotsnummer im Dokument');
  const referenceState = await caseMatchOf(page, referenceId);
  expect(referenceState).toMatchObject({ status: 'exact', caseId: b.vorgangId, reference: { kind: 'order', value: b.orderNumber }, linkAction: true });
  await page.screenshot({ path: 'test-results/localdb/01c1-2-referenz.png', fullPage: false });

  // Nichts wurde durch bloßes Öffnen verknüpft — auch nicht in der Cloud.
  await expect.poll(async () => {
    const { data } = await admin().from('workspace_inbox_items').select('client_inbox_id,vorgang_id,vorgang_link_status').in('client_inbox_id', [collisionId, referenceId]);
    return (data ?? []).length;
  }, { timeout: 60_000 }).toBe(2);
  const { data: rows } = await admin().from('workspace_inbox_items').select('client_inbox_id,vorgang_id,vorgang_link_status').in('client_inbox_id', [collisionId, referenceId]);
  for (const row of rows ?? []) {
    expect(row.vorgang_id, `${row.client_inbox_id} wurde ungefragt verknüpft`).toBeNull();
    expect(row.vorgang_link_status).toBe('none');
  }

  // A./C. Stammkunde, gleiche Adresse, neuer Vertrag → nur Vorschlag, keine Auto-Zuordnung (P1-A)
  const repeat = await pdf([
    'Werkvertrag',
    'Auftraggeber: Kunde Alpha GmbH',
    `Auftragnehmer: ${company.companyName}`,
    'Baustelle: Alphaweg 1, Essen',
    'Bauvorhaben: Küchenumbau Alpha',
  ], 'stammkunde.pdf');
  const repeatId = await uploadToDetail(page, repeat);
  const repeatMatch = await caseMatchOf(page, repeatId);
  expect(repeatMatch.status, JSON.stringify(repeatMatch)).not.toBe('exact');
  expect(repeatMatch.candidates).toContain(a.vorgangId);
  expect(repeatMatch.linkAction).toBe(false);
  const repeatCard = page.getByTestId('document-case-match');
  await expect(repeatCard).toHaveAttribute('data-match-status', repeatMatch.status);
  await expect(repeatCard).toContainText('Vorgang prüfen');
  await repeatCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/localdb/01c1-3-stammkunde.png', fullPage: false });

  // D. Ausdrückliche Auswahl eines Vorschlags → danach bestätigt (user_confirmed).
  // Eine Lieferantenrechnung zur Baustelle von A: nur Vorschlag, dann Auswahl im echten Dialog.
  const delivery = await pdf([
    'Baustoff Meyer GmbH',
    'Rechnung',
    `An: ${company.companyName}`,
    'Rechnungsnummer: R-01C-9',
    'Baustelle: Alphaweg 1, Essen',
    'Gesamtbetrag 119,00 EUR',
  ], 'rechnung-baustelle.pdf');
  const deliveryId = await uploadToDetail(page, delivery);
  const deliveryMatch = await caseMatchOf(page, deliveryId);
  expect(deliveryMatch.status, JSON.stringify(deliveryMatch)).not.toBe('exact');
  expect(deliveryMatch.linkAction).toBe(false);
  const repeatId2 = deliveryId;
  // „Weitere Optionen" merkt sich seinen Zustand — nur öffnen, wenn es noch zu ist.
  if (!(await page.getByTestId('document-review-more-content').isVisible())) {
    await page.getByTestId('document-review-more-toggle').click();
  }
  // Darin „Weitere Details" (Technik, Verwaltung …).
  if (!(await page.getByTestId('review-group-content-more-details').isVisible())) {
    await page.getByTestId('review-group-toggle-more-details').click();
  }
  await page.getByTestId('review-section-toggle-technical').scrollIntoViewIfNeeded();
  await page.getByTestId('review-section-toggle-technical').click();
  await page.getByTestId('smart-intake-create-vorgang').click();
  await page.locator(`input[name="similarVorgang"][value="${a.vorgangId}"]`).check();
  await page.getByRole('button', { name: 'Mit bestehendem Vorgang verknüpfen' }).click();
  await expect.poll(async () => {
    const { data } = await admin().from('workspace_inbox_items').select('vorgang_id,vorgang_link_status,payload').eq('client_inbox_id', repeatId2).single();
    return data ? `${data.vorgang_id}|${data.vorgang_link_status}|${(data.payload as { vorgangAssignment?: { source?: string } }).vorgangAssignment?.source ?? ''}` : '';
  }, { timeout: 60_000 }).toBe(`${a.vorgangId}|linked|user_confirmed`);

  // 8. Keine Seitenfehler
  expect(pageErrors).toEqual([]);
});
