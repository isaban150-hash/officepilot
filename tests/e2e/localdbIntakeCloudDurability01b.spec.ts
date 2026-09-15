/**
 * FINANZ-CORE-DURABILITY-01B — Cloud Document Durability + Inbox Sync in der
 * echten App gegen die lokale Supabase-Instanz.
 *
 *  T1 Owner, Geraet 1: Upload DOC-00001 → Eingang → Sync (Seitenaufbau/Outbox)
 *     → Cloud: workspace_files (Hash = lokaler Hash), Storage-Objekt ws/sha256,
 *     inbox_items, work_results. Zweiter Sync erzeugt keine zweiten Zeilen.
 *  T2 Owner, Geraet 2 (zweiter Browser-Kontext): gleicher Eingangszustand,
 *     Dokument oeffnen → Original lazy laden → Hash identisch.
 *  T3 Member: eigener Upload sichtbar, Owner-Dokument nicht sichtbar (Cloud + UI).
 *  T4 Upload-Abbruch → Retry → genau ein Blob, genau eine Datei-/Eingangszeile.
 */
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';
const DOC_00001_PDF = 'test-world/documents/DOC-00001/source.pdf';
const DOC_00036_PDF = 'test-world/documents/DOC-00036/source.pdf';

let owner: LocalDbUser;
let member: LocalDbUser;
const company = loadTestWorldOperatorCompany();
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'dur-owner' });
  member = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'dur-member' });
});
test.afterAll(async () => {
  for (const user of [owner, member]) {
    if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
  }
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
  await page.getByTestId('setup-contactPerson').fill('Durability Test');
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

/** Echter Upload-Weg bis zur analysierten Ablage-Detailseite; liefert die Inbox-ID. */
async function uploadToAnalyzedDetail(page: Page, file: string): Promise<string> {
  await page.goto('/dokumente/upload', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('document-upload-page')).toBeVisible();
  await page.getByTestId('document-upload-input').setInputFiles(file);
  await expect(page.getByTestId('ocr-preview-panel')).toBeVisible();
  await expect(page.getByTestId('ocr-confirm-error')).toHaveCount(0);
  await expect(page.getByTestId('ocr-storage-decision-actions')).toBeVisible();
  const dup = page.getByTestId('storage-decision-save-duplicate-anyway');
  if (await dup.isVisible().catch(() => false)) await dup.click();
  else await page.getByTestId('storage-decision-save-permanently').click();
  await expect(page.getByTestId('ablage-detail-page')).toBeVisible();
  await expect(page.getByTestId('eingang-detail-analysis-loading')).toHaveCount(0);
  await expect(page.getByTestId('eingang-detail-analysis-pending')).toHaveCount(0);
  await expect(page.getByTestId('eingang-assist-flow')).toBeVisible();
  return new URL(page.url()).pathname.split('/').pop()!;
}

/** Sync ueber die Synchronisationsseite (sichtbarer Nutzerweg, keine internen Aufrufe). */
async function runSync(page: Page): Promise<void> {
  await page.goto('/synchronisation', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sync-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('sync-run-button').click();
  await expect(page.getByTestId('sync-run-button')).toBeEnabled({ timeout: 60_000 });
  await page.waitForTimeout(800);
}

interface LocalIntake { inbox: { id: string; status: string; fileRefId?: string; archiveDocumentId?: string; syncVersion?: number }[]; files: { id: string; contentHash: string; storageType: string; cloudPath?: string; lifecycle: string }[]; workResults: { inboxItemId: string; syncVersion?: number }[]; documents: { id: string; fileRefId?: string; category: string }[] }

/** Original-Panel liegt hinter „Weitere Optionen" (sofern die Klappe existiert). */
async function revealOriginal(page: Page): Promise<void> {
  const toggle = page.getByTestId('document-review-more-toggle');
  if (await toggle.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await toggle.click();
  }
  const section = page.getByTestId('review-section-toggle-original-document');
  await expect(section).toBeVisible({ timeout: 30_000 });
  if (!(await page.getByTestId('ablage-original-file').isVisible().catch(() => false))) await section.click();
  await expect(page.getByTestId('ablage-original-file')).toBeVisible({ timeout: 30_000 });
}

async function localIntake(page: Page): Promise<LocalIntake> {
  const raw = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (key.startsWith('officepilot-state:workspace:')) return localStorage.getItem(key);
    }
    return null;
  });
  const s = raw ? (JSON.parse(raw) as Record<string, any[]>) : {};
  return {
    inbox: (s.inboxItems ?? []).map((x) => ({ id: x.id, status: x.status, fileRefId: x.fileRefId, archiveDocumentId: x.archiveDocumentId, syncVersion: x.sync?.version })),
    files: (s.documentFileRefs ?? []).map((x) => ({ id: x.id, contentHash: x.contentHash, storageType: x.storageType, cloudPath: x.cloud?.storagePath, lifecycle: x.lifecycleStatus })),
    workResults: (s.documentWorkResults ?? []).map((x) => ({ inboxItemId: x.inboxItemId, syncVersion: x.sync?.version })),
    documents: (s.documents ?? []).map((x) => ({ id: x.id, fileRefId: x.fileRefId, category: x.category })),
  };
}

