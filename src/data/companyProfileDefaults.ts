import type { CompanyProfile, CompanySetup } from '../types/models';

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
  bankName: '',
  iban: '',
  bic: '',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

export function createCompanyProfileFromSetup(setup: CompanySetup): CompanyProfile {
  return {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: setup.companyName,
  };
}
