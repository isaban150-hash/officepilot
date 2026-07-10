import type { License, UserAccount } from '../../types/auth';
import { mapLicenseFromUser } from './userAccountMapper';

export function isLicenseActive(license: License | undefined, at = new Date()): boolean {
  if (!license) return false;
  if (license.status !== 'active') return false;
  if (license.expiresAt && new Date(license.expiresAt).getTime() < at.getTime()) {
    return false;
  }
  return true;
}

export function getLicenseFromUserAccount(user: UserAccount): License | undefined {
  return mapLicenseFromUser(user);
}

export function isUserAllowedToUseApp(user: UserAccount | undefined): boolean {
  if (!user) return false;
  if (user.status !== 'active') return false;
  const license = getLicenseFromUserAccount(user);
  return isLicenseActive(license);
}

export function getLicenseBlockReason(
  user: UserAccount | undefined,
): 'not_found' | 'pending' | 'blocked' | 'license_expired' | 'no_license' | null {
  if (!user) return 'not_found';
  if (user.status === 'pending') return 'pending';
  if (user.status === 'blocked') return 'blocked';
  const license = getLicenseFromUserAccount(user);
  if (!license) return 'no_license';
  if (!isLicenseActive(license)) return 'license_expired';
  return null;
}

export function getLicenseLabel(license: License | undefined): string {
  if (!license) return '—';
  const planLabels: Record<License['plan'], string> = {
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
