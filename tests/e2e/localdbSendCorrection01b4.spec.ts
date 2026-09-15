/**
 * EMAIL-01B4 — Korrekturbeleg-Versand und Standard-E-Mail-Texte in der
 * echten App (lokale Supabase, lokal servierte Edge Function, MAIL_PROVIDER=stub,
 * VITE_MAIL_PROVIDER=stub). Kein echter Provider, kein echter Key.
 *
 * Correction-Hauptflow: versendete Rechnung → Storno → Korrekturbeleg →
 * „Korrektur per E-Mail senden" → Dialog (Empfänger/Betreff/Nachricht/PDF) →
 * Senden (Doppeltipp) → genau eine invoice_correction-Delivery, provider_accepted,
 * nicht „zugestellt", Original-sent_delivery_id/-sent_source unverändert → Reload.
 * Settings-Flow: Standardtexte setzen → Dialog nutzt sie → Draft nach Reload,
 * spätere Settings-Änderung überschreibt ihn nicht, historische Delivery unverändert.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let user: LocalDbUser;
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  const probe = await fetch(`${SUPABASE_URL}/functions/v1/send-document`, { method: 'OPTIONS' }).catch(() => null);
  test.skip(!probe, 'send-document wird lokal nicht serviert.');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'send-corr' });
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
  await page.getByTestId('setup-companyName').fill('Korrektur E2E GmbH');
  await page.getByTestId('setup-contactPerson').fill('K. Test');
  await page.getByTestId('setup-street').fill('Werkstraße 2');
  await page.getByTestId('setup-zip').fill('54321');
  await page.getByTestId('setup-city').fill('Betriebsstadt');
  await page.getByTestId('setup-email').fill('korrektur@example.invalid');
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-taxNumber').fill('11/222/33333');
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-iban').fill('DE89370400440532013000');
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

async function sendInvoice(page: Page): Promise<void> {
  await expect(page.getByTestId('invoice-delivery-empty')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('invoice-delivery-send').scrollIntoViewIfNeeded();
  await page.getByTestId('invoice-delivery-send').click();
  await expect(page.getByTestId('send-document-dialog')).toBeVisible();
  await page.getByTestId('send-document-send').click();
  await expect(page.getByTestId('send-document-dialog')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('invoice-delivery-panel').getByTestId('invoice-delivery-status').first()).toHaveText('An E-Mail-Dienst übergeben');
}

async function invoiceRow(invoiceId: string) {
  const { data } = await admin().from('workspace_invoices').select('invoice_status,sent_source,sent_delivery_id,cancellation_kind,correction_document_id,payload,row_version').eq('client_invoice_id', invoiceId).single();
  return data as { invoice_status: string; sent_source: string | null; sent_delivery_id: string | null; cancellation_kind: string | null; correction_document_id: string | null; payload: Record<string, unknown>; row_version: number };
}

async function deliveries(invoiceId: string) {
  const { data } = await admin().from('workspace_document_deliveries').select('id,document_kind,status,subject,attempt_number').eq('linked_invoice_id', invoiceId).order('requested_at', { ascending: true });
  return (data ?? []) as { id: string; document_kind: string; status: string; subject: string; attempt_number: number }[];
}

async function expectNoOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontaler Überlauf: ${label}`).toBeLessThanOrEqual(1);
}

test.describe('EMAIL-01B4 — Korrekturbeleg und Standardtexte (lokal, Stub)', () => {
  test('Correction-Hauptflow: versendet → Storno → Korrektur senden (Doppeltipp) → eine invoice_correction-Delivery, Original unverändert, Reload; failed → Retry; unknown → kein Retry', async ({ page }) => {
    test.setTimeout(300_000);
    await loginAndSetup(page);

    /* 1. versendete Rechnung */
    const invoiceId = await createFinalizedInvoice(page, 'Korrektur Kunde GmbH', 'kunde@example.invalid');
    await sendInvoice(page);
    const before = await invoiceRow(invoiceId);
    expect(before).toMatchObject({ invoice_status: 'versendet', sent_source: 'officepilot' });
    expect(before.sent_delivery_id).toBeTruthy();
    await expect(page.getByTestId('invoice-correction-delivery-panel')).toHaveCount(0);

    /* 2./3. Storno → Korrekturbeleg */
    await page.getByTestId('invoice-cancel-action').scrollIntoViewIfNeeded();
    await page.getByTestId('invoice-cancel-action').click();
    await page.getByTestId('invoice-cancel-reason-input').fill('Falscher Betrag');
    await page.getByTestId('invoice-cancel-submit').click();
    await expect(page.getByTestId('invoice-cancel-dialog')).toHaveCount(0, { timeout: 45_000 });
    await expect(page.getByTestId('invoice-correction-delivery-panel')).toBeVisible({ timeout: 30_000 });
    const cancelled = await invoiceRow(invoiceId);
    expect(cancelled.cancellation_kind).toBe('correction');
    expect(cancelled.correction_document_id).toBeTruthy();
    expect(cancelled.sent_delivery_id).toBe(before.sent_delivery_id);
    // Rechnung selbst ist nach Storno nicht mehr versendbar; Korrektur ja.
    await expect(page.getByTestId('invoice-delivery-panel').getByTestId('invoice-delivery-send')).toHaveCount(0);
    await expectNoOverflow(page, 'Detail mit Korrekturpanel');

    /* 4.–9. Dialog */
    const correction = page.getByTestId('invoice-correction-delivery-panel');
    await expect(correction.getByTestId('invoice-delivery-empty')).toBeVisible({ timeout: 30_000 });
    await correction.getByTestId('invoice-delivery-send').scrollIntoViewIfNeeded();
    await expect(correction.getByTestId('invoice-delivery-send')).toHaveText('Korrektur per E-Mail senden');
    await correction.getByTestId('invoice-delivery-send').click();
    await expect(page.getByTestId('send-document-dialog')).toHaveAttribute('data-document-kind', 'invoice_correction');
    await expect(page.locator('#send-document-dialog-title')).toHaveText('Korrekturbeleg per E-Mail senden');
    await expect(page.getByTestId('send-document-recipient')).toHaveValue('kunde@example.invalid');
    await expect(page.getByTestId('send-document-subject')).toHaveValue(/^Rechnungskorrektur zu 2026-\d+ - Korrektur E2E GmbH/);
    await expect(page.getByTestId('send-document-body')).toHaveValue(/Rechnungskorrektur zu unserer Rechnung 2026-\d+/);
    await expect(page.getByTestId('send-document-attachment-name')).toContainText(/Rechnung_Rechnungskorrektur-2026-\d+\.pdf/);
    await expect(page.getByTestId('send-document-pdf')).toBeVisible();
    await expectNoOverflow(page, 'Korrekturdialog');
    expect((await deliveries(invoiceId)).filter((d) => d.document_kind === 'invoice_correction')).toHaveLength(0);

    /* 10.–15. Senden, Doppeltipp, Status, Original */
    const sendButton = page.getByTestId('send-document-send');
    await sendButton.scrollIntoViewIfNeeded();
    await sendButton.click();
    await sendButton.click({ force: true }).catch(() => undefined);
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0, { timeout: 60_000 });
    const afterSend = await deliveries(invoiceId);
    expect(afterSend.filter((d) => d.document_kind === 'invoice_correction')).toHaveLength(1);
    expect(afterSend.find((d) => d.document_kind === 'invoice_correction')?.status).toBe('provider_accepted');
    await expect(correction.getByTestId('invoice-delivery-status').first()).toHaveText('An E-Mail-Dienst übergeben');
    await expect(correction.getByTestId('invoice-delivery-kind').first()).toHaveText('Korrekturbeleg');
    await expect(correction).not.toContainText('Zugestellt');
    const afterRow = await invoiceRow(invoiceId);
    expect(afterRow.sent_delivery_id).toBe(before.sent_delivery_id);
    expect(afterRow.sent_source).toBe('officepilot');
    expect(afterRow.payload.sentAt).toBe(before.payload.sentAt);
    expect(afterRow.row_version).toBe(cancelled.row_version);

    /* 16./17. Reload */
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('invoice-correction-delivery-panel').getByTestId('invoice-delivery-status').first()).toHaveText('An E-Mail-Dienst übergeben', { timeout: 30_000 });
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0);
    expect((await deliveries(invoiceId)).filter((d) => d.document_kind === 'invoice_correction')).toHaveLength(1);
    await expect(page.getByTestId('invoice-correction-delivery-panel').getByTestId('invoice-delivery-send')).toHaveText('Korrektur erneut per E-Mail senden');

    /* failed → Retry (neuer Attempt); unknown → kein Retry */
    const invoice2 = await createFinalizedInvoice(page, 'Korrektur Bounce GmbH', 'kunde@example.invalid');
    await sendInvoice(page);
    await page.getByTestId('invoice-cancel-action').scrollIntoViewIfNeeded();
    await page.getByTestId('invoice-cancel-action').click();
    await page.getByTestId('invoice-cancel-reason-input').fill('Storno');
    await page.getByTestId('invoice-cancel-submit').click();
    await expect(page.getByTestId('invoice-correction-delivery-panel')).toBeVisible({ timeout: 45_000 });
    const corr2 = page.getByTestId('invoice-correction-delivery-panel');
    await expect(corr2.getByTestId('invoice-delivery-empty')).toBeVisible({ timeout: 30_000 });
    await corr2.getByTestId('invoice-delivery-send').click();
    await page.getByTestId('send-document-recipient').fill('x@bounce.invalid');
    await page.getByTestId('send-document-send').click();
    await expect(page.getByTestId('send-document-confirm-recipient')).toBeVisible();
    await page.getByTestId('send-document-send').click();
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0, { timeout: 60_000 });
    await expect(corr2.getByTestId('invoice-delivery-status').first()).toHaveText('Versand fehlgeschlagen');
    await corr2.getByTestId('invoice-delivery-retry').click();
    await expect(page.getByTestId('send-document-retry-hint')).toBeVisible();
    await page.getByTestId('send-document-recipient').fill('x@timeout.invalid');
    await page.getByTestId('send-document-send').click();
    await expect(page.getByTestId('send-document-confirm-recipient')).toBeVisible();
    await page.getByTestId('send-document-send').click();
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0, { timeout: 60_000 });
    await expect(corr2.getByTestId('invoice-delivery-status').first()).toHaveText('Versandstatus unklar');
    await expect(corr2.getByTestId('invoice-delivery-check-status')).toBeVisible();
    await expect(corr2.getByTestId('invoice-delivery-retry')).toHaveCount(0);
    const corrDeliveries = (await deliveries(invoice2)).filter((d) => d.document_kind === 'invoice_correction');
    expect(corrDeliveries.map((d) => d.attempt_number)).toEqual([1, 2]);
    const row2 = await invoiceRow(invoice2);
    expect(row2).toMatchObject({ invoice_status: 'versendet', sent_source: 'officepilot' });
  });

  test('Settings: Standardtexte → Dialog nutzt sie; Draft überlebt Reload; spätere Settings-Änderung überschreibt Draft nicht; historische Delivery unverändert', async ({ page }) => {
    test.setTimeout(300_000);
    await loginAndSetup(page);

    /* 1.–4. Einstellungen setzen */
    await page.goto('/einstellungen/kommunikation', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-communication-section-email')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('settings-communication-defaultInvoiceEmailSubject').fill('Ihre Rechnung {invoiceNumber} von {companyName}');
    await page.getByTestId('settings-communication-defaultInvoiceEmailBody').fill('Hallo,\n\nRechnung {invoiceNumber} anbei.\n\n{companyName}');
    await expect(page.getByTestId('settings-communication-email-preview-subject')).toHaveText('Ihre Rechnung VORSCHAU-0001 von Korrektur E2E GmbH');
    await page.getByTestId('settings-communication-save').scrollIntoViewIfNeeded();
    await page.getByTestId('settings-communication-save').click();
    await expect(page.getByText('Kommunikationseinstellungen gespeichert.')).toBeVisible();
    await expectNoOverflow(page, 'Settings E-Mail');

    /* 5.–7. Sendmaske mit Defaults, editieren */
    const invoiceId = await createFinalizedInvoice(page, 'Settings Kunde GmbH', 'kunde@example.invalid');
    await expect(page.getByTestId('invoice-delivery-empty')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('invoice-delivery-send').scrollIntoViewIfNeeded();
    await page.getByTestId('invoice-delivery-send').click();
    await expect(page.getByTestId('send-document-subject')).toHaveValue(/^Ihre Rechnung 2026-\d+ von Korrektur E2E GmbH$/);
    await expect(page.getByTestId('send-document-body')).toHaveValue(/^Hallo,\n\nRechnung 2026-\d+ anbei\.\n\nKorrektur E2E GmbH$/);
    await page.getByTestId('send-document-subject').fill('Individueller Betreff');
    await page.getByTestId('send-document-send').click();
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0, { timeout: 60_000 });
    const sent = await deliveries(invoiceId);
    expect(sent[0]?.subject).toBe('Individueller Betreff');

    /* 8.–9. Draft überlebt Reload; Settings-Änderung mischt sich nicht ein */
    const invoice2 = await createFinalizedInvoice(page, 'Draft Kunde GmbH', 'kunde@example.invalid');
    await expect(page.getByTestId('invoice-delivery-empty')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('invoice-delivery-send').scrollIntoViewIfNeeded();
    await page.getByTestId('invoice-delivery-send').click();
    await page.getByTestId('send-document-subject').fill('Entwurf-Betreff');
    // Entwurf mit stabiler client_delivery_id persistieren, ohne zu senden (Cloud-Ausfall simulieren).
    await page.route('**/functions/v1/send-document', (route) => route.abort());
    await page.getByTestId('send-document-send').click();
    await expect(page.getByTestId('send-document-error')).toBeVisible({ timeout: 60_000 });
    await page.unroute('**/functions/v1/send-document');
    await page.goto('/einstellungen/rechnungen', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('settings-communication-defaultInvoiceEmailSubject').fill('GEÄNDERT {invoiceNumber}');
    await page.getByTestId('settings-communication-save').scrollIntoViewIfNeeded();
    await page.getByTestId('settings-communication-save').click();
    await expect(page.getByText('Kommunikationseinstellungen gespeichert.')).toBeVisible();
    await page.goto(`/rechnungen/${invoice2}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('send-document-resume-hint')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('send-document-subject')).toHaveValue('Entwurf-Betreff');
    await page.getByTestId('send-document-send').click();
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0, { timeout: 60_000 });
    const sent2 = await deliveries(invoice2);
    expect(sent2).toHaveLength(1);
    expect(sent2[0]?.subject).toBe('Entwurf-Betreff');
    expect(sent2[0]?.status).toBe('provider_accepted');

    /* 10. historische Delivery unverändert */
    expect((await deliveries(invoiceId))[0]?.subject).toBe('Individueller Betreff');
    // Neuer Entwurf einer weiteren Rechnung nimmt den neuen Standard.
    const invoice3 = await createFinalizedInvoice(page, 'Neu Kunde GmbH', 'kunde@example.invalid');
    await expect(page.getByTestId('invoice-delivery-empty')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('invoice-delivery-send').scrollIntoViewIfNeeded();
    await page.getByTestId('invoice-delivery-send').click();
    await expect(page.getByTestId('send-document-subject')).toHaveValue(/^GEÄNDERT 2026-\d+$/);
    await page.getByTestId('send-document-cancel').click();
    expect(invoice3).toBeTruthy();
  });
});
