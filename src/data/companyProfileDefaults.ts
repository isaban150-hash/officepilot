import type { CompanyProfile, CompanySetup } from '../types/models';
import { STANDARD_TAX_FREE_NOTICE } from '../services/invoice/taxNoticeTexts';

export const DEFAULT_COMPANY_PROFILE: CompanyProfile = {
  companyName: '',
  legalForm: '',
  street: '',
  zip: '',
  city: '',
  country: 'Deutschland',
  contactPerson: '',
  phone: '',
  email: '',
  website: '',
  taxNumber: '',
  vatId: '',
  registrationAuthority: '',
  registrationNumber: '',
  bankName: '',
  iban: '',
  bic: '',
  // SETTINGS-01B1 — `accountHolder`, `defaultTaxStatus`, `defaultIntroText`,
  // `defaultClosingText` und `branding.documentTemplate` bleiben hier bewusst
  // abwesend: fehlend heisst leer / Legacy-Fallback / implizit classic, und ein
  // Altprofil erzeugt weiterhin denselben companySnapshot wie bisher.
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
  defaultSkonto: '',
  skontoEnabled: false,
  skontoPercent: 0,
  skontoDays: 0,
  managingDirector: '',
  // EINRICHTUNG-01 (AP6; V-02) — derselbe Standardhinweis wie der Rückfall auf Rechnung und Angebot.
  taxFreeNotice: STANDARD_TAX_FREE_NOTICE,
  invoiceFooterNotes: '',
};

export function createCompanyProfileFromSetup(setup: CompanySetup): CompanyProfile {
  return {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: setup.companyName,
  };
}
