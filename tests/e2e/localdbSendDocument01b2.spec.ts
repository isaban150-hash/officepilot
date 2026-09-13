/**
 * EMAIL-01B2 — Versandkette gegen die **lokale** Supabase-Instanz mit der
 * lokal servierten Edge Function `send-document` und `MAIL_PROVIDER=stub`.
 * Kein Browser, keine Cloud, kein echter Provider, kein echter Key.
 *
 * Voraussetzung: `supabase functions serve send-document --env-file <stub-env>`
 * läuft (siehe Bericht). Ohne erreichbare Function wird die Suite übersprungen.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const ANON_KEY = process.env.E2E_LOCALDB_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/send-document`;

let ownerA: LocalDbUser;
let memberA: LocalDbUser;
let ownerB: LocalDbUser;
let admin: SupabaseClient;
let clientOwnerA: SupabaseClient;
let clientMemberA: SupabaseClient;
let clientOwnerB: SupabaseClient;
let wsA = '';
let wsB = '';
let tokenOwnerA = '';
let tokenMemberA = '';
let tokenOwnerB = '';

async function login(user: LocalDbUser): Promise<{ client: SupabaseClient; token: string }> {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error || !data.session) throw new Error(`Login fehlgeschlagen: ${error?.message}`);
  return { client, token: data.session.access_token };
}

async function ensureWorkspace(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.rpc('ensure_personal_workspace', { p_name: 'Send SQL Test' });
  if (error) throw new Error(error.message);
  const id = (data as { workspace?: { id?: string }; id?: string })?.workspace?.id ?? (data as { id?: string })?.id;
  if (!id) throw new Error('Workspace-ID fehlt');
  return id;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SNAPSHOT = { companyName: 'Betrieb', legalForm: 'GmbH', email: 'info@betrieb.invalid', street: 'Werk 1', zip: '1', city: 'X' };

async function insertInvoice(workspaceId: string, clientInvoiceId: string, overrides: Record<string, unknown> = {}, snapshot: Record<string, unknown> | null = SNAPSHOT): Promise<void> {
  const { error } = await admin.from('workspace_invoices').insert({
    workspace_id: workspaceId,
    vorgang_id: overrides.vorgang_id ?? null,
    client_invoice_id: clientInvoiceId,
    invoice_number: `2026-${clientInvoiceId.slice(-6)}`,
    invoice_year: 2026,
    invoice_sequence_number: Math.floor(Math.random() * 1000000) + 1,
    invoice_type: 'rechnung',
    invoice_status: 'vorbereitet',
    payload: { id: clientInvoiceId, status: 'vorbereitet', ...(snapshot ? { companySnapshot: snapshot } : {}) },
    ...overrides,
  });
  if (error) throw new Error(`Rechnung anlegen: ${error.message}`);
}

/** Legt PDF-Bytes im Bucket ab und die Delivery dazu an (queued). */
async function prepareDelivery(input: {
  client: SupabaseClient;
  workspaceId: string;
  clientDeliveryId: string;
  invoiceId: string;
  recipient?: string;
  kind?: 'invoice' | 'invoice_correction';
  upload?: boolean;
  uploadBytes?: Uint8Array;
  retryOf?: string;
}): Promise<{ deliveryId: string; sha: string }> {
  const bytes = new TextEncoder().encode(`%PDF-1.4 ${input.invoiceId} ${input.clientDeliveryId}`);
  const sha = await sha256Hex(bytes);
  const kind = input.kind ?? 'invoice';
  const path = `${input.workspaceId}/${kind}-${input.invoiceId}/${sha}.pdf`;
  if (input.upload !== false) {
    const upload = await input.client.storage.from('document-deliveries').upload(path, new Blob([input.uploadBytes ?? bytes], { type: 'application/pdf' }), { contentType: 'application/pdf', upsert: false });
    if (upload.error && !/exists|duplicate/i.test(upload.error.message)) throw new Error(`Upload: ${upload.error.message}`);
  }
  const { data, error } = await input.client.rpc('create_workspace_document_delivery', {
    p_workspace_id: input.workspaceId,
    p_client_delivery_id: input.clientDeliveryId,
    p_document_kind: kind,
    p_linked_invoice_id: input.invoiceId,
    p_recipient_email: input.recipient ?? 'kunde@example.invalid',
    p_subject: `Rechnung ${input.invoiceId}`,
    p_body_text: 'Anbei Ihre Rechnung.',
    p_attachment_storage_path: path,
    p_attachment_sha256: sha,
    p_attachment_size_bytes: bytes.byteLength,
    p_attachment_filename: `Rechnung_${input.invoiceId}.pdf`,
    p_attachment_mime_type: 'application/pdf',
    p_provider: 'stub',
    p_retry_of_delivery_id: input.retryOf ?? null,
    p_linked_document_id: null,
  });
  if (error) throw new Error(`Delivery anlegen: ${error.message}`);
  return { deliveryId: (data as { delivery: { id: string } }).delivery.id, sha };
}

