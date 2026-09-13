/**
 * EMAIL-01B1 — SQL-Laufzeittests gegen die **lokale** Supabase-Instanz
 * (kein Browser, keine Cloud, synthetische Nutzer mit Kennwort nur im
 * Speicher). Prüft Tenant-Isolation, Schreibrecht, Dokumentidentität,
 * Idempotenz (Replay/Konflikt), Retry-Kette, Statusmaschine, Historie und
 * dass die reine Delivery-Anlage die Rechnung nicht verändert.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const ANON_KEY = process.env.E2E_LOCALDB_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

let ownerA: LocalDbUser;
let memberA: LocalDbUser;
let ownerB: LocalDbUser;
let admin: SupabaseClient;
let clientOwnerA: SupabaseClient;
let clientMemberA: SupabaseClient;
let clientOwnerB: SupabaseClient;
let wsA = '';
let wsB = '';

async function login(user: LocalDbUser): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`Login fehlgeschlagen: ${error.message}`);
  return client;
}

async function ensureWorkspace(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.rpc('ensure_personal_workspace', { p_name: 'Delivery SQL Test' });
  if (error) throw new Error(error.message);
  const id = (data as { workspace?: { id?: string }; id?: string })?.workspace?.id ?? (data as { id?: string })?.id;
  if (!id) throw new Error(`Workspace-ID fehlt: ${JSON.stringify(data)}`);
  return id;
}

async function insertInvoice(workspaceId: string, clientInvoiceId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const { error } = await admin.from('workspace_invoices').insert({
    workspace_id: workspaceId,
    vorgang_id: overrides.vorgang_id ?? null,
    client_invoice_id: clientInvoiceId,
    invoice_number: `2026-${clientInvoiceId.slice(-4)}`,
    invoice_year: 2026,
    invoice_sequence_number: Math.floor(Math.random() * 100000) + 1,
    invoice_type: 'rechnung',
    invoice_status: 'vorbereitet',
    payload: { id: clientInvoiceId, status: 'vorbereitet' },
    ...overrides,
  });
  if (error) throw new Error(`Rechnung anlegen: ${error.message}`);
}

function deliveryArgs(workspaceId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    p_workspace_id: workspaceId,
    p_client_delivery_id: 'cd-1',
    p_document_kind: 'invoice',
    p_linked_invoice_id: 'inv-order-1',
    p_recipient_email: 'kunde@example.invalid',
    p_subject: 'Rechnung 2026-0001',
    p_body_text: 'Anbei Ihre Rechnung.',
    p_attachment_storage_path: `${workspaceId}/invoice-inv-order-1/${SHA_A}.pdf`,
    p_attachment_sha256: SHA_A,
    p_attachment_size_bytes: 12345,
    p_attachment_filename: 'Rechnung_2026-0001.pdf',
    p_attachment_mime_type: 'application/pdf',
    p_provider: 'stub',
    p_retry_of_delivery_id: null,
    p_linked_document_id: null,
    ...overrides,
  };
}

async function create(client: SupabaseClient, args: Record<string, unknown>) {
  const { data, error } = await client.rpc('create_workspace_document_delivery', args);
  return { data: data as { outcome?: string; delivery?: Record<string, unknown> } | null, error };
}

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  ownerA = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'dlv-owner-a' });
  memberA = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'dlv-member-a' });
  ownerB = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'dlv-owner-b' });
  clientOwnerA = await login(ownerA);
  clientMemberA = await login(memberA);
  clientOwnerB = await login(ownerB);
  wsA = await ensureWorkspace(clientOwnerA);
  wsB = await ensureWorkspace(clientOwnerB);
  const { error } = await admin.from('workspace_members').insert({ workspace_id: wsA, user_id: memberA.id, role: 'member', status: 'active' });
  if (error) throw new Error(error.message);
  await insertInvoice(wsA, 'inv-order-1', { vorgang_id: 'v-1' });
  await insertInvoice(wsA, 'inv-free-1');
  await insertInvoice(wsA, 'inv-draft-1', { invoice_status: 'entwurf' });
  await insertInvoice(wsB, 'inv-b-1');
});

test.afterAll(async () => {
  for (const user of [ownerA, memberA, ownerB]) {
    if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
  }
});

test.describe('EMAIL-01B1 — Delivery-RPCs gegen die lokale Datenbank', () => {
  test('R1/R4/R8/R14/R19: Owner A legt Delivery für die Vorgangsrechnung an — queued, ohne Provider-ID, Rechnung unverändert', async () => {
    const before = await admin.from('workspace_invoices').select('invoice_status,row_version,sent_source').eq('workspace_id', wsA).eq('client_invoice_id', 'inv-order-1').single();
    const { data, error } = await create(clientOwnerA, deliveryArgs(wsA));
    expect(error).toBeNull();
    expect(data?.outcome).toBe('created');
    expect(data?.delivery).toMatchObject({ status: 'queued', provider: 'stub', attempt_number: 1, provider_message_id: null, recipient_email: 'kunde@example.invalid', requested_by: ownerA.id });
    expect(data?.delivery?.attachment_sha256).toBe(SHA_A);
    const after = await admin.from('workspace_invoices').select('invoice_status,row_version,sent_source').eq('workspace_id', wsA).eq('client_invoice_id', 'inv-order-1').single();
    expect(after.data).toEqual(before.data);
    expect(after.data?.invoice_status).toBe('vorbereitet');
  });

  test('R2/R6: Workspace B darf für A nichts anlegen; Rechnung aus A ist in B unbekannt', async () => {
    const foreign = await create(clientOwnerB, deliveryArgs(wsA, { p_client_delivery_id: 'cd-b-1' }));
    expect(foreign.error?.message).toContain('Kein Zugriff auf Workspace');
    const wrongWs = await create(clientOwnerB, deliveryArgs(wsB, { p_client_delivery_id: 'cd-b-2', p_attachment_storage_path: `${wsB}/invoice-inv-order-1/${SHA_A}.pdf` }));
    expect(wrongWs.error?.message).toContain('Rechnung nicht gefunden');
  });

  test('R3: member ohne Schreibrecht wird abgewiesen (owner/admin-Modell wie beim Branding)', async () => {
    const result = await create(clientMemberA, deliveryArgs(wsA, { p_client_delivery_id: 'cd-member-1' }));
    expect(result.error?.message).toContain('Keine Schreibberechtigung');
  });

  test('R5/R7: unbekannte Rechnung und Entwurf abgewiesen; freie Rechnung ohne Vorgang akzeptiert', async () => {
    const unknown = await create(clientOwnerA, deliveryArgs(wsA, { p_client_delivery_id: 'cd-x', p_linked_invoice_id: 'inv-nope', p_attachment_storage_path: `${wsA}/invoice-inv-nope/${SHA_A}.pdf` }));
    expect(unknown.error?.message).toContain('Rechnung nicht gefunden');
    const draft = await create(clientOwnerA, deliveryArgs(wsA, { p_client_delivery_id: 'cd-d', p_linked_invoice_id: 'inv-draft-1', p_attachment_storage_path: `${wsA}/invoice-inv-draft-1/${SHA_A}.pdf` }));
    expect(draft.error?.message).toContain('Rechnung nicht finalisiert');
    const free = await create(clientOwnerA, deliveryArgs(wsA, { p_client_delivery_id: 'cd-free-1', p_linked_invoice_id: 'inv-free-1', p_attachment_storage_path: `${wsA}/invoice-inv-free-1/${SHA_A}.pdf` }));
    expect(free.error).toBeNull();
    expect(free.data?.delivery).toMatchObject({ document_kind: 'invoice', linked_invoice_id: 'inv-free-1', status: 'queued' });
  });

  test('R9/R10/R11: identisches Replay liefert dieselbe Delivery; anderer Empfänger oder anderer Hash → Idempotenzkonflikt', async () => {
    const replay = await create(clientOwnerA, deliveryArgs(wsA));
    expect(replay.error).toBeNull();
    expect(replay.data?.outcome).toBe('replayed');
    const count = await admin.from('workspace_document_deliveries').select('id', { count: 'exact', head: true }).eq('workspace_id', wsA).eq('client_delivery_id', 'cd-1');
    expect(count.count).toBe(1);
    const otherRecipient = await create(clientOwnerA, deliveryArgs(wsA, { p_recipient_email: 'andere@example.invalid' }));
    expect(otherRecipient.error?.message).toContain('Idempotenzkonflikt');
    const otherHash = await create(clientOwnerA, deliveryArgs(wsA, { p_attachment_sha256: SHA_B, p_attachment_storage_path: `${wsA}/invoice-inv-order-1/${SHA_B}.pdf` }));
    expect(otherHash.error?.message).toContain('Idempotenzkonflikt');
    // Groß-/Kleinschreibung des Empfängers ist kein Konflikt.
    const sameNormalized = await create(clientOwnerA, deliveryArgs(wsA, { p_recipient_email: ' Kunde@Example.INVALID ' }));
    expect(sameNormalized.data?.outcome).toBe('replayed');
  });

  test('R13/R16: Statusmaschine — Client kann den Status nicht setzen; Server (service_role) nur monoton, row_version steigt', async () => {
    const created = await admin.from('workspace_document_deliveries').select('id,row_version').eq('workspace_id', wsA).eq('client_delivery_id', 'cd-1').single();
    const id = created.data!.id as string;
    const viaClient = await clientOwnerA.rpc('update_workspace_document_delivery_status', { p_delivery_id: id, p_status: 'provider_accepted', p_provider_message_id: 'm-1' });
    expect(viaClient.error).not.toBeNull();
    const direct = await clientOwnerA.from('workspace_document_deliveries').update({ status: 'provider_accepted' }).eq('id', id).select('id');
    expect((direct.data ?? []).length).toBe(0);

    const accepted = await admin.rpc('update_workspace_document_delivery_status', { p_delivery_id: id, p_status: 'provider_accepted', p_provider_message_id: 'stub-0001', p_expected_row_version: created.data!.row_version });
    expect(accepted.error).toBeNull();
    expect(accepted.data).toMatchObject({ status: 'provider_accepted', provider_message_id: 'stub-0001', row_version: Number(created.data!.row_version) + 1 });
    expect((accepted.data as { provider_accepted_at?: string }).provider_accepted_at).toBeTruthy();

    const back = await admin.rpc('update_workspace_document_delivery_status', { p_delivery_id: id, p_status: 'queued' });
    expect(back.error?.message).toContain('nicht erlaubt');
    const stale = await admin.rpc('update_workspace_document_delivery_status', { p_delivery_id: id, p_status: 'delivered', p_expected_row_version: 1 });
    expect(stale.error?.message).toContain('row_version veraltet');
    const bounced = await admin.rpc('update_workspace_document_delivery_status', { p_delivery_id: id, p_status: 'bounced', p_error_category: 'recipient', p_error_code: 'hard_bounce' });
    expect(bounced.error).toBeNull();
    expect(bounced.data).toMatchObject({ status: 'bounced', error_category: 'recipient' });
    // Rechnung bleibt durch Delivery-Status allein unverändert (Kopplung kommt in 01B2).
    const invoice = await admin.from('workspace_invoices').select('invoice_status,sent_source').eq('workspace_id', wsA).eq('client_invoice_id', 'inv-order-1').single();
    expect(invoice.data).toEqual({ invoice_status: 'vorbereitet', sent_source: null });
  });

  test('R12: bewusster Retry nur nach Fehlschlag, mit neuer ID und retry_of; Kette sichtbar', async () => {
    const failedCreate = await create(clientOwnerA, deliveryArgs(wsA, { p_client_delivery_id: 'cd-f1', p_linked_invoice_id: 'inv-free-1', p_attachment_storage_path: `${wsA}/invoice-inv-free-1/${SHA_A}.pdf` }));
    const failedId = failedCreate.data?.delivery?.id as string;
    // Retry auf eine noch laufende (queued) Delivery ist nicht erlaubt.
    const tooEarly = await create(clientOwnerA, deliveryArgs(wsA, { p_client_delivery_id: 'cd-f2', p_linked_invoice_id: 'inv-free-1', p_attachment_storage_path: `${wsA}/invoice-inv-free-1/${SHA_A}.pdf`, p_retry_of_delivery_id: failedId }));
    expect(tooEarly.error?.message).toContain('nur nach Fehlschlag');
    const fail = await admin.rpc('update_workspace_document_delivery_status', { p_delivery_id: failedId, p_status: 'failed', p_error_category: 'provider', p_error_code: 'stub_provider_unavailable' });
    expect(fail.error).toBeNull();
    const retry = await create(clientOwnerA, deliveryArgs(wsA, { p_client_delivery_id: 'cd-f2', p_linked_invoice_id: 'inv-free-1', p_attachment_storage_path: `${wsA}/invoice-inv-free-1/${SHA_A}.pdf`, p_retry_of_delivery_id: failedId }));
    expect(retry.error).toBeNull();
    expect(retry.data?.delivery).toMatchObject({ attempt_number: 2, retry_of_delivery_id: failedId, status: 'queued' });
    // Retry auf ein anderes Dokument ist kein Retry.
    const wrongDoc = await create(clientOwnerA, deliveryArgs(wsA, { p_client_delivery_id: 'cd-f3', p_retry_of_delivery_id: failedId }));
    expect(wrongDoc.error?.message).toContain('anderen Dokument');
  });

  test('R17/R18: Anhang-Metadaten und fremde Storage-Pfade werden abgewiesen', async () => {
    const foreignPath = await create(clientOwnerA, deliveryArgs(wsA, { p_client_delivery_id: 'cd-a1', p_attachment_storage_path: `${wsB}/invoice-inv-order-1/${SHA_A}.pdf` }));
    expect(foreignPath.error?.message).toContain('attachment_storage_path ungueltig');
    const hashMismatch = await create(clientOwnerA, deliveryArgs(wsA, { p_client_delivery_id: 'cd-a2', p_attachment_storage_path: `${wsA}/invoice-inv-order-1/${SHA_B}.pdf` }));
    expect(hashMismatch.error?.message).toContain('passt nicht zum Pfad');
    const tooBig = await create(clientOwnerA, deliveryArgs(wsA, { p_client_delivery_id: 'cd-a3', p_attachment_size_bytes: 20 * 1024 * 1024 }));
    expect(tooBig.error?.message).toContain('attachment_size_bytes ungueltig');
    const wrongMime = await create(clientOwnerA, deliveryArgs(wsA, { p_client_delivery_id: 'cd-a4', p_attachment_mime_type: 'image/png' }));
    expect(wrongMime.error?.message).toContain('mime ungueltig');
    const badEmail = await create(clientOwnerA, deliveryArgs(wsA, { p_client_delivery_id: 'cd-a5', p_recipient_email: 'kein-mail' }));
    expect(badEmail.error?.message).toContain('recipient_email ungueltig');
    const missing = await create(clientOwnerA, deliveryArgs(wsA, { p_client_delivery_id: 'cd-a6', p_attachment_sha256: null }));
    expect(missing.error?.message).toContain('attachment unvollstaendig');
  });

  test('R15: Historie neueste zuerst und tenant-isoliert; RLS gibt B keine A-Zeilen', async () => {
    const list = await clientOwnerA.rpc('list_workspace_document_deliveries', { p_workspace_id: wsA, p_document_kind: 'invoice', p_linked_invoice_id: 'inv-free-1' });
    expect(list.error).toBeNull();
    const rows = list.data as { client_delivery_id: string; requested_at: string }[];
    expect(rows.map((r) => r.client_delivery_id)).toEqual(['cd-f2', 'cd-f1', 'cd-free-1']);
    const memberList = await clientMemberA.rpc('list_workspace_document_deliveries', { p_workspace_id: wsA, p_document_kind: null, p_linked_invoice_id: 'inv-free-1' });
    expect(memberList.error).toBeNull();
    expect((memberList.data as unknown[]).length).toBe(3);
    const foreignList = await clientOwnerB.rpc('list_workspace_document_deliveries', { p_workspace_id: wsA, p_document_kind: 'invoice', p_linked_invoice_id: 'inv-free-1' });
    expect(foreignList.error?.message).toContain('Kein Zugriff auf Workspace');
    const rls = await clientOwnerB.from('workspace_document_deliveries').select('id').eq('workspace_id', wsA);
    expect(rls.error).toBeNull();
    expect(rls.data).toEqual([]);
  });

  test('R-Storage: privater Bucket — Owner A lädt unter eigenem Pfad hoch, fremder Pfad und member werden abgewiesen, kein Delete', async () => {
    const pdf = new Blob(['%PDF-1.4 test'], { type: 'application/pdf' });
    const own = await clientOwnerA.storage.from('document-deliveries').upload(`${wsA}/invoice-inv-order-1/${SHA_A}.pdf`, pdf, { contentType: 'application/pdf', upsert: false });
    expect(own.error).toBeNull();
    const dup = await clientOwnerA.storage.from('document-deliveries').upload(`${wsA}/invoice-inv-order-1/${SHA_A}.pdf`, pdf, { contentType: 'application/pdf', upsert: false });
    expect(dup.error).not.toBeNull();
    const foreign = await clientOwnerB.storage.from('document-deliveries').upload(`${wsA}/invoice-inv-order-1/${SHA_B}.pdf`, pdf, { contentType: 'application/pdf', upsert: false });
    expect(foreign.error).not.toBeNull();
    const member = await clientMemberA.storage.from('document-deliveries').upload(`${wsA}/invoice-inv-order-1/${SHA_B}.pdf`, pdf, { contentType: 'application/pdf', upsert: false });
    expect(member.error).not.toBeNull();
    const badPath = await clientOwnerA.storage.from('document-deliveries').upload(`${wsA}/invoice-inv-order-1/nohash.pdf`, pdf, { contentType: 'application/pdf', upsert: false });
    expect(badPath.error).not.toBeNull();
    const read = await clientMemberA.storage.from('document-deliveries').download(`${wsA}/invoice-inv-order-1/${SHA_A}.pdf`);
    expect(read.error).toBeNull();
    const foreignRead = await clientOwnerB.storage.from('document-deliveries').download(`${wsA}/invoice-inv-order-1/${SHA_A}.pdf`);
    expect(foreignRead.error).not.toBeNull();
    const del = await clientOwnerA.storage.from('document-deliveries').remove([`${wsA}/invoice-inv-order-1/${SHA_A}.pdf`]);
    // Ohne Delete-Policy bleibt das Objekt (Storage meldet leer/Fehler, löscht aber nicht).
    const still = await admin.storage.from('document-deliveries').download(`${wsA}/invoice-inv-order-1/${SHA_A}.pdf`);
    expect(still.error, JSON.stringify(del)).toBeNull();
  });

  test('R-Sent: manuelles Markieren setzt sent_source=manual und sentSource im Payload', async () => {
    const marked = await clientOwnerA.rpc('update_workspace_invoice_sent', { p_workspace_id: wsA, p_client_invoice_id: 'inv-free-1', p_sent_at: '2026-09-14', p_sent_via: 'post', p_sent_note: null });
    expect(marked.error).toBeNull();
    const row = (marked.data as { invoice_status: string; sent_source: string; payload: Record<string, unknown> }[])[0];
    expect(row).toMatchObject({ invoice_status: 'versendet', sent_source: 'manual' });
    expect(row.payload).toMatchObject({ status: 'versendet', sentAt: '2026-09-14', sentVia: 'post', sentSource: 'manual' });
    expect(row.payload).not.toHaveProperty('sentNote');
  });
});
