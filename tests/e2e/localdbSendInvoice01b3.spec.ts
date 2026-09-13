/**
 * EMAIL-01B3 — sichtbarer Rechnungsversand in der echten App gegen die
 * **lokale** Supabase-Instanz mit lokal servierter Edge Function
 * `send-document` und `MAIL_PROVIDER=stub` (Client: VITE_MAIL_PROVIDER=stub).
 * Kein echter Provider, kein echter Key, synthetisches Konto.
 *
 * Hauptflow (Desktop headed + Android + WebKit):
 *   1. freie Rechnung finalisieren  2. Versandpanel sichtbar  3. „Per E-Mail senden"
 *   4.–7. Empfänger/Betreff/Nachricht vorbelegt, PDF-Anhang sichtbar
 *   8. Senden (Doppeltipp)  9. genau eine Delivery  10. provider_accepted
 *  11. nicht „zugestellt"  12./13. Rechnung versendet / officepilot
 *  14.–16. Reload: Historie bleibt, kein erneuter Versand
 * Weitere: failed → Retry neuer Attempt; unknown → Status prüfen, kein Retry;
 * Empfängerabweichung → Zusatzconfirm; Zweitversand → Zusatzconfirm.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let user: LocalDbUser;

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  const probe = await fetch(`${SUPABASE_URL}/functions/v1/send-document`, { method: 'OPTIONS' }).catch(() => null);
  test.skip(!probe, 'send-document wird lokal nicht serviert (supabase functions serve).');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'send-ui' });
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
  await page.getByTestId('setup-companyName').fill('Versand E2E GmbH');
  await page.getByTestId('setup-contactPerson').fill('V. Test');
  await page.getByTestId('setup-street').fill('Werkstraße 2');
  await page.getByTestId('setup-zip').fill('54321');
  await page.getByTestId('setup-city').fill('Betriebsstadt');
  await page.getByTestId('setup-email').fill('versand@example.invalid');
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

/** Freie Rechnung mit Kunden-E-Mail anlegen und freigeben; liefert die Detail-URL. */
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
  // `inv-`: /rechnungen/neu ist keine Rechnungskennung — nicht auf die alte URL hereinfallen.
  await expect(page).toHaveURL(/\/rechnungen\/inv-[^/]+$/, { timeout: 45_000 });
  await expect(page.getByTestId('invoice-detail-page')).toBeVisible();
  return page.url();
}

