import { getSupabaseAnonKey, getSupabaseClient, getSupabaseUrl } from '../../lib/supabase';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';

/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.22 E-03, E18, K4) — Bestätigung der Antwortadresse aus Sicht der App.
 *
 * - Stand (`get_workspace_reply_to_status`, Inhaber und Admins): Adresse, bestätigt oder nicht, letzte Bestätigungsmail,
 *   frühester neuer Versand und welche Adresse ein Versand gerade nutzt (maskiert).
 * - Bestätigungsmail anfordern (Edge Function `confirm-reply-to`, „request“): Den Link baut der Server aus der geprüften
 *   Adresse der App; das Token erfährt die App nie.
 * - Bestätigen (Seite `/antwortadresse-bestaetigen`, „confirm“): nur ein ausdrückliches POST, ohne Anmeldung. Ein
 *   bloßer Seitenaufruf bestätigt nichts.
 *
 * Ohne Cloud gibt es nichts zu bestätigen (`null`). Fehler werden nie roh angezeigt.
 */
export interface ReplyToStatus {
  address: string | null;
  confirmed: boolean;
  pending: boolean;
  lastSentAt: string | null;
  canResendAt: string | null;
  sendsToday: number;
  effectiveSource: 'confirmed_reply_to' | 'owner_login' | null;
  effectiveMasked: string | null;
  unavailable: boolean;
}

function workspaceId(): string {
  try {
    return resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
  } catch {
    return '';
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export async function loadReplyToStatus(): Promise<ReplyToStatus | null> {
  const client = getSupabaseClient();
  const ws = workspaceId();
  if (!client || !ws) return null;
  try {
    const { data, error } = await client.rpc('get_workspace_reply_to_status', { p_workspace_id: ws });
    if (error || !data || typeof data !== 'object') return null;
    const row = data as Record<string, unknown>;
    return {
      address: text(row.address),
      confirmed: row.confirmed === true,
      pending: row.pending === true,
      lastSentAt: text(row.last_sent_at),
      canResendAt: text(row.can_resend_at),
      sendsToday: typeof row.sends_today === 'number' ? row.sends_today : 0,
      effectiveSource: row.effective_source === 'confirmed_reply_to' || row.effective_source === 'owner_login' ? row.effective_source : null,
      effectiveMasked: text(row.effective_masked),
      unavailable: row.unavailable === true,
    };
  } catch {
    return null;
  }
}

export type ReplyToRequestResult =
  | 'sent'
  | 'not_sent'
  | 'too_early'
  | 'limit'
  | 'already_confirmed'
  | 'not_synced'
  | 'missing'
  | 'forbidden'
  | 'unavailable';

const REQUEST_RESULTS: Record<string, ReplyToRequestResult> = {
  resend_too_early: 'too_early',
  resend_limit: 'limit',
  already_confirmed: 'already_confirmed',
  address_mismatch: 'not_synced',
  reply_to_missing: 'missing',
  forbidden: 'forbidden',
  unauthenticated: 'forbidden',
};

export async function requestReplyToConfirmation(
  address: string,
  language: string,
): Promise<{ result: ReplyToRequestResult; retryAfter?: string }> {
  const client = getSupabaseClient();
  const baseUrl = getSupabaseUrl();
  const ws = workspaceId();
  if (!client || !baseUrl || !ws) return { result: 'unavailable' };
  try {
    const { data } = await client.auth.getSession();
    const accessToken = data?.session?.access_token;
    if (!accessToken) return { result: 'forbidden' };
    const response = await fetch(`${baseUrl}/functions/v1/confirm-reply-to`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'request',
        workspaceId: ws,
        address: address.trim().toLowerCase(),
        language,
        linkBase: typeof window === 'undefined' ? '' : window.location.origin,
      }),
    });
    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; sent?: boolean; error?: string; retryAfter?: string }
      | null;
    if (response.ok && body?.ok === true) return { result: body.sent === true ? 'sent' : 'not_sent' };
    const mapped = body?.error ? REQUEST_RESULTS[body.error] : undefined;
    return { result: mapped ?? 'unavailable', ...(body?.retryAfter ? { retryAfter: body.retryAfter } : {}) };
  } catch {
    return { result: 'unavailable' };
  }
}

export type ReplyToConfirmResult =
  | { ok: true; status: 'confirmed' | 'already_confirmed'; address: string | null }
  | { ok: false; reason: 'invalid' | 'rate_limited' | 'unavailable' };

/** Ohne Anmeldung: der öffentliche anon key genügt dem Gateway; der Server prüft allein das Token. */
export async function confirmReplyToToken(token: string): Promise<ReplyToConfirmResult> {
  const baseUrl = getSupabaseUrl();
  const anonKey = getSupabaseAnonKey();
  if (!baseUrl || !anonKey) return { ok: false, reason: 'unavailable' };
  try {
    const response = await fetch(`${baseUrl}/functions/v1/confirm-reply-to`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${anonKey}`, apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'confirm', token }),
    });
    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; status?: string; address?: string | null; error?: string }
      | null;
    if (response.ok && body?.ok === true && (body.status === 'confirmed' || body.status === 'already_confirmed')) {
      return { ok: true, status: body.status, address: typeof body.address === 'string' ? body.address : null };
    }
    if (body?.error === 'rate_limited') return { ok: false, reason: 'rate_limited' };
    if (body?.error === 'invalid') return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'unavailable' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Das Token steht im Fragment des Links (`#token=…`); nur dieses Format wird angenommen. */
export function readReplyToTokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = (params.get('token') ?? '').trim();
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
