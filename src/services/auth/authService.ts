import type {
  AuthSession,
  RegisterUserInput,
  UserAccount,
  UserRole,
  UserStatus,
} from '../../types/auth';
import {
  findUserByEmail,
  findUserById,
  getAllUsersWithLicenses,
  getCurrentSession,
  setCurrentSession,
  upsertUser,
} from './authStore';
import {
  loadSessionFromStorage,
  saveAuthState,
  saveSessionToStorage,
} from './authPersistence';
import { LICENSE_VERSION, PRIVACY_VERSION, TERMS_VERSION } from '../../config/legalVersions';
import { grantBetaLicense } from './licenseService';
import { hashPasswordStub, verifyPasswordStub } from './passwordHash';

const SESSION_TTL_DAYS = 14;
const MIN_PASSWORD_LENGTH = 8;

/** Local stub default admin – replace when connecting real auth backend. */
export const DEFAULT_ADMIN_EMAIL = 'admin@officepilot.local';
export const DEFAULT_ADMIN_PASSWORD = 'OfficePilot-Admin-2026';

export type AuthResult<T> =
  | { success: true; data: T }
  | { success: false; error: import('../../types/auth').AuthErrorCode };

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function createSession(userId: string): AuthSession {
  const createdAt = nowIso();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_TTL_DAYS);
  return {
    userId,
    createdAt,
    expiresAt: expiresAt.toISOString(),
  };
}

export function getCurrentUser(): UserAccount | null {
  const session = getCurrentSession() ?? loadSessionFromStorage();
  if (session && !getCurrentSession()) {
    setCurrentSession(session);
  }
  if (!session) return null;
  return findUserById(session.userId) ?? null;
}

export { getCurrentSession } from './authStore';
export { isUserAllowedToUseApp, getLicenseBlockReason } from './licenseService';
export { hydrateAuthFromStorage } from './authPersistence';

export async function ensureDefaultAdminUser(): Promise<UserAccount | null> {
  const existing = findUserByEmail(DEFAULT_ADMIN_EMAIL);
  if (existing) return existing;

  const passwordHash = await hashPasswordStub(DEFAULT_ADMIN_PASSWORD);
  const now = nowIso();
  const admin: UserAccount = {
    id: createId('usr'),
    companyName: 'OfficePilot Admin',
    firstName: 'System',
    lastName: 'Administrator',
    email: DEFAULT_ADMIN_EMAIL,
    passwordHash,
    role: 'admin',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    acceptedTermsVersion: TERMS_VERSION,
    acceptedPrivacyVersion: PRIVACY_VERSION,
    acceptedLicenseVersion: LICENSE_VERSION,
    legalAcceptedAt: now,
  };
  upsertUser(admin);
  grantBetaLicense(admin.id, 365);
  saveAuthState();
  return admin;
}

interface RegisterOptions {
  role?: UserRole;
  status?: UserStatus;
  autoLicense?: boolean;
}

export async function registerUser(
  input: RegisterUserInput,
  options?: RegisterOptions,
): Promise<AuthResult<UserAccount>> {
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
  if (findUserByEmail(input.email)) {
    return { success: false, error: 'email_exists' };
  }

  const now = nowIso();
  const user: UserAccount = {
    id: createId('usr'),
    companyName: input.companyName.trim(),
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    email: input.email.trim().toLowerCase(),
    phone: input.phone?.trim() || undefined,
    industry: input.industry?.trim() || undefined,
    passwordHash: await hashPasswordStub(input.password),
    role: options?.role ?? 'user',
    status: options?.status ?? 'pending',
    createdAt: now,
    updatedAt: now,
    acceptedTermsVersion: input.acceptedTermsVersion,
    acceptedPrivacyVersion: input.acceptedPrivacyVersion,
    acceptedLicenseVersion: input.acceptedLicenseVersion,
    legalAcceptedAt: now,
    acceptedAt: now,
  };
  upsertUser(user);
  if (options?.autoLicense || user.status === 'active') {
    grantBetaLicense(user.id, 90);
  }
  saveAuthState();
  return { success: true, data: user };
}

export async function login(email: string, password: string): Promise<AuthResult<AuthSession>> {
  const user = findUserByEmail(email);
  if (!user) {
    return { success: false, error: 'invalid_credentials' };
  }
  const valid = await verifyPasswordStub(password, user.passwordHash);
  if (!valid) {
    return { success: false, error: 'invalid_credentials' };
  }

  const session = createSession(user.id);
  setCurrentSession(session);
  saveSessionToStorage(session);

  upsertUser({
    ...user,
    lastLoginAt: nowIso(),
    updatedAt: nowIso(),
  });
  saveAuthState();

  return { success: true, data: session };
}

export function logout(): void {
  setCurrentSession(null);
  saveSessionToStorage(null);
}

export function approveUser(userId: string, grantLicense = true): UserAccount | null {
  const user = findUserById(userId);
  if (!user) return null;
  const updated: UserAccount = {
    ...user,
    status: 'active',
    updatedAt: nowIso(),
  };
  upsertUser(updated);
  if (grantLicense) {
    grantBetaLicense(userId, 90);
  }
  saveAuthState();
  return updated;
}

export function blockUser(userId: string): UserAccount | null {
  const user = findUserById(userId);
  if (!user) return null;
  const updated: UserAccount = {
    ...user,
    status: 'blocked',
    updatedAt: nowIso(),
  };
  upsertUser(updated);
  saveAuthState();
  return updated;
}

export function listUsersForAdmin() {
  return getAllUsersWithLicenses();
}

export { extendLicense, expireLicense, grantBetaLicense } from './licenseService';

export function getAuthErrorMessage(
  error: import('../../types/auth').AuthErrorCode,
): string {
  const messages: Record<import('../../types/auth').AuthErrorCode, string> = {
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
