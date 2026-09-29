/**
 * E-MAIL-07E-MSA / 07E-PF — Edge Function `mailbox-oauth-callback` (Redirect-URI,
 * providerneutral; eine URL für alle OAuth-Anbieter).
 *
 * Der Anbieter leitet den Browser nach der Anmeldung hierher (GET, ohne
 * Supabase-JWT; daher verify_jwt = false). Sicherheit kommt aus dem `state`:
 * serverseitig gespeichert (nur SHA-256), genau einmal verwendbar, mit
 * Ablaufzeit und an Workspace + Nutzer + Anbieter gebunden. Der Anbieter wird
 * AUSSCHLIESSLICH aus dem gespeicherten Zustand bestimmt, nie aus der URL.
 *
 * Ablauf (`runMailboxOAuthCallback`): State einmalig verbrauchen → Anbieter
 * aus dem Zustand → Fehler/Code prüfen → Code serverseitig mit PKCE-Verifier
 * tauschen → Rechte prüfen → ID-Token prüfen (Aussteller, Empfänger, Ablauf,
 * Nonce, Adresse, Kontokennung) → Zugang im Vault speichern und Verbindung
 * anlegen bzw. bei abweichendem Konto nur eine Bestätigung vormerken →
 * Rückleitung in die App.
 *
 * Die Rückleitung enthält nie Code, Token oder Adresse; Logs ebenso nicht.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { exchangeAuthorizationCode, readMailboxAppUrl, runMailboxOAuthCallback, type ConsumedOAuthState } from '../_shared/oauth/mailboxOAuth.ts';
import { resolveMailboxOAuthBinding } from '../_shared/oauth/providers.ts';

function log(entry: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ scope: 'mailbox-oauth-callback', ...entry }));
}

function redirect(location: string): Response {
  // Referrer nicht weitergeben (Query enthielt den Code).
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

function plain(text: string, status: number): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'GET') return plain('Methode nicht erlaubt.', 405);
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const appUrl = readMailboxAppUrl((name) => Deno.env.get(name));
  if (!supabaseUrl || !serviceRoleKey || !appUrl) {
    log({ outcome: 'server_misconfigured' });
    return plain('Die Postfach-Anbindung ist auf dem Server noch nicht eingerichtet.', 503);
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const query = new URL(request.url).searchParams;

  const result = await runMailboxOAuthCallback(query, {
    appUrl,
    resolve(providerType) {
      const resolved = resolveMailboxOAuthBinding(providerType, (name) => Deno.env.get(name));
      return resolved.ok ? resolved.binding : null;
    },
    async consumeState(stateHash) {
      const { data, error } = await admin.rpc('consume_workspace_mailbox_oauth_state', { p_state_hash: stateHash });
      if (error) throw new Error('consume_failed');
      const envelope = data as { ok: boolean; reason?: 'unknown' | 'consumed' | 'expired'; state?: ConsumedOAuthState };
      return envelope.ok && envelope.state ? { ok: true, state: envelope.state } : { ok: false, reason: envelope.reason ?? 'unknown' };
    },
    exchange: (binding, code, codeVerifier) => exchangeAuthorizationCode({ ...binding, code, codeVerifier }),
    async complete(stateId, identity, credential) {
      const { data, error } = await admin.rpc('complete_workspace_mailbox_oauth', {
        p_state_id: stateId,
        p_detected_address: identity.address,
        p_detected_subject: identity.subject,
        p_credential: credential,
      });
      if (error) throw new Error('complete_failed');
      const envelope = data as { outcome: 'connected' | 'confirm_required' };
      return { outcome: envelope.outcome, stateId };
    },
    async fail(stateId) {
      await admin.rpc('fail_workspace_mailbox_oauth', { p_state_id: stateId });
    },
    log,
  });
  return redirect(result.redirectTo);
});
