import type { Session, User } from '@supabase/supabase-js';
import type { AuthSession, RegisterUserInput } from '../../types/auth';
import { buildRegistrationMetadata } from './profileMapper';

export interface OfficePilotUserMetadata {
  companyName?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  industry?: string;
  acceptedTermsVersion?: string;
  acceptedPrivacyVersion?: string;
  acceptedLicenseVersion?: string;
  legalAcceptedAt?: string;
}

function readMetadata(user: User): OfficePilotUserMetadata {
  const raw = (user.user_metadata ?? {}) as Record<string, string | undefined>;
  return {
    companyName: raw.companyName ?? raw.company_name,
    firstName: raw.firstName ?? raw.first_name,
    lastName: raw.lastName ?? raw.last_name,
    phone: raw.phone,
    industry: raw.industry,
    acceptedTermsVersion: raw.acceptedTermsVersion ?? raw.accepted_terms_version,
    acceptedPrivacyVersion: raw.acceptedPrivacyVersion ?? raw.accepted_privacy_version,
    acceptedLicenseVersion: raw.acceptedLicenseVersion ?? raw.accepted_license_version,
    legalAcceptedAt: raw.legalAcceptedAt ?? raw.legal_accepted_at,
  };
}

export function buildSignUpMetadata(input: RegisterUserInput): Record<string, string> {
  return buildRegistrationMetadata(input);
}

export function mapSupabaseSession(session: Session): AuthSession {
  return {
    userId: session.user.id,
    accessToken: session.access_token,
    createdAt: new Date(session.user.created_at).toISOString(),
    expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : undefined,
  };
}

export function mapRegistrationPreviewFromUser(user: User) {
  const metadata = readMetadata(user);
  const createdAt = user.created_at ? new Date(user.created_at).toISOString() : new Date().toISOString();

  return {
    id: user.id,
    email: user.email ?? '',
    companyName: metadata.companyName ?? '',
    firstName: metadata.firstName ?? '',
    lastName: metadata.lastName ?? '',
    phone: metadata.phone,
    industry: metadata.industry,
    createdAt,
    acceptedTermsVersion: metadata.acceptedTermsVersion,
    acceptedPrivacyVersion: metadata.acceptedPrivacyVersion,
    acceptedLicenseVersion: metadata.acceptedLicenseVersion,
    legalAcceptedAt: metadata.legalAcceptedAt,
  };
}

/** @deprecated Verwende mapProfileRowToUserAccount aus profileMapper. */
export function mapSupabaseUserToAccount(user: User) {
  const preview = mapRegistrationPreviewFromUser(user);
  return {
    ...preview,
    role: 'user' as const,
    status: 'pending' as const,
    updatedAt: preview.createdAt,
    acceptedAt: preview.legalAcceptedAt,
  };
}
