import {
  LICENSE_VERSION,
  PRIVACY_VERSION,
  TERMS_VERSION,
} from '../config/legalVersions';
import type { UserAccount } from '../types/auth';
import { signInWithPassword, signUpUser } from '../services/auth/authService';
import { mapProfileRowToUserAccount } from '../services/auth/profileMapper';
import { getLicenseFromUserAccount, isUserAllowedToUseApp } from '../services/auth/licenseService';
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  getMockProfile,
  mockApproveUser,
  mockBlockUser,
  mockExpireLicense,
  mockFindUserByEmail,
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
  const profile = getMockProfile(user.id);
  if (!profile) throw new Error('Admin profile missing');
  return mapProfileRowToUserAccount(profile);
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
  return result.user;
}

export async function registerAndApproveUser(email: string): Promise<UserAccount> {
  const user = await registerPendingTestUser(email);
  const approved = mockApproveUser(user.id);
  if (!approved) throw new Error('Approve failed');
  return mapProfileRowToUserAccount(approved);
}

export async function approveUser(userId: string): Promise<UserAccount | null> {
  const approved = mockApproveUser(userId);
  return approved ? mapProfileRowToUserAccount(approved) : null;
}

export async function blockUser(userId: string): Promise<UserAccount | null> {
  const blocked = mockBlockUser(userId);
  return blocked ? mapProfileRowToUserAccount(blocked) : null;
}

export async function expireLicense(userId: string): Promise<UserAccount | null> {
  const expired = mockExpireLicense(userId);
  return expired ? mapProfileRowToUserAccount(expired) : null;
}

export function findUserByEmail(email: string): UserAccount | undefined {
  const user = mockFindUserByEmail(email);
  if (!user) return undefined;
  const profile = getMockProfile(user.id);
  return profile ? mapProfileRowToUserAccount(profile) : undefined;
}

export {
  getLicenseFromUserAccount,
  isUserAllowedToUseApp,
  signUpUser as registerUser,
};
