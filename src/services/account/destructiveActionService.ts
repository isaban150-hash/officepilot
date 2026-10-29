import { getSupabaseClient, getSupabaseUrl } from '../../lib/supabase';
import { errorReference } from '../../i18n';

/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.25a, K1) — Bestätigungsnachweis für Konto- und Betriebslöschung aus Sicht der App.
 *
 * Das Passwort geht ausschließlich per TLS an die Edge Function `confirm-destructive-action`; sie prüft es serverseitig
 * gegen die Anmelde-E-Mail aus der Datenbank, widerruft die Prüfsitzung und stellt einen Nachweis aus (5 Minuten, einmal,
 * gebunden an Konto, Aktion, Ziel und Anfrage-ID). Die App speichert weder Passwort noch Nachweis dauerhaft.
 */
export type DestructiveAction = 'account_delete' | 'workspace_delete_request';

export type DestructiveConfirmResult =
  | { ok: true; confirmationToken: string; expiresAt: string }
  // EINRICHTUNG-01 (AP9; 1.30, Q-01.2) — `ref` bei unbekanntem Code oder Ausnahme (nie der Rohtext).
  | { ok: false; reason: 'password_invalid' | 'rate_limited' | 'account_blocked' | 'session' | 'unavailable' | 'invalid'; ref?: string };

const REASONS: Record<string, Extract<DestructiveConfirmResult, { ok: false }>['reason']> = {
  password_invalid: 'password_invalid',
  confirmation_rate_limited: 'rate_limited',
  account_blocked: 'account_blocked',
  unauthenticated: 'session',
  session_not_active: 'session',
  invalid_request: 'invalid',
};

export async function requestDestructiveConfirmation(input: {
  action: DestructiveAction;
  workspaceId: string | null;
  requestId: string;
  password: string;
}): Promise<DestructiveConfirmResult> {
  const client = getSupabaseClient();
  const baseUrl = getSupabaseUrl();
  if (!client || !baseUrl) return { ok: false, reason: 'unavailable' };
  try {
    const { data } = await client.auth.getSession();
    const accessToken = data?.session?.access_token;
    if (!accessToken) return { ok: false, reason: 'session' };
    const response = await fetch(`${baseUrl}/functions/v1/confirm-destructive-action`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: input.action, workspaceId: input.workspaceId, requestId: input.requestId, password: input.password }),
    });
    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; confirmationToken?: string; expiresAt?: string; error?: string }
      | null;
    if (response.ok && body?.ok === true && typeof body.confirmationToken === 'string' && typeof body.expiresAt === 'string') {
      return { ok: true, confirmationToken: body.confirmationToken, expiresAt: body.expiresAt };
    }
    const bekannt = body?.error ? REASONS[body.error] : undefined;
    if (bekannt) return { ok: false, reason: bekannt };
    return { ok: false, reason: 'unavailable', ref: errorReference(body?.error ?? `http_${response.status}`) };
  } catch (thrown) {
    return { ok: false, reason: 'unavailable', ref: errorReference(thrown) };
  }
}

/**
 * Neue Anfrage-ID (UUID v4); dieselbe ID wiederholt eine begonnene Aktion idempotent. Ohne `crypto.randomUUID` (HTTP im
 * lokalen Netz) aus `getRandomValues` — nie aus Math.random.
 */
export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
