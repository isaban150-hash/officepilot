/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.22 E-06) — Edge Function `mail-status`.
 *
 * Sendet der Server im Testmodus (Anbieter `stub` oder aktive Testempfänger-Liste), zeigen Kommunikationsseite und
 * Versanddialoge einen Hinweis. Diese Function liefert nur den Modus: angemeldet, aktives Mitglied des Betriebs
 * (workspace_user_access_denial, Aktion „member“). Keine Adressen, keine Geheimnisse, keine Anbieterdetails.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { resolveMailProviderName } from '../_shared/emailProvider.ts';
import { resolveTestRecipientAllowlist } from '../_shared/sendDocumentCore.ts';
import { runMailStatus } from '../_shared/mailStatusCore.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

const STATUS: Record<string, number> = { unauthenticated: 401, invalid_request: 400, forbidden: 403, server_error: 500 };

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (request.method !== 'POST') return json({ ok: false, error: 'invalid_request' }, STATUS.invalid_request);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) return json({ ok: false, error: 'server_error' }, STATUS.server_error);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: { workspaceId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'invalid_request' }, STATUS.invalid_request);
  }

  try {
    const authorization = request.headers.get('Authorization') ?? '';
    const accessToken = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
    let userId: string | null = null;
    if (accessToken) {
      const { data } = await admin.auth.getUser(accessToken);
      userId = data?.user?.id ?? null;
    }
    const outcome = await runMailStatus(
      { userId, workspaceId: body.workspaceId },
      {
        providerName: resolveMailProviderName(Deno.env.get('MAIL_PROVIDER')),
        allowlist: resolveTestRecipientAllowlist(Deno.env.get('MAIL_TEST_RECIPIENT_ALLOWLIST')),
        async accessDenial(workspaceId, user) {
          const { data, error } = await admin.rpc('workspace_user_access_denial', {
            p_workspace_id: workspaceId,
            p_user_id: user,
            p_action: 'member',
          });
          if (error) return 'error';
          return typeof data === 'string' ? data : null;
        },
      },
    );
    if (!outcome.ok) return json(outcome, STATUS[outcome.error] ?? 500);
    return json(outcome, 200);
  } catch {
    return json({ ok: false, error: 'server_error' }, STATUS.server_error);
  }
});
