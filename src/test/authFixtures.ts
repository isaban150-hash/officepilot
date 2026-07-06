import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  approveUser,
  ensureDefaultAdminUser,
  login,
  registerUser,
} from '../services/auth/authService';
import { clearAuthStorage, hydrateAuthFromStorage } from '../services/auth/authPersistence';
import { expireLicense, grantBetaLicense, isUserAllowedToUseApp } from '../services/auth/licenseService';
import { findUserByEmail, resetAuthStore } from '../services/auth/authStore';
import { LICENSE_VERSION, PRIVACY_VERSION, TERMS_VERSION } from '../config/legalVersions';
import type { UserAccount } from '../types/auth';

export async function seedDefaultAdminUser(): Promise<UserAccount> {
  hydrateAuthFromStorage();
  const admin = await ensureDefaultAdminUser();
  if (!admin) throw new Error('Default admin could not be created');
  return admin;
}

export async function loginAsDefaultAdmin(): Promise<void> {
  await seedDefaultAdminUser();
  const result = await login(DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
  if (!result.success) {
    throw new Error(`Admin login failed: ${result.error}`);
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
  const result = await registerUser({
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
  const approved = approveUser(user.id);
  if (!approved) throw new Error('Approve failed');
  grantBetaLicense(user.id, 30);
  return approved;
}

export function resetAuthForTests(): void {
  clearAuthStorage();
  resetAuthStore();
}

export {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  approveUser,
  expireLicense,
  findUserByEmail,
  isUserAllowedToUseApp,
  login,
  registerUser,
};
