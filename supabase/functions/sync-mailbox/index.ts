/**
 * E-MAIL-07E — Edge Function `sync-mailbox` (eingehende E-Mails abrufen).
 *
 * Auth → Schreibrecht im Workspace → Postfach gehört zum Workspace →
 * `runInboundSync` (_shared/inboundSyncCore.ts): Lease, seitenweiser Abruf ab
 * Cursor, Anhänge prüfen und im privaten Bucket `inbound-email-attachments`
 * ablegen, idempotenter Import mit Zuordnung, Cursor erst nach vollständiger
 * Seite, Abschluss mit sicherer Fehlerkategorie.
 *
 * Adapter, Vault-Zugang und Datenbank-Anbindung: _shared/inboundSyncServer.ts
 * (gemeinsam mit dem automatischen Abruf `mailbox-auto-sync`, 07E-AUTO-SYNC).
 * Diese Function sendet nie eine E-Mail.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { manualSyncCooldownRemaining, runInboundSync } from '../_shared/inboundSyncCore.ts';
import { createInboundSyncDeps } from '../_shared/inboundSyncServer.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

function log(entry: Record<string, string | number | boolean | null>): void {
  // Nur Kennungen, Zähler und Kategorien — keine Adressen, Betreffe, Inhalte, Dateinamen, Tokens.
  console.log(JSON.stringify({ scope: 'sync-mailbox', ...entry }));
}

const UUID = /^[0-9a-fA-F-]{36}$/;

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (request.method !== 'POST') return json({ ok: false, error: 'invalid_request' }, 400);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    log({ outcome: 'server_misconfigured' });
    return json({ ok: false, error: 'server_misconfigured' }, 500);
  }

  let body: { workspaceId?: unknown; connectionId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'invalid_request' }, 400);
  }
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  const connectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : '';
  if (!UUID.test(workspaceId) || !UUID.test(connectionId)) return json({ ok: false, error: 'invalid_request' }, 400);

  const authorization = request.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) return json({ ok: false, error: 'unauthenticated' }, 401);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await admin.auth.getUser(authorization.slice('bearer '.length).trim());
  const userId = userData?.user?.id ?? null;
  if (userError || !userId) return json({ ok: false, error: 'unauthenticated' }, 401);

  const { data: canWrite, error: writeError } = await admin.rpc('workspace_user_can_write', { p_workspace_id: workspaceId, p_user_id: userId });
  if (writeError || canWrite !== true) return json({ ok: false, error: 'forbidden' }, 403);

  // Das Postfach muss zu genau diesem Workspace gehören (keine Cross-Workspace-Abrufe).
  const { data: owned, error: ownedError } = await admin.rpc('mailbox_connection_belongs_to_workspace', { p_connection_id: connectionId, p_workspace_id: workspaceId });
  if (ownedError || owned !== true) return json({ ok: false, error: 'not_found' }, 404);

  // Kurz hintereinander ausgelöste Abrufe abweisen (ohne Lease, ohne Graph-Aufruf).
  const { data: last } = await admin.from('workspace_mailbox_connections').select('last_attempt_at').eq('id', connectionId).maybeSingle();
  const cooldown = manualSyncCooldownRemaining((last as { last_attempt_at?: string | null } | null)?.last_attempt_at ?? null, Date.now());
  if (cooldown > 0) {
    log({ connectionId, outcome: 'cooldown', retryAfterSeconds: cooldown });
    return json({ ok: true, action: 'cooldown', retryAfterSeconds: cooldown }, 200);
  }

  try {
    const outcome = await runInboundSync(connectionId, createInboundSyncDeps(admin, log));
    return json(outcome, 200);
  } catch {
    log({ outcome: 'server_error', connectionId });
    return json({ ok: false, error: 'server_error' }, 500);
  }
});
