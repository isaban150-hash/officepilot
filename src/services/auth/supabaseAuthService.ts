import type { Session } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../lib/supabase';
import type { AppLanguage } from '../../types/models';
import type { TranslationKey } from '../../i18n';
import { errorReference, t } from '../../i18n';
import type {
  AuthErrorCode,
  AuthSession,
  RegisterErrorCode,
  RegisterUserInput,
  UserAccount,
} from '../../types/auth';
import {
  buildSignUpMetadata,
  mapRegistrationPreviewFromUser,
  mapSupabaseSession,
} from './userAccountMapper';
import { fetchCurrentUserProfile } from './profileService';
import { mapProfileRowToUserAccount } from './profileMapper';
import type { ProfileRow } from '../../types/profile';
import { getLicenseBlockReason, isUserAllowedToUseApp } from './licenseService';

export const MIN_PASSWORD_LENGTH = 8;

/** sessionStorage flag so reload on /reset-password still recognizes recovery. */
export const PASSWORD_RECOVERY_FLAG_KEY = 'officepilot.auth.passwordRecovery';

export type PasswordResetRequestError = 'invalid_email' | 'request_failed';
export type PasswordUpdateError =
  | 'recovery_session_missing'
  | 'password_too_short'
  | 'update_failed';

/**
 * EINRICHTUNG-01 (AP2, EIN-26; A-11.1) — der Merker gilt für alle Tabs dieses Geräts: Öffnet ein Tab den
 * Wiederherstellungslink, zeigen auch die anderen nur noch das Formular, ohne Bootstrap und ohne Abgleich. Er läuft
 * nach einer Stunde ab (wie die Wiederherstellungssitzung), damit ein abgebrochener Vorgang die App nicht dauerhaft
 * sperrt. Der Tab-Merker bleibt für den Neuladen-Fall erhalten.
 */
export const PASSWORD_RECOVERY_SHARED_KEY = 'officetakt.auth.passwordRecovery.shared';
const PASSWORD_RECOVERY_MAX_AGE_MS = 60 * 60 * 1000;

export function markPasswordRecoveryPending(): void {
  try {
    sessionStorage.setItem(PASSWORD_RECOVERY_FLAG_KEY, '1');
  } catch {
    // ignore quota / private mode
  }
  try {
    localStorage.setItem(PASSWORD_RECOVERY_SHARED_KEY, JSON.stringify({ at: Date.now() }));
  } catch {
    // ohne gemeinsamen Speicher gilt der Merker nur in diesem Tab
  }
}

export function clearPasswordRecoveryPending(): void {
  try {
    sessionStorage.removeItem(PASSWORD_RECOVERY_FLAG_KEY);
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem(PASSWORD_RECOVERY_SHARED_KEY);
  } catch {
    // ignore
  }
}

function readSharedRecoveryFlag(): boolean {
  try {
    const raw = localStorage.getItem(PASSWORD_RECOVERY_SHARED_KEY);
    if (!raw) return false;
    const value = JSON.parse(raw) as { at?: unknown } | null;
    const at = typeof value?.at === 'number' ? value.at : NaN;
    if (!Number.isFinite(at) || Date.now() - at > PASSWORD_RECOVERY_MAX_AGE_MS || at > Date.now() + 60_000) {
      localStorage.removeItem(PASSWORD_RECOVERY_SHARED_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function readPasswordRecoveryPendingFlag(): boolean {
  try {
    if (sessionStorage.getItem(PASSWORD_RECOVERY_FLAG_KEY) === '1') return true;
  } catch {
    // weiter mit dem gemeinsamen Merker
  }
  return readSharedRecoveryFlag();
}

/**
 * Always returns success for a syntactically valid email so responses do not
 * reveal whether an account exists. The Supabase call still runs.
 */
export async function requestPasswordReset(
  email: string,
  redirectTo: string,
): Promise<{ success: true } | { success: false; error: PasswordResetRequestError }> {
  if (!isValidEmail(email)) {
    return { success: false, error: 'invalid_email' };
  }

  const client = requireSupabaseClient();
  try {
    // Ignore provider errors so responses do not reveal account existence.
    await client.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo });
  } catch {
    // network / unexpected — still neutral success below
  }
  return { success: true };
}

export async function hasPasswordRecoverySession(): Promise<boolean> {
  if (!readPasswordRecoveryPendingFlag()) return false;
  const client = getSupabaseClient();
  if (!client) return false;
  const { data, error } = await client.auth.getSession();
  return Boolean(!error && data.session);
}

/**
 * Updates the password only when a recovery session was marked and a session exists.
 * Does not modify profile, license, workspace, or local business data.
 */
export async function updatePasswordDuringRecovery(
  password: string,
): Promise<{ success: true } | { success: false; error: PasswordUpdateError }> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { success: false, error: 'password_too_short' };
  }
  if (!readPasswordRecoveryPendingFlag()) {
    return { success: false, error: 'recovery_session_missing' };
  }

  const client = requireSupabaseClient();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError || !sessionData.session) {
    return { success: false, error: 'recovery_session_missing' };
  }

  const { error } = await client.auth.updateUser({ password });
  if (error) {
    return { success: false, error: 'update_failed' };
  }
  return { success: true };
}

