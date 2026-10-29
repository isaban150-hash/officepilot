import type { CommunicationLanguage, CompanyProfile, TaxStatus } from '../../types/models';
import { composeSenderLegalName, senderDisplayNameProblem } from './senderDisplayName';
import { DEFAULT_DOCUMENT_TEMPLATE, isDocumentTemplateId, type DocumentTemplateId } from '../../types/branding';

/**
 * SETTINGS-01B1 — die kanonische Lesesemantik der neuen Profilfelder.
 *
 * Eine Funktion, beide Seiten der Cloud-Grenze und der lokale Ladepfad:
 * Was hier durchläuft, ist danach in genau einer Form gespeichert —
 * getrimmte Texte, ein gültiger Steuerstatus oder gar keiner. Altprofile
 * ohne die Felder bleiben unverändert (kein Backfill); fehlende Werte lesen
 * sich über die `resolve*`-Helfer als Vorgabe.
 *
 * Bewusst **nur** diese Felder. Es gibt weiterhin keinen allgemeinen
 * `CompanyProfile`-Sanitizer; Branding hat seinen eigenen Vertrag.
 */
export const COMPANY_PROFILE_TEXT_LIMITS = {
  /** Kontoinhaber — wie ein Firmenname. */
  accountHolder: 120,
  /** 01B — Absender-Anzeigename, wie ein Firmenname. */
  senderDisplayName: 120,
  /** Einleitungs-/Schlusstext — mehrzeilig, wie Fussnoten. */
  defaultIntroText: 2000,
  defaultClosingText: 2000,
  /** EMAIL-01B4 — wie die Delivery-Grenzen des Servers (Betreff 255, Text 20000). */
  defaultInvoiceEmailSubject: 255,
  defaultInvoiceEmailBody: 20000,
  /** E-MAIL-07C — dieselben Grenzen für Angebots-/Briefvorlagen; Signatur wie ein Freitext. */
  defaultOfferEmailSubject: 255,
  defaultOfferEmailBody: 20000,
  defaultLetterEmailSubject: 255,
  defaultLetterEmailBody: 20000,
  emailSignature: 2000,
  /** EINRICHTUNG-01 (AP6; Vertrag 1.21) — Fußzeile und Hinweis „steuerfrei“ wie die Standardtexte (Client und Server). */
  invoiceFooterNotes: 2000,
  taxFreeNotice: 2000,
  /** EINRICHTUNG-01 (AP6; 1.21) — Vorgaben für neue Angebote, Aufträge und Briefe. */
  offerIntroText: 2000,
  offerClosingText: 2000,
  orderIntroText: 2000,
  orderClosingText: 2000,
  letterSalutation: 2000,
  letterClosing: 2000,
} as const;

export type CompanyProfileTextLimitField = keyof typeof COMPANY_PROFILE_TEXT_LIMITS;

/**
 * EINRICHTUNG-01 (EIN-06, S-08) — Textgrenzen zählen **Unicode-Codepunkte**, genau
 * wie der Server (`length()` in PostgreSQL). `String.length` zählt UTF-16-Einheiten:
 * „👷" wäre dort zwei Zeichen, „ä" und „€" je eines — Client und Server zählten
 * verschieden.
 */
export function countTextCodePoints(value: string): number {
  let count = 0;
  for (const _codePoint of value) count += 1;
  return count;
}

/**
 * Eingabefelder begrenzen über `maxLength` UTF-16-Einheiten. Ein Codepunkt belegt
 * höchstens zwei davon; mit der doppelten Grenze blockiert der Browser deshalb nie
 * einen gültigen Wert. Die eigentliche Grenze prüft {@link findCompanyProfileTextLimitViolation}.
 */
export function textInputMaxLength(limit: number): number {
  return limit * 2;
}

/** Betreffe sind einzeilig: kein Zeilenumbruch, kein anderes Steuerzeichen (wie der Server). */
const SUBJECT_FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]/;

const SUBJECT_FIELDS: ReadonlySet<CompanyProfileTextLimitField> = new Set([
  'defaultInvoiceEmailSubject',
  'defaultOfferEmailSubject',
  'defaultLetterEmailSubject',
]);

