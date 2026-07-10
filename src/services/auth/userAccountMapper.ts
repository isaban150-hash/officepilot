import type { Session, User } from '@supabase/supabase-js';
import type {
  AuthSession,
  License,
  LicensePlan,
  LicenseStatus,
  RegisterUserInput,
  UserAccount,
  UserRole,
  UserStatus,
} from '../../types/auth';

export interface OfficePilotUserMetadata {
  company_name?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  industry?: string;
  status?: UserStatus;
  role?: UserRole;
  accepted_terms_version?: string;
  accepted_privacy_version?: string;
  accepted_license_version?: string;
  legal_accepted_at?: string;
  license_plan?: LicensePlan;
  license_status?: LicenseStatus;
  license_expires_at?: string;
  license_starts_at?: string;
}

function readMetadata(user: User): OfficePilotUserMetadata {
  return (user.user_metadata ?? {}) as OfficePilotUserMetadata;
}

export function buildSignUpMetadata(input: RegisterUserInput): OfficePilotUserMetadata {
  const now = new Date().toISOString();
  return {
    company_name: input.companyName.trim(),
    first_name: input.firstName.trim(),
    last_name: input.lastName.trim(),
    phone: input.phone?.trim() || undefined,
    industry: input.industry?.trim() || undefined,
    status: 'pending',
    role: 'user',
    accepted_terms_version: input.acceptedTermsVersion,
    accepted_privacy_version: input.acceptedPrivacyVersion,
    accepted_license_version: input.acceptedLicenseVersion,
    legal_accepted_at: now,
  };
}

export function mapSupabaseSession(session: Session): AuthSession {
  return {
    userId: session.user.id,
    accessToken: session.access_token,
    createdAt: new Date(session.user.created_at).toISOString(),
    expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : undefined,
  };
}

export function mapSupabaseUserToAccount(user: User): UserAccount {
  const metadata = readMetadata(user);
  const createdAt = user.created_at ? new Date(user.created_at).toISOString() : new Date().toISOString();
  const updatedAt = user.updated_at ? new Date(user.updated_at).toISOString() : createdAt;

  return {
    id: user.id,
    companyName: metadata.company_name ?? '',
    firstName: metadata.first_name ?? '',
    lastName: metadata.last_name ?? '',
    email: user.email ?? '',
    phone: metadata.phone,
    industry: metadata.industry,
    role: metadata.role ?? 'user',
    status: metadata.status ?? 'pending',
    createdAt,
    updatedAt,
    lastLoginAt: user.last_sign_in_at ? new Date(user.last_sign_in_at).toISOString() : undefined,
    acceptedTermsVersion: metadata.accepted_terms_version,
    acceptedPrivacyVersion: metadata.accepted_privacy_version,
    acceptedLicenseVersion: metadata.accepted_license_version,
    legalAcceptedAt: metadata.legal_accepted_at,
    acceptedAt: metadata.legal_accepted_at,
    licensePlan: metadata.license_plan,
    licenseStatus: metadata.license_status,
    licenseStartsAt: metadata.license_starts_at,
    licenseExpiresAt: metadata.license_expires_at,
  };
}

export function mapLicenseFromUser(user: UserAccount): License | undefined {
  if (!user.licensePlan || !user.licenseStatus) return undefined;

  const startsAt = user.licenseStartsAt ?? user.createdAt;
  return {
    id: `lic-${user.id}`,
    userId: user.id,
    plan: user.licensePlan,
    status: user.licenseStatus,
    startsAt,
    expiresAt: user.licenseExpiresAt,
    createdAt: startsAt,
    updatedAt: user.updatedAt,
  };
}

export function withUpdatedMetadata(
  user: User,
  patch: Partial<OfficePilotUserMetadata>,
): OfficePilotUserMetadata {
  return {
    ...readMetadata(user),
    ...patch,
  };
}

export function buildActiveLicenseMetadata(daysValid = 90): Partial<OfficePilotUserMetadata> {
  const startsAt = new Date().toISOString();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + daysValid);
  return {
    status: 'active',
    license_plan: 'beta',
    license_status: 'active',
    license_starts_at: startsAt,
    license_expires_at: expiresAt.toISOString(),
  };
}