/** `ref` nur bei `unknown` (EINRICHTUNG-01, AP9; 1.30, Q-01.2): Kurzreferenz statt Rohtext. */
export type AuthResult<T> =
  | { success: true; data: T }
  | { success: false; error: AuthErrorCode; ref?: string };

export type RegisterResult =
  | { success: true; outcome: 'email_confirmation_required'; user: UserAccount }
  | { success: true; outcome: 'session_created'; user: UserAccount; payload: AuthPayload }
  | { success: false; error: RegisterErrorCode };

export interface AuthPayload {
  session: AuthSession;
  user: UserAccount;
  supabaseSession: Session;
  /** EINRICHTUNG-01 (AP2) — das bestätigte Profil, für den Zwischenspeicher des Offline-Starts. */
  profile: ProfileRow;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function requireSupabaseClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Supabase ist nicht konfiguriert. VITE_SUPABASE_URL und VITE_SUPABASE_ANON_KEY setzen.');
  }
  return client;
}

async function mapAuthPayload(session: Session): Promise<AuthPayload | null> {
  const result = await fetchCurrentUserProfile(session.user.id);
  if (!result.success) return null;
  return {
    session: mapSupabaseSession(session),
    user: mapProfileRowToUserAccount(result.profile),
    supabaseSession: session,
    profile: result.profile,
  };
}

/**
 * EINRICHTUNG-01 (AP2, EIN-17; A-07, A-08) — Fehler der Anmeldung über Code, Status und Fehlerart zuordnen, nie über
 * den Wortlaut der Meldung. Jeder Fall bekommt einen eigenen, verständlichen Hinweis; Rohtexte erscheinen nie.
 */
type AuthErrorLike = { name?: string; code?: string; status?: number; message?: string } | null | undefined;

function isNetworkAuthError(error: AuthErrorLike): boolean {
  return error?.name === 'AuthRetryableFetchError' || error?.status === 0;
}

function isRateLimitAuthError(error: AuthErrorLike): boolean {
  return error?.status === 429 || error?.code === 'over_request_rate_limit' || error?.code === 'over_email_send_rate_limit';
}

export function mapSupabaseLoginError(error: AuthErrorLike): AuthErrorCode {
  if (!error) return 'invalid_credentials';
  if (isNetworkAuthError(error)) return 'network';
  if (error.code === 'email_not_confirmed') return 'email_not_confirmed';
  if (isRateLimitAuthError(error)) return 'rate_limited';
  if (error.code === 'invalid_credentials') return 'invalid_credentials';
  // Ältere Auth-Server liefern für falsche Zugangsdaten 400 ohne Code.
  if (error.status === 400 && !error.code) return 'invalid_credentials';
  return 'unknown';
}

/** `existing`: Die Adresse ist schon registriert — die Oberfläche antwortet trotzdem neutral (A-08.1). */
export function mapSupabaseSignUpError(error: AuthErrorLike): RegisterErrorCode | 'existing' {
  if (!error) return 'registration_failed';
  if (isNetworkAuthError(error)) return 'network';
  if (isRateLimitAuthError(error)) return 'rate_limited';
  if (error.code === 'user_already_exists' || error.code === 'email_exists') return 'existing';
  if (error.code === 'weak_password') return 'weak_password';
  if (error.code === 'email_address_invalid' || error.code === 'email_address_not_authorized') return 'invalid_email';
  return 'registration_failed';
}

/**
 * EINRICHTUNG-01 (AP2, A-16.1) — Bestätigungs- und Wiederherstellungslinks führen auf diese Adresse zurück, und nur auf
 * Pfade aus einer festen Liste. Nie auf eine fremde oder eine Produktionsadresse, wenn lokal geprüft wird.
 */
const AUTH_REDIRECT_PATHS = ['/login', '/reset-password'] as const;

