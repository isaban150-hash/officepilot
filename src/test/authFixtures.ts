import {
  LICENSE_VERSION,
  PRIVACY_VERSION,
  TERMS_VERSION,
} from '../config/legalVersions';
import type { UserAccount } from '../types/auth';
import { signInWithPassword, signUpUser, expireLicense as expireLicenseAccess } from '../services/auth/authService';
import { mapSupabaseUserToAccount } from '../services/auth/userAccountMapper';
import { getLicenseFromUserAccount, isUserAllowedToUseApp } from '../services/auth/licenseService';
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  mockApproveUser,
  mockBlockUser,
  mockFindUserByEmail,
  mockGrantBetaLicense,
  mockListUsersForAdmin,
  resetMockSupabaseAuth,
  seedMockAdminUser,
} from './mockSupabaseAuth';

export { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD, mockListUsersForAdmin as listUsersForAdmin };

export function resetAuthForTests(): void {
  resetMockSupabaseAuth();
}

export async function seedDefaultAdminUser(): Promise<UserAccount> {
  const user = seedMockAdminUser();
  return mapSupabaseUserToAccount(user);
}

export async function loginAsDefaultAdmin(): Promise<void> {
  await seedDefaultAdminUser();
  const result = await signInWithPassword(DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
  if (!result.success) {
    throw new Error(`Admin login failed: ${result.error}`);
  }
}

export async function login(email: string, password: string): Promise<void> {
  const result = await signInWithPassword(email, password);
  if (!result.success) {
    throw new Error(`Login failed: ${result.error}`);
  }
}

export async function registerPendingTestUser(
  email: string,
  overrides?: Partial<{
    companyName: string;
    firstName: string;
    lastName: string;
    password: string;
  }>,
): Promise<UserAccount> {
  const result = await signUpUser({
    companyName: overrides?.companyName ?? 'Test Firma GmbH',
    firstName: overrides?.firstName ?? 'Test',
    lastName: overrides?.lastName ?? 'Nutzer',
    email,
    password: overrides?.password ?? 'TestPasswort1',
    acceptedTermsVersion: TERMS_VERSION,
    acceptedPrivacyVersion: PRIVACY_VERSION,
    acceptedLicenseVersion: LICENSE_VERSION,
  });
  if (!result.success) {
    throw new Error(`Register failed: ${result.error}`);
  }
  return result.data;
}

export async function registerAndApproveUser(email: string): Promise<UserAccount> {
  const user = await registerPendingTestUser(email);
  const approved = mockApproveUser(user.id);
  if (!approved) throw new Error('Approve failed');
  return mapSupabaseUserToAccount(approved);
}

export function approveUser(userId: string): UserAccount | null {
  const approved = mockApproveUser(userId);
  return approved ? mapSupabaseUserToAccount(approved) : null;
}

export function blockUser(userId: string): UserAccount | null {
  const blocked = mockBlockUser(userId);
  return blocked ? mapSupabaseUserToAccount(blocked) : null;
}

export function expireLicense(userId: string): UserAccount | null {
  return expireLicenseAccess(userId);
}

export function findUserByEmail(email: string): UserAccount | undefined {
  const user = mockFindUserByEmail(email);
  return user ? mapSupabaseUserToAccount(user) : undefined;
}

export {
  getLicenseFromUserAccount,
  isUserAllowedToUseApp,
  mockGrantBetaLicense as grantBetaLicense,
  signUpUser as registerUser,
};
