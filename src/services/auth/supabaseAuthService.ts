import type { Session } from '@supabase/supabase-js';
import { getSupabaseClient, getSupabaseUrl } from '../../lib/supabase';
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

const MIN_PASSWORD_LENGTH = 8;

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
  const supabaseUrl = getSupabaseUrl();
  const signupEndpoint = supabaseUrl ? `${supabaseUrl}/auth/v1/signup` : undefined;
  console.debug('[OfficePilot] Supabase URL:', supabaseUrl);
  console.debug('[OfficePilot] SignUp-Endpunkt:', signupEndpoint);

  const signUpResponse = await client.auth.signUp({
    email: input.email.trim().toLowerCase(),
    password: input.password,
    options: {
      data: buildSignUpMetadata(input),
    },
  });

  console.debug('[OfficePilot] supabase.auth.signUp() – vollständige Rückgabe', signUpResponse);

  const { data, error } = signUpResponse;

  if (error) {
    const authError = error as { message?: string; code?: string; status?: number };
    console.debug('[OfficePilot] supabase.auth.signUp() – Fehlerdetails', {
      message: authError.message,
      code: authError.code,
      status: authError.status,
    });
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

export function getLoginErrorMessage(error: AuthErrorCode): string {
  const messages: Record<AuthErrorCode, string> = {
    invalid_credentials: 'E-Mail oder Passwort ist falsch.',
    email_exists: 'Diese E-Mail-Adresse ist bereits registriert.',
    user_not_found: 'Benutzerprofil wurde nicht gefunden.',
    user_pending: 'Ihr Zugang wartet noch auf Freischaltung.',
    user_blocked: 'Ihr Zugang wurde gesperrt.',
    license_expired: 'Ihre Lizenz ist abgelaufen.',
    terms_required:
      'Bitte akzeptieren Sie AGB, Datenschutzerklärung und Lizenzbedingungen.',
    invalid_email: 'Bitte geben Sie eine gültige E-Mail-Adresse ein.',
    password_too_short: `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben.`,
  };
  return messages[error];
}

export function getRegisterErrorMessage(error: RegisterErrorCode): string {
  const messages: Record<RegisterErrorCode, string> = {
    email_exists: 'Diese E-Mail-Adresse ist bereits registriert.',
    terms_required:
      'Bitte akzeptieren Sie AGB, Datenschutzerklärung und Lizenzbedingungen.',
    invalid_email: 'Bitte geben Sie eine gültige E-Mail-Adresse ein.',
    password_too_short: `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben.`,
    registration_failed:
      'Die Registrierung konnte nicht abgeschlossen werden. Bitte versuchen Sie es erneut.',
  };
  return messages[error];
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
