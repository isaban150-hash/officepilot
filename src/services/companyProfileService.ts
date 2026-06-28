import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { getCachedSetup, persistAll } from './persistenceService';
import type { CompanyProfile } from '../types/models';

let companyProfile: CompanyProfile = { ...DEFAULT_COMPANY_PROFILE };

function cloneProfile(profile: CompanyProfile): CompanyProfile {
  return {
    ...profile,
    logoDataUrl: profile.logoDataUrl,
  };
}

export function getCompanyProfileStoreSnapshot(): CompanyProfile {
  return cloneProfile(companyProfile);
}

export function hydrateCompanyProfileStore(profile: CompanyProfile): void {
  companyProfile = cloneProfile({ ...DEFAULT_COMPANY_PROFILE, ...profile });
}

export function resetCompanyProfile(setupCompanyName = ''): void {
  companyProfile = {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: setupCompanyName,
  };
}

export function getCompanyProfile(): CompanyProfile {
  return cloneProfile(companyProfile);
}

export function createCompanyProfileSnapshot(): CompanyProfile {
  return cloneProfile(companyProfile);
}

export type CompanyProfileUpdateResult =
  | { success: true; profile: CompanyProfile }
  | { success: false; errorKey: string };

export function updateCompanyProfile(
  partial: Partial<CompanyProfile>,
): CompanyProfileUpdateResult {
  const merged: CompanyProfile = {
    ...companyProfile,
    ...partial,
  };

  if (partial.companyName !== undefined && !merged.companyName.trim()) {
    return { success: false, errorKey: 'companyProfile.nameRequired' };
  }

  if (partial.defaultPaymentDays !== undefined) {
    const days = Number(partial.defaultPaymentDays);
    if (!Number.isFinite(days) || days < 0) {
      return { success: false, errorKey: 'companyProfile.paymentDaysInvalid' };
    }
    merged.defaultPaymentDays = Math.round(days);
  }

  companyProfile = cloneProfile(merged);

  const setup = getCachedSetup();
  if (companyProfile.companyName && companyProfile.companyName !== setup.companyName) {
    persistAll({ ...setup, companyName: companyProfile.companyName });
  } else {
    persistAll();
  }

  return { success: true, profile: getCompanyProfile() };
}

export function syncCompanyProfileFromSetup(setupCompanyName: string): void {
  if (!companyProfile.companyName.trim() && setupCompanyName.trim()) {
    companyProfile = { ...companyProfile, companyName: setupCompanyName.trim() };
  }
}
