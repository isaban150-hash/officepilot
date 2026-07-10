import type { UserAccount } from '../../types/auth';
import type { getLicenseFromUserAccount } from './licenseService';

export interface AdminAccessBridge {
  listUsersForAdmin: () => Array<{
    user: UserAccount;
    license: ReturnType<typeof getLicenseFromUserAccount>;
  }>;
  approveUser: (userId: string) => UserAccount | null;
  blockUser: (userId: string) => UserAccount | null;
  extendLicense: (userId: string, days: number) => UserAccount | null;
  expireLicense: (userId: string) => UserAccount | null;
  grantBetaLicense: (userId: string, daysValid?: number) => UserAccount | null;
}

let bridge: AdminAccessBridge | null = null;

export function registerAdminAccessBridge(nextBridge: AdminAccessBridge | null): void {
  bridge = nextBridge;
}

export function listUsersForAdmin(): Array<{
  user: UserAccount;
  license: ReturnType<typeof getLicenseFromUserAccount>;
}> {
  return bridge?.listUsersForAdmin() ?? [];
}

export function approveUser(userId: string): UserAccount | null {
  return bridge?.approveUser(userId) ?? null;
}

export function blockUser(userId: string): UserAccount | null {
  return bridge?.blockUser(userId) ?? null;
}

export function extendLicense(userId: string, days: number): UserAccount | null {
  return bridge?.extendLicense(userId, days) ?? null;
}

export function expireLicense(userId: string): UserAccount | null {
  return bridge?.expireLicense(userId) ?? null;
}

export function grantBetaLicense(userId: string, daysValid = 90): UserAccount | null {
  return bridge?.grantBetaLicense(userId, daysValid) ?? null;
}
