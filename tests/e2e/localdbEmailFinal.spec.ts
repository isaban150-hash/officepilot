/**
 * EMAIL-FINAL — Gesamtabnahme des E-Mail-Bereichs als eine Kette in der echten
 * App (lokale Supabase, lokal servierte Edge Function mit MAIL_PROVIDER=stub,
 * VITE_MAIL_PROVIDER=stub). Kein echter Provider, kein echter Key.
 *
 * Ergänzt 01B3 (freie Rechnung, Retry, Unknown) und 01B4 (Korrektur, Settings)
 * um die noch offenen Kettenglieder:
 *  - freie Rechnung als Träger (Vorgangsweg: siehe Hinweis im Test, serverseitig in 01B2 belegt)
 *  - Confirm-first: Finalize, Dialog öffnen, PDF ansehen, Navigation, Reload senden nichts
 *  - historische Wahrheit: Profil nach Finalisierung geändert, versendetes PDF trägt alte Werte;
 *    Hash/Größe/Pfad der Delivery entsprechen dem tatsächlich gespeicherten PDF
 *  - Reload während des Versands: keine zweite Mail
 *  - manuell versendet → später OfficePilot: Hochstufung, sentManualPrior; manuelle Korrektur danach stuft nicht zurück
 */
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let user: LocalDbUser;
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  const probe = await fetch(`${SUPABASE_URL}/functions/v1/send-document`, { method: 'OPTIONS' }).catch(() => null);
  test.skip(!probe, 'send-document wird lokal nicht serviert.');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'email-final' });
});
test.afterAll(async () => {
  if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
});

const company = loadTestWorldOperatorCompany();

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

async function createFinalizedInvoice(page: Page, customerName: string, customerEmail: string): Promise<string> {
  await page.goto('/rechnungen/neu', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('1/4', { timeout: 30_000 });
  await page.getByTestId('customer-decision-new').locator('input').check();
  await page.getByTestId('manual-invoice-customer-name').fill(customerName);
  await page.getByTestId('customer-decision-street').fill('Hauptstraße 12');
  await page.getByTestId('customer-decision-zip').fill('45356');
  await page.getByTestId('customer-decision-city').fill('Essen');
  await page.getByTestId('customer-decision-email').fill(customerEmail);
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('2/4');
  await page.getByTestId('manual-position-description').fill('Anfahrt');
  await page.getByTestId('manual-position-quantity').fill('1');
  await page.getByTestId('manual-position-unit-price').fill('45');
  await page.getByTestId('manual-position-commit').click();
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('3/4');
  await page.getByTestId('invoice-edit-service-from').fill('2026-09-01');
  await page.getByTestId('invoice-edit-service-to').fill('2026-09-05');
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('4/4');
  const approve = page.getByTestId('invoice-approve');
  await approve.scrollIntoViewIfNeeded();
  await approve.click();
  await expect(page).toHaveURL(/\/rechnungen\/inv-[^/]+$/, { timeout: 45_000 });
  await expect(page.getByTestId('invoice-detail-page')).toBeVisible();
  return page.url().split('/').pop()!;
}

interface DeliveryRow {
  id: string; document_kind: string; status: string; subject: string; provider: string; provider_message_id: string | null;
  attachment_storage_path: string | null; attachment_sha256: string | null; attachment_size_bytes: number | null; attachment_filename: string | null;
  attempt_number: number; workspace_id: string;
}
async function deliveries(invoiceId: string): Promise<DeliveryRow[]> {
  const { data, error } = await admin().from('workspace_document_deliveries')
    .select('id,document_kind,status,subject,provider,provider_message_id,attachment_storage_path,attachment_sha256,attachment_size_bytes,attachment_filename,attempt_number,workspace_id')
    .eq('linked_invoice_id', invoiceId).order('requested_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as DeliveryRow[];
}
async function invoiceRow(invoiceId: string) {
  const { data, error } = await admin().from('workspace_invoices').select('invoice_status,sent_source,sent_delivery_id,payload,row_version,vorgang_id').eq('client_invoice_id', invoiceId).single();
  if (error) throw new Error(error.message);
  return data as { invoice_status: string; sent_source: string | null; sent_delivery_id: string | null; payload: Record<string, unknown>; row_version: number; vorgang_id: string | null };
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true, verbosity: 0, useWorkerFetch: false }).promise;
  try {
    const parts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const content = await (await pdf.getPage(i)).getTextContent();
      parts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
    }
    return parts.join('\n');
  } finally {
    await pdf.destroy();
  }
}

