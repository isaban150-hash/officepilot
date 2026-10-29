export type UserRole = 'user' | 'admin';
export type UserStatus = 'pending' | 'approved' | 'blocked';
export type LicensePlan = 'beta' | 'starter' | 'pro' | 'premium';
export type LicenseStatus = 'inactive' | 'active' | 'expired' | 'cancelled';

export interface UserAccount {
  id: string;
  companyName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  industry?: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  acceptedTermsVersion?: string;
  acceptedPrivacyVersion?: string;
  acceptedLicenseVersion?: string;
  /** @deprecated Use legalAcceptedAt */
  acceptedAt?: string;
  legalAcceptedAt?: string;
  /** EINRICHTUNG-01 (AP3, K-04.3) — am Profil gespeicherte Oberflächensprache. */
  uiLanguage?: string;
  licensePlan?: LicensePlan;
  licenseStatus?: LicenseStatus;
  licenseStartsAt?: string;
  licenseExpiresAt?: string;
}

export interface License {
  id: string;
  userId: string;
  plan: LicensePlan;
  status: LicenseStatus;
  startsAt: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  userId: string;
  accessToken: string;
  createdAt: string;
  expiresAt?: string;
}

export interface AuthPersistedState {
  version: number;
  users: UserAccount[];
  licenses: License[];
  savedAt: string;
}

export interface RegisterUserInput {
  companyName: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string;
  industry?: string;
  acceptedTermsVersion: string;
  acceptedPrivacyVersion: string;
  acceptedLicenseVersion: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_exists'
  | 'user_not_found'
  | 'user_pending'
  | 'user_blocked'
  | 'license_expired'
  | 'terms_required'
  | 'invalid_email'
  | 'password_too_short'
  /** EINRICHTUNG-01 (AP2, EIN-17; A-07) — eigene Hinweise statt „E-Mail oder Passwort falsch“. */
  | 'email_not_confirmed'
  | 'rate_limited'
  | 'network'
  | 'unknown';

export type RegisterErrorCode =
  /** Wird seit EINRICHTUNG-01 (A-08.1) nicht mehr gemeldet: Bekannte Adressen erhalten die neutrale Antwort. */
  | 'email_exists'
  | 'terms_required'
  | 'invalid_email'
  | 'password_too_short'
  | 'registration_failed'
  | 'weak_password'
  | 'rate_limited'
  | 'network';