async function cloudState(wsId: string) {
  const a = admin();
  const files = await a.from('workspace_files').select('client_file_ref_id,content_sha256,size_bytes,storage_path,created_by,deleted,row_version').eq('workspace_id', wsId);
  const inbox = await a.from('workspace_inbox_items').select('client_inbox_id,status,client_file_ref_id,created_by,deleted,row_version').eq('workspace_id', wsId);
  const work = await a.from('workspace_document_work_results').select('client_inbox_id,source_fingerprint,row_version').eq('workspace_id', wsId);
  const docs = await a.from('workspace_documents').select('client_document_id,document_kind').eq('workspace_id', wsId);
  const objects = await a.storage.from('workspace-files').list(wsId);
  return { files: files.data ?? [], inbox: inbox.data ?? [], work: work.data ?? [], docs: docs.data ?? [], objects: (objects.data ?? []).map((o) => o.name) };
}

async function workspaceIdOf(userId: string): Promise<string> {
  const { data } = await admin().from('workspace_members').select('workspace_id,role').eq('user_id', userId).eq('role', 'owner').limit(1);
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

test.describe('FINANZ-CORE-DURABILITY-01B (lokal)', () => {
  test('T1–T4: Upload → Cloud → Geraet 2 → Original; Member-Grenzen; Retry ohne Duplikat', async ({ page, browser }) => {
    test.setTimeout(420_000);
    await login(page, owner, true);
    const wsId = await workspaceIdOf(owner.id);

    /* T1 — Upload auf Geraet 1 */
    const inboxId = await uploadToAnalyzedDetail(page, DOC_00001_PDF);
    const localBefore = await localIntake(page);
    const item = localBefore.inbox.find((i) => i.id === inboxId)!;
    expect(item.fileRefId).toBeTruthy();
    const ref = localBefore.files.find((f) => f.id === item.fileRefId)!;
    expect(ref.lifecycle).toBe('committed');
    const originalHash = ref.contentHash;
    const originalBytes = await (await import('node:fs/promises')).readFile(DOC_00001_PDF);
    expect(originalHash).toBe(createHash('sha256').update(originalBytes).digest('hex'));

    await runSync(page);
    const cloud1 = await cloudState(wsId);
    expect(cloud1.files.map((f) => f.client_file_ref_id)).toContain(ref.id);
    const cloudFile = cloud1.files.find((f) => f.client_file_ref_id === ref.id)!;
    expect(cloudFile.content_sha256).toBe(originalHash);
    expect(cloudFile.storage_path).toBe(`${wsId}/${originalHash}`);
    expect(cloudFile.created_by).toBe(owner.id);
    expect(cloud1.objects).toContain(originalHash);
    expect(cloud1.inbox.map((i) => i.client_inbox_id)).toContain(inboxId);
    expect(cloud1.work.map((w) => w.client_inbox_id)).toContain(inboxId);
    // Objekt ist byte-identisch
    const down = await admin().storage.from('workspace-files').download(`${wsId}/${originalHash}`);
    expect(createHash('sha256').update(new Uint8Array(await down.data!.arrayBuffer())).digest('hex')).toBe(originalHash);
    // lokale Referenz kennt jetzt ihren Cloud-Pfad; Sync-Version gesetzt
    const localAfter = await localIntake(page);
    expect(localAfter.files.find((f) => f.id === ref.id)?.cloudPath).toBe(`${wsId}/${originalHash}`);
    expect(localAfter.inbox.find((i) => i.id === inboxId)?.syncVersion).toBe(1);

    // zweiter Sync: keine zweiten Zeilen/Objekte
    await page.goto('/synchronisation', { waitUntil: 'domcontentloaded' });
    await runSync(page);
    const cloud1b = await cloudState(wsId);
    expect(cloud1b.files.filter((f) => f.client_file_ref_id === ref.id)).toHaveLength(1);
    expect(cloud1b.inbox.filter((i) => i.client_inbox_id === inboxId)).toHaveLength(1);
    expect(cloud1b.objects.filter((o) => o === originalHash)).toHaveLength(1);

    /* T2 — Geraet 2 */
    const device2 = await openSecondDevice(browser, owner);
    try {
      await device2.page.goto('/ablage', { waitUntil: 'domcontentloaded' });
      await expect(device2.page.getByTestId('eingang-list')).toBeVisible({ timeout: 30_000 });
      const local2 = await localIntake(device2.page);
      const item2 = local2.inbox.find((i) => i.id === inboxId);
      expect(item2, 'Eingang fehlt auf Geraet 2').toBeTruthy();
      expect(item2!.status).toBe(item.status);
      expect(item2!.fileRefId).toBe(ref.id);
      expect(local2.workResults.map((w) => w.inboxItemId)).toContain(inboxId);
      const ref2 = local2.files.find((f) => f.id === ref.id)!;
      expect(ref2.storageType).toBe('cloud');
      expect(ref2.contentHash).toBe(originalHash);

      await device2.page.goto(`/ablage/${inboxId}`, { waitUntil: 'domcontentloaded' });
      await expect(device2.page.getByTestId('ablage-detail-page')).toBeVisible({ timeout: 30_000 });
      await revealOriginal(device2.page);
      const pdf = device2.page.getByTestId('document-original-file-panel-pdf');
      await expect(pdf).toBeVisible({ timeout: 60_000 });
      const src = await pdf.getAttribute('src');
      expect(src).toMatch(/^blob:/);
      const hash2 = await device2.page.evaluate(async (url) => {
        const buffer = await (await fetch(url)).arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      }, src!);
      expect(hash2).toBe(originalHash);
      const local2b = await localIntake(device2.page);
      expect(local2b.files.find((f) => f.id === ref.id)?.storageType).toBe('indexeddb');
      await expect(device2.page.getByTestId('document-original-file-panel-blob-missing')).toHaveCount(0);
    } finally {
      await device2.context.close();
    }

    /* T3 — Member: eigener Upload sichtbar, Owner-Dokument nicht.
     * Hinweis: Die App kennt keinen Beitritts-Flow fuer Mitglieder
     * (ensure_personal_workspace legt fuer reine Member einen eigenen Workspace an).
     * Der Member-Pfad laeuft daher ueber dieselben Bausteine, die die App nutzt:
     * Storage-Upload (Hash-Pfad) → upsert_workspace_intake_entity → pull_workspace_intake_state.
     */
    const { error: memberErr } = await admin().from('workspace_members').insert({ workspace_id: wsId, user_id: member.id, role: 'member', status: 'active' });
    expect(memberErr).toBeNull();
    const memberClient = createClient(SUPABASE_URL, process.env.E2E_LOCALDB_ANON_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } });
    const memberLogin = await memberClient.auth.signInWithPassword({ email: member.email, password: member.password });
    expect(memberLogin.error).toBeNull();
    const memberBytes = await (await import('node:fs/promises')).readFile(DOC_00036_PDF);
    const memberHash = createHash('sha256').update(memberBytes).digest('hex');
    const memberFileRefId = `file-ref-member-${Date.now()}`;
    const memberInboxId = `inbox-upload-${Date.now()}`;
    const memberUpload = await memberClient.storage.from('workspace-files').upload(`${wsId}/${memberHash}`, memberBytes, { contentType: 'application/pdf', upsert: false });
    expect(memberUpload.error).toBeNull();
    const memberFileRpc = await memberClient.rpc('upsert_workspace_intake_entity', {
      p_workspace_id: wsId,
      p_entity_type: 'document_file',
      p_payload: { client_file_ref_id: memberFileRefId, content_sha256: memberHash, size_bytes: memberBytes.length, mime_type: 'application/pdf', original_file_name: 'DOC-00036.pdf', storage_path: `${wsId}/${memberHash}` },
      p_row_version: 0,
    });
    expect(memberFileRpc.error).toBeNull();
    const memberInboxRpc = await memberClient.rpc('upsert_workspace_intake_entity', {
      p_workspace_id: wsId,
      p_entity_type: 'inbox_item',
      p_payload: { client_inbox_id: memberInboxId, status: 'neu', client_file_ref_id: memberFileRefId, payload: { id: memberInboxId, title: 'Member-Upload', status: 'neu', fileRefId: memberFileRefId, receivedAt: new Date().toISOString() } },
      p_row_version: 0,
    });
    expect(memberInboxRpc.error).toBeNull();
    const cloud3 = await cloudState(wsId);
    expect(cloud3.inbox.find((i) => i.client_inbox_id === memberInboxId)?.created_by).toBe(member.id);
    expect(cloud3.files.find((f) => f.client_file_ref_id === memberFileRefId)?.created_by).toBe(member.id);
    expect(cloud3.objects).toContain(memberHash);
    // Member-Pull sieht nur Eigenes; Owner-Original ist fuer den Member nicht lesbar
    const memberPull = await memberClient.rpc('pull_workspace_intake_state', { p_workspace_id: wsId });
    expect(memberPull.error).toBeNull();
    expect((memberPull.data.inbox_items as { client_inbox_id: string }[]).map((i) => i.client_inbox_id)).toEqual([memberInboxId]);
    expect((memberPull.data.files as { client_file_ref_id: string }[]).map((f) => f.client_file_ref_id)).not.toContain(ref.id);
    const ownerBlobForMember = await memberClient.storage.from('workspace-files').download(`${wsId}/${originalHash}`);
    expect(ownerBlobForMember.error).not.toBeNull();
    const ownBlobForMember = await memberClient.storage.from('workspace-files').download(`${wsId}/${memberHash}`);
    expect(ownBlobForMember.error).toBeNull();
    await memberClient.auth.signOut();

    /* Owner-Geraet sieht den Member-Upload nach Sync (Pull) */
    await page.goto('/synchronisation', { waitUntil: 'domcontentloaded' });
    await runSync(page);
    const ownerAfterMember = await localIntake(page);
    expect(ownerAfterMember.inbox.map((i) => i.id)).toContain(memberInboxId);
    const memberRefOnOwner = ownerAfterMember.files.find((f) => f.id === memberFileRefId);
    expect(memberRefOnOwner?.storageType).toBe('cloud');
    expect(memberRefOnOwner?.contentHash).toBe(memberHash);

    /* T4 — Upload-Abbruch → Retry → kein Duplikat */
    const secondInboxId = await uploadToAnalyzedDetail(page, DOC_00001_PDF); // gleiche Bytes: Hash-Treffer, weiterer Eintrag
    let aborted = 0;
    await page.route('**/storage/v1/object/workspace-files/**', async (route) => {
      if (route.request().method() === 'POST' && aborted === 0) {
        aborted += 1;
        await route.abort();
        return;
      }
      await route.continue();
    });
    await runSync(page);
    await page.unroute('**/storage/v1/object/workspace-files/**');
    await runSync(page);
    const cloud4 = await cloudState(wsId);
    expect(cloud4.inbox.filter((i) => i.client_inbox_id === secondInboxId)).toHaveLength(1);
    expect(cloud4.objects.filter((o) => o === originalHash)).toHaveLength(1);
    const localFinal = await localIntake(page);
    const secondItem = localFinal.inbox.find((i) => i.id === secondInboxId)!;
    // gleiche Bytes → dieselbe lokale FileRef, dieselbe Cloud-Zeile, kein zweiter Blob
    expect(secondItem.fileRefId).toBe(ref.id);
    expect(cloud4.files.filter((f) => f.content_sha256 === originalHash)).toHaveLength(1);
    expect(cloud4.docs.filter((d) => d.document_kind === 'generated_invoice')).toHaveLength(0);
  });
});
