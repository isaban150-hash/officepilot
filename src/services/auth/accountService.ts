import { createIsolatedAuthClient, getSupabaseClient } from '../../lib/supabase';
import { buildAuthRedirectUrl } from './supabaseAuthService';
import type { WorkspaceRole } from '../../types/workspace';

/**
 * EINRICHTUNG-01 (AP3; K-02, K-03, K-05) — das eigene Konto: E-Mail und Passwort über Supabase Auth, Mitgliedschaften
 * über `list_own_memberships`. Fehler werden über Code und Status eingeordnet, nie über den Wortlaut; Passwörter
 * erscheinen in keiner Meldung und keinem Protokoll (K-03.5).
 */
type AuthErrorLike = { name?: string; code?: string; status?: number; message?: string } | null | undefined;

function isNetwork(error: AuthErrorLike): boolean {
  return error?.name === 'AuthRetryableFetchError' || error?.status === 0;
}

function isRateLimit(error: AuthErrorLike): boolean {
  return error?.status === 429 || error?.code === 'over_request_rate_limit' || error?.code === 'over_email_send_rate_limit';
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export type EmailChangeResult = 'sent' | 'invalid_email' | 'same_email' | 'rate_limited' | 'network' | 'failed';

/**
 * K-02 — einen E-Mail-Wechsel anfordern. Bis beide Bestätigungslinks benutzt sind, gilt die alte Adresse in
 * `auth.users` und `profiles` (doppelte Bestätigung; der Server-Trigger gleicht danach `profiles.email` ab).
 */
export async function requestEmailChange(currentEmail: string, newEmail: string): Promise<EmailChangeResult> {
  if (!isValidEmail(newEmail)) return 'invalid_email';
  if (newEmail.trim().toLowerCase() === currentEmail.trim().toLowerCase()) return 'same_email';
  const client = getSupabaseClient();
  if (!client) return 'failed';
  try {
    const redirect = buildAuthRedirectUrl('/login');
    const { error } = await client.auth.updateUser(
      { email: newEmail.trim().toLowerCase() },
      redirect ? { emailRedirectTo: redirect } : undefined,
    );
    if (!error) return 'sent';
    if (isNetwork(error)) return 'network';
    if (isRateLimit(error)) return 'rate_limited';
    if (error.code === 'email_address_invalid') return 'invalid_email';
    // Eine schon vergebene Adresse wird nicht verraten (wie bei der Registrierung).
    if (error.code === 'email_exists' || error.code === 'user_already_exists') return 'sent';
    return 'failed';
  } catch (thrown) {
    return thrown instanceof TypeError || isNetwork(thrown as AuthErrorLike) ? 'network' : 'failed';
  }
}

export type PasswordChangeResult =
  | 'ok'
  | 'wrong_current'
  | 'weak_password'
  | 'same_password'
  | 'account_mismatch'
  | 'rate_limited'
  | 'network'
  | 'failed';

export const MIN_NEW_PASSWORD_LENGTH = 8;

/**
 * K-03 — Passwort ändern. Zuerst wird das aktuelle Passwort beim Server bestätigt, dann das neue gesetzt, danach
 * werden alle anderen Sitzungen abgemeldet (`scope: 'others'`, K-03.4); diese Sitzung bleibt. Mit falschem aktuellem
 * Passwort ändert sich nichts (K-03.1).
 *
 * K-03.3 — die Bestätigung läuft über einen eigenen Prüf-Client (`createIsolatedAuthClient`), nicht über die Anmeldung
 * dieses Geräts: Eine Anmeldung im Haupt-Client hätte dessen Sitzung ersetzt (neue Sitzung, Ereignis `SIGNED_IN` in
 * allen Tabs). So bleibt die Sitzung dieselbe, und es gibt weder Konto- noch Bestandswechsel noch einen Bootstrap.
 * Die Nutzer-ID der Prüfung muss die eigene sein; die Prüfsitzung wird sofort beim Server beendet.
 */
export async function changePassword(input: {
  userId: string;
  email: string;
  currentPassword: string;
  newPassword: string;
}): Promise<PasswordChangeResult> {
  if (input.newPassword.length < MIN_NEW_PASSWORD_LENGTH) return 'weak_password';
  if (input.newPassword === input.currentPassword) return 'same_password';
  const client = getSupabaseClient();
  const verifier = createIsolatedAuthClient();
  if (!client || !verifier) return 'failed';
  try {
    const { data, error } = await verifier.auth.signInWithPassword({
      email: input.email.trim(),
      password: input.currentPassword,
    });
    if (error || !data?.session) {
      if (isNetwork(error)) return 'network';
      if (isRateLimit(error)) return 'rate_limited';
      return 'wrong_current';
    }
    const sameAccount = data.session.user.id === input.userId;
    // Die Prüfsitzung hat ihren Zweck erfüllt; scheitert das Beenden, beendet `others` sie unten mit.
    try {
      await verifier.auth.signOut({ scope: 'local' });
    } catch {
      // siehe oben
    }
    if (!sameAccount) {
      // Darf nie vorkommen (die E-Mail stammt aus dem eigenen Profil); fail-closed ohne Änderung.
      return 'account_mismatch';
    }
    const { error: updateError } = await client.auth.updateUser({ password: input.newPassword });
    if (updateError) {
      if (isNetwork(updateError)) return 'network';
      if (updateError.code === 'weak_password') return 'weak_password';
      if (updateError.code === 'same_password') return 'same_password';
      return 'failed';
    }
    try {
      await client.auth.signOut({ scope: 'others' });
    } catch {
      // Das neue Passwort gilt; ein erneuter Versuch meldet die anderen Sitzungen später ab.
    }
    return 'ok';
  } catch (thrown) {
    return thrown instanceof TypeError || isNetwork(thrown as AuthErrorLike) ? 'network' : 'failed';
  }
}

export interface OwnMembership {
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  memberSince: string | null;
}

/** K-05.1 — die eigenen aktiven Mitgliedschaften mit Betrieb und Rolle; `null` bei einem Fehler. */
export async function listOwnMemberships(): Promise<OwnMembership[] | null> {
  const client = getSupabaseClient();
  if (!client) return [];
  try {
    const { data, error } = await client.rpc('list_own_memberships');
    if (error || !Array.isArray(data)) return null;
    return (data as Array<Record<string, unknown>>)
      .filter((row) => typeof row.workspace_id === 'string' && (row.role === 'owner' || row.role === 'admin' || row.role === 'member'))
      .map((row) => ({
        workspaceId: row.workspace_id as string,
        workspaceName: typeof row.workspace_name === 'string' ? row.workspace_name : '',
        role: row.role as WorkspaceRole,
        memberSince: typeof row.member_since === 'string' ? row.member_since : null,
      }));
  } catch {
    return null;
  }
}
