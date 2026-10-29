/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.22 E-03, E18, K4) — Edge Function `confirm-reply-to`.
 *
 * Nur POST. Ein bloßer Abruf (GET, etwa durch eine Link-Vorschau) bestätigt nichts und wird abgewiesen.
 *   { action: 'request', workspaceId, address, linkBase, language }  — angemeldet (Bearer: Token der Person)
 *   { action: 'confirm', token }                                      — ohne Anmeldung (Bearer: anon key genügt)
 *
 * Die Entscheidungen trifft der Kern (`_shared/replyToConfirmCore.ts`); Rolle, Lizenz, Adresse, Änderungsstand und
 * Fristen prüft der Server (`reply_to_confirmation_issue`, `reply_to_confirmation_confirm`, nur service_role).
 * Protokolle enthalten nie Token, Link, Adresse oder Betriebsnamen. Secrets nur aus Deno.env.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createMailProvider, resolveMailProviderName } from '../_shared/emailProvider.ts';
import { resolveConfiguredSenderEmail, resolveTestRecipientAllowlist } from '../_shared/sendDocumentCore.ts';
import { bytesToBase64Url, runReplyToConfirm, runReplyToRequest } from '../_shared/replyToConfirmCore.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

function log(entry: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ scope: 'confirm-reply-to', ...entry }));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

const STATUS: Record<string, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  link_not_allowed: 400,
  reply_to_missing: 409,
  address_mismatch: 409,
  already_confirmed: 409,
  resend_too_early: 429,
  resend_limit: 429,
  invalid: 400,
  rate_limited: 429,
  method_not_allowed: 405,
  server_misconfigured: 500,
  server_error: 500,
};

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, STATUS.method_not_allowed);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    log({ outcome: 'server_misconfigured' });
    return json({ ok: false, error: 'server_misconfigured' }, STATUS.server_misconfigured);
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: { action?: unknown; workspaceId?: unknown; address?: unknown; linkBase?: unknown; language?: unknown; token?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'invalid_request' }, STATUS.invalid_request);
  }

  try {
    if (body.action === 'confirm') {
      const source = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('cf-connecting-ip') || null;
      const outcome = await runReplyToConfirm(
        { token: body.token, attemptSource: source },
        {
          sha256Hex,
          async confirm(tokenHash, attemptKey) {
            const { data, error } = await admin.rpc('reply_to_confirmation_confirm', { p_token_hash: tokenHash, p_attempt_key: attemptKey });
            if (error) throw new Error('confirm_failed');
            const row = (data ?? {}) as Record<string, unknown>;
            return {
              ok: row.ok === true,
              status: typeof row.status === 'string' ? row.status : undefined,
              code: typeof row.code === 'string' ? row.code : undefined,
              address: typeof row.address === 'string' ? row.address : null,
            };
          },
          log,
        },
      );
      if (!outcome.ok) return json(outcome, STATUS[outcome.error] ?? 400);
      return json(outcome, 200);
    }

    if (body.action === 'request') {
      const providerName = resolveMailProviderName(Deno.env.get('MAIL_PROVIDER'));
      const senderEmail = resolveConfiguredSenderEmail(Deno.env.get('MAIL_SENDER_EMAIL'));
      if (!providerName || !senderEmail) {
        log({ outcome: 'server_misconfigured', providerConfigured: Boolean(providerName), senderConfigured: Boolean(senderEmail) });
        return json({ ok: false, error: 'server_misconfigured' }, STATUS.server_misconfigured);
      }
      const authorization = request.headers.get('Authorization') ?? '';
      const accessToken = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
      let userId: string | null = null;
      if (accessToken) {
        const { data } = await admin.auth.getUser(accessToken);
        userId = data?.user?.id ?? null;
      }
      const outcome = await runReplyToRequest(
        { userId, workspaceId: body.workspaceId, address: body.address, linkBase: body.linkBase, language: body.language },
        {
          senderEmail,
          allowedOrigins: Deno.env.get('APP_ALLOWED_ORIGINS'),
          testRecipientAllowlist: resolveTestRecipientAllowlist(Deno.env.get('MAIL_TEST_RECIPIENT_ALLOWLIST')),
          provider: createMailProvider({ provider: providerName, brevoApiKey: Deno.env.get('BREVO_API_KEY') }),
          randomToken,
          sha256Hex,
          async issue(workspaceId, actorUserId, tokenHash, address) {
            const { data, error } = await admin.rpc('reply_to_confirmation_issue', {
              p_workspace_id: workspaceId,
              p_actor: actorUserId,
              p_token_hash: tokenHash,
              p_address: address,
            });
            if (error) return { ok: false, code: 'server_error' };
            const row = (data ?? {}) as Record<string, unknown>;
            return {
              ok: row.ok === true,
              code: typeof row.code === 'string' ? row.code : undefined,
              address: typeof row.address === 'string' ? row.address : undefined,
              expiresAt: typeof row.expires_at === 'string' ? row.expires_at : undefined,
              retryAfter: typeof row.retry_after === 'string' ? row.retry_after : undefined,
            };
          },
          async markSent(tokenHash, actorUserId) {
            await admin.rpc('reply_to_confirmation_mark_sent', { p_token_hash: tokenHash, p_actor: actorUserId });
          },
          async withdraw(tokenHash) {
            await admin.rpc('reply_to_confirmation_withdraw', { p_token_hash: tokenHash });
          },
          log,
        },
      );
      if (!outcome.ok) return json(outcome, STATUS[outcome.error] ?? 500);
      return json(outcome, 200);
    }

    return json({ ok: false, error: 'invalid_request' }, STATUS.invalid_request);
  } catch (error) {
    log({ outcome: 'server_error', message: error instanceof Error ? error.message.slice(0, 120) : 'unknown' });
    return json({ ok: false, error: 'server_error' }, STATUS.server_error);
  }
});
