import type { CompanyProfile } from '../types/models';
import type { SetupWizardDraft, SetupWizardStep } from '../types/setup';
import type { TranslationKey } from '../i18n';
import { isDocumentTemplateId } from '../types/branding';
import {
  COMPANY_PROFILE_TEXT_LIMITS,
  isTaxStatus,
} from './company/companyProfileSettingsContract';
import { checkIban } from '../utils/iban';

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

/** Die frühere Formprüfung — nur noch für Seiten, auf denen die IBAN nicht bearbeitet wird. */
function hasIbanShape(value: string): boolean {
  const iban = normalizeIban(value);
  return iban.length >= 15 && iban.length <= 34 && /^[A-Z0-9]+$/.test(iban);
}

/**
 * BROWSER-ACCEPTANCE-FIX 01 / B2 — wie wird die IBAN geprüft?
 *
 * `strict` (Standard): Ländercode, Länge je Land und Prüfziffer (Mod-97).
 * `shape`: nur die frühere Formprüfung. Für Seiten, auf denen die IBAN weder
 * sichtbar noch änderbar ist (Rechnungseinstellungen): Eine alte, ungültige
 * IBAN soll dort nicht das Speichern anderer Angaben blockieren, ohne dass der
 * Nutzer sie an Ort und Stelle korrigieren könnte. Korrigiert — und streng
 * geprüft — wird sie in den Firmendaten.
 */
export interface SetupValidationOptions {
  ibanCheck?: 'strict' | 'shape';
}

export function ibanErrorKey(value: string): TranslationKey | null {
  const result = checkIban(value);
  if (result.valid) return null;
  switch (result.problem) {
    case 'empty':
      return 'setup.error.ibanRequired';
    case 'characters':
      return 'setup.error.ibanCharacters';
    case 'country':
      return 'setup.error.ibanCountry';
    case 'length':
      return result.normalized.startsWith('DE') ? 'setup.error.ibanLengthDe' : 'setup.error.ibanLength';
    case 'checksum':
      return 'setup.error.ibanChecksum';
    default:
      return 'setup.error.ibanInvalid';
  }
}

function hasTaxIdentifier(draft: Pick<SetupWizardDraft, 'taxNumber' | 'vatId'>): boolean {
  return Boolean(draft.taxNumber.trim() || draft.vatId.trim());
}

export function validateSetupStep(
  step: SetupWizardStep,
  draft: SetupWizardDraft,
  options: SetupValidationOptions = {},
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
    const iban = (draft.iban ?? '').toString();
    if (!iban.trim()) errors.iban = 'setup.error.ibanRequired';
    else if (options.ibanCheck === 'shape') {
      if (!hasIbanShape(iban)) errors.iban = 'setup.error.ibanInvalid';
    } else {
      const ibanError = ibanErrorKey(iban);
      if (ibanError) errors.iban = ibanError;
    }
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

export function validateSetupWizard(
  draft: SetupWizardDraft,
  options: SetupValidationOptions = {},
): SetupValidationResult {
  const merged: SetupValidationErrors = {};
  for (const step of ['company', 'tax', 'bank', 'invoicing'] as SetupWizardStep[]) {
    const result = validateSetupStep(step, draft, options);
    Object.assign(merged, result.errors);
  }
  return { valid: Object.keys(merged).length === 0, errors: merged };
}

export function validateCompanyProfileForSettings(
  profile: CompanyProfile,
  lastInvoiceNumber?: number,
  options: SetupValidationOptions = {},
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
    iban: profile.iban ?? '',
    bic: profile.bic,
    defaultPaymentDays: profile.defaultPaymentDays,
    defaultPaymentTerms: profile.defaultPaymentTerms,
    lastInvoiceNumber: lastInvoiceNumber ?? 0,
  };
  const result = validateSetupWizard(draft, options);
  return {
    ...result,
    ...mergeSettingsFieldErrors(profile, mergeSkontoErrors(profile, result)),
  };
}

/**
 * SETTINGS-01B1 — die neuen Profilfelder. Längen wie bei vergleichbaren
 * Feldern (Kontoinhaber wie ein Name, Standardtexte wie Fussnoten), ein
 * Steuerstatus nur aus der bekannten Menge, eine Vorlage nur aus den
 * implementierten. Leer ist überall erlaubt.
 */
