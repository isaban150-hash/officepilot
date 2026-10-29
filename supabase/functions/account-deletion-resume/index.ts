/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.25, K2) — Edge Function `account-deletion-resume` (Dienstweg).
 *
 * Setzt jeden Kontolöschauftrag in `sql_done` oder `auth_done` fort (je Teilschritt idempotent, Prüfspur genau einmal).
 * Aufrufer: der Planer `officetakt-account-deletion-resume` (lokal inaktiv; Aktivierung mit RELEASE-01) oder ein direkter
 * Aufruf mit dem Dienstrollen-Schlüssel. Ohne Entsperrung, ohne Geschäftszugriff. Protokolle nur mit Zählern.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { runAccountDeletionResume, toAccountDeletionJob } from '../_shared/accountDeletionCore.ts';
import { bytesToBase64Url } from '../_shared/replyToConfirmCore.ts';
import { isSchedulerOrServiceCall } from '../_shared/schedulerAuth.ts';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function log(entry: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ scope: 'account-deletion-resume', ...entry }));
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') return json({ ok: false, error: 'invalid_request' }, 405);
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    log({ outcome: 'server_misconfigured' });
    return json({ ok: false, error: 'server_error' }, 500);
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const allowed = await isSchedulerOrServiceCall(request, serviceRoleKey, 'officetakt_account_deletion_secret', async (name, secret) => {
    const { data, error } = await admin.rpc('einrichtung01_scheduler_secret_valid', { p_name: name, p_secret: secret });
    return !error && data === true;
  });
  if (!allowed) {
    log({ outcome: 'unauthenticated' });
    return json({ ok: false, error: 'unauthenticated' }, 401);
  }

  const loadJob = async (jobId: string) => {
    const { data, error } = await admin.rpc('account_deletion_job', { p_job_id: jobId });
    if (error) throw new Error('job_load_failed');
    return toAccountDeletionJob((data ?? null) as Record<string, unknown> | null);
  };
  try {
    const summary = await runAccountDeletionResume({
      async pendingJobIds(limit) {
        const { data, error } = await admin.rpc('account_deletion_pending_jobs', { p_limit: limit });
        if (error) throw new Error('pending_failed');
        return (Array.isArray(data) ? data : [])
          .map((row) => (row as Record<string, unknown>).job_id)
          .filter((id): id is string => typeof id === 'string');
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
    });
    log({ outcome: 'run', ...summary });
    return json({ ok: true, ...summary }, 200);
  } catch {
    log({ outcome: 'server_error' });
    return json({ ok: false, error: 'server_error' }, 500);
  }
});
