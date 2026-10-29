import type { TranslationKey } from '../../i18n';
import { SETTINGS_TARGET_PATHS, type SettingsTargetId } from './settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.18, F-01) — wo ein Profilfeld bearbeitet wird: Einstellungsziel, Eingabe-ID und
 * Beschriftung. Speichern prüft das ganze Profil; Fehler in Feldern anderer Seiten erscheinen als Liste mit Seite, Feld
 * und Sprung zum Feld (`SettingsForeignFieldErrors`). Die Zielseite setzt den Fokus über `useFocusFieldFromHash`.
 *
 * Schlüssel sind die Fehlerschlüssel des Validators (`validateCompanyProfileForSettings`), also meist Feldnamen und die
 * Sammelangabe `taxIdentifier` (Steuernummer oder USt-IdNr.).
 */
export interface SettingsFieldLocation {
  target: SettingsTargetId;
  inputId: string;
  labelKey: TranslationKey;
}

const company = (field: string, labelKey: string): SettingsFieldLocation => ({
  target: 'company-profile',
  inputId: `settings-company-${field}`,
  labelKey: labelKey as TranslationKey,
});
const invoices = (field: string, labelKey: string): SettingsFieldLocation => ({
  target: 'invoices',
  inputId: `settings-invoices-${field}`,
  labelKey: labelKey as TranslationKey,
});
const communication = (field: string, labelKey: string): SettingsFieldLocation => ({
  target: 'communication',
  inputId: `settings-communication-${field}`,
  labelKey: labelKey as TranslationKey,
});
const offers = (field: string, labelKey: string): SettingsFieldLocation => ({
  target: 'offers',
  inputId: `settings-offers-${field}`,
  labelKey: labelKey as TranslationKey,
});
const letters = (field: string, labelKey: string): SettingsFieldLocation => ({
  target: 'letters',
  inputId: `settings-letters-${field}`,
  labelKey: labelKey as TranslationKey,
});

export const SETTINGS_FIELD_LOCATIONS: Readonly<Record<string, SettingsFieldLocation>> = {
  companyName: company('companyName', 'companyProfile.companyName'),
  legalForm: company('legalForm', 'companyProfile.legalForm'),
  managingDirector: company('managingDirector', 'companyProfile.managingDirector'),
  contactPerson: company('contactPerson', 'companyProfile.contactPerson'),
  street: company('street', 'companyProfile.street'),
  zip: company('zip', 'companyProfile.zip'),
  city: company('city', 'companyProfile.city'),
  country: company('country', 'companyProfile.country'),
  countryCode: company('countryCode', 'companyProfile.countryCode'),
  phone: company('phone', 'companyProfile.phone'),
  email: company('email', 'companyProfile.email'),
  website: company('website', 'companyProfile.website'),
  taxNumber: company('taxNumber', 'companyProfile.taxNumber'),
  vatId: company('vatId', 'companyProfile.vatId'),
  taxIdentifier: company('taxNumber', 'companyProfile.taxNumber'),
  registrationAuthority: company('registrationAuthority', 'companyProfile.registrationAuthority'),
  registrationNumber: company('registrationNumber', 'companyProfile.registrationNumber'),
  bankName: company('bankName', 'companyProfile.bankName'),
  accountHolder: company('accountHolder', 'companyProfile.accountHolder'),
  iban: company('iban', 'companyProfile.iban'),
  bic: company('bic', 'companyProfile.bic'),
  industry: company('industry', 'setup.industry'),
  materialStandard: company('materialStandard', 'setup.materialStandard'),
  communicationChannel: company('communicationChannel', 'setup.communicationChannel'),

  defaultPaymentDays: invoices('defaultPaymentDays', 'settings.invoices.paymentDays'),
  defaultPaymentTerms: invoices('defaultPaymentTerms', 'settings.invoices.paymentTerms'),
  skontoPercent: invoices('skontoPercent', 'settings.invoices.skontoPercent'),
  skontoDays: invoices('skontoDays', 'settings.invoices.skontoDays'),
  defaultTaxStatus: invoices('defaultTaxStatus', 'settings.invoices.taxStatus'),
  defaultIntroText: invoices('defaultIntroText', 'settings.invoices.introText'),
  defaultClosingText: invoices('defaultClosingText', 'settings.invoices.closingText'),
  invoiceFooterNotes: invoices('invoiceFooterNotes', 'settings.invoices.footerNotes'),
  taxFreeNotice: invoices('taxFreeNotice', 'settings.invoices.taxFreeNotice'),

  senderDisplayName: communication('senderDisplayName', 'settings.communication.senderDisplayName'),
  replyToEmail: communication('replyToEmail', 'settings.communication.replyToEmail'),
  communicationLanguage: communication('communicationLanguage', 'settings.communication.language'),
  defaultInvoiceEmailSubject: communication('defaultInvoiceEmailSubject', 'settings.invoices.email.subject'),
  defaultInvoiceEmailBody: communication('defaultInvoiceEmailBody', 'settings.invoices.email.body'),
  emailSignature: communication('emailSignature', 'settings.communication.signature.label'),

  offerValidityDays: offers('offerValidityDays', 'settings.offers.validityDays'),
  offerIntroText: offers('offerIntroText', 'settings.offers.introText'),
  offerClosingText: offers('offerClosingText', 'settings.offers.closingText'),
  orderIntroText: offers('orderIntroText', 'settings.orders.introText'),
  orderClosingText: offers('orderClosingText', 'settings.orders.closingText'),

  letterSalutation: letters('letterSalutation', 'settings.letters.salutation'),
  letterClosing: letters('letterClosing', 'settings.letters.closing'),

  documentTemplate: { target: 'logo', inputId: 'settings-design-template', labelKey: 'settings.design.section.template' as TranslationKey },
};

export function settingsFieldLocation(field: string): SettingsFieldLocation | null {
  return SETTINGS_FIELD_LOCATIONS[field] ?? null;
}

/** Sprungadresse zum Feld (Hash = Eingabe-ID). */
export function settingsFieldHref(location: SettingsFieldLocation): string {
  return `${SETTINGS_TARGET_PATHS[location.target]}#${location.inputId}`;
}
