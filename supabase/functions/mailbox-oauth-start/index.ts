/**
 * E-MAIL-07E-MSA / 07E-PF — Edge Function `mailbox-oauth-start` (providerneutral).
 *
 * Angemeldeter Nutzer mit Schreibrecht im Workspace startet die Verbindung
 * eines Postfachs beim gewählten Anbieter (`provider`; umgesetzt:
 * microsoft_graph). Eingaben prüfen, `state`/PKCE/Nonce erzeugen und
 * serverseitig mit Ablaufzeit speichern (nur der SHA-256 des `state`), dann
 * die Anmelde-URL des Anbieters zurückgeben. Der Browser leitet dorthin
 * weiter; das Passwort gibt der Nutzer ausschließlich beim Anbieter ein.
 *
 * Nicht freigegebene Anbieter (z. B. google_gmail) → `provider_not_available`.
 * Antwort enthält nie Verifier, Nonce, Secrets oder Tokens.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { runMailboxOAuthStart } from '../_shared/oauth/mailboxOAuth.ts';
import { resolveMailboxOAuthBinding } from '../_shared/oauth/providers.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function log(entry: Record<string, string | number | boolean | null>): void {
  // Keine Adressen, keine State-/PKCE-Werte, keine Tokens.
  console.log(JSON.stringify({ scope: 'mailbox-oauth-start', ...entry }));
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (request.method !== 'POST') return json({ ok: false, error: 'invalid_request' }, 400);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    log({ outcome: 'server_misconfigured' });
    return json({ ok: false, error: 'server_misconfigured' }, 500);
  }

  let body: { workspaceId?: unknown; provider?: unknown; expectedAddress?: unknown; sourceName?: unknown; importDays?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'invalid_request' }, 400);
  }
  const providerType = typeof body.provider === 'string' ? body.provider.trim() : '';
  const resolved = resolveMailboxOAuthBinding(providerType, (name) => Deno.env.get(name));
  if (!resolved.ok) {
    // Nur Namen fehlender Einstellungen ins Log, nie Werte.
    log({ outcome: resolved.error, provider: providerType.slice(0, 40), missing: resolved.missing?.join(',') ?? null });
    return json({ ok: false, error: resolved.error }, resolved.error === 'provider_not_available' ? 400 : 503);
  }

  const authorization = request.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) return json({ ok: false, error: 'unauthenticated' }, 401);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await admin.auth.getUser(authorization.slice('bearer '.length).trim());
  const userId = userData?.user?.id ?? null;
  if (userError || !userId) return json({ ok: false, error: 'unauthenticated' }, 401);

  const result = await runMailboxOAuthStart(
    {
      workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '',
      expectedAddress: typeof body.expectedAddress === 'string' ? body.expectedAddress : '',
      sourceName: typeof body.sourceName === 'string' ? body.sourceName : undefined,
      importDays: typeof body.importDays === 'number' ? body.importDays : undefined,
    },
    {
      ...resolved.binding,
      userId,
      async canWrite(workspaceId, uid) {
        const { data, error } = await admin.rpc('workspace_user_can_write', { p_workspace_id: workspaceId, p_user_id: uid });
        return !error && data === true;
      },
      async createState(row) {
        const { error } = await admin.rpc('create_workspace_mailbox_oauth_state', {
          p_workspace_id: row.workspaceId,
          p_user_id: row.userId,
          p_provider_type: row.providerType,
          p_state_hash: row.stateHash,
          p_code_verifier: row.codeVerifier,
          p_nonce: row.nonce,
          p_expected_address: row.expectedAddress,
          p_source_kind: row.sourceKind,
          p_source_name: row.sourceName,
          p_import_from: row.importFrom,
          p_ttl_seconds: row.ttlSeconds,
        });
        if (error) throw new Error('state_failed');
      },
    },
  );
  log({ outcome: result.ok ? 'started' : result.error, provider: providerType });
  if (!result.ok) return json({ ok: false, error: result.error }, result.error === 'forbidden' ? 403 : result.error === 'state_failed' ? 500 : 400);
  return json({ ok: true, authorizeUrl: result.authorizeUrl, expiresInSeconds: result.expiresInSeconds }, 200);
});
