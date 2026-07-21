import type { Session } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../lib/supabase';
import type { AppLanguage } from '../../types/models';
import type { TranslationKey } from '../../i18n';
import { t } from '../../i18n';
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
import { getLicenseBlockReason, isUserAllowedToUseApp } from './licenseService';

export const MIN_PASSWORD_LENGTH = 8;

/** sessionStorage flag so reload on /reset-password still recognizes recovery. */
export const PASSWORD_RECOVERY_FLAG_KEY = 'officepilot.auth.passwordRecovery';

export type PasswordResetRequestError = 'invalid_email' | 'request_failed';
export type PasswordUpdateError =
  | 'recovery_session_missing'
  | 'password_too_short'
  | 'update_failed';

export function markPasswordRecoveryPending(): void {
  try {
    sessionStorage.setItem(PASSWORD_RECOVERY_FLAG_KEY, '1');
  } catch {
    // ignore quota / private mode
  }
}

export function clearPasswordRecoveryPending(): void {
  try {
    sessionStorage.removeItem(PASSWORD_RECOVERY_FLAG_KEY);
  } catch {
    // ignore
  }
}

export function readPasswordRecoveryPendingFlag(): boolean {
  try {
    return sessionStorage.getItem(PASSWORD_RECOVERY_FLAG_KEY) === '1';
  } catch {
    return false;
  }
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

export type AuthResult<T> =
  | { success: true; data: T }
  | { success: false; error: AuthErrorCode };

export type RegisterResult =
  | { success: true; outcome: 'email_confirmation_required'; user: UserAccount }
  | { success: true; outcome: 'session_created'; user: UserAccount; payload: AuthPayload }
  | { success: false; error: RegisterErrorCode };

export interface AuthPayload {
  session: AuthSession;
  user: UserAccount;
  supabaseSession: Session;
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

async function loadUserFromProfile(userId: string): Promise<UserAccount | null> {
  const result = await fetchCurrentUserProfile(userId);
  if (!result.success) return null;
  return mapProfileRowToUserAccount(result.profile);
}

async function mapAuthPayload(session: Session): Promise<AuthPayload | null> {
  const user = await loadUserFromProfile(session.user.id);
  if (!user) return null;
  return {
    session: mapSupabaseSession(session),
    user,
    supabaseSession: session,
  };
}

function mapSupabaseLoginError(message: string): AuthErrorCode {
  const normalized = message.toLowerCase();
  if (normalized.includes('invalid login credentials')) return 'invalid_credentials';
  if (normalized.includes('email not confirmed')) return 'invalid_credentials';
  return 'invalid_credentials';
}

function mapSupabaseSignUpError(message: string): RegisterErrorCode {
  const normalized = message.toLowerCase();
  if (normalized.includes('already registered') || normalized.includes('already exists')) {
    return 'email_exists';
  }
  if (normalized.includes('password')) return 'password_too_short';
  if (normalized.includes('email')) return 'invalid_email';
  return 'registration_failed';
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<AuthResult<AuthPayload>> {
  const client = requireSupabaseClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (error || !data.session) {
    return {
      success: false,
      error: mapSupabaseLoginError(error?.message ?? 'invalid login credentials'),
    };
  }

  const payload = await mapAuthPayload(data.session);
  if (!payload) {
    return { success: false, error: 'user_not_found' };
  }

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

  const signUpResponse = await client.auth.signUp({
    email: input.email.trim().toLowerCase(),
    password: input.password,
    options: {
      data: buildSignUpMetadata(input),
    },
  });

  const { data, error } = signUpResponse;

  if (error) {
    return { success: false, error: mapSupabaseSignUpError(error.message) };
  }

  if (!data.user) {
    return { success: false, error: 'registration_failed' };
  }

  if (data.user.identities?.length === 0) {
    return { success: false, error: 'email_exists' };
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

export async function signOutUser(): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return;
  await client.auth.signOut();
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
};

const REGISTER_ERROR_KEYS: Record<RegisterErrorCode, TranslationKey> = {
  email_exists: 'auth.error.emailExists',
  terms_required: 'auth.error.termsRequired',
  invalid_email: 'auth.error.invalidEmail',
  password_too_short: 'auth.error.passwordTooShort',
  registration_failed: 'auth.error.registrationFailed',
};

export function getLoginErrorKey(error: AuthErrorCode): TranslationKey {
  return LOGIN_ERROR_KEYS[error];
}

export function getRegisterErrorKey(error: RegisterErrorCode): TranslationKey {
  return REGISTER_ERROR_KEYS[error];
}

export function getLoginErrorMessage(error: AuthErrorCode, lang: AppLanguage = 'de'): string {
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
  if (block === 'license_expired' || block === 'no_license') return '/license-expired';
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