async function send(token: string, workspaceId: string, clientDeliveryId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, clientDeliveryId }),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

async function invoiceRow(workspaceId: string, invoiceId: string) {
  const { data } = await admin.from('workspace_invoices').select('invoice_status,sent_source,sent_delivery_id,payload,row_version').eq('workspace_id', workspaceId).eq('client_invoice_id', invoiceId).single();
  return data as { invoice_status: string; sent_source: string | null; sent_delivery_id: string | null; payload: Record<string, unknown>; row_version: number };
}

async function deliveryRow(id: string) {
  const { data } = await admin.from('workspace_document_deliveries').select('*').eq('id', id).single();
  return data as Record<string, unknown>;
}

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  const probe = await fetch(FUNCTION_URL, { method: 'OPTIONS' }).catch(() => null);
  test.skip(!probe, 'send-document wird lokal nicht serviert (supabase functions serve).');
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  ownerA = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'snd-owner-a' });
  memberA = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'snd-member-a' });
  ownerB = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'snd-owner-b' });
  ({ client: clientOwnerA, token: tokenOwnerA } = await login(ownerA));
  ({ client: clientMemberA, token: tokenMemberA } = await login(memberA));
  ({ client: clientOwnerB, token: tokenOwnerB } = await login(ownerB));
  wsA = await ensureWorkspace(clientOwnerA);
  wsB = await ensureWorkspace(clientOwnerB);
  const { error } = await admin.from('workspace_members').insert({ workspace_id: wsA, user_id: memberA.id, role: 'member', status: 'active' });
  if (error) throw new Error(error.message);
  for (const id of ['inv-v-1', 'inv-free-1', 'inv-bounce', 'inv-prov', 'inv-auth', 'inv-timeout', 'inv-noatt', 'inv-badhash', 'inv-corr', 'inv-manual', 'inv-cancel', 'inv-bounce2', 'inv-nosender']) {
    await insertInvoice(wsA, id, id === 'inv-v-1' ? { vorgang_id: 'v-1' } : {}, id === 'inv-nosender' ? { companyName: 'Betrieb' } : SNAPSHOT);
  }
  await insertInvoice(wsB, 'inv-b-1');
});

test.afterAll(async () => {
  for (const user of [ownerA, memberA, ownerB]) {
    if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
  }
});