const TEXT_LIMIT_ERROR_KEYS: Record<CompanyProfileTextLimitField, string> = {
  accountHolder: 'companyProfile.accountHolderTooLong',
  senderDisplayName: 'companyProfile.senderDisplayNameTooLong',
  defaultIntroText: 'companyProfile.defaultIntroTextTooLong',
  defaultClosingText: 'companyProfile.defaultClosingTextTooLong',
  defaultInvoiceEmailSubject: 'companyProfile.defaultInvoiceEmailSubjectInvalid',
  defaultInvoiceEmailBody: 'companyProfile.defaultInvoiceEmailBodyTooLong',
  defaultOfferEmailSubject: 'companyProfile.emailSubjectInvalid',
  defaultOfferEmailBody: 'companyProfile.emailBodyTooLong',
  defaultLetterEmailSubject: 'companyProfile.emailSubjectInvalid',
  defaultLetterEmailBody: 'companyProfile.emailBodyTooLong',
  emailSignature: 'companyProfile.emailSignatureTooLong',
  invoiceFooterNotes: 'companyProfile.invoiceFooterNotesTooLong',
  taxFreeNotice: 'companyProfile.taxFreeNoticeTooLong',
  offerIntroText: 'companyProfile.templateTextTooLong',
  offerClosingText: 'companyProfile.templateTextTooLong',
  orderIntroText: 'companyProfile.templateTextTooLong',
  orderClosingText: 'companyProfile.templateTextTooLong',
  letterSalutation: 'companyProfile.templateTextTooLong',
  letterClosing: 'companyProfile.templateTextTooLong',
};

export interface CompanyProfileTextLimitViolation {
  field: CompanyProfileTextLimitField;
  errorKey: string;
}

/**
 * Alle Verstösse eines Profils oder Teilprofils gegen die Textgrenzen, gezählt wie
 * beim Server: der getrimmte Wert (so wird er gespeichert) in Codepunkten; Betreffe
 * zusätzlich ohne Zeilenumbruch. Nicht-Texte prüft der Vertrag an anderer Stelle.
 */
export function findCompanyProfileTextLimitViolations(
  profileLike: Readonly<Record<string, unknown>>,
): CompanyProfileTextLimitViolation[] {
  const violations: CompanyProfileTextLimitViolation[] = [];
  for (const field of Object.keys(COMPANY_PROFILE_TEXT_LIMITS) as CompanyProfileTextLimitField[]) {
    const value = profileLike[field];
    if (typeof value !== 'string') continue;
    const text = value.trim();
    const tooLong = countTextCodePoints(text) > COMPANY_PROFILE_TEXT_LIMITS[field];
    const lineBreak = SUBJECT_FIELDS.has(field) && SUBJECT_FORBIDDEN_CHARACTERS.test(text);
    if (tooLong || lineBreak) violations.push({ field, errorKey: TEXT_LIMIT_ERROR_KEYS[field] });
  }
  return violations;
}

/** Der erste Verstoss oder `null`. */
export function findCompanyProfileTextLimitViolation(
  profileLike: Readonly<Record<string, unknown>>,
): CompanyProfileTextLimitViolation | null {
  return findCompanyProfileTextLimitViolations(profileLike)[0] ?? null;
}

export const TAX_STATUS_VALUES: readonly TaxStatus[] = [
  'standard_19',
  'standard_7',
  'kleinunternehmer_19',
  'reverse_charge_13b',
  'tax_free',
  'unclear',
];

export function isTaxStatus(value: unknown): value is TaxStatus {
  return typeof value === 'string' && (TAX_STATUS_VALUES as readonly string[]).includes(value);
}

const TEXT_FIELDS = [
  'accountHolder',
  'defaultIntroText',
  'defaultClosingText',
  'defaultInvoiceEmailSubject',
  'defaultInvoiceEmailBody',
  'senderDisplayName',
  // E-MAIL-07C
  'defaultOfferEmailSubject',
  'defaultOfferEmailBody',
  'defaultLetterEmailSubject',
  'defaultLetterEmailBody',
  'emailSignature',
  // EINRICHTUNG-01 (AP6; 1.21)
  'offerIntroText',
  'offerClosingText',
  'orderIntroText',
  'orderClosingText',
  'letterSalutation',
  'letterClosing',
] as const;

/**
 * E-MAIL-07C — E-Mail-Vorlagen und Signatur: leer bedeutet „die Vorgabe
 * verwenden". Ein leerer Text wird deshalb nicht gespeichert, sondern der
 * Schlüssel entfernt — sonst stünde nach dem Leeren ein anderer Bestand als
 * vor dem ersten Speichern, obwohl beides dasselbe bedeutet.
 */
