import type { CompanyProfile } from '../../types/models';

/**
 * EINRICHTUNG-01 (EIN-06, S-09) — der Feldkatalog des Firmenprofils.
 *
 * Jedes Feld von `CompanyProfile` steht in genau einer Klasse:
 *
 *   transferred — liegt im Cloud-Profil (`workspace_company_profiles.payload`)
 *   localOnly   — bleibt auf dem Gerät: `logoDataUrl`, das eingebettete Alt-Bild,
 *                 wird vor dem Senden entfernt
 *   excluded    — weder gespeichert noch übertragen (derzeit keines)
 *
 * Ein neues Feld ohne Eintrag lässt die Typprüfung (`satisfies`) und den
 * Klassifikationstest scheitern. Wer ein Feld überträgt, trägt es zusätzlich mit
 * seiner Einführungsversion in {@link COMPANY_PROFILE_FIELD_INTRODUCED_IN} und im
 * Server-Katalog ein (`upsert_workspace_sync_entity`, Firmenprofil-Zweig).
 *
 * Bewusst getrennt vom Rechnungs-Snapshotvertrag (`COMPANY_SNAPSHOT_KEYS`): Was eine
 * Rechnung einfriert, entscheidet allein jener Vertrag; das Profil führt mehr Felder.
 */
export type CompanyProfileFieldClass = 'transferred' | 'localOnly' | 'excluded';

export const COMPANY_PROFILE_FIELD_CLASSES = {
  companyName: 'transferred',
  legalForm: 'transferred',
  logoDataUrl: 'localOnly',
  branding: 'transferred',
  street: 'transferred',
  zip: 'transferred',
  city: 'transferred',
  country: 'transferred',
  countryCode: 'transferred',
  contactPerson: 'transferred',
  phone: 'transferred',
  email: 'transferred',
  website: 'transferred',
  taxNumber: 'transferred',
  vatId: 'transferred',
  registrationAuthority: 'transferred',
  registrationNumber: 'transferred',
  bankName: 'transferred',
  accountHolder: 'transferred',
  iban: 'transferred',
  bic: 'transferred',
  defaultTaxStatus: 'transferred',
  currency: 'transferred',
  defaultPaymentDays: 'transferred',
  defaultPaymentTerms: 'transferred',
  defaultIntroText: 'transferred',
  defaultClosingText: 'transferred',
  defaultInvoiceEmailSubject: 'transferred',
  defaultInvoiceEmailBody: 'transferred',
  defaultOfferEmailSubject: 'transferred',
  defaultOfferEmailBody: 'transferred',
  defaultLetterEmailSubject: 'transferred',
  defaultLetterEmailBody: 'transferred',
  emailSignature: 'transferred',
  replyToEmail: 'transferred',
  senderDisplayName: 'transferred',
  defaultSkonto: 'transferred',
  skontoEnabled: 'transferred',
  skontoPercent: 'transferred',
  skontoDays: 'transferred',
  managingDirector: 'transferred',
  taxFreeNotice: 'transferred',
  invoiceFooterNotes: 'transferred',
  // EINRICHTUNG-01 (AP6; 1.21, E-05) — Vorlagen und Kommunikationssprache, Schema 3.
  offerValidityDays: 'transferred',
  offerIntroText: 'transferred',
  offerClosingText: 'transferred',
  orderIntroText: 'transferred',
  orderClosingText: 'transferred',
  letterSalutation: 'transferred',
  letterClosing: 'transferred',
  communicationLanguage: 'transferred',
} as const satisfies Record<keyof CompanyProfile, CompanyProfileFieldClass>;

export type CompanyProfileField = keyof typeof COMPANY_PROFILE_FIELD_CLASSES;

/**
 * Die Felder der ersten Ganzdokument-Fassung (CLOUD-DATA-01, 11.07.2026). Alles, was
 * danach übertragen wurde, braucht einen Katalogeintrag mit Einführungsversion.
 */
export const COMPANY_PROFILE_BASE_FIELDS: readonly CompanyProfileField[] = [
  'bankName', 'bic', 'city', 'companyName', 'contactPerson', 'country', 'defaultPaymentDays',
  'defaultPaymentTerms', 'defaultSkonto', 'email', 'iban', 'invoiceFooterNotes', 'legalForm',
  'logoDataUrl', 'managingDirector', 'phone', 'skontoDays', 'skontoEnabled', 'skontoPercent',
  'street', 'taxFreeNotice', 'taxNumber', 'vatId', 'website', 'zip',
];

/**
 * Spiegel des Server-Katalogs: Einführungsversion je später hinzugekommenem,
 * übertragenem Feld. Ein Client mit älterer Version, der ein solches Feld nicht
 * sendet, kennt es nachweislich nicht — der Server bewahrt den bestehenden Wert.
 *
 * Version 3 (EINRICHTUNG-01) trägt alle Felder nach, die nach der ersten Fassung
 * ohne Katalogeintrag eingeführt wurden; `branding` hat seine eigene Regel.
 */
export const COMPANY_PROFILE_FIELD_INTRODUCED_IN: Readonly<Partial<Record<CompanyProfileField, 2 | 3>>> = {
  defaultTaxStatus: 2,
  currency: 2,
  replyToEmail: 2,
  senderDisplayName: 2,
  accountHolder: 3,
  countryCode: 3,
  defaultIntroText: 3,
  defaultClosingText: 3,
  defaultInvoiceEmailSubject: 3,
  defaultInvoiceEmailBody: 3,
  defaultOfferEmailSubject: 3,
  defaultOfferEmailBody: 3,
  defaultLetterEmailSubject: 3,
  defaultLetterEmailBody: 3,
  emailSignature: 3,
  registrationAuthority: 3,
  registrationNumber: 3,
  // EINRICHTUNG-01 (AP6; Vertrag 1.21) — neue Profilfelder gehören zu Schema 3 (Server-Katalog ebenso).
  offerValidityDays: 3,
  offerIntroText: 3,
  offerClosingText: 3,
  orderIntroText: 3,
  orderClosingText: 3,
  letterSalutation: 3,
  letterClosing: 3,
  communicationLanguage: 3,
};

/**
 * Pflichtfelder (Vertrag 1.10): Ein Schema-3-Patch darf sie nicht leeren — weder mit
 * `null` noch mit einem leeren Wert, wenn vorher einer gesetzt war.
 */
export const COMPANY_PROFILE_REQUIRED_FIELDS: readonly CompanyProfileField[] = [
  'companyName',
  'contactPerson',
  'street',
  'zip',
  'city',
  'email',
  'iban',
];

/**
 * Was ein Schema-3-Patch mit `null` löschen darf: übertragene Felder ohne die
 * Pflichtfelder und ohne `branding` (eigener Vertrag: `null` ist dort kein
 * Löschsignal, entfernt wird über `{}`).
 */
export const COMPANY_PROFILE_PATCH_DELETABLE_FIELDS: readonly CompanyProfileField[] = (
  Object.keys(COMPANY_PROFILE_FIELD_CLASSES) as CompanyProfileField[]
).filter(
  (field) =>
    COMPANY_PROFILE_FIELD_CLASSES[field] === 'transferred' &&
    field !== 'branding' &&
    !COMPANY_PROFILE_REQUIRED_FIELDS.includes(field),
);
