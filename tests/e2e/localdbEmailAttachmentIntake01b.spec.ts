/**
 * EINGANG-01B — sichtbarer Selbsttest: eingegangener Mail-Anhang → Dokumenteingang.
 *
 * Nur gegen die **lokale** Supabase-Instanz (Docker) mit einem synthetischen
 * Testnutzer und eigenem Workspace. Die eingehende Mail wird serverseitig über
 * den echten Import-Weg angelegt (Stub-Postfach, Sync-Lease, RPC
 * `import_workspace_inbound_email`), ihr Anhang liegt im privaten Bucket
 * `inbound-email-attachments`. Kein Provider, kein Versand, keine produktiven Daten.
 */
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
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
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'mail-intake-01b' });
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

async function invoicePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  const lines = [
    'Baustoff Meyer GmbH',
    'Rechnung',
    `An: ${company.companyName}`,
    'Rechnungsnummer: R-01B-77',
    'Rechnungsdatum: 26.09.2026',
    'Gesamtbetrag 119,00 EUR',
    'Zahlbar bis 15.10.2026',
  ];
  lines.forEach((line, index) => page.drawText(line, { x: 60, y: 760 - index * 22, size: 12, font }));
  return pdf.save();
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Legt die eingehende Mail über den echten Server-Import-Weg an (nur lokale Instanz). */
async function seedInboundMail(workspaceId: string): Promise<{ messageId: string; pdfAttachmentId: string }> {
  const db = admin();
  const pdf = await invoicePdf();
  const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode('01b-docx-fixture')]);
  const files = [
    { bytes: pdf, ext: 'pdf', name: 'Rechnung-R-01B-77.pdf', mime: 'application/pdf' },
    { bytes: docx, ext: 'docx', name: 'Leistungsverzeichnis.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  ];
  for (const file of files) {
    const upload = await db.storage.from('inbound-email-attachments').upload(`${workspaceId}/${sha(file.bytes)}.${file.ext}`, file.bytes, { contentType: file.mime, upsert: true });
    if (upload.error) throw new Error(`Upload: ${upload.error.message}`);
  }

  const connection = await db.from('workspace_mailbox_connections')
    .insert({ workspace_id: workspaceId, provider_type: 'stub', mailbox_address: 'info-01b@betrieb.invalid', status: 'connected' })
    .select('id').single();
  if (connection.error) throw new Error(`Postfach: ${connection.error.message}`);
  const claim = await db.rpc('claim_workspace_mailbox_sync', { p_connection_id: connection.data.id, p_lease_seconds: 300 });
  if (claim.error) throw new Error(`Lease: ${claim.error.message}`);
  const lease = (claim.data as { connection: { sync_lease_token: string } }).connection.sync_lease_token;

  const imported = await db.rpc('import_workspace_inbound_email', {
    p_connection_id: connection.data.id,
    p_lease_token: lease,
    p_message: {
      provider_message_id: `01b-${Date.now()}`, internet_message_id: `<01b-${Date.now()}@lieferant.invalid>`, provider_thread_id: 'thread-01b',
      from_address: 'buchhaltung@baustoff-meyer.invalid', from_name: 'Baustoff Meyer GmbH',
      to: ['info-01b@betrieb.invalid'], cc: [], subject: 'Rechnung R-01B-77', body_text: 'Guten Tag, anbei unsere Rechnung.',
      has_html: false, received_at: '2026-09-27T08:15:00Z',
    },
    p_attachments: files.map((file) => ({
      storage_path: `${workspaceId}/${sha(file.bytes)}.${file.ext}`, sha256: sha(file.bytes), filename: file.name,
      original_filename: file.name, mime_type: file.mime, size_bytes: file.bytes.length,
    })),
  });
  if (imported.error) throw new Error(`Import: ${imported.error.message}`);
  const result = imported.data as { outcome?: string; message_id?: string };
  if (result.outcome !== 'imported' || !result.message_id) throw new Error(`Import ohne Nachricht: ${JSON.stringify(result)}`);
  const messageId = result.message_id;
  const attachment = await db.from('workspace_email_message_attachments').select('id,filename').eq('message_id', messageId).eq('mime_type', 'application/pdf').single();
  if (attachment.error) throw new Error(`Anhang: ${attachment.error.message}`);
  return { messageId, pdfAttachmentId: attachment.data.id as string };
}

test('EINGANG-01B: Mail-Anhang sichtbar in den Eingang übernehmen', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 200)));

  await loginAndSetup(page);
  const membership = await admin().from('workspace_members').select('workspace_id').eq('user_id', user.id).eq('status', 'active').single();
  expect(membership.error).toBeNull();
  const workspaceId = membership.data!.workspace_id as string;
  const { messageId, pdfAttachmentId } = await seedInboundMail(workspaceId);
  const inboxId = `inbox-mail-${pdfAttachmentId}`;

  // 1./2. Eingehende Testmail mit geeignetem und ungeeignetem Anhang
  await page.goto(`/kommunikation/eingang/${messageId}`, { waitUntil: 'domcontentloaded' });
  const rows = page.getByTestId('kommunikation-inbound-attachment-row');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  const pdfRow = rows.filter({ hasText: 'Rechnung-R-01B-77.pdf' });
  const docxRow = rows.filter({ hasText: 'Leistungsverzeichnis.docx' });
  // 3. Aktion vorhanden; 10. ungeeigneter Anhang ohne Intake-Aktion
  await expect(pdfRow.getByTestId('kommunikation-inbound-intake')).toHaveText('In Eingang übernehmen');
  await expect(docxRow.getByTestId('kommunikation-inbound-intake')).toHaveCount(0);
  await expect(docxRow.getByTestId('kommunikation-inbound-attachment-download')).toBeVisible();
  await page.screenshot({ path: 'test-results/localdb/01b-1-mail.png' });
  await page.getByTestId('kommunikation-inbound-attachments').screenshot({ path: 'test-results/localdb/01b-1b-anhaenge.png' });

  // 4./6. Übernehmen → Eingang öffnet sich
  await pdfRow.getByTestId('kommunikation-inbound-intake').click();
  await expect(page).toHaveURL(new RegExp(`/ablage/${inboxId}$`), { timeout: 60_000 });
  // 7. Herkunft sichtbar
  const origin = page.getByTestId('eingang-detail-email-origin');
  await expect(origin).toContainText('Eingegangen per E-Mail');
  await expect(origin).toContainText('Baustoff Meyer GmbH');
  await expect(origin).toContainText('27.09.2026');
  await page.screenshot({ path: 'test-results/localdb/01b-2-eingang.png' });

  // 5. Genau ein Eingang, mit Herkunft, ohne Vorgang (11.) — in der Cloud nach dem Sync
  await expect.poll(async () => {
    const { data } = await admin().from('workspace_inbox_items').select('client_inbox_id').eq('workspace_id', workspaceId);
    return (data ?? []).length;
  }, { timeout: 60_000 }).toBe(1);
  const row = await admin().from('workspace_inbox_items').select('client_inbox_id,vorgang_id,vorgang_link_status,payload').eq('workspace_id', workspaceId).single();
  expect(row.data!.client_inbox_id).toBe(inboxId);
  expect(row.data!.vorgang_id).toBeNull();
  expect(row.data!.vorgang_link_status).toBe('none');
  const payload = row.data!.payload as { importSource?: string; emailOrigin?: { messageId: string; attachmentId: string }; mailImportId?: string; vorgangId?: string };
  expect(payload.importSource).toBe('email');
  expect(payload.emailOrigin).toMatchObject({ messageId, attachmentId: pdfAttachmentId });
  expect(payload.mailImportId).toBeUndefined();
  expect(payload.vorgangId).toBeUndefined();

  // 8. Rückverweis zur Ursprungs-E-Mail
  await page.getByTestId('eingang-detail-email-origin-link').click();
  await expect(page).toHaveURL(new RegExp(`/kommunikation/eingang/${messageId}$`));
  // 9. Bereits übernommen → kein zweiter Import
  await expect(pdfRow.getByTestId('kommunikation-inbound-intake-open')).toBeVisible({ timeout: 30_000 });
  await expect(pdfRow.getByTestId('kommunikation-inbound-intake')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/localdb/01b-3-bereits.png' });
  await pdfRow.getByTestId('kommunikation-inbound-intake-open').click();
  await expect(page).toHaveURL(new RegExp(`/ablage/${inboxId}$`));
  const { data: after } = await admin().from('workspace_inbox_items').select('client_inbox_id').eq('workspace_id', workspaceId);
  expect((after ?? []).length).toBe(1);

  // 12. Keine Seitenfehler
  expect(pageErrors).toEqual([]);
});