export function buildAuthRedirectUrl(path: (typeof AUTH_REDIRECT_PATHS)[number] = '/login'): string | undefined {
  if (typeof window === 'undefined' || !window.location?.origin) return undefined;
  if (!AUTH_REDIRECT_PATHS.includes(path)) return undefined;
  return `${window.location.origin}${path}`;
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<AuthResult<AuthPayload>> {
  const client = requireSupabaseClient();
  let response: Awaited<ReturnType<typeof client.auth.signInWithPassword>>;
  try {
    response = await client.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
  } catch (thrown) {
    // EIN-26 — eine Ausnahme ist kein falsches Passwort.
    if (isNetworkAuthError(thrown as AuthErrorLike) || thrown instanceof TypeError) return { success: false, error: 'network' };
    return { success: false, error: 'unknown', ref: errorReference(thrown) };
  }
  const { data, error } = response;

  if (error || !data.session) {
    const code = mapSupabaseLoginError(error ?? null);
    return code === 'unknown' ? { success: false, error: code, ref: errorReference(error) } : { success: false, error: code };
  }

  const profileResult = await fetchCurrentUserProfile(data.session.user.id);
  if (!profileResult.success) {
    if (profileResult.error === 'not_found') {
      // A-10.1 — bestätigt kein Profil: Diese Anmeldung bleibt nicht bestehen.
      try {
        await client.auth.signOut({ scope: 'local' });
      } catch {
        // die lokale Sitzung verwirft AuthContext ohnehin
      }
      return { success: false, error: 'user_not_found' };
    }
    // Profil vorübergehend nicht abrufbar: Die Sitzung bleibt; AuthContext wiederholt den Abruf.
    return { success: false, error: 'network' };
  }
  const payload: AuthPayload = {
    session: mapSupabaseSession(data.session),
    user: mapProfileRowToUserAccount(profileResult.profile),
    supabaseSession: data.session,
    profile: profileResult.profile,
  };

  return { success: true, data: payload };
}

export async function signUpUser(input: RegisterUserInput): Promise<RegisterResult> {
  if (
    !input.acceptedTermsVersion ||
    !input.acceptedPrivacyVersion ||
    !input.acceptedLicenseVersion
  ) {
    return { success: false, error: 'terms_required' };
  }
  if (!isValidEmail(input.email)) {
    return { success: false, error: 'invalid_email' };
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return { success: false, error: 'password_too_short' };
  }

  const client = requireSupabaseClient();
  const normalizedEmail = input.email.trim().toLowerCase();
  const neutral = (): RegisterResult => ({
    success: true,
    outcome: 'email_confirmation_required',
    user: {
      id: '',
      email: normalizedEmail,
      companyName: input.companyName,
      firstName: input.firstName,
      lastName: input.lastName,
      role: 'user',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      licenseStatus: 'inactive',
    },
  });

  let signUpResponse: Awaited<ReturnType<typeof client.auth.signUp>>;
  try {
    const redirect = buildAuthRedirectUrl('/login');
    signUpResponse = await client.auth.signUp({
      email: normalizedEmail,
      password: input.password,
      options: {
        data: buildSignUpMetadata(input),
        ...(redirect ? { emailRedirectTo: redirect } : {}),
      },
    });
  } catch (thrown) {
    return { success: false, error: thrown instanceof TypeError || isNetworkAuthError(thrown as AuthErrorLike) ? 'network' : 'registration_failed' };
  }

  const { data, error } = signUpResponse;

  if (error) {
    const mapped = mapSupabaseSignUpError(error);
    // A-08.1 — eine schon registrierte Adresse bekommt dieselbe neutrale Antwort wie eine neue.
    if (mapped === 'existing') return neutral();
    return { success: false, error: mapped };
  }

  if (!data.user) {
    return { success: false, error: 'registration_failed' };
  }

  // Mit Bestätigungspflicht liefert der Auth-Server für bekannte Adressen ein Konto ohne Identitäten.
  if (data.user.identities?.length === 0) {
    return neutral();
  }

  if (data.session) {
    const payload = await mapAuthPayload(data.session);
    if (!payload) {
      return { success: false, error: 'registration_failed' };
    }
    return {
      success: true,
      outcome: 'session_created',
      user: payload.user,
      payload,
    };
  }

  const preview = mapRegistrationPreviewFromUser(data.user);
  return {
    success: true,
    outcome: 'email_confirmation_required',
    user: {
      ...preview,
      role: 'user',
      status: 'pending',
      updatedAt: preview.createdAt,
      licenseStatus: 'inactive',
    },
  };
}

/**
 * EINRICHTUNG-01 (AP2, EIN-16; Vertrag 1.8) — Abmelden beendet standardmäßig nur die Sitzung dieses Geräts
 * (`local`). „Auf allen Geräten abmelden“ widerruft alle Refresh-Sitzungen des Kontos (`global`); deren noch gültige
 * Zugriffstoken weist die zentrale Zugriffsregel ab dem nächsten Aufruf ab (`session_not_active`).
 */
export async function signOutUser(scope: 'local' | 'global' = 'local'): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return;
  try {
    await client.auth.signOut({ scope });
  } catch {
    // Ohne Verbindung wird wenigstens lokal abgemeldet; die Sitzung verwirft AuthContext ohnehin.
    if (scope === 'global') throw new Error('global_signout_failed');
  }
}