async function expectNoOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontaler Überlauf: ${label}`).toBeLessThanOrEqual(1);
}

async function countDeliveries(invoiceId: string): Promise<number> {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { count } = await admin.from('workspace_document_deliveries').select('id', { count: 'exact', head: true }).eq('linked_invoice_id', invoiceId);
  return count ?? 0;
}

async function openSendDialog(page: Page): Promise<void> {
  const send = page.getByTestId('invoice-delivery-send');
  await send.scrollIntoViewIfNeeded();
  await send.click();
  await expect(page.getByTestId('send-document-dialog')).toBeVisible();
}

test.describe('E-Mail-Versand — freie Rechnung (lokale Datenbank, Stub)', () => {
  test('Hauptflow: Panel, Dialog vorbelegt, Doppeltipp → eine Delivery, provider_accepted ≠ zugestellt, Rechnung versendet/officepilot, Reload ohne erneuten Versand, Zweitversand-Confirm', async ({ page }) => {
    test.setTimeout(240_000);
    await loginAndSetup(page);
    const url = await createFinalizedInvoice(page, 'Versand Kunde GmbH', 'kunde@example.invalid');
    const invoiceId = url.split('/').pop()!;

    /* 2. Versandpanel sichtbar; manuelle Markierung getrennt */
    await expect(page.getByTestId('invoice-delivery-panel')).toBeVisible();
    await expect(page.getByTestId('invoice-delivery-source')).toContainText('Noch nicht versendet');
    await expect(page.getByTestId('invoice-delivery-empty')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('invoice-sent-panel')).toBeVisible();
    await expect(page.getByTestId('invoice-sent-panel')).toContainText('Extern als versendet markieren');
    await expectNoOverflow(page, 'Detail mit Versandpanel');

    /* 3.–7. Dialog mit Vorbelegung */
    await openSendDialog(page);
    await expect(page.getByTestId('send-document-recipient')).toHaveValue('kunde@example.invalid');
    await expect(page.getByTestId('send-document-subject')).toHaveValue(/^Rechnung 2026-\d+ - Versand E2E GmbH/);
    await expect(page.getByTestId('send-document-body')).toHaveValue(/anbei erhalten Sie unsere Rechnung 2026-\d+/);
    await expect(page.getByTestId('send-document-attachment-name')).toContainText(/Rechnung_2026-\d+\.pdf/);
    await expect(page.getByTestId('send-document-pdf')).toBeVisible();
    await expectNoOverflow(page, 'Dialog');
    expect(await countDeliveries(invoiceId)).toBe(0);

    /* 8./9. Senden — zwei schnelle Klicks, genau eine Delivery */
    const sendButton = page.getByTestId('send-document-send');
    await sendButton.scrollIntoViewIfNeeded();
    await sendButton.click();
    await sendButton.click({ force: true }).catch(() => undefined);
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByText('Rechnung an den E-Mail-Dienst übergeben.')).toBeVisible();
    expect(await countDeliveries(invoiceId)).toBe(1);

    /* 10.–13. Status und Rechnung */
    await expect(page.getByTestId('invoice-delivery-status')).toHaveText('An E-Mail-Dienst übergeben');
    await expect(page.getByTestId('invoice-delivery-panel')).not.toContainText('Zugestellt');
    await expect(page.getByTestId('invoice-delivery-source')).toContainText('Per OfficePilot versendet');
    await expect(page.getByTestId('invoice-sent-status')).toBeVisible();
    await expect(page.getByTestId('invoice-sent-via')).toContainText('E-Mail');
    await expect(page.getByTestId('invoice-delivery-item')).toContainText('kunde@example.invalid');

    /* 14.–16. Reload: Historie bleibt, kein erneuter Versand */
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('invoice-delivery-status')).toHaveText('An E-Mail-Dienst übergeben', { timeout: 30_000 });
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0);
    await expect(page.getByTestId('invoice-delivery-source')).toContainText('Per OfficePilot versendet');
    expect(await countDeliveries(invoiceId)).toBe(1);

    /* Zweitversand: Zusatzconfirm, Abbrechen ohne Versand */
    await expect(page.getByTestId('invoice-delivery-send')).toHaveText('Erneut per E-Mail senden');
    await openSendDialog(page);
    await page.getByTestId('send-document-send').click();
    await expect(page.getByTestId('send-document-confirm-resend')).toBeVisible();
    await page.getByTestId('send-document-cancel').click();
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0);
    expect(await countDeliveries(invoiceId)).toBe(1);
    await expectNoOverflow(page, 'Detail nach Versand');
  });

  test('failed → Erneut versuchen erzeugt Attempt 2; Empfängerabweichung verlangt Confirm; unknown → Status prüfen ohne Retry', async ({ page }) => {
    test.setTimeout(240_000);
    await loginAndSetup(page);
    const url = await createFinalizedInvoice(page, 'Bounce Kunde GmbH', 'x@bounce.invalid');
    const invoiceId = url.split('/').pop()!;

    /* failed (recipient) */
    await expect(page.getByTestId('invoice-delivery-empty')).toBeVisible({ timeout: 30_000 });
    await openSendDialog(page);
    await page.getByTestId('send-document-send').click();
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId('invoice-delivery-status')).toHaveText('Versand fehlgeschlagen');
    await expect(page.getByTestId('invoice-delivery-error')).toContainText('Empfängeradresse');
    await expect(page.getByTestId('invoice-delivery-source')).toContainText('Noch nicht versendet');
    await expect(page.getByTestId('invoice-delivery-retry')).toBeVisible();

    /* Retry mit korrigierter Adresse: Empfängerabweichung → Confirm, dann Attempt 2 */
    await page.getByTestId('invoice-delivery-retry').click();
    await expect(page.getByTestId('send-document-retry-hint')).toBeVisible();
    await page.getByTestId('send-document-recipient').fill('kunde@example.invalid');
    await page.getByTestId('send-document-send').click();
    await expect(page.getByTestId('send-document-confirm-recipient')).toBeVisible();
    await page.getByTestId('send-document-send').click();
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId('invoice-delivery-item').first()).toContainText('Versuch 2');
    await expect(page.getByTestId('invoice-delivery-item').first()).toContainText('An E-Mail-Dienst übergeben');
    expect(await countDeliveries(invoiceId)).toBe(2);
    await expect(page.getByTestId('invoice-delivery-source')).toContainText('Per OfficePilot versendet');

    /* unknown (Timeout) auf einer weiteren Rechnung: kein blindes Retry */
    const url2 = await createFinalizedInvoice(page, 'Timeout Kunde GmbH', 'x@timeout.invalid');
    const invoiceId2 = url2.split('/').pop()!;
    await expect(page.getByTestId('invoice-delivery-empty')).toBeVisible({ timeout: 30_000 });
    await openSendDialog(page);
    await page.getByTestId('send-document-send').click();
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId('invoice-delivery-status')).toHaveText('Versandstatus unklar');
    await expect(page.getByTestId('invoice-delivery-unknown-hint')).toBeVisible();
    await expect(page.getByTestId('invoice-delivery-check-status')).toBeVisible();
    await expect(page.getByTestId('invoice-delivery-retry')).toHaveCount(0);
    await expect(page.getByTestId('invoice-delivery-send')).toHaveCount(0);
    await expect(page.getByTestId('invoice-delivery-source')).toContainText('Noch nicht versendet');
    await page.getByTestId('invoice-delivery-check-status').click();
    await expect(page.getByTestId('invoice-delivery-status')).toHaveText('Versandstatus unklar');
    expect(await countDeliveries(invoiceId2)).toBe(1);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('invoice-delivery-status')).toHaveText('Versandstatus unklar', { timeout: 30_000 });
    await expect(page.getByTestId('send-document-dialog')).toHaveCount(0);
    expect(await countDeliveries(invoiceId2)).toBe(1);
  });
});
