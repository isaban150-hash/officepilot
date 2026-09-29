/**
 * E-MAIL 07F-01B — Edge Function `email-provider-webhook`: Zustellereignisse
 * des E-Mail-Dienstes (heute Brevo) für freie E-Mail und Dokumentversand.
 *
 * Aufruf: POST /functions/v1/email-provider-webhook?provider=brevo
 * verify_jwt = false (Brevo sendet kein Supabase-JWT); abgesichert durch das
 * Bearer-Token der Brevo-Webhook-Konfiguration, geprüft gegen das
 * Function-Secret BREVO_WEBHOOK_TOKEN (fehlt es → alles abgelehnt).
 *
 * Nur die Datenbank (record_email_provider_event, service_role) entscheidet
 * über Deduplizierung, Zuordnung (ausschließlich Message-ID) und Rang. Kein
 * Versand, kein Neuversuch, keine neue Nachricht. Logs: nur Zähler.
 * Antwort 200 auch bei nicht zuordenbaren Ereignissen (sonst wiederholt der
 * Dienst endlos); 401/400/413 bei Authentisierungs- oder Formatfehlern.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { PROVIDER_WEBHOOK_MAX_BYTES, processBrevoWebhook, verifyBearerToken, type NormalizedProviderEvent } from '../_shared/providerEventCore.ts';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function log(entry: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ scope: 'email-provider-webhook', ...entry }));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') return json({ ok: false, error: 'invalid_request' }, 405);
  const provider = new URL(request.url).searchParams.get('provider');
  if (provider !== 'brevo') return json({ ok: false, error: 'unknown_provider' }, 404);

  const auth = verifyBearerToken(request.headers.get('Authorization'), Deno.env.get('BREVO_WEBHOOK_TOKEN'));
  if (auth !== 'ok') {
    log({ outcome: auth });
    return json({ ok: false, error: 'unauthenticated' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    log({ outcome: 'server_misconfigured' });
    return json({ ok: false, error: 'server_misconfigured' }, 500);
  }

  const length = Number(request.headers.get('Content-Length') ?? '0');
  if (length > PROVIDER_WEBHOOK_MAX_BYTES) return json({ ok: false, error: 'too_large' }, 413);
  const text = await request.text();
  if (text.length > PROVIDER_WEBHOOK_MAX_BYTES) return json({ ok: false, error: 'too_large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, error: 'invalid_payload' }, 400);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await processBrevoWebhook(body, {
    sha256Hex,
    async record(event: NormalizedProviderEvent) {
      const { data, error } = await admin.rpc('record_email_provider_event', {
        p_provider: event.provider,
        p_dedupe_key: event.dedupeKey,
        p_provider_message_id: event.providerMessageId,
        p_event_type: event.eventType,
        p_normalized_state: event.state,
        p_reason: event.reason,
        p_event_at: event.eventAt,
      });
      if (error) throw new Error('record_failed');
      return (data as { outcome: 'applied' | 'ignored_older' | 'duplicate' | 'unmatched' | 'ambiguous' }).outcome;
    },
  });
  if (!result.ok) {
    log({ outcome: result.error });
    return json({ ok: false, error: result.error }, 400);
  }
  log({ outcome: 'processed', ...result.summary });
  // Einzelne Datenbankfehler: 500, damit der Dienst später erneut zustellt (Deduplizierung verhindert Doppelanwendung).
  return json({ ok: result.summary.failed === 0, ...result.summary }, result.summary.failed === 0 ? 200 : 500);
});
