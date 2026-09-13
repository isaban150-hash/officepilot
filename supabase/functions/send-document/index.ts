/**
 * EMAIL-01B2 — Edge Function `send-document`.
 *
 * Serverseitige Versandkette: Auth → Delivery laden (workspace_id +
 * client_delivery_id) → Schreibrecht → Zustand → Anhang aus dem privaten
 * Bucket laden und prüfen → Provider (Serverkonfiguration) → Ergebnis
 * autoritativ persistieren → bei provider_accepted atomare Rechnungs-Kopplung.
 *
 * Der Browser setzt nie provider_message_id, provider_accepted, failed,
 * sent_source oder sent_delivery_id — diese Fakten entstehen nur hier über
 * service_role und die dafür freigegebenen RPCs.
 *
 * Secrets: BREVO_API_KEY nur aus Deno.env; nie geloggt, nie zurückgegeben.
 * MAIL_PROVIDER muss explizit `stub` oder `brevo` sein (fail-closed).
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createMailProvider, resolveMailProviderName } from '../_shared/emailProvider.ts';
import { runSendDocument, type DeliveryRow, type InvoiceContext, type SendDocumentErrorCode } from '../_shared/sendDocumentCore.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const HTTP_STATUS: Record<SendDocumentErrorCode | 'invalid_request' | 'server_misconfigured' | 'server_error', number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  delivery_not_found: 404,
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
  // Nur Kennungen, Provider, Status, sichere Fehlerkategorie — nie Inhalte, Keys oder Empfänger.
  console.log(JSON.stringify({ scope: 'send-document', ...entry }));
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
  if (!supabaseUrl || !serviceRoleKey || !providerName) {
    log({ outcome: 'server_misconfigured', providerConfigured: Boolean(providerName) });
    return fail('server_misconfigured');
  }

  let body: { workspaceId?: unknown; clientDeliveryId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail('invalid_request');
  }
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  const clientDeliveryId = typeof body.clientDeliveryId === 'string' ? body.clientDeliveryId.trim() : '';
  if (!/^[0-9a-fA-F-]{36}$/.test(workspaceId) || !clientDeliveryId || clientDeliveryId.length > 128) {
    return fail('invalid_request');
  }

  const authorization = request.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) return fail('unauthenticated');

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await admin.auth.getUser(authorization.slice('bearer '.length).trim());
  const userId = userData?.user?.id ?? null;
  if (userError || !userId) return fail('unauthenticated');

  const provider = createMailProvider({ provider: providerName, brevoApiKey: Deno.env.get('BREVO_API_KEY') });

  try {
    const outcome = await runSendDocument(
      { userId, workspaceId, clientDeliveryId },
      {
        async userCanWrite(ws, user) {
          const { data, error } = await admin.rpc('workspace_user_can_write', { p_workspace_id: ws, p_user_id: user });
          if (error) throw new Error(`can_write: ${error.message}`);
          return data === true;
        },
        async loadDelivery(ws, id) {
          const { data, error } = await admin.rpc('get_workspace_document_delivery_for_send', { p_workspace_id: ws, p_client_delivery_id: id });
          if (error) throw new Error(`load: ${error.message}`);
          if (!data || typeof data !== 'object') return null;
          const envelope = data as { delivery?: DeliveryRow; invoice?: InvoiceContext | null };
          if (!envelope.delivery) return null;
          return { delivery: envelope.delivery, invoice: envelope.invoice ?? null };
        },
        async downloadAttachment(path) {
          const { data, error } = await admin.storage.from('document-deliveries').download(path);
          if (error || !data) return null;
          return new Uint8Array(await data.arrayBuffer());
        },
        sha256Hex,
        provider,
        async markAccepted(deliveryId, providerMessageId, expectedRowVersion) {
          const { data, error } = await admin.rpc('mark_workspace_document_delivery_accepted', {
            p_delivery_id: deliveryId,
            p_provider_message_id: providerMessageId,
            p_expected_row_version: expectedRowVersion,
          });
          if (error) throw new Error(`accept: ${error.message}`);
          const envelope = data as { delivery: DeliveryRow; coupling: string };
          return { delivery: envelope.delivery, coupling: envelope.coupling };
        },
        async markStatus(deliveryId, status, errorInfo, expectedRowVersion) {
          const { data, error } = await admin.rpc('update_workspace_document_delivery_status', {
            p_delivery_id: deliveryId,
            p_status: status,
            p_provider_message_id: null,
            p_error_category: errorInfo.category,
            p_error_code: errorInfo.code,
            p_error_message_safe: errorInfo.message,
            p_expected_row_version: expectedRowVersion,
          });
          if (error) throw new Error(`status: ${error.message}`);
          return data as DeliveryRow;
        },
        log,
      },
    );
    if (!outcome.ok) return fail(outcome.error);
    return json(outcome, 200);
  } catch (error) {
    // Kein Rohfehler nach aussen; intern nur die Kategorie.
    log({ outcome: 'server_error', workspaceId, message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    return fail('server_error');
  }
});
