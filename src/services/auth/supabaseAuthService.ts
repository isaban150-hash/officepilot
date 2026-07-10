import type { Session } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../lib/supabase';
import type {
  AuthErrorCode,
  AuthSession,
  RegisterUserInput,
  UserAccount,
} from '../../types/auth';
import {
  buildSignUpMetadata,
  mapSupabaseSession,
  mapSupabaseUserToAccount,
} from './userAccountMapper';
import { getLicenseBlockReason, isUserAllowedToUseApp } from './licenseService';

const MIN_PASSWORD_LENGTH = 8;

export type AuthResult<T> =
  | { success: true; data: T }
  | { success: false; error: AuthErrorCode };

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

function mapAuthPayload(session: Session): AuthPayload {
  return {
    session: mapSupabaseSession(session),
    user: mapSupabaseUserToAccount(session.user),
    supabaseSession: session,
  };
}

function mapSupabaseAuthError(message: string): AuthErrorCode {
  const normalized = message.toLowerCase();
  if (normalized.includes('invalid login credentials')) return 'invalid_credentials';
  if (normalized.includes('user already registered')) return 'email_exists';
  if (normalized.includes('email')) return 'invalid_email';
  return 'invalid_credentials';
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
    return { success: false, error: mapSupabaseAuthError(error?.message ?? 'invalid login credentials') };
  }

  return { success: true, data: mapAuthPayload(data.session) };
}

export async function signUpUser(input: RegisterUserInput): Promise<AuthResult<UserAccount>> {
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
  const { data, error } = await client.auth.signUp({
    email: input.email.trim().toLowerCase(),
    password: input.password,
    options: {
      data: buildSignUpMetadata(input),
    },
  });

  if (error) {
    return { success: false, error: mapSupabaseAuthError(error.message) };
  }

  if (!data.user) {
    return { success: false, error: 'invalid_email' };
  }

  return { success: true, data: mapSupabaseUserToAccount(data.user) };
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

export function getAuthErrorMessage(error: AuthErrorCode): string {
  const messages: Record<AuthErrorCode, string> = {
    invalid_credentials: 'E-Mail oder Passwort ist falsch.',
    email_exists: 'Diese E-Mail-Adresse ist bereits registriert.',
    user_not_found: 'Benutzer wurde nicht gefunden.',
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
} from './adminAccessBridge';