/**
 * EINRICHTUNG-01 (AP2, A-07.6) — „Bestätigung erneut senden“. Die Antwort ist immer neutral: Sie verrät nicht, ob es
 * ein Konto gibt. Das Server-Limit des Auth-Servers greift unabhängig davon.
 */
export async function resendSignupConfirmation(email: string): Promise<'sent' | 'invalid_email' | 'rate_limited' | 'network'> {
  if (!isValidEmail(email)) return 'invalid_email';
  const client = getSupabaseClient();
  if (!client) return 'network';
  try {
    const redirect = buildAuthRedirectUrl('/login');
    const { error } = await client.auth.resend({
      type: 'signup',
      email: email.trim().toLowerCase(),
      ...(redirect ? { options: { emailRedirectTo: redirect } } : {}),
    });
    if (error && isRateLimitAuthError(error)) return 'rate_limited';
    if (error && isNetworkAuthError(error)) return 'network';
    return 'sent';
  } catch (thrown) {
    return thrown instanceof TypeError || isNetworkAuthError(thrown as AuthErrorLike) ? 'network' : 'sent';
  }
}

export async function fetchCurrentSession(): Promise<AuthPayload | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  const { data, error } = await client.auth.getSession();
  if (error || !data.session) return null;
  return mapAuthPayload(data.session);
}

const LOGIN_ERROR_KEYS: Record<AuthErrorCode, TranslationKey> = {
  invalid_credentials: 'auth.error.invalidCredentials',
  email_exists: 'auth.error.emailExists',
  user_not_found: 'auth.error.userNotFound',
  user_pending: 'auth.error.userPending',
  user_blocked: 'auth.error.userBlocked',
  license_expired: 'auth.error.licenseExpired',
  terms_required: 'auth.error.termsRequired',
  invalid_email: 'auth.error.invalidEmail',
  password_too_short: 'auth.error.passwordTooShort',
  email_not_confirmed: 'auth.error.emailNotConfirmed',
  rate_limited: 'auth.error.rateLimited',
  network: 'auth.error.network',
  unknown: 'auth.error.unknown',
};

const REGISTER_ERROR_KEYS: Record<RegisterErrorCode, TranslationKey> = {
  email_exists: 'auth.error.emailExists',
  terms_required: 'auth.error.termsRequired',
  invalid_email: 'auth.error.invalidEmail',
  password_too_short: 'auth.error.passwordTooShort',
  registration_failed: 'auth.error.registrationFailed',
  weak_password: 'auth.error.weakPassword',
  rate_limited: 'auth.error.rateLimited',
  network: 'auth.error.network',
};

export function getLoginErrorKey(error: AuthErrorCode): TranslationKey {
  return LOGIN_ERROR_KEYS[error];
}

export function getRegisterErrorKey(error: RegisterErrorCode): TranslationKey {
  return REGISTER_ERROR_KEYS[error];
}

export function getLoginErrorMessage(error: AuthErrorCode, lang: AppLanguage = 'de', ref?: string): string {
  // EINRICHTUNG-01 (AP9; 1.30) — unbekannter Fehler mit Kurzreferenz: der allgemeine Text mit dieser Referenz.
  if (error === 'unknown' && ref) return t('errors.genericWithReference', lang, { ref });
  const key = LOGIN_ERROR_KEYS[error];
  if (key === 'auth.error.passwordTooShort') {
    return t(key, lang, { min: MIN_PASSWORD_LENGTH });
  }
  return t(key, lang);
}

export function getRegisterErrorMessage(error: RegisterErrorCode, lang: AppLanguage = 'de'): string {
  const key = REGISTER_ERROR_KEYS[error];
  if (key === 'auth.error.passwordTooShort') {
    return t(key, lang, { min: MIN_PASSWORD_LENGTH });
  }
  return t(key, lang);
}

/** @deprecated Verwende getLoginErrorMessage oder getRegisterErrorMessage. */
export function getAuthErrorMessage(error: AuthErrorCode | RegisterErrorCode): string {
  if (error === 'registration_failed') {
    return getRegisterErrorMessage(error);
  }
  return getLoginErrorMessage(error as AuthErrorCode);
}

export function getPostLoginRoute(user: UserAccount | null | undefined): string {
  const block = getLicenseBlockReason(user ?? undefined);
  if (block === 'pending') return '/waiting-approval';
  if (block === 'blocked') return '/access-blocked';
  // EINRICHTUNG-01 (E3, E5) — die eigene Lizenz entscheidet nicht über den Zugang; siehe isUserAllowedToUseApp.
  if (!isUserAllowedToUseApp(user ?? undefined)) return '/license-expired';
  return '/';
}

export { getLicenseBlockReason, isUserAllowedToUseApp };

export {
  approveUser,
  blockUser,
  expireLicense,
  extendLicense,
  grantBetaLicense,
  listUsersForAdmin,
} from './profileAdminService';
