export type ProfileStatus = 'pending' | 'approved' | 'blocked';
export type ProfileRole = 'user' | 'admin';
export type ProfileLicenseStatus = 'inactive' | 'active' | 'expired';

export interface ProfileRow {
  id: string;
  company_name: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  industry: string | null;
  status: ProfileStatus;
  role: ProfileRole;
  license_status: ProfileLicenseStatus;
  license_expires_at: string | null;
  accepted_terms_version: string | null;
  accepted_privacy_version: string | null;
  accepted_license_version: string | null;
  legal_accepted_at: string | null;
  /** EINRICHTUNG-01 (AP3, K-04.3) — Oberflächensprache der Person (`set_own_ui_language`). */
  ui_language?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RegistrationMetadata {
  companyName: string;
  firstName: string;
  lastName: string;
  phone?: string;
  industry?: string;
  acceptedTermsVersion: string;
  acceptedPrivacyVersion: string;
  acceptedLicenseVersion: string;
  legalAcceptedAt: string;
}