const EMPTY_MEANS_UNSET_FIELDS: ReadonlySet<string> = new Set([
  'defaultInvoiceEmailSubject',
  'defaultInvoiceEmailBody',
  'defaultOfferEmailSubject',
  'defaultOfferEmailBody',
  'defaultLetterEmailSubject',
  'defaultLetterEmailBody',
  'emailSignature',
]);

/**
 * PRODUCT-BASIS-FIRMENPROFIL-01B — Schema-Version des Profil-Payloads.
 *
 * Der Client sendet sie mit jedem Ganzdokument (`profile_schema_version`). Der
 * Server bewahrt Felder, die erst in einer **spaeteren** Version eingefuehrt
 * wurden, wenn ein Client mit aelterer (oder ohne) Version sie weglaesst — und
 * behandelt das Weglassen durch einen Client dieser Version als bewusstes
 * Loeschen. Wer ein neues Profilfeld einfuehrt, erhoeht die Version hier und
 * traegt das Feld serverseitig mit derselben Version in den Katalog ein.
 *
 * EINRICHTUNG-01 (EIN-06, Vertrag 1.10) — Version 3 ist ein **Patch**: Ein
 * fehlender Schlüssel bleibt am Server unverändert, `null` löscht ein optionales
 * Feld, Pflichtfelder lassen sich nicht leeren. Der Client sendet deshalb jedes
 * ihm bekannte, löschbare Feld — mit Wert oder ausdrücklich `null`
 * (`buildCompanyProfileCloudPayload`). Den Feldkatalog führt
 * `companyProfileFieldCatalog.ts`.
 */
export const COMPANY_PROFILE_SCHEMA_VERSION = 3;

/** ISO 4217: drei Grossbuchstaben. Fachlich unterstuetzt ist derzeit EUR. */
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
export const DEFAULT_PROFILE_CURRENCY = 'EUR';
export const SUPPORTED_PROFILE_CURRENCIES: readonly string[] = ['EUR'];

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_CODE_PATTERN.test(value);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isProfileEmail(value: unknown): value is string {
  return typeof value === 'string' && EMAIL_PATTERN.test(value.trim());
}

/**
 * Wendet den Vertrag auf ein Profil-artiges Objekt an und gibt eine flache
 * Kopie zurück. Ungültige Werte werden **entfernt** (nicht auf `undefined`
 * gesetzt), damit ein Payload ohne den Schlüssel entsteht.
 */
export function applyCompanyProfileSettingsContract<T extends Record<string, unknown>>(
  profileLike: T,
): T {
  const next = { ...profileLike } as Record<string, unknown>;

  for (const field of TEXT_FIELDS) {
    if (!(field in next)) continue;
    const value = next[field];
    if (typeof value !== 'string') {
      delete next[field];
      continue;
    }
    next[field] = value.trim();
    // E-MAIL-07C — leere Vorlage/Signatur heisst „Vorgabe verwenden": kein leerer Schlüssel.
    if (next[field] === '' && EMPTY_MEANS_UNSET_FIELDS.has(field)) delete next[field];
  }

  if ('defaultTaxStatus' in next && !isTaxStatus(next.defaultTaxStatus)) {
    delete next.defaultTaxStatus;
  }

  /*
   * 01B/01B2 — optionale Felder, drei Zustaende, streng getrennt:
   *   gueltig          -> normalisiert (Grossbuchstaben / Kleinbuchstaben / getrimmt)
   *   bewusst leer     -> Schluessel entfernt (im v2-Payload = bewusstes Loeschen)
   *   ungueltig        -> **unveraendert belassen**, nie entfernt. Ein ungueltiger
   *                       Wert darf im Payload nicht wie eine Loeschung aussehen;
   *                       abgelehnt wird er an der Schreibgrenze
   *                       (`validateCompanyProfileOptionalFields`), Leser fallen
   *                       ueber die `resolve*`-Helfer auf die Vorgabe zurueck.
   */
  if ('currency' in next) {
    if (next.currency === '' || next.currency === null || next.currency === undefined) delete next.currency;
    else if (typeof next.currency === 'string' && isCurrencyCode(next.currency.trim().toUpperCase())) {
      next.currency = next.currency.trim().toUpperCase();
    }
  }
  if ('replyToEmail' in next) {
    const raw = typeof next.replyToEmail === 'string' ? next.replyToEmail.trim() : next.replyToEmail;
    if (raw === '' || raw === null || raw === undefined) delete next.replyToEmail;
    else if (typeof raw === 'string' && isProfileEmail(raw)) next.replyToEmail = raw.toLowerCase();
  }
  if ('senderDisplayName' in next) {
    if (next.senderDisplayName === '' || next.senderDisplayName === null || next.senderDisplayName === undefined) {
      delete next.senderDisplayName;
    }
  }
  // EINRICHTUNG-01 (AP6; E-05) — leer heißt Deutsch: kein Schlüssel. Ungültig bleibt stehen (Schreibgrenze weist ab).
  if ('communicationLanguage' in next) {
    if (next.communicationLanguage === '' || next.communicationLanguage === null || next.communicationLanguage === undefined) {
      delete next.communicationLanguage;
    }
  }
  if ('offerValidityDays' in next && (next.offerValidityDays === null || next.offerValidityDays === undefined)) {
    delete next.offerValidityDays;
  }

  return next as T;
}

