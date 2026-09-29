/**
 * E-MAIL-07E — Client-Vertrag der eingehenden E-Mail: Zeilen lesen,
 * Anhänge nur aus erlaubten privaten Buckets, RPC-Argumente, Abruf-Aufruf.
 * Gefälschter Supabase-Client, kein Netz.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as supabaseLib from '../../lib/supabase';
import {
  downloadEmailAttachment,
  invokeSyncMailbox,
  parseEmailMessageRow,
  rpcAssignInboundEmailMessage,
  rpcListInboundEmailMessages,
  rpcListMailboxConnections,
} from './emailMessageCloudService';

const WS = '00000000-0000-4000-8000-0000000007e0';
const SHA = 'a'.repeat(64);

afterEach(() => vi.restoreAllMocks());

describe('E-MAIL-07E — Client-Vertrag', () => {
  it('eingehende Zeile: Richtung, Absender, Zuordnung, nicht übernommene Anhänge, Eingangs-Bucket', () => {
    const message = parseEmailMessageRow({
      id: 'in-1', workspace_id: WS, client_message_id: 'in:x', direction: 'inbound', provider: 'microsoft_graph', status: 'received',
      to_recipients: ['info@betrieb.invalid'], cc_recipients: [], bcc_recipients: [], subject: 'S', body_text: 'T',
      from_address: 'a@b.invalid', from_name: 'A', received_at: '2026-09-27T08:00:00Z', has_html: true,
      assignment_status: 'needs_review', assignment_source: null, suggested_vorgang_id: 'v-1',
      skipped_attachments: [{ filename: 'x.exe', mime_type: 'application/octet-stream', size_bytes: 3, reason: 'type_not_allowed' }, { filename: 'y', reason: 'erfunden' }],
      attachments: [{ position: 1, filename: 'A.pdf', mime_type: 'application/pdf', size_bytes: 1, sha256: SHA, storage_path: `${WS}/${SHA}.pdf`, storage_bucket: 'inbound-email-attachments' }],
      attempt_number: 1, row_version: 1, created_at: '2026-09-27T08:00:00Z',
    })!;
    expect(message).toMatchObject({ direction: 'inbound', provider: 'microsoft_graph', status: 'received', fromAddress: 'a@b.invalid', hasHtml: true, assignmentStatus: 'needs_review', suggestedVorgangId: 'v-1' });
    expect(message.skippedAttachments).toEqual([{ filename: 'x.exe', mimeType: 'application/octet-stream', sizeBytes: 3, reason: 'type_not_allowed' }]);
    expect(message.attachments[0].storageBucket).toBe('inbound-email-attachments');
    // Ausgehende Zeilen ohne Richtung bleiben ausgehend; fremder Bucket fällt auf den 07D-Bucket zurück.
    const outbound = parseEmailMessageRow({ id: 'o', workspace_id: WS, client_message_id: 'em', provider: 'brevo', status: 'queued', to_recipients: [], cc_recipients: [], bcc_recipients: [], attachments: [{ position: 1, filename: 'a.pdf', mime_type: 'application/pdf', size_bytes: 1, sha256: SHA, storage_path: 'p', storage_bucket: 'oeffentlich' }] })!;
    expect(outbound.direction).toBe('outbound');
    expect(outbound.attachments[0].storageBucket).toBe('email-attachments');
    // Eingehend mit ungültigem Provider wird verworfen.
    expect(parseEmailMessageRow({ id: 'x', client_message_id: 'x', direction: 'inbound', provider: 'brevo', status: 'received' })).toBeNull();
  });

  it('T/S: Anhang aus dem privaten Eingangs-Bucket; unbekannter Bucket wird nie verwendet', async () => {
    const download = vi.fn(async () => ({ data: new Blob(['%PDF-']), error: null }));
    const from = vi.fn(() => ({ download }));
    const client = { storage: { from } } as never;
    const result = await downloadEmailAttachment({ storagePath: `${WS}/${SHA}.pdf`, mimeType: 'application/pdf', storageBucket: 'inbound-email-attachments' }, client);
    expect(result.ok).toBe(true);
    expect(from).toHaveBeenCalledWith('inbound-email-attachments');
    await downloadEmailAttachment({ storagePath: `${WS}/${SHA}.pdf`, mimeType: 'application/pdf', storageBucket: 'fremd' as never }, client);
    expect(from).toHaveBeenLastCalledWith('email-attachments');
  });

  it('RPC-Argumente: Posteingang mit Filtern, Zuordnung mit Version; veraltet und Widerspruch erkannt', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const responses: Record<string, { data?: unknown; error?: { message: string } }> = {
      list_workspace_inbound_email_messages: { data: [] },
      list_workspace_mailbox_connections: { data: [{ id: 'c', provider_type: 'microsoft_graph', mailbox_address: 'info@betrieb.invalid', status: 'connected', has_credentials: true, sync_cursor: 'darf nicht ankommen' }] },
    };
    const client = {
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        const response = responses[name] ?? { data: null };
        return { data: response.data ?? null, error: response.error ?? null };
      }),
    } as never;
    await rpcListInboundEmailMessages({ workspaceId: WS, customerId: 'c-1', needsReviewOnly: true }, client);
    expect(calls[0]).toEqual({ name: 'list_workspace_inbound_email_messages', args: { p_workspace_id: WS, p_customer_id: 'c-1', p_vorgang_id: null, p_needs_review_only: true, p_limit: 200 } });
    const connections = await rpcListMailboxConnections({ workspaceId: WS }, client);
    expect(connections.ok && connections.connections[0]).toEqual(expect.objectContaining({ mailboxAddress: 'info@betrieb.invalid', hasCredentials: true }));
    expect(JSON.stringify(connections)).not.toContain('darf nicht ankommen');

    responses.assign_workspace_inbound_email_message = { error: { message: 'row_version veraltet' } };
    expect(await rpcAssignInboundEmailMessage({ workspaceId: WS, messageId: 'm', customerId: 'c-1', expectedRowVersion: 3 }, client)).toEqual({ ok: false, error: 'stale' });
    expect(calls.at(-1)!.args).toEqual({ p_workspace_id: WS, p_message_id: 'm', p_customer_id: 'c-1', p_vorgang_id: null, p_expected_row_version: 3 });
    responses.assign_workspace_inbound_email_message = { error: { message: 'Kunde passt nicht zum Vorgang' } };
    expect(await rpcAssignInboundEmailMessage({ workspaceId: WS, messageId: 'm', vorgangId: 'v-1' }, client)).toEqual({ ok: false, error: 'context_conflict' });
  });

  it('Abruf: ruft ausschließlich sync-mailbox (nie einen Versand) und übersetzt Ergebnisse', async () => {
    vi.spyOn(supabaseLib, 'getSupabaseUrl').mockReturnValue('https://projekt.invalid');
    const client = { auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) } } as never;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, action: 'synced', imported: 2, duplicates: 0, failed: 0, pages: 1, more: false }), { status: 200 }));
    expect(await invokeSyncMailbox({ workspaceId: WS, connectionId: 'conn-1' }, client)).toMatchObject({ ok: true, action: 'synced', imported: 2 });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://projekt.invalid/functions/v1/sync-mailbox');
    fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    expect(await invokeSyncMailbox({ workspaceId: WS, connectionId: 'conn-1' }, client)).toEqual({ ok: false, error: 'not_deployed' });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, action: 'provider_error', category: 'reauthorize', code: 'graph_403' }), { status: 200 }));
    expect(await invokeSyncMailbox({ workspaceId: WS, connectionId: 'conn-1' }, client)).toEqual({ ok: false, error: 'provider_error', category: 'reauthorize' });
    expect(fetchSpy.mock.calls.every((call) => String(call[0]).endsWith('/functions/v1/sync-mailbox'))).toBe(true);
  });
});