async function expectNoOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontaler Überlauf: ${label}`).toBeLessThanOrEqual(1);
}

async function sendThroughDialog(page: Page): Promise<void> {
  const send = page.getByTestId('send-document-send');
  await send.scrollIntoViewIfNeeded();
  await send.click();
  const confirm = page.getByTestId('send-document-confirm-recipient');
  if (await confirm.isVisible().catch(() => false)) await send.click();
  await expect(page.getByTestId('send-document-dialog')).toHaveCount(0, { timeout: 60_000 });
}

test.describe('EMAIL-FINAL — Gesamtkette (lokal, Stub)', () => {
  test('Kette: Confirm-first, Profiländerung nach Finalisierung, Versand mit historischem PDF (Hash/Größe/Pfad), Reload während Versand ohne zweite Mail', async ({ page }) => {
    test.setTimeout(420_000);
    await loginAndSetup(page);

    /*
     * Freie Rechnung als Träger der Kette. Eine Vorgangsrechnung ist über die
     * lokale Testwelt nicht per Oberfläche erreichbar (DOC-00001 liefert einen
     * Vorgang ohne Leistungspositionen — dokumentierter Skip in
     * localdbManualInvoice01b1b); der Vorgangsweg ist serverseitig in
     * localdbSendDocument01b2 (Q1–Q7) und in der Panel-Unit-Suite (vorgangId)
     * belegt und nutzt denselben Dialog/Orchestrator/Serverpfad.
     */
    const invoiceId = await createFinalizedInvoice(page, 'Kette Kunde GmbH', 'kunde@example.invalid');
    const invoiceUrl = page.url();
    const row0 = await invoiceRow(invoiceId);
    expect(row0.vorgang_id).toBeNull();
    expect(row0.invoice_status).toBe('vorbereitet');

    /* ---- Confirm-first: nichts davon sendet ---- */
    expect(await deliveries(invoiceId)).toHaveLength(0); // Finalize
    await expect(page.getByTestId('invoice-delivery-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('invoice-delivery-empty')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('invoice-delivery-send').scrollIntoViewIfNeeded();
    await page.getByTestId('invoice-delivery-send').click();
    await expect(page.getByTestId('send-document-dialog')).toHaveAttribute('data-document-kind', 'invoice');
    await expect(page.getByTestId('send-document-subject')).toHaveValue(new RegExp(`^Rechnung 2026-\\d+ - ${company.companyName}$`));
    await page.getByTestId('send-document-pdf').click(); // PDF ansehen
    await page.waitForTimeout(1500);
    expect(await deliveries(invoiceId)).toHaveLength(0);
    await page.getByTestId('send-document-cancel').click();
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0);
    await page.waitForTimeout(800);
    await page.goto('/rechnungen', { waitUntil: 'domcontentloaded' }); // Navigation
    await page.goto(invoiceUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('invoice-delivery-empty')).toBeVisible({ timeout: 30_000 });
    await page.reload({ waitUntil: 'domcontentloaded' }); // Reload
    await expect(page.getByTestId('invoice-delivery-empty')).toBeVisible({ timeout: 30_000 });
    expect(await deliveries(invoiceId)).toHaveLength(0);
    expect((await invoiceRow(invoiceId)).invoice_status).toBe('vorbereitet');

    /* ---- Profil NACH Finalisierung ändern (Bankdaten + Telefon; der Firmenname ist Identitätsanker des Betriebs und bleibt) ---- */
    await page.goto('/einstellungen/firma', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-company-page')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('settings-company-phone').fill('+49 201 9999-0');
    await page.getByTestId('settings-company-iban').fill('DE02120300000000202051');
    await page.getByTestId('settings-company-save').scrollIntoViewIfNeeded();
    await page.getByTestId('settings-company-save').click();
    await expect(page.getByText('Firmenprofil gespeichert.')).toBeVisible();
    await page.waitForTimeout(1500);

    /* ---- Versand: Betreff/PDF aus dem Snapshot, nicht aus dem aktuellen Profil ---- */
    await page.goto(invoiceUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('invoice-delivery-empty')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('invoice-delivery-send').scrollIntoViewIfNeeded();
    await page.getByTestId('invoice-delivery-send').click();
    await expect(page.getByTestId('send-document-subject')).toHaveValue(new RegExp(`^Rechnung 2026-\\d+ - ${company.companyName}$`));
    const recipient = page.getByTestId('send-document-recipient');
    if (!(await recipient.inputValue())) await recipient.fill('kunde@example.invalid');
    await expect(page.getByTestId('send-document-confirm-recipient')).toHaveCount(0);
    await sendThroughDialog(page);
    await expect(page.getByTestId('invoice-delivery-status').first()).toHaveText('An E-Mail-Dienst übergeben');
    await expect(page.getByTestId('invoice-delivery-panel')).not.toContainText('Zugestellt');
    await expect(page.getByTestId('invoice-delivery-source')).toContainText('Per OfficePilot versendet');
    await expectNoOverflow(page, 'Vorgangsrechnung nach Versand');

    const sent = await deliveries(invoiceId);
    expect(sent).toHaveLength(1);
    const d = sent[0]!;
    expect(d).toMatchObject({ document_kind: 'invoice', status: 'provider_accepted', provider: 'stub' });
    expect(d.provider_message_id).toBeTruthy();
    const row1 = await invoiceRow(invoiceId);
    expect(row1).toMatchObject({ invoice_status: 'versendet', sent_source: 'officepilot', sent_delivery_id: d.id });
    expect(row1.payload.sentVia).toBe('email');
    expect(row1.payload.sentSource).toBe('officepilot');
    expect(row1.payload.sentDeliveryId).toBe(d.id);

    /* ---- Historische Wahrheit des Anhangs: Pfad/Hash/Größe == gespeichertes PDF; Inhalt == Snapshot ---- */
    expect(d.attachment_storage_path).toBe(`${d.workspace_id}/invoice-${invoiceId}/${d.attachment_sha256}.pdf`);
    const download = await admin().storage.from('document-deliveries').download(d.attachment_storage_path!);
    expect(download.error).toBeNull();
    const bytes = new Uint8Array(await download.data!.arrayBuffer());
    expect(bytes.length).toBe(d.attachment_size_bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(d.attachment_sha256);
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    const text = (await pdfText(bytes)).replace(/\s+/g, ' ');
    expect(text).toContain(company.companyName);
    expect(text).not.toContain('+49 201 9999-0');
    const oldIbanCompact = company.iban.replace(/\s+/g, '');
    expect(text.replace(/\s+/g, '')).toContain(oldIbanCompact);
    expect(text.replace(/\s+/g, '')).not.toContain('DE02120300000000202051');

    /* ---- Reload während des Versands: keine zweite Mail ---- */
    const invoice2 = await createFinalizedInvoice(page, 'Reload Kunde GmbH', 'kunde@example.invalid');
    await expect(page.getByTestId('invoice-delivery-empty')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('invoice-delivery-send').scrollIntoViewIfNeeded();
    await page.getByTestId('invoice-delivery-send').click();
    await expect(page.getByTestId('send-document-dialog')).toBeVisible();
    const seen = { calls: 0 };
    await page.route('**/functions/v1/send-document', async (route) => {
      if (route.request().method() === 'POST') {
        seen.calls += 1;
        await new Promise((r) => setTimeout(r, 2500));
      }
      // Der Reload bricht die laufende Anfrage ab — dann ist die Route bereits erledigt.
      await route.continue().catch(() => undefined);
    });
    await page.getByTestId('send-document-send').click();
    await expect(page.getByTestId('send-document-phase')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(600);
    await page.unroute('**/functions/v1/send-document');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('invoice-delivery-panel')).toBeVisible({ timeout: 30_000 });
    // Nach dem Reload entscheidet der Serverstatus: entweder bereits übergeben, oder ein wiederaufnehmbarer Entwurf — nie ein blinder zweiter Versand.
    await page.waitForTimeout(4000);
    const afterReload = await deliveries(invoice2);
    expect(afterReload.length).toBeLessThanOrEqual(1);
    if (afterReload[0]?.status === 'provider_accepted') {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('invoice-delivery-status').first()).toHaveText('An E-Mail-Dienst übergeben', { timeout: 30_000 });
      await expect(page.getByTestId('send-document-dialog')).toHaveCount(0);
    } else {
      await expect(page.getByTestId('send-document-resume-hint')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('send-document-send').click();
      await expect(page.getByTestId('send-document-dialog')).toHaveCount(0, { timeout: 60_000 });
    }
    const final2 = await deliveries(invoice2);
    expect(final2).toHaveLength(1);
    expect(final2[0]!.status).toBe('provider_accepted');
    expect((await invoiceRow(invoice2)).sent_delivery_id).toBe(final2[0]!.id);
  });

  test('Manuell versendet → OfficePilot-Versand stuft hoch (sentManualPrior), manuelle Korrektur danach stuft nicht zurück; Storno danach = Korrektur', async ({ page }) => {
    test.setTimeout(300_000);
    await loginAndSetup(page);
    const invoiceId = await createFinalizedInvoice(page, 'Manuell Kunde GmbH', 'kunde@example.invalid');

    /* Extern als versendet markieren: keine Fake-Delivery */
    await page.getByTestId('invoice-sent-mark').scrollIntoViewIfNeeded();
    await page.getByTestId('invoice-sent-mark').click();
    await expect(page.getByTestId('invoice-sent-form')).toBeVisible();
    await page.getByTestId('invoice-sent-date-input').fill('2026-09-05');
    await page.getByTestId('invoice-sent-via-input').selectOption('post');
    await page.getByTestId('invoice-sent-continue').click();
    await expect(page.getByTestId('invoice-sent-confirm')).toBeVisible();
    await page.getByTestId('invoice-sent-confirm-submit').click();
    await expect(page.getByTestId('invoice-sent-status')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1000);
    const manual = await invoiceRow(invoiceId);
    expect(manual).toMatchObject({ invoice_status: 'versendet', sent_source: 'manual', sent_delivery_id: null });
    expect(await deliveries(invoiceId)).toHaveLength(0);
    await expect(page.getByTestId('invoice-delivery-source')).toContainText('Extern als versendet markiert');
    await expect(page.getByTestId('invoice-delivery-send')).toHaveText('Per E-Mail senden');

    /* OfficePilot-Versand danach: Hochstufung, manuelle Angaben bewahrt, kein Zweitversand-Confirm (erster OfficePilot-Versand) */
    await page.getByTestId('invoice-delivery-send').scrollIntoViewIfNeeded();
    await page.getByTestId('invoice-delivery-send').click();
    await page.getByTestId('send-document-send').click();
    await expect(page.getByTestId('send-document-confirm-resend')).toHaveCount(0);
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId('invoice-delivery-status').first()).toHaveText('An E-Mail-Dienst übergeben');
    await expect(page.getByTestId('invoice-delivery-source')).toContainText('Per OfficePilot versendet');
    await expect(page.getByTestId('invoice-delivery-manual-prior')).toBeVisible();
    const sent = await deliveries(invoiceId);
    expect(sent).toHaveLength(1);
    const up = await invoiceRow(invoiceId);
    expect(up).toMatchObject({ invoice_status: 'versendet', sent_source: 'officepilot', sent_delivery_id: sent[0]!.id });
    expect(up.payload.sentVia).toBe('email');
    expect(up.payload.sentManualPrior).toMatchObject({ sentVia: 'post' });

    /* Spätere manuelle Korrektur der Versandangaben stuft nicht zurück */
    await page.getByTestId('invoice-sent-correct').scrollIntoViewIfNeeded();
    await page.getByTestId('invoice-sent-correct').click();
    await expect(page.getByTestId('invoice-sent-form')).toBeVisible();
    await page.getByTestId('invoice-sent-note-input').fill('Nachtrag');
    await page.getByTestId('invoice-sent-continue').click();
    await expect(page.getByTestId('invoice-sent-confirm')).toBeVisible();
    await page.getByTestId('invoice-sent-confirm-submit').click();
    await expect(page.getByTestId('invoice-sent-status')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1000);
    const afterCorrect = await invoiceRow(invoiceId);
    expect(afterCorrect).toMatchObject({ invoice_status: 'versendet', sent_source: 'officepilot', sent_delivery_id: sent[0]!.id });
    expect(afterCorrect.payload.sentSource).toBe('officepilot');
    expect(await deliveries(invoiceId)).toHaveLength(1);

    /* Zweitversand verlangt Bestätigung; Doppelklick → genau eine weitere Delivery */
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('invoice-delivery-send')).toHaveText('Erneut per E-Mail senden', { timeout: 30_000 });
    await page.getByTestId('invoice-delivery-send').scrollIntoViewIfNeeded();
    await page.getByTestId('invoice-delivery-send').click();
    await page.getByTestId('send-document-send').click();
    await expect(page.getByTestId('send-document-confirm-resend')).toBeVisible();
    await page.getByTestId('send-document-send').dblclick();
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0, { timeout: 60_000 });
    expect(await deliveries(invoiceId)).toHaveLength(2);
    const afterResend = await invoiceRow(invoiceId);
    expect(afterResend.sent_delivery_id).toBe(sent[0]!.id); // Erst-Kopplung bleibt (kept_existing)

    /* Storno nach OfficePilot-Versand ist ein Korrekturbeleg, kein internes Storno */
    await page.getByTestId('invoice-cancel-action').scrollIntoViewIfNeeded();
    await page.getByTestId('invoice-cancel-action').click();
    await expect(page.getByTestId('invoice-cancel-kind-correction')).toBeVisible();
    await page.getByTestId('invoice-cancel-reason-input').fill('Nachträgliche Korrektur');
    await page.getByTestId('invoice-cancel-submit').click();
    await expect(page.getByTestId('invoice-correction-delivery-panel')).toBeVisible({ timeout: 45_000 });
    const cancelled = await admin().from('workspace_invoices').select('cancellation_kind,sent_delivery_id,sent_source').eq('client_invoice_id', invoiceId).single();
    expect(cancelled.data).toMatchObject({ cancellation_kind: 'correction', sent_delivery_id: sent[0]!.id, sent_source: 'officepilot' });
    await expectNoOverflow(page, 'Detail nach Storno');
  });
});
