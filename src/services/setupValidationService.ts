import type { CompanyProfile } from '../types/models';
import type { SetupWizardDraft, SetupWizardStep } from '../types/setup';
import type { TranslationKey } from '../i18n';

export type SetupValidationErrors = Partial<Record<string, TranslationKey>>;

export interface SetupValidationResult {
  valid: boolean;
  errors: SetupValidationErrors;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function normalizeIban(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

function isValidIban(value: string): boolean {
  const iban = normalizeIban(value);
  return iban.length >= 15 && iban.length <= 34 && /^[A-Z0-9]+$/.test(iban);
}

function hasTaxIdentifier(draft: Pick<SetupWizardDraft, 'taxNumber' | 'vatId'>): boolean {
  return Boolean(draft.taxNumber.trim() || draft.vatId.trim());
}

export function validateSetupStep(
  step: SetupWizardStep,
  draft: SetupWizardDraft,
): SetupValidationResult {
  const errors: SetupValidationErrors = {};

  if (step === 'company') {
    if (!draft.companyName.trim()) errors.companyName = 'setup.error.companyNameRequired';
    if (!draft.contactPerson.trim()) errors.contactPerson = 'setup.error.contactPersonRequired';
    if (!draft.street.trim()) errors.street = 'setup.error.streetRequired';
    if (!draft.zip.trim()) errors.zip = 'setup.error.zipRequired';
    if (!draft.city.trim()) errors.city = 'setup.error.cityRequired';
    if (!draft.email.trim()) errors.email = 'setup.error.emailRequired';
    else if (!isValidEmail(draft.email)) errors.email = 'setup.error.emailInvalid';
  }

  if (step === 'tax') {
    if (!hasTaxIdentifier(draft)) errors.taxIdentifier = 'setup.error.taxIdentifierRequired';
  }

  if (step === 'bank') {
    if (!draft.iban.trim()) errors.iban = 'setup.error.ibanRequired';
    else if (!isValidIban(draft.iban)) errors.iban = 'setup.error.ibanInvalid';
  }

  if (step === 'invoicing') {
    if (!Number.isFinite(draft.lastInvoiceNumber) || draft.lastInvoiceNumber < 0) {
      errors.lastInvoiceNumber = 'setup.error.lastInvoiceNumberInvalid';
    }
    if (!Number.isFinite(draft.defaultPaymentDays) || draft.defaultPaymentDays < 0) {
      errors.defaultPaymentDays = 'companyProfile.paymentDaysInvalid';
    }
    if (!draft.defaultPaymentTerms.trim()) {
      errors.defaultPaymentTerms = 'setup.error.paymentTermsRequired';
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

export function validateSetupWizard(draft: SetupWizardDraft): SetupValidationResult {
  const merged: SetupValidationErrors = {};
  for (const step of ['company', 'tax', 'bank', 'invoicing'] as SetupWizardStep[]) {
    const result = validateSetupStep(step, draft);
    Object.assign(merged, result.errors);
  }
  return { valid: Object.keys(merged).length === 0, errors: merged };
}

export function validateCompanyProfileForSettings(
  profile: CompanyProfile,
  lastInvoiceNumber?: number,
): SetupValidationResult {
  const draft: SetupWizardDraft = {
    language: 'de',
    industry: '',
    taxStatus: 'standard_19',
    materialStandard: 'betrieb',
    communicationChannel: 'email',
    companyName: profile.companyName,
    contactPerson: profile.contactPerson,
    street: profile.street,
    zip: profile.zip,
    city: profile.city,
    country: profile.country,
    email: profile.email,
    phone: profile.phone,
    taxNumber: profile.taxNumber,
    vatId: profile.vatId,
    bankName: profile.bankName,
    iban: profile.iban,
    bic: profile.bic,
    defaultPaymentDays: profile.defaultPaymentDays,
    defaultPaymentTerms: profile.defaultPaymentTerms,
    lastInvoiceNumber: lastInvoiceNumber ?? 0,
  };
  return validateSetupWizard(draft);
}
