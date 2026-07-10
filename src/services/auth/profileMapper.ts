import type {
  License,
  UserAccount,
  UserRole,
  UserStatus,
} from '../../types/auth';
import type { ProfileLicenseStatus, ProfileRow } from '../../types/profile';

export type ProfileLoadResult =
  | { success: true; profile: ProfileRow }
  | { success: false; error: 'not_found' | 'query_failed' };

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
    accepted_terms_version: metadata.acceptedTermsVersion,
    accepted_privacy_version: metadata.acceptedPrivacyVersion,
    accepted_license_version: metadata.acceptedLicenseVersion,
    legal_accepted_at: metadata.legalAcceptedAt,
    created_at: now,
    updated_at: now,
  };
}
