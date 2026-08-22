import { getCompanyProfile, hydrateCompanyProfileStore } from './companyProfileService';
import {
  getCurrentInvoiceYear,
  getInvoiceNumberSequenceSnapshot,
  hydrateInvoiceNumberSequence,
} from './invoiceNumberService';
import { persistAll } from './persistenceService';
import { validateSetupWizard } from './setupValidationService';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import type { CompanyProfile, CompanySetup } from '../types/models';
import { SETUP_VERSION, type SetupWizardDraft } from '../types/setup';
import type { TranslationKey } from '../i18n';

export type SetupCompletionResult =
  | { success: true; setup: CompanySetup; profile: CompanyProfile }
  | { success: false; errorKey?: TranslationKey; errors?: Partial<Record<string, TranslationKey>> };

function buildProfileFromDraft(draft: SetupWizardDraft): CompanyProfile {
  return {
    ...DEFAULT_COMPANY_PROFILE,
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

  /**
   * OFFICEPILOT-SETUP-CLOUD-PERSIST-01C — vor dem Hydrieren den bisherigen Stand
   * merken. Scheitert das lokale Speichern, darf kein halb abgeschlossener
   * Zustand in den Stores zurückbleiben.
   */
  const previousProfile = getCompanyProfile();
  const previousSequence = getInvoiceNumberSequenceSnapshot();

  hydrateCompanyProfileStore(profile);
  hydrateInvoiceNumberSequence({
    year: getCurrentInvoiceYear(),
    lastIssuedNumber: Math.round(draft.lastInvoiceNumber),
  });
  /**
   * OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — die lokale Speicherung ist maßgeblich.
   * Schlägt sie fehl, gilt der Assistent nicht als abgeschlossen; erst danach
   * darf überhaupt an eine Cloud-Sicherung gedacht werden.
   */
  const persisted = persistAll(nextSetup);
  if (!persisted.success) {
    // Stores auf den Stand vor dem Abschluss zurücksetzen.
    hydrateCompanyProfileStore(previousProfile);
    hydrateInvoiceNumberSequence(previousSequence);
    return { success: false, errorKey: 'persist.banner.message' };
  }

  return { success: true, setup: nextSetup, profile };
}
