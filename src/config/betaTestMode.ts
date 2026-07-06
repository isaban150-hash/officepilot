import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import type { CompanyProfile, CompanySetup } from '../types/models';

export function isBetaTestMode(): boolean {
  return import.meta.env.VITE_BETA_TEST_MODE === 'true';
}

export const BETA_TEST_SETUP: CompanySetup = {
  companyName: 'Musterbetrieb GmbH',
  industry: 'Handwerk – Sanitär/Heizung',
  taxStatus: 'standard_19',
  materialStandard: 'betrieb',
  language: 'de',
  setupComplete: true,
  setupVersion: 1,
  communicationChannel: 'email',
};

export const BETA_TEST_COMPANY_PROFILE: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Musterbetrieb GmbH',
  legalForm: 'GmbH',
  contactPerson: 'Max Mustermann',
  street: 'Handwerkerweg 7',
  zip: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  phone: '030 1234567',
  email: 'info@musterbetrieb.de',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse Berlin',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
  defaultSkonto: '',
  managingDirector: 'Max Mustermann',
  invoiceFooterNotes: 'Musterbetrieb GmbH · Handwerkerweg 7 · 10115 Berlin',
};

export function shouldSkipSetupWizard(setup: CompanySetup): boolean {
  return isBetaTestMode() && setup.setupComplete;
}
