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

  /*
   * COMPANY-PROFILE-REGISTER-01I — nur äussere Leerzeichen fallen weg.
   *
   * „ HRB 12345 " und „HRB 12345" sind dieselbe Registernummer; ein
   * mitgeschlepptes Leerzeichen würde sonst als Änderung der rechtlichen
   * Stammdaten gelten und beim nächsten Rechnungsentwurf eine Rückfrage
   * auslösen, die nichts bedeutet. Weiter geht die Normalisierung bewusst
   * nicht: Gross-/Kleinschreibung und innere Zeichen sind Teil der Angabe.
   */
  /*
   * COMPANY-PROFILE-MANAGING-DIRECTOR-UX-01 — `managingDirector` folgt
   * derselben Regel, und ausdrücklich **nur** dieser.
   *
   * Das Feld darf mehrere Namen tragen („Max Mustermann, Erika Beispiel"). Was
   * innen steht, gehört dem Betrieb: Kommas, Semikolons, doppelte Leerzeichen
   * und die Reihenfolge bleiben unangetastet. Nichts wird aufgeteilt und
   * nichts einzeln nachgeputzt — eine Namensliste zu normalisieren hiesse zu
   * raten, wo ein Name aufhört.
   */
  for (const field of [
    'registrationAuthority',
    'registrationNumber',
    'managingDirector',
  ] as const) {
    if (partial[field] !== undefined) {
      merged[field] = (partial[field] ?? '').trim();
    }
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