function mergeSettingsFieldErrors(
  profile: CompanyProfile,
  result: SetupValidationResult,
): SetupValidationResult {
  const errors: SetupValidationErrors = { ...result.errors };

  const accountHolder = profile.accountHolder ?? '';
  if (accountHolder.trim().length > COMPANY_PROFILE_TEXT_LIMITS.accountHolder) {
    errors.accountHolder = 'companyProfile.accountHolderTooLong';
  }
  if ((profile.defaultIntroText ?? '').trim().length > COMPANY_PROFILE_TEXT_LIMITS.defaultIntroText) {
    errors.defaultIntroText = 'companyProfile.defaultIntroTextTooLong';
  }
  if ((profile.defaultClosingText ?? '').trim().length > COMPANY_PROFILE_TEXT_LIMITS.defaultClosingText) {
    errors.defaultClosingText = 'companyProfile.defaultClosingTextTooLong';
  }
  // EMAIL-01B4 — Standard-E-Mail-Texte: Betreff einzeilig, Grenzen wie der Versandserver.
  const emailSubject = (profile.defaultInvoiceEmailSubject ?? '').trim();
  if (emailSubject.length > COMPANY_PROFILE_TEXT_LIMITS.defaultInvoiceEmailSubject || emailSubject.includes('\n') || emailSubject.includes('\r')) {
    errors.defaultInvoiceEmailSubject = 'companyProfile.defaultInvoiceEmailSubjectInvalid';
  }
  if ((profile.defaultInvoiceEmailBody ?? '').trim().length > COMPANY_PROFILE_TEXT_LIMITS.defaultInvoiceEmailBody) {
    errors.defaultInvoiceEmailBody = 'companyProfile.defaultInvoiceEmailBodyTooLong';
  }
  if (profile.defaultTaxStatus !== undefined && !isTaxStatus(profile.defaultTaxStatus)) {
    errors.defaultTaxStatus = 'companyProfile.defaultTaxStatusInvalid';
  }
  const template = profile.branding?.documentTemplate;
  if (template !== undefined && !isDocumentTemplateId(template)) {
    errors.documentTemplate = 'companyProfile.documentTemplateInvalid';
  }

  const valid = Object.keys(errors).length === 0;
  return { ...result, valid, errors };
}

/**
 * SKONTO-NUMERIC-INPUT-01B — Skonto wird erstmals wirklich geprüft.
 *
 * Bis hierher gab es dafür keine Regel. Das fiel nicht auf, weil die Eingabe
 * jeden ungültigen Wert über `Number(…) || 0` still zu `0` machte und ein
 * Skontosatz mit `0` ohnehin nicht entsteht. Mit einem Feld, das einen leeren
 * Zwischenzustand zulässt, fällt diese unbeabsichtigte Schutzschicht weg —
 * deshalb steht die Regel jetzt hier, an der zentralen Stelle, und nicht in der
 * Oberfläche.
 *
 * Geprüft wird nur, wenn der Betrieb Skonto ausdrücklich eingeschaltet hat.
 * Ist es aus, dürfen Prozentsatz und Frist `0` bleiben; es wird nichts
 * erzwungen und nichts gelöscht.
 */
function mergeSkontoErrors(
  profile: CompanyProfile,
  result: SetupValidationResult,
): SetupValidationResult {
  if (profile.skontoEnabled !== true) return result;

  const errors: SetupValidationErrors = { ...result.errors };
  const percent = profile.skontoPercent ?? 0;
  const days = profile.skontoDays ?? 0;

  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    errors.skontoPercent = 'companyProfile.skontoPercentInvalid';
  }
  if (!Number.isFinite(days) || days <= 0) {
    errors.skontoDays = 'companyProfile.skontoDaysInvalid';
  } else if (Number.isFinite(profile.defaultPaymentDays) && days > profile.defaultPaymentDays) {
    /*
     * SKONTO-DUE-DATE-CONSISTENCY-01B — die Frist darf das Zahlungsziel nicht
     * überholen.
     *
     * Realbefund: gespeichert waren 7 Tage Zahlungsziel und 10 Tage Skontofrist.
     * Die Rechnung versprach damit einen Abzug für einen Zeitraum, in dem die
     * Forderung längst fällig war. Beide Zahlen waren für sich gültig; erst ihr
     * Verhältnis ist der Fehler — deshalb steht die Prüfung hier, wo beide
     * vorliegen, und nicht bei einem der Felder allein.
     *
     * Gleichstand ist erlaubt: Ein Nachlass bis zum Fälligkeitstag ist
     * wirtschaftlich schwach, aber nicht widersprüchlich. Der Betrieb darf ihn
     * wählen.
     *
     * Der Fehler hängt an `skontoDays`, weil die Frist die abhängige Grösse ist
     * — das Zahlungsziel gilt für alle Rechnungen, das Skonto nur für dieses
     * Angebot. Korrigieren kann der Nutzer trotzdem beides; automatisch wird
     * nichts geändert.
     */
    errors.skontoDays = 'companyProfile.skontoDaysExceedPaymentDays';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}