test.describe('EMAIL-01B2 — send-document (lokal, Stub)', () => {
  test('Q1–Q7/Q17: Vorgangsrechnung queued → provider_accepted, Message-ID, Rechnung atomar versendet (email/officepilot/delivery); Replay ohne zweite Mail', async () => {
    const { deliveryId } = await prepareDelivery({ client: clientOwnerA, workspaceId: wsA, clientDeliveryId: 'cd-v-1', invoiceId: 'inv-v-1' });
    const first = await send(tokenOwnerA, wsA, 'cd-v-1');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ ok: true, action: 'sent', coupling: 'linked', delivery: { status: 'provider_accepted' } });
    const row = await deliveryRow(deliveryId);
    expect(row.status).toBe('provider_accepted');
    expect(String(row.provider_message_id)).toMatch(/^stub-/);
    expect(row.provider_accepted_at).toBeTruthy();
    expect(Number(row.row_version)).toBe(2);
    const invoice = await invoiceRow(wsA, 'inv-v-1');
    expect(invoice).toMatchObject({ invoice_status: 'versendet', sent_source: 'officepilot', sent_delivery_id: deliveryId });
    expect(invoice.payload).toMatchObject({ status: 'versendet', sentVia: 'email', sentSource: 'officepilot', sentDeliveryId: deliveryId });
    expect(String(invoice.payload.sentAt)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const replay = await send(tokenOwnerA, wsA, 'cd-v-1');
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ ok: true, action: 'replayed', coupling: 'already_linked' });
    const again = await deliveryRow(deliveryId);
    expect(again.provider_message_id).toBe(row.provider_message_id);
    expect(Number(again.row_version)).toBe(2);
    const { count } = await admin.from('workspace_document_deliveries').select('id', { count: 'exact', head: true }).eq('workspace_id', wsA).eq('linked_invoice_id', 'inv-v-1');
    expect(count).toBe(1);
  });

  test('Q16: freie Rechnung (ohne Vorgang) — derselbe Weg', async () => {
    const { deliveryId } = await prepareDelivery({ client: clientOwnerA, workspaceId: wsA, clientDeliveryId: 'cd-free-1', invoiceId: 'inv-free-1' });
    const result = await send(tokenOwnerA, wsA, 'cd-free-1');
    expect(result.body).toMatchObject({ ok: true, action: 'sent', delivery: { status: 'provider_accepted' } });
    expect(await invoiceRow(wsA, 'inv-free-1')).toMatchObject({ invoice_status: 'versendet', sent_source: 'officepilot', sent_delivery_id: deliveryId });
  });

  test('Q8–Q10: recipient/provider/auth → failed mit Kategorie; Rechnung bleibt vorbereitet', async () => {
    for (const [invoiceId, cd, recipient, category] of [['inv-bounce', 'cd-bounce', 'x@bounce.invalid', 'recipient'], ['inv-prov', 'cd-prov', 'x@provider.invalid', 'provider'], ['inv-auth', 'cd-auth', 'x@auth.invalid', 'auth']] as const) {
      const { deliveryId } = await prepareDelivery({ client: clientOwnerA, workspaceId: wsA, clientDeliveryId: cd, invoiceId, recipient });
      const result = await send(tokenOwnerA, wsA, cd);
      expect(result.status, cd).toBe(200);
      expect(result.body, cd).toMatchObject({ ok: true, action: 'failed', delivery: { status: 'failed', errorCategory: category } });
      const row = await deliveryRow(deliveryId);
      expect(row, cd).toMatchObject({ status: 'failed', error_category: category, provider_message_id: null });
      expect(row.failed_at, cd).toBeTruthy();
      expect((await invoiceRow(wsA, invoiceId)).invoice_status, cd).toBe('vorbereitet');
    }
  });

  test('Q11/Q12: Timeout → unknown; erneuter Aufruf sendet nicht blind erneut; Retry mit neuer ID nach unknown erlaubt', async () => {
    const { deliveryId } = await prepareDelivery({ client: clientOwnerA, workspaceId: wsA, clientDeliveryId: 'cd-timeout', invoiceId: 'inv-timeout', recipient: 'x@timeout.invalid' });
    const first = await send(tokenOwnerA, wsA, 'cd-timeout');
    expect(first.body).toMatchObject({ ok: true, action: 'unknown_pending', delivery: { status: 'unknown', errorCategory: 'network' } });
    const rowAfter = await deliveryRow(deliveryId);
    expect(rowAfter.status).toBe('unknown');
    expect(rowAfter.failed_at).toBeNull();
    const second = await send(tokenOwnerA, wsA, 'cd-timeout');
    expect(second.body).toMatchObject({ ok: true, action: 'unknown_pending' });
    expect(Number((await deliveryRow(deliveryId)).row_version)).toBe(Number(rowAfter.row_version));
    expect((await invoiceRow(wsA, 'inv-timeout')).invoice_status).toBe('vorbereitet');
    // Bewusster neuer Versuch (neue ID, retry_of) an eine erreichbare Adresse.
    const retry = await prepareDelivery({ client: clientOwnerA, workspaceId: wsA, clientDeliveryId: 'cd-timeout-2', invoiceId: 'inv-timeout', recipient: 'kunde@example.invalid', retryOf: deliveryId });
    const sent = await send(tokenOwnerA, wsA, 'cd-timeout-2');
    expect(sent.body).toMatchObject({ ok: true, action: 'sent' });
    expect((await deliveryRow(retry.deliveryId)).attempt_number).toBe(2);
    expect((await invoiceRow(wsA, 'inv-timeout')).sent_delivery_id).toBe(retry.deliveryId);
  });

  test('Q13/Q14: Anhang fehlt bzw. Hash passt nicht → failed/attachment ohne Provider-Aufruf', async () => {
    const missing = await prepareDelivery({ client: clientOwnerA, workspaceId: wsA, clientDeliveryId: 'cd-noatt', invoiceId: 'inv-noatt', upload: false });
    const r1 = await send(tokenOwnerA, wsA, 'cd-noatt');
    expect(r1.body).toMatchObject({ ok: true, action: 'failed', delivery: { status: 'failed', errorCategory: 'attachment', errorCode: 'attachment_missing' } });
    expect((await deliveryRow(missing.deliveryId)).provider_message_id).toBeNull();
    const tampered = await prepareDelivery({ client: clientOwnerA, workspaceId: wsA, clientDeliveryId: 'cd-badhash', invoiceId: 'inv-badhash', uploadBytes: new TextEncoder().encode('%PDF-1.4 inv-badhash cd-badhasX') });
    const r2 = await send(tokenOwnerA, wsA, 'cd-badhash');
    expect(r2.body).toMatchObject({ ok: true, action: 'failed', delivery: { errorCategory: 'attachment', errorCode: 'attachment_sha256_mismatch' } });
    expect((await deliveryRow(tampered.deliveryId)).status).toBe('failed');
  });

  test('Q18/Q19: Korrekturbeleg wird gesendet; Original wird nicht erneut verändert', async () => {
    const original = await prepareDelivery({ client: clientOwnerA, workspaceId: wsA, clientDeliveryId: 'cd-corr-orig', invoiceId: 'inv-corr' });
    expect((await send(tokenOwnerA, wsA, 'cd-corr-orig')).body).toMatchObject({ action: 'sent' });
    const before = await invoiceRow(wsA, 'inv-corr');
    expect(before).toMatchObject({ invoice_status: 'versendet', sent_delivery_id: original.deliveryId });
    // Storno der versendeten Rechnung erzeugt den Korrekturbeleg (bestehende RPC).
    const cancel = await clientOwnerA.rpc('cancel_workspace_invoice', { p_workspace_id: wsA, p_client_invoice_id: 'inv-corr', p_reason: 'Testkorrektur' });
    expect(cancel.error, JSON.stringify(cancel.error)).toBeNull();
    const cancelled = await admin.from('workspace_invoices').select('cancellation_kind,correction_document_id,invoice_status,sent_delivery_id,row_version').eq('workspace_id', wsA).eq('client_invoice_id', 'inv-corr').single();
    expect(cancelled.data).toMatchObject({ cancellation_kind: 'correction', invoice_status: 'versendet', sent_delivery_id: original.deliveryId });
    expect(cancelled.data?.correction_document_id).toBeTruthy();

    const correction = await prepareDelivery({ client: clientOwnerA, workspaceId: wsA, clientDeliveryId: 'cd-corr-doc', invoiceId: 'inv-corr', kind: 'invoice_correction' });
    const sent = await send(tokenOwnerA, wsA, 'cd-corr-doc');
    expect(sent.body).toMatchObject({ ok: true, action: 'sent', coupling: 'none', delivery: { status: 'provider_accepted' } });
    expect((await deliveryRow(correction.deliveryId)).document_kind).toBe('invoice_correction');
    const after = await admin.from('workspace_invoices').select('sent_delivery_id,row_version,payload').eq('workspace_id', wsA).eq('client_invoice_id', 'inv-corr').single();
    expect(after.data?.sent_delivery_id).toBe(original.deliveryId);
    expect(after.data?.row_version).toBe(cancelled.data?.row_version);
    // Ein erneuter Versand der stornierten Originalrechnung selbst ist nicht mehr möglich.
    await expect(prepareDelivery({ client: clientOwnerA, workspaceId: wsA, clientDeliveryId: 'cd-corr-again', invoiceId: 'inv-corr' })).rejects.toThrow(/storniert/);
  });

  test('Q20: manuell markierte Rechnung — OfficePilot-Versand stuft auf officepilot hoch und bewahrt die manuellen Angaben', async () => {
    const marked = await clientOwnerA.rpc('update_workspace_invoice_sent', { p_workspace_id: wsA, p_client_invoice_id: 'inv-manual', p_sent_at: '2026-09-01', p_sent_via: 'post', p_sent_note: 'per Brief' });
    expect(marked.error).toBeNull();
    const { deliveryId } = await prepareDelivery({ client: clientOwnerA, workspaceId: wsA, clientDeliveryId: 'cd-manual', invoiceId: 'inv-manual' });
    const sent = await send(tokenOwnerA, wsA, 'cd-manual');
    expect(sent.body).toMatchObject({ action: 'sent', coupling: 'upgraded_from_manual' });
    const invoice = await invoiceRow(wsA, 'inv-manual');
    expect(invoice).toMatchObject({ invoice_status: 'versendet', sent_source: 'officepilot', sent_delivery_id: deliveryId });
    expect(invoice.payload).toMatchObject({ sentVia: 'email', sentSource: 'officepilot', sentManualPrior: { sentAt: '2026-09-01', sentVia: 'post', sentNote: 'per Brief' } });
    // Ein späteres manuelles Korrigieren stuft nicht auf manual zurück.
    const again = await clientOwnerA.rpc('update_workspace_invoice_sent', { p_workspace_id: wsA, p_client_invoice_id: 'inv-manual', p_sent_at: '2026-09-02', p_sent_via: 'email', p_sent_note: null });
    expect(again.error).toBeNull();
    expect((await invoiceRow(wsA, 'inv-manual')).sent_source).toBe('officepilot');
  });

  test('Q21/Q22: nach provider_accepted erzeugt Storno einen Korrekturbeleg; Bounce stuft die Rechnung nicht zurück', async () => {
    const { deliveryId } = await prepareDelivery({ client: clientOwnerA, workspaceId: wsA, clientDeliveryId: 'cd-cancel', invoiceId: 'inv-cancel' });
    expect((await send(tokenOwnerA, wsA, 'cd-cancel')).body).toMatchObject({ action: 'sent' });
    const cancel = await clientOwnerA.rpc('cancel_workspace_invoice', { p_workspace_id: wsA, p_client_invoice_id: 'inv-cancel', p_reason: 'Storno nach Versand' });
    expect(cancel.error).toBeNull();
    expect((await admin.from('workspace_invoices').select('cancellation_kind').eq('workspace_id', wsA).eq('client_invoice_id', 'inv-cancel').single()).data?.cancellation_kind).toBe('correction');

    const bounce = await prepareDelivery({ client: clientOwnerA, workspaceId: wsA, clientDeliveryId: 'cd-bounce2', invoiceId: 'inv-bounce2' });
    expect((await send(tokenOwnerA, wsA, 'cd-bounce2')).body).toMatchObject({ action: 'sent' });
    const bounced = await admin.rpc('update_workspace_document_delivery_status', { p_delivery_id: bounce.deliveryId, p_status: 'bounced', p_error_category: 'recipient', p_error_code: 'hard_bounce' });
    expect(bounced.error).toBeNull();
    expect(await invoiceRow(wsA, 'inv-bounce2')).toMatchObject({ invoice_status: 'versendet', sent_source: 'officepilot', sent_delivery_id: bounce.deliveryId });
    // Replay auf bounced: keine zweite Mail, Kopplung bleibt.
    const replay = await send(tokenOwnerA, wsA, 'cd-bounce2');
    expect(replay.body).toMatchObject({ action: 'replayed', coupling: 'already_linked' });
    expect(deliveryId).toBeTruthy();
  });

  test('Q23/Q24/Q25: Fremdworkspace und member abgewiesen; ohne Snapshot-E-Mail kein Versand; ungültiger Request', async () => {
    await prepareDelivery({ client: clientOwnerA, workspaceId: wsA, clientDeliveryId: 'cd-perm', invoiceId: 'inv-nosender' });
    const foreign = await send(tokenOwnerB, wsA, 'cd-perm');
    expect(foreign.status).toBe(403);
    const member = await send(tokenMemberA, wsA, 'cd-perm');
    expect(member.status).toBe(403);
    const noAuth = await fetch(FUNCTION_URL, { method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: wsA, clientDeliveryId: 'cd-perm' }) });
    expect(noAuth.status).toBe(401);
    const bad = await fetch(FUNCTION_URL, { method: 'POST', headers: { Authorization: `Bearer ${tokenOwnerA}`, apikey: ANON_KEY, 'Content-Type': 'application/json' }, body: '{"workspaceId":"x"}' });
    expect(bad.status).toBe(400);
    const notFound = await send(tokenOwnerA, wsA, 'cd-does-not-exist');
    expect(notFound.status).toBe(404);
    // Absender-Wahrheit: Snapshot ohne E-Mail → fail-closed, kein Provider-Aufruf, Rechnung bleibt.
    const own = await send(tokenOwnerA, wsA, 'cd-perm');
    expect(own.body).toMatchObject({ ok: true, action: 'failed', delivery: { errorCode: 'sender_reply_to_missing' } });
    expect((await invoiceRow(wsA, 'inv-nosender')).invoice_status).toBe('vorbereitet');
    expect(clientOwnerB && clientMemberA && wsB).toBeTruthy();
  });
});
