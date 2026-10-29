import { getCompanyProfile, hydrateCompanyProfileStore } from './companyProfileService';
import {
  getCurrentInvoiceYear,
  getInvoiceNumberSequenceSnapshot,
  hydrateInvoiceNumberSequence,
} from './invoiceNumberService';
import { getCachedSetup, persistAll, setCachedSetup } from './persistenceService';
import { validateSetupWizard } from './setupValidationService';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import type { CompanyProfile, CompanySetup } from '../types/models';
import { SETUP_VERSION, type SetupWizardDraft } from '../types/setup';
import type { TranslationKey } from '../i18n';

export type SetupCompletionResult =
  | { success: true; setup: CompanySetup; profile: CompanyProfile }
  | {
      success: false;
      errorKey?: TranslationKey;
      errors?: Partial<Record<string, TranslationKey>>;
      /** EINRICHTUNG-01 (AP3, O-04.3) — der Assistent bietet „Erneut versuchen“ an (etwa beim Nummernkreis). */
      retryable?: boolean;
    };

function buildProfileFromDraft(draft: SetupWizardDraft): CompanyProfile {
  return {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: draft.companyName.trim(),
    // EINRICHTUNG-01 (AP3, O-02.2) — bisher fest leer; jetzt die optionale Angabe aus dem Assistenten.
    legalForm: (draft.legalForm ?? '').trim(),
    street: draft.street.trim(),
    zip: draft.zip.trim(),
    city: draft.city.trim(),
    country: draft.country.trim() || 'Deutschland',
    contactPerson: draft.contactPerson.trim(),
    phone: draft.phone.trim(),
    email: draft.email.trim(),
    // 01B — Onboarding-Entscheidungen landen im Profil (Wahrheit), das Setup bleibt Spiegel.
    defaultTaxStatus: draft.taxStatus,
    currency: 'EUR',
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

export interface SetupCompletionOptions {
  /**
   * EINRICHTUNG-01 (AP3, EIN-14; E6) — im Cloud-Betrieb gehört die Sprachwahl im Assistenten der Person (Profil und
   * Gerät), nicht dem Betrieb: Das Setup behält seine bisherige Sprache. Im lokalen Betrieb gehört das Setup dem
   * Gerät, dort gilt die Wahl wie bisher für das Setup.
   */
  keepSetupLanguage?: boolean;
}

function buildSetupFromDraft(
  draft: SetupWizardDraft,
  currentSetup: CompanySetup,
  options: SetupCompletionOptions,
): CompanySetup {
  return {
    ...currentSetup,
    companyName: draft.companyName.trim(),
    industry: draft.industry.trim(),
    taxStatus: draft.taxStatus,
    materialStandard: draft.materialStandard,
    language: options.keepSetupLanguage ? currentSetup.language : draft.language,
    communicationChannel: draft.communicationChannel,
    setupComplete: true,
    setupVersion: SETUP_VERSION,
  };
}

export function completeSetupWizard(
  draft: SetupWizardDraft,
  currentSetup: CompanySetup,
  options: SetupCompletionOptions = {},
): SetupCompletionResult {
  const validation = validateSetupWizard(draft);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  const profile = buildProfileFromDraft(draft);
  const nextSetup = buildSetupFromDraft(draft, currentSetup, options);

  /**
   * OFFICEPILOT-SETUP-CLOUD-PERSIST-01C — vor dem Hydrieren den bisherigen Stand
   * merken. Scheitert das lokale Speichern, darf kein halb abgeschlossener
   * Zustand in den Stores zurückbleiben.
   */
  const previousProfile = getCompanyProfile();
  const previousSequence = getInvoiceNumberSequenceSnapshot();
  /*
   * EINRICHTUNG-01 (AP3, O-01.3) — auch das Setup im Speicher: `persistAll(nextSetup)` übernimmt es vor dem Schreiben.
   * Scheitert das Schreiben, stand sonst im Speicher „abgeschlossen“, und die nächste Setup-Änderung (etwa die
   * Sprachwahl im Assistenten) hätte den Abschluss ohne Firmenprofil gespeichert — ein vorgetäuschter Abschluss.
   */
  const previousSetup = getCachedSetup();

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
    setCachedSetup(previousSetup);
    return { success: false, errorKey: 'persist.banner.message' };
  }

  return { success: true, setup: nextSetup, profile };
}
