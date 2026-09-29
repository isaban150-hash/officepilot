/**
 * E-MAIL-07D — Edge Function `send-email` (freie Geschäfts-E-Mail).
 *
 * Auth → Schreibrecht → Nachricht laden (workspace_id + client_message_id) →
 * Zustand → Empfänger + Testempfänger-Schutz (An, Cc, Bcc) → Anhänge aus dem
 * privaten Bucket laden und prüfen → Claim → Provider → Ergebnis autoritativ
 * speichern. Entscheidungen trifft `runSendEmail` (_shared/sendEmailCore.ts).
 *
 * Dieselbe Serverkonfiguration wie `send-document`: MAIL_PROVIDER,
 * MAIL_SENDER_EMAIL, BREVO_API_KEY, optional MAIL_TEST_RECIPIENT_ALLOWLIST.
 * Secrets nur aus Deno.env; nie geloggt, nie zurückgegeben. Logs enthalten
 * nie Adressen, Betreff, Text oder Dateinamen.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createMailProvider, resolveMailProviderName } from '../_shared/emailProvider.ts';
import { EMAIL_ATTACHMENT_BUCKET } from '../_shared/emailMessageRules.ts';
import { resolveConfiguredSenderEmail, resolveTestRecipientAllowlist } from '../_shared/sendDocumentCore.ts';
import { runSendEmail, type EmailMessageRow, type SendEmailErrorCode } from '../_shared/sendEmailCore.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const HTTP_STATUS: Record<SendEmailErrorCode | 'invalid_request' | 'server_misconfigured' | 'server_error', number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  message_not_found: 404,
  provider_mismatch: 409,
  invalid_state: 409,
  server_misconfigured: 500,
  server_error: 500,
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

function fail(error: keyof typeof HTTP_STATUS): Response {
  return json({ ok: false, error }, HTTP_STATUS[error]);
}

function log(entry: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ scope: 'send-email', ...entry }));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (request.method !== 'POST') return fail('invalid_request');

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const providerName = resolveMailProviderName(Deno.env.get('MAIL_PROVIDER'));
  const senderEmail = resolveConfiguredSenderEmail(Deno.env.get('MAIL_SENDER_EMAIL'));
  if (!supabaseUrl || !serviceRoleKey || !providerName || !senderEmail) {
    log({ outcome: 'server_misconfigured', providerConfigured: Boolean(providerName), senderConfigured: Boolean(senderEmail) });
    return fail('server_misconfigured');
  }

  let body: { workspaceId?: unknown; clientMessageId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail('invalid_request');
  }
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  const clientMessageId = typeof body.clientMessageId === 'string' ? body.clientMessageId.trim() : '';
  if (!/^[0-9a-fA-F-]{36}$/.test(workspaceId) || !clientMessageId || clientMessageId.length > 128) {
    return fail('invalid_request');
  }

  const authorization = request.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) return fail('unauthenticated');

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await admin.auth.getUser(authorization.slice('bearer '.length).trim());
  const userId = userData?.user?.id ?? null;
  if (userError || !userId) return fail('unauthenticated');

  const provider = createMailProvider({ provider: providerName, brevoApiKey: Deno.env.get('BREVO_API_KEY') });
  const testRecipientAllowlist = resolveTestRecipientAllowlist(Deno.env.get('MAIL_TEST_RECIPIENT_ALLOWLIST'));

  try {
    const outcome = await runSendEmail(
      { userId, workspaceId, clientMessageId },
      {
        senderEmail,
        testRecipientAllowlist,
        async userCanWrite(ws, user) {
          const { data, error } = await admin.rpc('workspace_user_can_write', { p_workspace_id: ws, p_user_id: user });
          if (error) throw new Error(`can_write: ${error.message}`);
          return data === true;
        },
        async loadMessage(ws, id) {
          const { data, error } = await admin.rpc('get_workspace_email_message_for_send', { p_workspace_id: ws, p_client_message_id: id });
          if (error) throw new Error(`load: ${error.message}`);
          if (!data || typeof data !== 'object') return null;
          return data as EmailMessageRow;
        },
        async downloadAttachment(path) {
          const { data, error } = await admin.storage.from(EMAIL_ATTACHMENT_BUCKET).download(path);
          if (error || !data) return null;
          return new Uint8Array(await data.arrayBuffer());
        },
        sha256Hex,
        provider,
        async claim(messageId, expectedRowVersion) {
          const { data, error } = await admin.rpc('claim_workspace_email_message_for_send', {
            p_message_id: messageId,
            p_expected_row_version: expectedRowVersion,
          });
          if (error) throw new Error(`claim: ${error.message}`);
          const envelope = data as { claimed: boolean; message: EmailMessageRow };
          return { claimed: envelope.claimed === true, message: envelope.message };
        },
        async resolveStaleClaim(messageId, staleAfterSeconds) {
          const { data, error } = await admin.rpc('resolve_stale_workspace_email_message_claim', {
            p_message_id: messageId,
            p_stale_after_seconds: staleAfterSeconds,
          });
          if (error) throw new Error(`stale_claim: ${error.message}`);
          const envelope = data as { resolved: boolean; message: EmailMessageRow };
          return { resolved: envelope.resolved === true, message: envelope.message };
        },
        async markAccepted(messageId, providerMessageId, expectedRowVersion) {
          const { data, error } = await admin.rpc('update_workspace_email_message_status', {
            p_message_id: messageId,
            p_status: 'provider_accepted',
            p_provider_message_id: providerMessageId,
            p_error_category: null,
            p_error_code: null,
            p_error_message_safe: null,
            p_expected_row_version: expectedRowVersion,
          });
          if (error) throw new Error(`accept: ${error.message}`);
          return data as EmailMessageRow;
        },
        async markStatus(messageId, status, errorInfo, expectedRowVersion) {
          const { data, error } = await admin.rpc('update_workspace_email_message_status', {
            p_message_id: messageId,
            p_status: status,
            p_provider_message_id: null,
            p_error_category: errorInfo.category,
            p_error_code: errorInfo.code,
            p_error_message_safe: errorInfo.message,
            p_expected_row_version: expectedRowVersion,
          });
          if (error) throw new Error(`status: ${error.message}`);
          return data as EmailMessageRow;
        },
        log: (entry) => log({ ...entry, testRecipientGuard: testRecipientAllowlist.mode }),
      },
    );
    if (!outcome.ok) return fail(outcome.error);
    return json(outcome, 200);
  } catch (error) {
    log({ outcome: 'server_error', workspaceId, message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    return fail('server_error');
  }
});