export type CompanyProfileOptionalFieldError =
  | 'companyProfile.currencyInvalid'
  | 'companyProfile.currencyUnsupported'
  | 'companyProfile.replyToEmailInvalid'
  | 'companyProfile.senderDisplayNameTooLong'
  | 'companyProfile.senderDisplayNameInvalid'
  | 'companyProfile.taxStatusInvalid'
  | 'companyProfile.offerValidityDaysInvalid'
  | 'companyProfile.communicationLanguageInvalid';

/** EINRICHTUNG-01 (AP6; 1.21) — Angebotsgültigkeit in ganzen Tagen. */
export const OFFER_VALIDITY_DAYS_MIN = 1;
export const OFFER_VALIDITY_DAYS_MAX = 365;
export const DEFAULT_OFFER_VALIDITY_DAYS = 30;

export function isOfferValidityDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= OFFER_VALIDITY_DAYS_MIN && value <= OFFER_VALIDITY_DAYS_MAX;
}

/** EINRICHTUNG-01 (AP6; E-05) — Sprachen der Kommunikationsvorgaben. */
export const COMMUNICATION_LANGUAGES: readonly CommunicationLanguage[] = ['de', 'tr', 'bg'];
export const DEFAULT_COMMUNICATION_LANGUAGE: CommunicationLanguage = 'de';

export function isCommunicationLanguage(value: unknown): value is CommunicationLanguage {
  return typeof value === 'string' && (COMMUNICATION_LANGUAGES as readonly string[]).includes(value);
}

/**
 * 01B2 — die Schreibgrenze: Was hier abgelehnt wird, erreicht weder Store noch
 * Payload. Leer (`''`) ist erlaubt und bedeutet bewusstes Loeschen.
 */
export function validateCompanyProfileOptionalFields(
  partial: Partial<
    Pick<CompanyProfile, 'currency' | 'replyToEmail' | 'senderDisplayName' | 'defaultTaxStatus' | 'offerValidityDays' | 'communicationLanguage'>
  >,
): CompanyProfileOptionalFieldError | null {
  if (partial.currency !== undefined && partial.currency !== '') {
    const code = String(partial.currency).trim().toUpperCase();
    if (!isCurrencyCode(code)) return 'companyProfile.currencyInvalid';
    if (!SUPPORTED_PROFILE_CURRENCIES.includes(code)) return 'companyProfile.currencyUnsupported';
  }
  if (partial.replyToEmail !== undefined && String(partial.replyToEmail).trim() !== '' && !isProfileEmail(partial.replyToEmail)) {
    return 'companyProfile.replyToEmailInvalid';
  }
  // EINRICHTUNG-01 (S-08) — in Codepunkten, wie der Server.
  if (partial.senderDisplayName !== undefined && countTextCodePoints(String(partial.senderDisplayName).trim()) > COMPANY_PROFILE_TEXT_LIMITS.senderDisplayName) {
    return 'companyProfile.senderDisplayNameTooLong';
  }
  // EINRICHTUNG-01 (AP6; E-04, 1.19) — dieselbe Regel wie der Server (`display_name_invalid`).
  if (partial.senderDisplayName !== undefined && senderDisplayNameProblem(String(partial.senderDisplayName)) !== null) {
    return 'companyProfile.senderDisplayNameInvalid';
  }
  if (partial.offerValidityDays !== undefined && !isOfferValidityDays(partial.offerValidityDays)) {
    return 'companyProfile.offerValidityDaysInvalid';
  }
  if (
    partial.communicationLanguage !== undefined &&
    (partial.communicationLanguage as unknown) !== '' &&
    !isCommunicationLanguage(partial.communicationLanguage)
  ) {
    return 'companyProfile.communicationLanguageInvalid';
  }
  if (partial.defaultTaxStatus !== undefined && (partial.defaultTaxStatus as unknown) !== '' && !isTaxStatus(partial.defaultTaxStatus)) {
    return 'companyProfile.taxStatusInvalid';
  }
  return null;
}

