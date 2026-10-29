import { getSupabaseClient, getSupabaseUrl } from '../../lib/supabase';
import { errorReference } from '../../i18n';
import { newRequestId, requestDestructiveConfirmation } from './destructiveActionService';

/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.25, E11 a, E20, K1, K2) — Kontolöschung aus Sicht der App.
 *
 * Ablauf: Nachweis mit dem Passwort (1.25a) → Edge Function `delete-account` mit Anfrage-ID, Nachweis und der
 * eingegebenen E-Mail (der Server vergleicht sie normalisiert mit der Anmelde-E-Mail). Die Anfrage-ID bleibt für diese
 * Sitzung erhalten: Eine Wiederholung setzt einen begonnenen eigenen Auftrag fort, ohne neuen Nachweis.
 *
 * Ergebnis „wird abgeschlossen“ (`completing`) heißt: begonnen, Konto gesperrt und ohne Mitgliedschaften; der Rest läuft
 * serverseitig nach. Nie „vollständig gelöscht“ ohne `completed`.
 */
export type AccountDeletionResult =
  | { ok: true; state: 'completed' }
  | { ok: true; state: 'completing' }
  | { ok: false; reason: 'owner'; workspaces: Array<{ id: string; name: string }> }
  | {
      ok: false;
      reason:
        | 'password_invalid'
        | 'rate_limited'
        | 'email_mismatch'
        | 'last_platform_admin'
        | 'account_blocked'
        | 'confirmation_invalid'
        | 'session'
        | 'request_mismatch'
        | 'unavailable';
      /** EINRICHTUNG-01 (AP9; 1.30) — Kurzreferenz bei unbekanntem Code oder Ausnahme. */
      ref?: string;
    };

const REQUEST_KEY = 'officetakt.accountDeletion.requestId';

/** Anfrage-ID je Konto für diese Sitzung (Wiederholung und eigener Wiederanlauf mit derselben ID). */
export function accountDeletionRequestId(userId: string): string {
  const key = `${REQUEST_KEY}:${userId}`;
  try {
    const vorhanden = sessionStorage.getItem(key);
    if (vorhanden && /^[0-9a-f-]{36}$/i.test(vorhanden)) return vorhanden;
    const neu = newRequestId();
    sessionStorage.setItem(key, neu);
    return neu;
  } catch {
    return newRequestId();
  }
}

export function forgetAccountDeletionRequestId(userId: string): void {
  try {
    sessionStorage.removeItem(`${REQUEST_KEY}:${userId}`);
  } catch {
    // nichts zu tun
  }
}

const FAILURES: Record<string, Exclude<AccountDeletionResult, { ok: true } | { reason: 'owner' }>['reason']> = {
  email_mismatch: 'email_mismatch',
  last_platform_admin: 'last_platform_admin',
  account_blocked: 'account_blocked',
  confirmation_invalid: 'confirmation_invalid',
  unauthenticated: 'session',
  session_not_active: 'session',
  deletion_request_mismatch: 'request_mismatch',
};

async function callDeleteAccount(input: { requestId: string; confirmationToken: string | null; email: string }): Promise<AccountDeletionResult> {
  const client = getSupabaseClient();
  const baseUrl = getSupabaseUrl();
  if (!client || !baseUrl) return { ok: false, reason: 'unavailable' };
  try {
    const { data } = await client.auth.getSession();
    const accessToken = data?.session?.access_token;
    if (!accessToken) return { ok: false, reason: 'session' };
    const response = await fetch(`${baseUrl}/functions/v1/delete-account`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; state?: string; completing?: boolean; error?: string; workspaces?: Array<{ workspace_id?: string; name?: string }> }
      | null;
    if (body?.ok === true && body.state === 'completed') return { ok: true, state: 'completed' };
    if (body?.ok === true && body.completing === true) return { ok: true, state: 'completing' };
    if (body?.error === 'account_owner') {
      return {
        ok: false,
        reason: 'owner',
        workspaces: (body.workspaces ?? [])
          .filter((w) => typeof w.workspace_id === 'string')
          .map((w) => ({ id: String(w.workspace_id), name: typeof w.name === 'string' ? w.name : '' })),
      };
    }
    const bekannt = body?.error ? FAILURES[body.error] : undefined;
    if (bekannt) return { ok: false, reason: bekannt };
    return { ok: false, reason: 'unavailable', ref: errorReference(body?.error ?? `http_${response.status}`) };
  } catch (thrown) {
    return { ok: false, reason: 'unavailable', ref: errorReference(thrown) };
  }
}

/** Konto löschen: Nachweis über das Passwort, dann der Auftrag. */
export async function deleteOwnAccount(input: { userId: string; email: string; password: string }): Promise<AccountDeletionResult> {
  const requestId = accountDeletionRequestId(input.userId);
  const nachweis = await requestDestructiveConfirmation({ action: 'account_delete', workspaceId: null, requestId, password: input.password });
  if (!nachweis.ok) {
    if (nachweis.reason === 'password_invalid') return { ok: false, reason: 'password_invalid' };
    if (nachweis.reason === 'rate_limited') return { ok: false, reason: 'rate_limited' };
    if (nachweis.reason === 'account_blocked') return { ok: false, reason: 'account_blocked' };
    if (nachweis.reason === 'session') return { ok: false, reason: 'session' };
    return { ok: false, reason: 'unavailable', ...(nachweis.ref ? { ref: nachweis.ref } : {}) };
  }
  return callDeleteAccount({ requestId, confirmationToken: nachweis.confirmationToken, email: input.email });
}

/** Einen begonnenen eigenen Auftrag fortsetzen (dieselbe Anfrage-ID, ohne neuen Nachweis). */
export function resumeOwnAccountDeletion(userId: string): Promise<AccountDeletionResult> {
  return callDeleteAccount({ requestId: accountDeletionRequestId(userId), confirmationToken: null, email: '' });
}
