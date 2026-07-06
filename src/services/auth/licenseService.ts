import type { License, LicensePlan, LicenseStatus, UserAccount } from '../../types/auth';
import {
  findLicenseForUser,
  findUserById,
  upsertLicense,
} from './authStore';
import { saveAuthState } from './authPersistence';

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function isLicenseActive(license: License | undefined, at = new Date()): boolean {
  if (!license) return false;
  if (license.status !== 'active') return false;
  if (license.expiresAt && new Date(license.expiresAt).getTime() < at.getTime()) {
    return false;
  }
  return true;
}

export function isUserAllowedToUseApp(user: UserAccount | undefined): boolean {
  if (!user) return false;
  if (user.status !== 'active') return false;
  const license = findLicenseForUser(user.id);
  return isLicenseActive(license);
}

export function getLicenseBlockReason(
  user: UserAccount | undefined,
): 'not_found' | 'pending' | 'blocked' | 'license_expired' | 'no_license' | null {
  if (!user) return 'not_found';
  if (user.status === 'pending') return 'pending';
  if (user.status === 'blocked') return 'blocked';
  const license = findLicenseForUser(user.id);
  if (!license) return 'no_license';
  if (!isLicenseActive(license)) return 'license_expired';
  return null;
}

export function createLicenseForUser(
  userId: string,
  plan: LicensePlan,
  options?: { daysValid?: number; expiresAt?: string },
): License {
  const startsAt = nowIso();
  let expiresAt = options?.expiresAt;
  if (!expiresAt && options?.daysValid && options.daysValid > 0) {
    const end = new Date();
    end.setDate(end.getDate() + options.daysValid);
    expiresAt = end.toISOString();
  }
  const license: License = {
    id: createId('lic'),
    userId,
    plan,
    status: 'active',
    startsAt,
    expiresAt,
    createdAt: startsAt,
    updatedAt: startsAt,
  };
  upsertLicense(license);
  saveAuthState();
  return license;
}

export function extendLicense(userId: string, days: number, plan?: LicensePlan): License | null {
  const user = findUserById(userId);
  if (!user) return null;
  const existing = findLicenseForUser(userId);
  const baseDate =
    existing?.expiresAt && new Date(existing.expiresAt) > new Date()
      ? new Date(existing.expiresAt)
      : new Date();
  baseDate.setDate(baseDate.getDate() + days);
  const updated: License = existing
    ? {
        ...existing,
        plan: plan ?? existing.plan,
        status: 'active',
        expiresAt: baseDate.toISOString(),
        updatedAt: nowIso(),
      }
    : createLicenseForUser(userId, plan ?? 'beta', { expiresAt: baseDate.toISOString() });
  if (existing) {
    upsertLicense(updated);
    saveAuthState();
  }
  return updated;
}

export function expireLicense(userId: string): License | null {
  const existing = findLicenseForUser(userId);
  if (!existing) return null;
  const updated: License = {
    ...existing,
    status: 'expired',
    expiresAt: nowIso(),
    updatedAt: nowIso(),
  };
  upsertLicense(updated);
  saveAuthState();
  return updated;
}

export function grantBetaLicense(userId: string, daysValid = 90): License {
  return createLicenseForUser(userId, 'beta', { daysValid });
}

export function setLicenseStatus(userId: string, status: LicenseStatus): License | null {
  const existing = findLicenseForUser(userId);
  if (!existing) return null;
  const updated: License = {
    ...existing,
    status,
    updatedAt: nowIso(),
  };
  upsertLicense(updated);
  saveAuthState();
  return updated;
}

export function getLicenseLabel(license: License | undefined): string {
  if (!license) return '—';
  const planLabels: Record<LicensePlan, string> = {
    beta: 'Beta',
    starter: 'Starter',
    pro: 'Pro',
    premium: 'Premium',
  };
  const statusSuffix =
    license.status === 'active' && isLicenseActive(license)
      ? ''
      : ` (${license.status === 'expired' ? 'abgelaufen' : 'inaktiv'})`;
  return `${planLabels[license.plan]}${statusSuffix}`;
}
