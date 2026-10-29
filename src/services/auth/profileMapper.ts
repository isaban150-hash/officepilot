import type {
  License,
  UserAccount,
  UserRole,
  UserStatus,
} from '../../types/auth';
import type { ProfileLicenseStatus, ProfileRow } from '../../types/profile';
import { LEGAL_DOCUMENT_VERSIONS } from '../../config/legalVersions';

/**
 * EINRICHTUNG-01 (AP2, EIN-09; A-01, A-10) — warum ein Profilabruf scheiterte. Nur `not_found` (der Server bestätigt:
 * kein Profil) und `session_invalid` (der Server weist die Sitzung ab) beenden die Anmeldung. `temporary` (Netz,
 * Zeitüberschreitung, 5xx, unbekannt) ist keine Abmeldung: Das letzte Profil bleibt, die App versucht es erneut.
 * `query_failed` bleibt als Sammelwert für ältere Aufrufer erhalten und gilt wie `temporary`.
 */
export type ProfileLoadError = 'not_found' | 'session_invalid' | 'temporary' | 'query_failed';

export type ProfileLoadResult =
  | { success: true; profile: ProfileRow }
  | { success: false; error: ProfileLoadError };

export function mapProfileRowToUserAccount(profile: ProfileRow): UserAccount {
  return {
    id: profile.id,
    companyName: profile.company_name,
    firstName: profile.first_name,
    lastName: profile.last_name,
    email: profile.email,
    phone: profile.phone ?? undefined,
    industry: profile.industry ?? undefined,
    role: profile.role as UserRole,
    status: profile.status as UserStatus,
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
    acceptedTermsVersion: profile.accepted_terms_version ?? undefined,
    acceptedPrivacyVersion: profile.accepted_privacy_version ?? undefined,
    acceptedLicenseVersion: profile.accepted_license_version ?? undefined,
    legalAcceptedAt: profile.legal_accepted_at ?? undefined,
    uiLanguage: profile.ui_language ?? undefined,
    acceptedAt: profile.legal_accepted_at ?? undefined,
    licenseStatus: mapProfileLicenseStatus(profile.license_status),
    licenseExpiresAt: profile.license_expires_at ?? undefined,
  };
}

function mapProfileLicenseStatus(status: ProfileLicenseStatus): UserAccount['licenseStatus'] {
  if (status === 'inactive') return 'inactive';
  if (status === 'expired') return 'expired';
  return 'active';
}

export function mapProfileToLicense(profile: ProfileRow): License | undefined {
  if (profile.license_status === 'inactive') return undefined;

  return {
    id: `lic-${profile.id}`,
    userId: profile.id,
    plan: 'beta',
    status: profile.license_status === 'expired' ? 'expired' : 'active',
    startsAt: profile.created_at,
    expiresAt: profile.license_expires_at ?? undefined,
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
  };
}

export function buildRegistrationMetadata(input: {
  companyName: string;
  firstName: string;
  lastName: string;
  phone?: string;
  industry?: string;
  acceptedTermsVersion: string;
  acceptedPrivacyVersion: string;
  acceptedLicenseVersion: string;
}): Record<string, string> {
  const now = new Date().toISOString();
  return {
    companyName: input.companyName.trim(),
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    ...(input.phone?.trim() ? { phone: input.phone.trim() } : {}),
    ...(input.industry?.trim() ? { industry: input.industry.trim() } : {}),
    acceptedTermsVersion: input.acceptedTermsVersion,
    acceptedPrivacyVersion: input.acceptedPrivacyVersion,
    acceptedLicenseVersion: input.acceptedLicenseVersion,
    legalAcceptedAt: now,
  };
}

export function createPendingProfileFromRegistration(
  userId: string,
  email: string,
  metadata: ReturnType<typeof buildRegistrationMetadata>,
): ProfileRow {
  const now = new Date().toISOString();
  const consented =
    metadata.acceptedTermsVersion === LEGAL_DOCUMENT_VERSIONS.terms &&
    metadata.acceptedPrivacyVersion === LEGAL_DOCUMENT_VERSIONS.privacy &&
    metadata.acceptedLicenseVersion === LEGAL_DOCUMENT_VERSIONS.license;
  return {
    id: userId,
    company_name: metadata.companyName,
    first_name: metadata.firstName,
    last_name: metadata.lastName,
    email,
    phone: metadata.phone ?? null,
    industry: metadata.industry ?? null,
    status: 'pending',
    role: 'user',
    license_status: 'inactive',
    license_expires_at: null,
    // EINRICHTUNG-01 (EIN-19) — wie der Server: nur die geltende Fassung zählt, der Zeitpunkt ist die Serverzeit.
    accepted_terms_version: consented ? metadata.acceptedTermsVersion : null,
    accepted_privacy_version: consented ? metadata.acceptedPrivacyVersion : null,
    accepted_license_version: consented ? metadata.acceptedLicenseVersion : null,
    legal_accepted_at: consented ? now : null,
    created_at: now,
    updated_at: now,
  };
}