/** Fehlend → EUR (die bislang implizite Waehrung des Produkts). Nie eine Profilmutation. */
export function resolveProfileCurrency(profile: Pick<CompanyProfile, 'currency'>): string {
  return isCurrencyCode(profile.currency) ? profile.currency : DEFAULT_PROFILE_CURRENCY;
}

/** Fehlend/leer → Firmen-E-Mail (bestehende Versandlogik bleibt unveraendert). */
export function resolveProfileReplyToEmail(profile: Pick<CompanyProfile, 'email' | 'replyToEmail'>): string {
  const explicit = (profile.replyToEmail ?? '').trim().toLowerCase();
  return isProfileEmail(explicit) ? explicit : (profile.email ?? '').trim().toLowerCase();
}

/**
 * Fehlend/leer → Firmenname mit Rechtsform nach der einen Regel aus 1.19 (EINRICHTUNG-01 AP6; F-05): Endet der Name
 * schon auf die Rechtsform, bleibt er unverändert — dieselbe Regel wie der Versandserver (`sendDocumentCore`).
 */
export function resolveProfileSenderDisplayName(
  profile: Pick<CompanyProfile, 'companyName' | 'legalForm' | 'senderDisplayName'>,
): string {
  const explicit = (profile.senderDisplayName ?? '').trim();
  if (explicit) return explicit;
  return composeSenderLegalName(profile.companyName, profile.legalForm);
}

/** EINRICHTUNG-01 (AP6; 1.21) — fehlend oder ungültig → 30 Tage. */
export function resolveProfileOfferValidityDays(profile: Pick<CompanyProfile, 'offerValidityDays'>): number {
  return isOfferValidityDays(profile.offerValidityDays) ? profile.offerValidityDays : DEFAULT_OFFER_VALIDITY_DAYS;
}

/** EINRICHTUNG-01 (AP6; E-05) — fehlend oder ungültig → Deutsch. */
export function resolveProfileCommunicationLanguage(
  profile: Pick<CompanyProfile, 'communicationLanguage'>,
): CommunicationLanguage {
  return isCommunicationLanguage(profile.communicationLanguage) ? profile.communicationLanguage : DEFAULT_COMMUNICATION_LANGUAGE;
}

/** Fehlend/leer → keine Vorgabe; der Aufrufer nimmt den Legacy-Fallback. */
export function resolveProfileDefaultTaxStatus(
  profile: Pick<CompanyProfile, 'defaultTaxStatus'>,
): TaxStatus | undefined {
  return isTaxStatus(profile.defaultTaxStatus) ? profile.defaultTaxStatus : undefined;
}

export function resolveProfileDefaultIntroText(
  profile: Pick<CompanyProfile, 'defaultIntroText'>,
): string {
  return (profile.defaultIntroText ?? '').trim();
}

export function resolveProfileDefaultClosingText(
  profile: Pick<CompanyProfile, 'defaultClosingText'>,
): string {
  return (profile.defaultClosingText ?? '').trim();
}

/**
 * Fehlend → `classic`. Ein unbekannter Wert (z. B. aus einer neueren Version)
 * wird **fail-closed** als `classic` angezeigt — SETTINGS-01B3. Nie eine
 * Profilmutation: das Feld bleibt im Profil, wie es ist.
 */
export function resolveProfileDocumentTemplate(
  profile: Pick<CompanyProfile, 'branding'>,
): DocumentTemplateId {
  const value = profile.branding?.documentTemplate;
  return value !== undefined && isDocumentTemplateId(value) ? value : DEFAULT_DOCUMENT_TEMPLATE;
}
