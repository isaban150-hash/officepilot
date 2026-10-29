/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.25a, K1) — Edge Function `confirm-destructive-action`.
 *
 * Nur POST, angemeldet (Token der Person): { action: 'account_delete' | 'workspace_delete_request', workspaceId?,
 * requestId, password }. Die Entscheidungen trifft der Kern (`_shared/destructiveConfirmCore.ts`). Das Passwort wird
 * gegen die Anmelde-E-Mail aus der Datenbank geprüft (Supabase Auth); die dabei entstandene Sitzung wird sofort
 * widerrufen. Gespeichert wird nur der Hash des Nachweises (Dienstrolle). Protokolle enthalten nie Passwort, Token oder
 * E-Mail. Secrets nur aus Deno.env.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { precheckErrorCode, runDestructiveConfirm } from '../_shared/destructiveConfirmCore.ts';
import { bytesToBase64Url } from '../_shared/replyToConfirmCore.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

function log(entry: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ scope: 'confirm-destructive-action', ...entry }));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const STATUS: Record<string, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  session_not_active: 401,
  account_blocked: 403,
  confirmation_rate_limited: 429,
  password_invalid: 401,
  auth_unavailable: 503,
  server_error: 500,
};

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (request.method !== 'POST') return json({ ok: false, error: 'invalid_request' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    log({ outcome: 'server_misconfigured' });
    return json({ ok: false, error: 'server_error' }, 500);
  }
  const authorization = request.headers.get('Authorization') ?? '';
  const accessToken = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
  if (!accessToken) return json({ ok: false, error: 'unauthenticated' }, 401);

  let body: { action?: unknown; workspaceId?: unknown; requestId?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'invalid_request' }, 400);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const asUser = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  try {
    const outcome = await runDestructiveConfirm(
      { action: body.action, workspaceId: body.workspaceId, requestId: body.requestId, password: body.password },
      {
        async precheck(action, workspaceId) {
          const { data, error } = await asUser.rpc('destructive_action_precheck', { p_action: action, p_workspace_id: workspaceId });
          if (error) return { ok: false, code: precheckErrorCode(error.message) };
          const row = (data ?? {}) as Record<string, unknown>;
          if (row.ok === true && typeof row.user_id === 'string' && typeof row.email === 'string') {
            return { ok: true, userId: row.user_id, email: row.email };
          }
          const code = row.code === 'confirmation_rate_limited' ? 'confirmation_rate_limited' : 'invalid_request';
          return { ok: false, code };
        },
        async signInWithPassword(email, password) {
          // Eigener Client ohne gespeicherte Sitzung: die Prüfsitzung verlässt diese Function nie.
          const probe = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
          const { data, error } = await probe.auth.signInWithPassword({ email, password });
          if (error || !data?.session?.access_token) {
            const status = (error as { status?: number } | null)?.status ?? 0;
            if (status === 429) return { ok: false, reason: 'rate_limited' };
            if (status === 400 || status === 401 || status === 422) return { ok: false, reason: 'invalid_credentials' };
            return { ok: false, reason: 'unavailable' };
          }
          return { ok: true, accessToken: data.session.access_token };
        },
        async revokeSession(token) {
          const { error } = await admin.auth.admin.signOut(token, 'local');
          return !error;
        },
        async recordFailure(userId) {
          await admin.rpc('destructive_action_record_failure', { p_user_id: userId });
        },
        randomToken() {
          const bytes = new Uint8Array(32);
          crypto.getRandomValues(bytes);
          return bytesToBase64Url(bytes);
        },
        sha256Hex,
        async issue(input) {
          const { data, error } = await admin.rpc('destructive_action_issue', {
            p_user_id: input.userId,
            p_action: input.action,
            p_workspace_id: input.workspaceId,
            p_request_id: input.requestId,
            p_token_hash: input.tokenHash,
          });
          if (error) return { ok: false, code: 'server_error' };
          const row = (data ?? {}) as Record<string, unknown>;
          return {
            ok: row.ok === true,
            code: typeof row.code === 'string' ? row.code : undefined,
            expiresAt: typeof row.expires_at === 'string' ? row.expires_at : undefined,
          };
        },
        log,
      },
    );
    if (!outcome.ok) return json(outcome, STATUS[outcome.error] ?? 400);
    return json(outcome, 200);
  } catch (error) {
    log({ outcome: 'server_error', message: error instanceof Error ? error.message.slice(0, 120) : 'unknown' });
    return json({ ok: false, error: 'server_error' }, 500);
  }
});
