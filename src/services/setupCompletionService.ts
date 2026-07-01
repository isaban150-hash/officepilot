import { hydrateCompanyProfileStore } from './companyProfileService';
import {
  getCurrentInvoiceYear,
  hydrateInvoiceNumberSequence,
} from './invoiceNumberService';
import { persistAll } from './persistenceService';
import { validateSetupWizard } from './setupValidationService';
import type { CompanyProfile, CompanySetup } from '../types/models';
import { SETUP_VERSION, type SetupWizardDraft } from '../types/setup';
import type { TranslationKey } from '../i18n';

export type SetupCompletionResult =
  | { success: true; setup: CompanySetup; profile: CompanyProfile }
  | { success: false; errorKey?: TranslationKey; errors?: Partial<Record<string, TranslationKey>> };

function buildProfileFromDraft(draft: SetupWizardDraft): CompanyProfile {
  return {
    companyName: draft.companyName.trim(),
    legalForm: '',
    street: draft.street.trim(),
    zip: draft.zip.trim(),
    city: draft.city.trim(),
    country: draft.country.trim() || 'Deutschland',
    contactPerson: draft.contactPerson.trim(),
    phone: draft.phone.trim(),
    email: draft.email.trim(),
    website: '',
    taxNumber: draft.taxNumber.trim(),
    vatId: draft.vatId.trim(),
    bankName: draft.bankName.trim(),
    iban: draft.iban.replace(/\s+/g, '').toUpperCase(),
    bic: draft.bic.trim(),
    defaultPaymentDays: Math.round(draft.defaultPaymentDays),
    defaultPaymentTerms: draft.defaultPaymentTerms.trim(),
    defaultSkonto: '',
    invoiceFooterNotes: '',
  };
}

function buildSetupFromDraft(draft: SetupWizardDraft, currentSetup: CompanySetup): CompanySetup {
  return {
    ...currentSetup,
    companyName: draft.companyName.trim(),
    industry: draft.industry.trim(),
    taxStatus: draft.taxStatus,
    materialStandard: draft.materialStandard,
    language: draft.language,
    communicationChannel: draft.communicationChannel,
    setupComplete: true,
    setupVersion: SETUP_VERSION,
  };
}

export function completeSetupWizard(
  draft: SetupWizardDraft,
  currentSetup: CompanySetup,
): SetupCompletionResult {
  const validation = validateSetupWizard(draft);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  const profile = buildProfileFromDraft(draft);
  const nextSetup = buildSetupFromDraft(draft, currentSetup);

  hydrateCompanyProfileStore(profile);
  hydrateInvoiceNumberSequence({
    year: getCurrentInvoiceYear(),
    lastIssuedNumber: Math.round(draft.lastInvoiceNumber),
  });
  persistAll(nextSetup);

  return { success: true, setup: nextSetup, profile };
}
