/**
 * E-MAIL 07E-AUTO-SYNC 01A — Edge Function `mailbox-auto-sync`
 * (automatischer, serverseitiger Postfachabruf).
 *
 * Aufrufer ist ausschließlich pg_cron über `mailbox_auto_sync_dispatch()`
 * (pg_net). Kein Browser, kein Benutzer: verify_jwt = false, abgesichert durch
 * das Scheduler-Geheimnis aus dem Supabase Vault (Header
 * `x-officetakt-scheduler`, geprüft per `mailbox_auto_sync_secret_valid`).
 *
 * Je fälligem Postfach läuft derselbe `runInboundSync` mit denselben
 * Adaptern wie „Jetzt abrufen" (_shared/inboundSyncServer.ts): Lease,
 * Token-Refresh mit sicherer Rotation, Ordner-Schutz (delegiert nur
 * „OfficeTakt-Test", nie Posteingang), Cursor, idempotenter Import.
 * Auswahl und Backoff: _shared/mailboxAutoSyncCore.ts.
 *
 * Logs: eine Zeile pro Lauf mit Zählern, bei Fehlern nur Kategorie/Code —
 * keine Adressen, Betreffe, Inhalte, Nachrichten-/Ordner-Kennungen, Cursor,
 * Tokens oder Geheimnisse. Diese Function sendet nie eine E-Mail.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { runInboundSync } from '../_shared/inboundSyncCore.ts';
import { availableInboundProviders, createInboundSyncDeps } from '../_shared/inboundSyncServer.ts';
import { runMailboxAutoSync, type AutoSyncCandidateRow } from '../_shared/mailboxAutoSyncCore.ts';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function log(entry: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ scope: 'mailbox-auto-sync', ...entry }));
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') return json({ ok: false, error: 'invalid_request' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    log({ outcome: 'server_misconfigured' });
    return json({ ok: false, error: 'server_misconfigured' }, 500);
  }

  const schedulerSecret = request.headers.get('x-officetakt-scheduler') ?? '';
  if (schedulerSecret.length < 32) return json({ ok: false, error: 'unauthenticated' }, 401);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: valid, error: validError } = await admin.rpc('mailbox_auto_sync_secret_valid', { p_secret: schedulerSecret });
  if (validError || valid !== true) {
    log({ outcome: 'unauthenticated' });
    return json({ ok: false, error: 'unauthenticated' }, 401);
  }

  // Innerhalb des Abrufs nur Fehlerkategorie/-code protokollieren (ohne Postfach-Kennung).
  const syncLog = (entry: Record<string, string | number | boolean | null>) => {
    if (entry.outcome === 'provider_error') log({ outcome: 'connection_error', category: entry.category ?? null, code: entry.code ?? null });
  };

  try {
    const summary = await runMailboxAutoSync({
      async listCandidates() {
        const { data, error } = await admin.rpc('list_workspace_mailbox_auto_sync_candidates', { p_limit: 200 });
        if (error) throw new Error('candidates_failed');
        return (Array.isArray(data) ? data : []) as AutoSyncCandidateRow[];
      },
      availableProviders: availableInboundProviders(),
      syncConnection: (connectionId) => runInboundSync(connectionId, createInboundSyncDeps(admin, syncLog)),
      log,
    });
    return json({ ok: true, ...summary }, 200);
  } catch {
    log({ outcome: 'server_error' });
    return json({ ok: false, error: 'server_error' }, 500);
  }
});
