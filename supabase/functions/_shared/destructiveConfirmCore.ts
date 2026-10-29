/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.25a, K1) — Bestätigungsnachweis für zerstörende Aktionen, Entscheidungen ohne
 * Deno-APIs (Vitest prüft sie).
 *
 * Ablauf: Eingabe prüfen → Vorprüfung mit dem Token der Person (angemeldet, Sitzung besteht, nicht gesperrt; liefert die
 * Anmelde-E-Mail AUS DER DATENBANK, nie aus der Anfrage; Versuchslimit 5 je 15 Minuten, danach ohne Passwortprüfung
 * abgewiesen) → Passwort über Supabase Auth gegen diese E-Mail prüfen → die dabei entstandene Sitzung sofort widerrufen
 * (Sitzungszahl davor = danach) → 256-Bit-Token erzeugen, nur den SHA-256 beim Server ausstellen (5 Minuten, einmal,
 * gebunden an Konto, Aktion, Ziel, Anfrage-ID) → Token nur in der Antwort an die Person.
 *
 * Das Passwort steht nie in einem Protokoll, einer Antwort, einer Fehlermeldung oder der Datenbank.
 */
export type DestructiveAction = 'account_delete' | 'workspace_delete_request';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** 32 Byte als base64url ohne Auffüllung: 43 Zeichen. */
export const CONFIRMATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type DestructiveConfirmOutcome =
  | { ok: true; confirmationToken: string; expiresAt: string }
  | {
      ok: false;
      error:
        | 'invalid_request'
        | 'unauthenticated'
        | 'session_not_active'
        | 'account_blocked'
        | 'confirmation_rate_limited'
        | 'password_invalid'
        | 'auth_unavailable'
        | 'server_error';
    };

export type PrecheckResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; code: 'unauthenticated' | 'session_not_active' | 'account_blocked' | 'confirmation_rate_limited' | 'invalid_request' | 'server_error' };

export type SignInResult = { ok: true; accessToken: string } | { ok: false; reason: 'invalid_credentials' | 'rate_limited' | 'unavailable' };

export interface DestructiveConfirmDeps {
  precheck(action: DestructiveAction, workspaceId: string | null): Promise<PrecheckResult>;
  signInWithPassword(email: string, password: string): Promise<SignInResult>;
  revokeSession(accessToken: string): Promise<boolean>;
  recordFailure(userId: string): Promise<void>;
  randomToken(): string;
  sha256Hex(value: string): Promise<string>;
  issue(input: { userId: string; action: DestructiveAction; workspaceId: string | null; requestId: string; tokenHash: string }): Promise<{ ok: boolean; code?: string; expiresAt?: string }>;
  log(entry: Record<string, string | number | boolean | null>): void;
}

export async function runDestructiveConfirm(
  input: { action: unknown; workspaceId: unknown; requestId: unknown; password: unknown },
  deps: DestructiveConfirmDeps,
): Promise<DestructiveConfirmOutcome> {
  const action = input.action === 'account_delete' || input.action === 'workspace_delete_request' ? input.action : null;
  const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
  const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId.trim() ? input.workspaceId.trim() : null;
  const password = typeof input.password === 'string' ? input.password : '';
  if (
    !action ||
    !UUID.test(requestId) ||
    (action === 'account_delete' ? workspaceId !== null : !workspaceId || !UUID.test(workspaceId)) ||
    password.length === 0 ||
    password.length > 256
  ) {
    return { ok: false, error: 'invalid_request' };
  }

  const pre = await deps.precheck(action, workspaceId);
  if (!pre.ok) {
    deps.log({ outcome: pre.code });
    return { ok: false, error: pre.code === 'invalid_request' ? 'invalid_request' : pre.code };
  }

  const signIn = await deps.signInWithPassword(pre.email, password);
  if (!signIn.ok) {
    if (signIn.reason === 'invalid_credentials') {
      await deps.recordFailure(pre.userId);
      deps.log({ outcome: 'password_invalid' });
      return { ok: false, error: 'password_invalid' };
    }
    deps.log({ outcome: signIn.reason === 'rate_limited' ? 'auth_rate_limited' : 'auth_unavailable' });
    return { ok: false, error: signIn.reason === 'rate_limited' ? 'confirmation_rate_limited' : 'auth_unavailable' };
  }
  // Die Prüfsitzung lebt nicht weiter: ohne Widerruf kein Nachweis.
  if (!(await deps.revokeSession(signIn.accessToken))) {
    deps.log({ outcome: 'session_revoke_failed' });
    return { ok: false, error: 'server_error' };
  }

  const token = deps.randomToken();
  if (!CONFIRMATION_TOKEN_PATTERN.test(token)) return { ok: false, error: 'server_error' };
  const issued = await deps.issue({ userId: pre.userId, action, workspaceId, requestId, tokenHash: await deps.sha256Hex(token) });
  if (!issued.ok || !issued.expiresAt) {
    deps.log({ outcome: issued.code ?? 'issue_failed' });
    return { ok: false, error: issued.code === 'account_blocked' ? 'account_blocked' : 'server_error' };
  }
  deps.log({ outcome: 'issued', action });
  return { ok: true, confirmationToken: token, expiresAt: issued.expiresAt };
}

/** Fehlertext des Servers (Vorprüfung) → Code; nie der Rohtext in der Antwort. */
export function precheckErrorCode(message: string | null | undefined): Exclude<PrecheckResult, { ok: true }>['code'] {
  const text = message ?? '';
  if (/session_not_active/.test(text)) return 'session_not_active';
  if (/account_blocked/.test(text)) return 'account_blocked';
  if (/Nicht angemeldet|profile_missing|JWT|jwt/.test(text)) return 'unauthenticated';
  return 'server_error';
}
