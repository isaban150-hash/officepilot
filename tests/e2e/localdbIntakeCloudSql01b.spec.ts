/**
 * FINANZ-CORE-DURABILITY-01B — SQL/RLS-Laufzeittests gegen die lokale
 * Supabase-Instanz (kein --linked, keine Remote-Daten).
 *
 * Geprueft werden die Tabellen `workspace_files`, `workspace_document_file_bindings`,
 * `workspace_inbox_items`, `workspace_document_work_results`, die additive
 * Erweiterung von `workspace_documents` (archived_document), der Bucket
 * `workspace-files` und die RPCs `upsert_workspace_intake_entity` /
 * `pull_workspace_intake_state`:
 *   - fremder Workspace gesperrt
 *   - owner/admin voller Zugriff
 *   - member: eigener Upload/Eingang erlaubt, fremde Zeilen nicht lesbar, kein Tombstone
 *   - kein Client-Overwrite/-Delete des Blobs, gleiche Bytes = ein Objekt
 *   - Hash-Idempotenz, row_version-/Create-Guard
 *   - generated_invoice bleibt unangetastet
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const ANON_KEY = process.env.E2E_LOCALDB_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

const BYTES_A = new TextEncoder().encode('OfficePilot Beleg A — Originalbytes');
const BYTES_B = new TextEncoder().encode('OfficePilot Beleg B — andere Bytes');

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

let ownerA: LocalDbUser;
let memberA: LocalDbUser;
let ownerB: LocalDbUser;
let admin: SupabaseClient;
let clientOwnerA: SupabaseClient;
let clientMemberA: SupabaseClient;
let clientOwnerB: SupabaseClient;
let wsA = '';
let wsB = '';
let shaA = '';
let shaB = '';

async function login(user: LocalDbUser): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`Login fehlgeschlagen: ${error.message}`);
  return client;
}

async function ensureWorkspace(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.rpc('ensure_personal_workspace', { p_name: 'Intake SQL Test' });
  if (error) throw new Error(error.message);
  const id = (data as { workspace?: { id?: string }; id?: string })?.workspace?.id ?? (data as { id?: string })?.id;
  if (!id) throw new Error(`Workspace-ID fehlt: ${JSON.stringify(data)}`);
  return id;
}

async function upsert(client: SupabaseClient, workspaceId: string, entityType: string, payload: Record<string, unknown>, rowVersion = 0) {
  const { data, error } = await client.rpc('upsert_workspace_intake_entity', {
    p_workspace_id: workspaceId,
    p_entity_type: entityType,
    p_payload: payload,
    p_row_version: rowVersion,
  });
  return { data: data as { row_version?: number; deleted?: boolean; payload?: Record<string, unknown> } | null, error };
}

async function pull(client: SupabaseClient, workspaceId: string) {
  const { data, error } = await client.rpc('pull_workspace_intake_state', { p_workspace_id: workspaceId });
  return { data: data as Record<string, Array<Record<string, unknown>>> | null, error };
}

function filePayload(fileRefId: string, sha: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  return {
    client_file_ref_id: fileRefId,
    content_sha256: sha,
    size_bytes: bytes.length,
    mime_type: 'text/plain',
    original_file_name: 'beleg.txt',
    ...extra,
  };
}

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  ownerA = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'intake-owner-a' });
  memberA = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'intake-member-a' });
  ownerB = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'intake-owner-b' });
  clientOwnerA = await login(ownerA);
  clientMemberA = await login(memberA);
  clientOwnerB = await login(ownerB);
  wsA = await ensureWorkspace(clientOwnerA);
  wsB = await ensureWorkspace(clientOwnerB);
  const { error } = await admin.from('workspace_members').insert({ workspace_id: wsA, user_id: memberA.id, role: 'member', status: 'active' });
  if (error) throw new Error(`Member anlegen: ${error.message}`);
  shaA = await sha256Hex(BYTES_A);
  shaB = await sha256Hex(BYTES_B);
});

test.afterAll(async () => {
  for (const user of [ownerA, memberA, ownerB]) {
    if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
  }
});

test.describe('DURABILITY-01B — Intake-Cloud gegen die lokale Datenbank', () => {
  test('F1/F2: Owner registriert Datei; Pfad = ws/sha256; Create-Guard und row_version', async () => {
    const created = await upsert(clientOwnerA, wsA, 'document_file', filePayload('fr-a-1', shaA, BYTES_A));
    expect(created.error).toBeNull();
    expect(created.data?.row_version).toBe(1);
    expect(created.data?.payload?.storage_path).toBe(`${wsA}/${shaA}`);

    // Create-Guard: 0 = "darf noch nicht existieren"
    const replay = await upsert(clientOwnerA, wsA, 'document_file', filePayload('fr-a-1', shaA, BYTES_A), 0);
    expect(replay.error?.message).toContain('Versionskonflikt');
    // stale update
    const stale = await upsert(clientOwnerA, wsA, 'document_file', filePayload('fr-a-1', shaA, BYTES_A, { original_file_name: 'neu.txt' }), 5);
    expect(stale.error?.message).toContain('Versionskonflikt');
    const ok = await upsert(clientOwnerA, wsA, 'document_file', filePayload('fr-a-1', shaA, BYTES_A, { original_file_name: 'neu.txt' }), 1);
    expect(ok.error).toBeNull();
    expect(ok.data?.row_version).toBe(2);
    // Hash/Pfad unveraenderlich: ein anderer Hash im Update wird ignoriert
    expect(ok.data?.payload?.content_sha256).toBe(shaA);
    // ungueltiger Hash wird abgewiesen
    const bad = await upsert(clientOwnerA, wsA, 'document_file', filePayload('fr-a-bad', 'zz', BYTES_A));
    expect(bad.error?.message).toContain('content_sha256');
  });

  test('S1/S2: Blob-Upload unter ws/sha256 — gleiche Bytes = ein Objekt; kein Overwrite, kein Delete durch Clients', async () => {
    const path = `${wsA}/${shaA}`;
    const up = await clientOwnerA.storage.from('workspace-files').upload(path, BYTES_A, { contentType: 'text/plain', upsert: false });
    expect(up.error).toBeNull();
    // zweiter Upload gleicher Bytes: Objekt existiert bereits -> kein zweiter Blob
    const again = await clientOwnerA.storage.from('workspace-files').upload(path, BYTES_A, { contentType: 'text/plain', upsert: false });
    expect(again.error).not.toBeNull();
    // Overwrite verboten (keine update-Policy)
    const over = await clientOwnerA.storage.from('workspace-files').upload(path, BYTES_B, { contentType: 'text/plain', upsert: true });
    expect(over.error).not.toBeNull();
    // Delete verboten
    const del = await clientOwnerA.storage.from('workspace-files').remove([path]);
    expect((del.data ?? []).length).toBe(0);
    // Objekt unveraendert und per Hash/Groesse verifizierbar
    const down = await clientOwnerA.storage.from('workspace-files').download(path);
    expect(down.error).toBeNull();
    const bytes = new Uint8Array(await down.data!.arrayBuffer());
    expect(bytes.length).toBe(BYTES_A.length);
    expect(await sha256Hex(bytes)).toBe(shaA);
    // Pfad mit Endung oder fremder Workspace-Ordner: abgewiesen
    const wrongPath = await clientOwnerA.storage.from('workspace-files').upload(`${wsA}/${shaB}.txt`, BYTES_B, { contentType: 'text/plain', upsert: false });
    expect(wrongPath.error).not.toBeNull();
    const foreign = await clientOwnerA.storage.from('workspace-files').upload(`${wsB}/${shaB}`, BYTES_B, { contentType: 'text/plain', upsert: false });
    expect(foreign.error).not.toBeNull();
  });

  test('R1: Fremdworkspace — Owner B darf in A weder registrieren noch lesen', async () => {
    const write = await upsert(clientOwnerB, wsA, 'document_file', filePayload('fr-b-in-a', shaB, BYTES_B));
    expect(write.error?.message).toMatch(/Kein Zugriff/);
    const read = await pull(clientOwnerB, wsA);
    expect(read.error?.message).toMatch(/Kein Zugriff/);
    const { data: rows } = await clientOwnerB.from('workspace_files').select('id').eq('workspace_id', wsA);
    expect(rows ?? []).toHaveLength(0);
    const down = await clientOwnerB.storage.from('workspace-files').download(`${wsA}/${shaA}`);
    expect(down.error).not.toBeNull();
  });

  test('M1/M2: Member laedt eigenen Beleg hoch und sieht ihn; fremde Belege des Workspace bleiben unsichtbar', async () => {
    const memberSha = await sha256Hex(new TextEncoder().encode('Tankbeleg member'));
    const memberBytes = new TextEncoder().encode('Tankbeleg member');
    const up = await clientMemberA.storage.from('workspace-files').upload(`${wsA}/${memberSha}`, memberBytes, { contentType: 'text/plain', upsert: false });
    expect(up.error).toBeNull();
    const file = await upsert(clientMemberA, wsA, 'document_file', filePayload('fr-member-1', memberSha, memberBytes));
    expect(file.error).toBeNull();
    const inbox = await upsert(clientMemberA, wsA, 'inbox_item', {
      client_inbox_id: 'inbox-upload-member-1',
      status: 'neu',
      client_file_ref_id: 'fr-member-1',
      payload: { title: 'Tankbeleg', documentType: 'eingangsrechnung' },
    });
    expect(inbox.error).toBeNull();
    const work = await upsert(clientMemberA, wsA, 'document_work_result', {
      client_inbox_id: 'inbox-upload-member-1',
      source_fingerprint: 'fp-1',
      analysis_version: '01a.1',
      analysis: { classifiedKind: 'tankbeleg' },
      overlay: [],
    });
    expect(work.error).toBeNull();

    const own = await pull(clientMemberA, wsA);
    expect(own.error).toBeNull();
    expect(own.data?.files.map((f) => f.client_file_ref_id)).toEqual(['fr-member-1']);
    expect(own.data?.inbox_items.map((i) => i.client_inbox_id)).toEqual(['inbox-upload-member-1']);
    expect(own.data?.work_results).toHaveLength(1);
    // Owner-Datei fr-a-1 ist fuer den member nicht sichtbar — auch nicht per Tabelle oder Storage
    const { data: rows } = await clientMemberA.from('workspace_files').select('client_file_ref_id').eq('workspace_id', wsA);
    expect((rows ?? []).map((r) => r.client_file_ref_id)).toEqual(['fr-member-1']);
    const down = await clientMemberA.storage.from('workspace-files').download(`${wsA}/${shaA}`);
    expect(down.error).not.toBeNull();
    // eigener Blob lesbar
    const ownDown = await clientMemberA.storage.from('workspace-files').download(`${wsA}/${memberSha}`);
    expect(ownDown.error).toBeNull();

    // Owner sieht alles
    const all = await pull(clientOwnerA, wsA);
    expect(all.data?.files.map((f) => f.client_file_ref_id).sort()).toEqual(['fr-a-1', 'fr-member-1']);
  });

  test('M3: Member darf keine Tombstones setzen, keine fremden Zeilen aendern, keine archivierten Fremddokumente lesen', async () => {
    const tomb = await upsert(clientMemberA, wsA, 'inbox_item', { client_inbox_id: 'inbox-upload-member-1', deleted: true }, 1);
    expect(tomb.error?.message).toMatch(/Keine Schreibberechtigung/);
    const foreign = await upsert(clientMemberA, wsA, 'document_file', filePayload('fr-a-1', shaA, BYTES_A, { original_file_name: 'x' }), 2);
    expect(foreign.error?.message).toMatch(/Keine Schreibberechtigung/);
    // Owner archiviert ein Fremddokument
    const doc = await upsert(clientOwnerA, wsA, 'archived_document', {
      client_document_id: 'doc-a-1',
      payload: { title: 'Werkvertrag', category: 'vertraege', sourceInboxItemId: 'inbox-upload-a-1' },
    });
    expect(doc.error).toBeNull();
    expect(doc.data?.payload?.document_kind).toBe('archived_document');
    const memberDocs = await clientMemberA.from('workspace_documents').select('client_document_id').eq('workspace_id', wsA);
    expect((memberDocs.data ?? []).map((d) => d.client_document_id)).not.toContain('doc-a-1');
    const memberPull = await pull(clientMemberA, wsA);
    expect(memberPull.data?.archived_documents).toHaveLength(0);
  });

  test('B1/B2: Bindings — source_reuse (eine Datei, zwei Rollen), mehrere Originale je Dokument (part), extrahiertes XML nie Original', async () => {
    const orig = await upsert(clientOwnerA, wsA, 'document_file_binding', {
      binding_id: 'doc-a-1|original|',
      client_document_id: 'doc-a-1', client_file_ref_id: 'fr-a-1', binding_kind: 'original', provenance: 'received',
    });
    expect(orig.error).toBeNull();
    const archiveReuse = await upsert(clientOwnerA, wsA, 'document_file_binding', {
      binding_id: 'doc-a-1|archive|',
      client_document_id: 'doc-a-1', client_file_ref_id: 'fr-a-1', binding_kind: 'archive', provenance: 'derived',
    });
    expect(archiveReuse.error).toBeNull();
    // zweites Original (separat empfangenes XML)
    const xmlOriginal = await upsert(clientOwnerA, wsA, 'document_file_binding', {
      binding_id: 'doc-a-1|original|xml',
      client_document_id: 'doc-a-1', client_file_ref_id: 'fr-a-xml', binding_kind: 'original', part: 'xml', provenance: 'received',
    });
    expect(xmlOriginal.error).toBeNull();
    // extrahiertes XML als Original: abgewiesen (Check-Constraint)
    const extractedAsOriginal = await upsert(clientOwnerA, wsA, 'document_file_binding', {
      binding_id: 'doc-a-1|original|xml2',
      client_document_id: 'doc-a-1', client_file_ref_id: 'fr-a-xml', binding_kind: 'original', part: 'xml2', provenance: 'extracted',
    });
    expect(extractedAsOriginal.error).not.toBeNull();
    // extrahiertes XML korrekt: structured/extracted
    const structured = await upsert(clientOwnerA, wsA, 'document_file_binding', {
      binding_id: 'doc-a-1|structured|',
      client_document_id: 'doc-a-1', client_file_ref_id: 'fr-a-xml', binding_kind: 'structured', provenance: 'extracted',
    });
    expect(structured.error).toBeNull();
    // dieselbe Datei an einem zweiten Dokument
    const other = await upsert(clientOwnerA, wsA, 'document_file_binding', {
      binding_id: 'doc-a-2|original|',
      client_document_id: 'doc-a-2', client_file_ref_id: 'fr-a-1', binding_kind: 'original', provenance: 'received',
    });
    expect(other.error).toBeNull();
    // natuerlicher Schluessel: Replay mit 0 -> Versionskonflikt statt zweiter Zeile
    const dup = await upsert(clientOwnerA, wsA, 'document_file_binding', {
      binding_id: 'doc-a-1|original|',
      client_document_id: 'doc-a-1', client_file_ref_id: 'fr-a-1', binding_kind: 'original', provenance: 'received',
    });
    expect(dup.error?.message).toContain('Versionskonflikt');
    const all = await pull(clientOwnerA, wsA);
    expect(all.data?.bindings.filter((b) => b.client_document_id === 'doc-a-1')).toHaveLength(4);
  });

  test('I1/I2: Eingang — Status/Verknuepfung/Tombstone mit row_version; Pull liefert Grabsteine', async () => {
    const created = await upsert(clientOwnerA, wsA, 'inbox_item', {
      client_inbox_id: 'inbox-upload-a-1', status: 'neu', client_file_ref_id: 'fr-a-1',
      payload: { title: 'Werkvertrag', documentType: 'kundenauftrag' },
    });
    expect(created.error).toBeNull();
    const linked = await upsert(clientOwnerA, wsA, 'inbox_item', {
      client_inbox_id: 'inbox-upload-a-1', status: 'geprueft', vorgang_link_status: 'created', vorgang_id: 'v-1', archive_document_id: 'doc-a-1',
      payload: { title: 'Werkvertrag', documentType: 'kundenauftrag' },
    }, 1);
    expect(linked.error).toBeNull();
    expect(linked.data?.payload?.vorgang_id).toBe('v-1');
    expect(linked.data?.row_version).toBe(2);
    const bad = await upsert(clientOwnerA, wsA, 'inbox_item', { client_inbox_id: 'inbox-upload-a-1', status: 'kaputt', payload: {} }, 2);
    expect(bad.error).not.toBeNull();
    const tomb = await upsert(clientOwnerA, wsA, 'inbox_item', { client_inbox_id: 'inbox-upload-a-1', deleted: true }, 2);
    expect(tomb.error).toBeNull();
    expect(tomb.data?.deleted).toBe(true);
    // Tombstone bewahrt Verknuepfungen (kein Wegputzen), Pull enthaelt ihn
    expect(tomb.data?.payload?.vorgang_id).toBe('v-1');
    const all = await pull(clientOwnerA, wsA);
    const row = all.data?.inbox_items.find((i) => i.client_inbox_id === 'inbox-upload-a-1');
    expect(row?.deleted).toBe(true);
  });

  test('W1: WorkResult — analysis und overlay getrennt, Versionsguard', async () => {
    const created = await upsert(clientOwnerA, wsA, 'document_work_result', {
      client_inbox_id: 'inbox-upload-a-1', source_fingerprint: 'fp-a', analysis_version: '01a.1',
      analyzed_at: '2026-09-14T10:00:00.000Z', analysis: { businessInterpretation: { kind: 'werkvertrag' } }, overlay: [],
    });
    expect(created.error).toBeNull();
    const overlay = await upsert(clientOwnerA, wsA, 'document_work_result', {
      client_inbox_id: 'inbox-upload-a-1', source_fingerprint: 'fp-a', analysis_version: '01a.1',
      analysis: { businessInterpretation: { kind: 'werkvertrag' } },
      overlay: [{ slotId: 'facts.money.0', status: 'user_confirmed', value: 1200, updatedAt: '2026-09-14T11:00:00.000Z' }],
    }, 1);
    expect(overlay.error).toBeNull();
    expect((overlay.data?.payload?.overlay as unknown[]).length).toBe(1);
    const stale = await upsert(clientOwnerA, wsA, 'document_work_result', { client_inbox_id: 'inbox-upload-a-1', overlay: [] }, 1);
    expect(stale.error?.message).toContain('Versionskonflikt');
  });

  test('G1: generated_invoice bleibt unangetastet — nicht ueber den Intake-Pfad aenderbar, weiterhin fuer Mitglieder lesbar', async () => {
    const { error: invErr } = await admin.from('workspace_invoices').insert({
      workspace_id: wsA, vorgang_id: null, client_invoice_id: 'inv-g-1', invoice_number: '2026-9001', invoice_year: 2026,
      invoice_sequence_number: 9001, invoice_type: 'rechnung', invoice_status: 'vorbereitet', payload: { id: 'inv-g-1', status: 'vorbereitet' },
    });
    expect(invErr).toBeNull();
    const { error: docErr } = await admin.from('workspace_documents').insert({
      workspace_id: wsA, client_document_id: 'doc-gen-1', document_kind: 'generated_invoice', linked_invoice_id: 'inv-g-1', payload: { title: '2026-9001 – Rechnung' },
    });
    expect(docErr).toBeNull();
    // 01D2 — der Storno-Korrekturbeleg (Migration 20260913) bleibt als Dokumentart zulaessig.
    const { error: corrErr } = await admin.from('workspace_documents').insert({
      workspace_id: wsA, client_document_id: 'corr-inv-g-1', document_kind: 'generated_invoice_correction', linked_invoice_id: 'inv-g-1', payload: { title: 'Rechnungskorrektur' },
    });
    expect(corrErr).toBeNull();
    const viaIntake = await upsert(clientOwnerA, wsA, 'archived_document', { client_document_id: 'doc-gen-1', payload: { title: 'x' } }, 1);
    expect(viaIntake.error?.message).toMatch(/Dokumentart nicht zulaessig/);
    const memberDocs = await clientMemberA.from('workspace_documents').select('client_document_id,document_kind').eq('workspace_id', wsA);
    expect((memberDocs.data ?? []).map((d) => d.client_document_id)).toContain('doc-gen-1');
    const { data: pulled } = await clientOwnerA.rpc('pull_workspace_documents', { p_workspace_id: wsA, p_since: null });
    expect((pulled as Array<{ client_document_id: string }>).map((d) => d.client_document_id).sort()).toEqual(['corr-inv-g-1', 'doc-gen-1']);
  });
});
