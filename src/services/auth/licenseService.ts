import type { License, UserAccount } from '../../types/auth';
import { mapProfileToLicense } from './profileMapper';

export function isLicenseActive(license: License | undefined, at = new Date()): boolean {
  if (!license) return false;
  if (license.status !== 'active') return false;
  if (license.expiresAt && new Date(license.expiresAt).getTime() < at.getTime()) {
    return false;
  }
  return true;
}

export function getLicenseFromUserAccount(user: UserAccount): License | undefined {
  if (user.licenseStatus === 'inactive' || !user.licenseStatus) return undefined;

  return {
    id: `lic-${user.id}`,
    userId: user.id,
    plan: user.licensePlan ?? 'beta',
    status: user.licenseStatus === 'expired' ? 'expired' : 'active',
    startsAt: user.licenseStartsAt ?? user.createdAt,
    expiresAt: user.licenseExpiresAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function getLicenseFromProfileUser(user: UserAccount): License | undefined {
  if (user.licenseStatus === 'inactive') return undefined;
  return getLicenseFromUserAccount(user);
}

/**
 * EINRICHTUNG-01 (AP1; E3, E5, Vertrag 1.1) — die App öffnet sich für jedes freigegebene Konto.
 *
 * Die Lizenz gehört dem Betrieb (der Lizenz seines Inhabers), nicht der Person: Admins und Mitglieder brauchen keine
 * eigene. Ob ein Betrieb schreiben darf, meldet der Server (`get_workspace_access`); ist seine Lizenz nicht wirksam,
 * gilt Nur-Lesen statt einer Sperrseite (E5). Wer noch keinen Betrieb hat, erfährt bei der Betriebsbindung, dass
 * für einen eigenen Betrieb eine Lizenz fehlt (Z-03.1). Gesperrt und wartend bleiben eigene Seiten.
 */
export function isUserAllowedToUseApp(user: UserAccount | undefined): boolean {
  if (!user) return false;
  return user.status === 'approved';
}

export function getLicenseBlockReason(
  user: UserAccount | undefined,
): 'not_found' | 'pending' | 'blocked' | 'license_expired' | 'no_license' | null {
  if (!user) return 'not_found';
  if (user.status === 'pending') return 'pending';
  if (user.status === 'blocked') return 'blocked';
  if (user.licenseStatus === 'inactive') return 'no_license';
  if (user.licenseStatus === 'expired') return 'license_expired';
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

export { mapProfileToLicense };
