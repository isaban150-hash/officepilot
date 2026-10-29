/**
 * EINRICHTUNG-01 (AP4; Vertrag 1.5, M-17) — Edge Function `send-team-invitation`.
 *
 * Auth (Token der einladenden Person) → Kontext über `team_invitation_mail_context` mit genau diesem Token (Rolle,
 * Betriebslizenz, Status und Hash prüft der Server) → Linkbasis gegen APP_ALLOWED_ORIGINS → Testempfänger-Schutz →
 * Anbieter (MAIL_PROVIDER; lokal `stub`). Dieselbe Serverkonfiguration wie `send-email`. Secrets nur aus Deno.env;
 * Protokolle enthalten nie Token, Link, Adresse oder Betriebsnamen.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createMailProvider, resolveMailProviderName } from '../_shared/emailProvider.ts';
import { resolveConfiguredSenderEmail, resolveTestRecipientAllowlist } from '../_shared/sendDocumentCore.ts';
import { runSendTeamInvitation, type InvitationMailContext } from '../_shared/teamInvitationCore.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

function log(entry: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ scope: 'send-team-invitation', ...entry }));
}

const STATUS: Record<string, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_open: 409,
  link_not_allowed: 400,
  server_misconfigured: 500,
  server_error: 500,
};

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (request.method !== 'POST') return json({ ok: false, error: 'invalid_request' }, 400);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const providerName = resolveMailProviderName(Deno.env.get('MAIL_PROVIDER'));
  const senderEmail = resolveConfiguredSenderEmail(Deno.env.get('MAIL_SENDER_EMAIL'));
  if (!supabaseUrl || !anonKey || !providerName || !senderEmail) {
    log({ outcome: 'server_misconfigured', providerConfigured: Boolean(providerName), senderConfigured: Boolean(senderEmail) });
    return json({ ok: false, error: 'server_misconfigured' }, STATUS.server_misconfigured);
  }

  const authorization = request.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) return json({ ok: false, error: 'unauthenticated' }, STATUS.unauthenticated);

  let body: { invitationId?: unknown; token?: unknown; language?: unknown; linkBase?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'invalid_request' }, STATUS.invalid_request);
  }

  // Der Kontext wird MIT dem Token der anfragenden Person gelesen: Der Server entscheidet über Rolle und Lizenz.
  const asUser = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });

  try {
    const outcome = await runSendTeamInvitation(body, {
      senderEmail,
      allowedOrigins: Deno.env.get('APP_ALLOWED_ORIGINS'),
      testRecipientAllowlist: resolveTestRecipientAllowlist(Deno.env.get('MAIL_TEST_RECIPIENT_ALLOWLIST')),
      provider: createMailProvider({ provider: providerName, brevoApiKey: Deno.env.get('BREVO_API_KEY') }),
      async resolveReplyTo(invitationId) {
        // EINRICHTUNG-01 (AP6; E18) — mit dem Token der einladenden Person; der Server prüft die zentrale Regel.
        const { data, error } = await asUser.rpc('resolve_workspace_reply_to_for_invitation', { p_invitation_id: invitationId });
        if (error) return { ok: false as const };
        const row = (data ?? {}) as Record<string, unknown>;
        return row.ok === true && typeof row.email === 'string' ? { ok: true as const, email: row.email } : { ok: false as const };
      },
      async loadContext(invitationId, token) {
        const { data, error } = await asUser.rpc('team_invitation_mail_context', { p_invitation_id: invitationId, p_token: token });
        if (error) {
          const message = error.message ?? '';
          return { ok: false, error: /invitation_not_open/.test(message) ? 'not_open' : 'forbidden' };
        }
        const row = (data ?? {}) as Record<string, unknown>;
        const context: InvitationMailContext = {
          email: String(row.email ?? ''),
          role: row.role === 'admin' ? 'admin' : 'member',
          workspaceName: String(row.workspace_name ?? ''),
          inviterName: typeof row.inviter_name === 'string' ? row.inviter_name : null,
          expiresAt: String(row.expires_at ?? ''),
        };
        if (!context.email) return { ok: false, error: 'forbidden' };
        return { ok: true, context };
      },
      log,
    });
    if (!outcome.ok) return json(outcome, STATUS[outcome.error] ?? 500);
    return json(outcome, 200);
  } catch (error) {
    log({ outcome: 'server_error', message: error instanceof Error ? error.message.slice(0, 120) : 'unknown' });
    return json({ ok: false, error: 'server_error' }, STATUS.server_error);
  }
});
