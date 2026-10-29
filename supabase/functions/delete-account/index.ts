/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.25, K1, K2) — Edge Function `delete-account`.
 *
 * Nur POST, angemeldet (Token der Person): { requestId, confirmationToken, email }. Schritt 1 läuft als
 * `account_deletion_begin` mit dem Token der Person (Sitzung, Sperren, Nachweis und Voraussetzungen prüft der Server in
 * einer Transaktion); Schritt 2 und 3 mit der Dienstrolle, je Teilschritt idempotent (`_shared/accountDeletionCore.ts`).
 * Dieselbe Anfrage-ID setzt einen begonnenen eigenen Auftrag fort. Antwort nie „vollständig gelöscht“, solange der
 * Auftrag nicht `completed` ist. Protokolle ohne E-Mail, Token oder Namen.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { beginErrorCode, runDeleteAccount, toAccountDeletionJob } from '../_shared/accountDeletionCore.ts';
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
  console.log(JSON.stringify({ scope: 'delete-account', ...entry }));
}

const STATUS: Record<string, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  session_not_active: 401,
  account_blocked: 403,
  confirmation_invalid: 403,
  account_owner: 409,
  last_platform_admin: 409,
  email_mismatch: 409,
  deletion_request_mismatch: 409,
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

  let body: { requestId?: unknown; confirmationToken?: unknown; email?: unknown };
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
    const { data: who } = await admin.auth.getUser(accessToken);
    const userId = who?.user?.id ?? null;
    const loadJob = async (jobId: string) => {
      const { data, error } = await admin.rpc('account_deletion_job', { p_job_id: jobId });
      if (error) throw new Error('job_load_failed');
      return toAccountDeletionJob((data ?? null) as Record<string, unknown> | null);
    };
    const outcome = await runDeleteAccount(
      { userId, requestId: body.requestId, confirmationToken: body.confirmationToken, email: body.email },
      {
        async begin(input) {
          const { data, error } = await asUser.rpc('account_deletion_begin', {
            p_request_id: input.requestId,
            p_confirmation_token: input.confirmationToken,
            p_typed_email: input.email,
          });
          if (error) return { ok: false, code: beginErrorCode(error.message) };
          const row = (data ?? {}) as Record<string, unknown>;
          if (row.ok === true && typeof row.job_id === 'string' && typeof row.state === 'string') {
            return { ok: true, jobId: row.job_id, state: row.state as 'sql_done' };
          }
          return {
            ok: false,
            code: typeof row.code === 'string' ? row.code : 'server_error',
            workspaces: Array.isArray(row.workspaces) ? (row.workspaces as Array<{ workspace_id: string; name: string }>) : undefined,
            ways: Array.isArray(row.ways) ? (row.ways as string[]) : undefined,
          };
        },
        loadJob,
        async pseudonymizeAuthUser(id, pseudonymEmail) {
          const bytes = new Uint8Array(32);
          crypto.getRandomValues(bytes);
          const { error } = await admin.auth.admin.updateUserById(id, {
            email: pseudonymEmail,
            email_confirm: true,
            password: bytesToBase64Url(bytes),
            ban_duration: '876000h',
            user_metadata: {},
            app_metadata: { provider: 'email', providers: ['email'] },
          });
          return error ? { ok: false, code: 'auth_email_failed' } : { ok: true };
        },
        async step(jobId, step, errorCode) {
          const { error } = await admin.rpc('account_deletion_auth_step', { p_job_id: jobId, p_step: step, p_error_code: errorCode ?? null });
          if (error) return null;
          return loadJob(jobId);
        },
        async complete(jobId) {
          const { error } = await admin.rpc('account_deletion_complete', { p_job_id: jobId });
          if (error) return null;
          return loadJob(jobId);
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
