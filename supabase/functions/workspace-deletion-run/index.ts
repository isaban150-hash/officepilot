/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.26, K3) — Edge Function `workspace-deletion-run` (Dienstweg).
 *
 * Führt fällige Betriebslöschungen aus (`_shared/workspaceDeletionRunCore.ts`): Sperre für genau einen Lauf, Objekte
 * der Arbeitsliste über die Storage-API löschen und vermerken, danach die Ausführung in einer Transaktion. Aufrufer: der
 * Planer `officetakt-workspace-deletion` (lokal inaktiv; Aktivierung mit RELEASE-01) oder ein direkter Aufruf mit dem
 * Dienstrollen-Schlüssel, optional für genau einen Betrieb ({ workspaceId }). Protokolle nur mit Zählern und Codes.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { runWorkspaceDeletionBatch, type DeletionObject } from '../_shared/workspaceDeletionRunCore.ts';
import { isSchedulerOrServiceCall } from '../_shared/schedulerAuth.ts';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function log(entry: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ scope: 'workspace-deletion-run', ...entry }));
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
  const allowed = await isSchedulerOrServiceCall(request, serviceRoleKey, 'officetakt_workspace_deletion_secret', async (name, secret) => {
    const { data, error } = await admin.rpc('einrichtung01_scheduler_secret_valid', { p_name: name, p_secret: secret });
    return !error && data === true;
  });
  if (!allowed) {
    log({ outcome: 'unauthenticated' });
    return json({ ok: false, error: 'unauthenticated' }, 401);
  }

  let body: { workspaceId?: unknown } = {};
  try {
    body = ((await request.json().catch(() => ({}))) ?? {}) as typeof body;
  } catch {
    body = {};
  }

  try {
    const outcome = await runWorkspaceDeletionBatch(
      { workspaceId: body.workspaceId },
      {
        async due(limit) {
          const { data, error } = await admin.rpc('workspace_deletion_due', { p_limit: limit });
          if (error) throw new Error('due_failed');
          return (Array.isArray(data) ? data : []).filter((id): id is string => typeof id === 'string');
        },
        async begin(workspaceId, runner) {
          const { data, error } = await admin.rpc('workspace_deletion_begin', { p_workspace_id: workspaceId, p_runner: runner, p_lease_seconds: 600 });
          if (error) return { ok: false, code: 'begin_failed' };
          const row = (data ?? {}) as Record<string, unknown>;
          if (row.ok === true && row.state === 'completed') return { ok: true, state: 'completed' };
          if (row.ok === true && row.state === 'deleting') {
            return { ok: true, state: 'deleting', objects: (Array.isArray(row.objects) ? row.objects : []) as DeletionObject[] };
          }
          return { ok: false, code: typeof row.code === 'string' ? row.code : 'begin_failed' };
        },
        async removeObjects(bucket, names) {
          const { data, error } = await admin.storage.from(bucket).remove(names);
          if (error) return { removed: [], error: 'storage_remove_failed' };
          return { removed: (data ?? []).map((object) => object.name).filter((name): name is string => typeof name === 'string') };
        },
        async mark(workspaceId, runner, objects) {
          const { error } = await admin.rpc('workspace_deletion_mark_objects', { p_workspace_id: workspaceId, p_runner: runner, p_objects: objects });
          if (error) throw new Error('mark_failed');
        },
        async execute(workspaceId, runner) {
          const { data, error } = await admin.rpc('workspace_deletion_execute', { p_workspace_id: workspaceId, p_runner: runner });
          if (error) return { ok: false, code: 'execute_failed' };
          const row = (data ?? {}) as Record<string, unknown>;
          return { ok: row.ok === true, state: typeof row.state === 'string' ? row.state : undefined, code: typeof row.code === 'string' ? row.code : undefined };
        },
        async fail(workspaceId, runner, code) {
          await admin.rpc('workspace_deletion_fail', { p_workspace_id: workspaceId, p_runner: runner, p_error_code: code });
        },
        randomRunner: () => crypto.randomUUID(),
        log,
      },
    );
    if (!outcome.ok) return json(outcome, 400);
    log({ outcome: 'run', ...outcome.results });
    return json(outcome, 200);
  } catch {
    log({ outcome: 'server_error' });
    return json({ ok: false, error: 'server_error' }, 500);
  }
});
