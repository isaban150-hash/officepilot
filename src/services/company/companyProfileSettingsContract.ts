import type { CompanyProfile, TaxStatus } from '../../types/models';
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
} as const;

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

const TEXT_FIELDS = ['accountHolder', 'defaultIntroText', 'defaultClosingText', 'defaultInvoiceEmailSubject', 'defaultInvoiceEmailBody', 'senderDisplayName'] as const;

/**
 * PRODUCT-BASIS-FIRMENPROFIL-01B — Schema-Version des Profil-Payloads.
 *
 * Der Client sendet sie mit jedem Ganzdokument (`profile_schema_version`). Der
 * Server bewahrt Felder, die erst in einer **spaeteren** Version eingefuehrt
 * wurden, wenn ein Client mit aelterer (oder ohne) Version sie weglaesst — und
 * behandelt das Weglassen durch einen Client dieser Version als bewusstes
 * Loeschen. Wer ein neues Profilfeld einfuehrt, erhoeht die Version hier und
 * traegt das Feld serverseitig mit derselben Version in den Katalog ein.
 */
export const COMPANY_PROFILE_SCHEMA_VERSION = 2;

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

  return next as T;
}

export type CompanyProfileOptionalFieldError =
  | 'companyProfile.currencyInvalid'
  | 'companyProfile.currencyUnsupported'
  | 'companyProfile.replyToEmailInvalid'
  | 'companyProfile.senderDisplayNameTooLong'
  | 'companyProfile.taxStatusInvalid';

/**
 * 01B2 — die Schreibgrenze: Was hier abgelehnt wird, erreicht weder Store noch
 * Payload. Leer (`''`) ist erlaubt und bedeutet bewusstes Loeschen.
 */
export function validateCompanyProfileOptionalFields(
  partial: Partial<Pick<CompanyProfile, 'currency' | 'replyToEmail' | 'senderDisplayName' | 'defaultTaxStatus'>>,
): CompanyProfileOptionalFieldError | null {
  if (partial.currency !== undefined && partial.currency !== '') {
    const code = String(partial.currency).trim().toUpperCase();
    if (!isCurrencyCode(code)) return 'companyProfile.currencyInvalid';
    if (!SUPPORTED_PROFILE_CURRENCIES.includes(code)) return 'companyProfile.currencyUnsupported';
  }
  if (partial.replyToEmail !== undefined && String(partial.replyToEmail).trim() !== '' && !isProfileEmail(partial.replyToEmail)) {
    return 'companyProfile.replyToEmailInvalid';
  }
  if (partial.senderDisplayName !== undefined && String(partial.senderDisplayName).trim().length > COMPANY_PROFILE_TEXT_LIMITS.senderDisplayName) {
    return 'companyProfile.senderDisplayNameTooLong';
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

/** Fehlend/leer → „Firmenname Rechtsform" (dieselbe Ableitung wie der Versand). */
export function resolveProfileSenderDisplayName(
  profile: Pick<CompanyProfile, 'companyName' | 'legalForm' | 'senderDisplayName'>,
): string {
  const explicit = (profile.senderDisplayName ?? '').trim();
  if (explicit) return explicit;
  return [profile.companyName?.trim(), profile.legalForm?.trim()].filter(Boolean).join(' ');
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
