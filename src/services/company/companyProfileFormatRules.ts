import type { CompanyProfile } from '../../types/models';
import type { TranslationKey } from '../../i18n';
import { isPlausibleVatId, normalizeCountryCodeInput, normalizeVatIdInput } from '../customer/customerFieldFormat';
import { KNOWN_COUNTRY_CODES, normalizeCountryCode } from '../einvoice/einvoiceStandards';

/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.18, F-02, F-03) — Formatprüfungen der Firmendaten im Client.
 *
 * Geprüft wird die Schreibweise, nicht die Existenz (keine Online-Abfrage). Leer heißt „nicht angegeben“ — Pflichtfelder
 * prüft weiterhin `validateSetupStep`. Der Server behält seine Längengrenzen (1.10); diese Regeln gelten auf der Seite,
 * auf der die Felder bearbeitet werden (Firmendaten). Andere Einstellungsseiten blockiert ein älterer, ungeprüfter Wert
 * nicht (wie die IBAN-Prüfung „shape“ auf der Rechnungsseite).
 */
export type CompanyFormatField = 'vatId' | 'zip' | 'bic' | 'countryCode' | 'phone' | 'website';

export const COMPANY_FORMAT_ERROR_KEYS: Record<CompanyFormatField, TranslationKey> = {
  vatId: 'companyProfile.format.vatId',
  zip: 'companyProfile.format.zip',
  bic: 'companyProfile.format.bic',
  countryCode: 'companyProfile.format.countryCode',
  phone: 'companyProfile.format.phone',
  website: 'companyProfile.format.website',
};

const BIC_PATTERN = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const PHONE_CHARACTERS = /^[0-9 +()/-]+$/;
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function normalizeBicInput(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

export function normalizeIbanInput(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

/** F-03 — Anzeige in Vierergruppen; gespeichert wird die elektronische Form ohne Leerzeichen. */
export function formatIbanGroups(value: string): string {
  return normalizeIbanInput(value).replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * Ländercode, nach dem sich die PLZ-Regel richtet: der eigene Code, sonst der aus dem Freitext „Land“; ohne beides
 * Deutschland (wie `DEFAULT_COUNTRY_CODE`). Ein unbekanntes Land ergibt `null` (allgemeine Regel).
 */
function zipCountry(profile: Pick<CompanyProfile, 'countryCode' | 'country'>): string | null {
  const code = (profile.countryCode ?? '').trim();
  if (code) return normalizeCountryCodeInput(code);
  const text = (profile.country ?? '').trim();
  if (!text) return 'DE';
  return normalizeCountryCode(text) ?? null;
}

export function isPlausibleZip(zip: string, country: string | null): boolean {
  const value = zip.trim();
  if (country === 'DE') return /^\d{5}$/.test(value);
  if (country === 'AT' || country === 'CH') return /^\d{4}$/.test(value);
  return /^[A-Za-z0-9 -]{2,10}$/.test(value);
}

export function isPlausibleCompanyPhone(value: string): boolean {
  const text = value.trim();
  if (text.length > 30 || !PHONE_CHARACTERS.test(text)) return false;
  return (text.match(/\d/g) ?? []).length >= 6;
}

/** Domain („beispiel.de“, auch mit Pfad) oder eine http(s)-Adresse; andere Schemata (`javascript:`, `data:`) nie. */
export function isPlausibleWebsite(value: string): boolean {
  const text = value.trim();
  if (/\s/.test(text)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    if (!/^https?:\/\//i.test(text)) return false;
    try {
      const url = new URL(text);
      return (url.protocol === 'http:' || url.protocol === 'https:') && DOMAIN_PATTERN.test(url.hostname);
    } catch {
      return false;
    }
  }
  const host = text.split(/[/?#]/, 1)[0] ?? '';
  return DOMAIN_PATTERN.test(host);
}

export function isKnownCompanyCountryCode(value: string): boolean {
  const code = normalizeCountryCodeInput(value);
  return code !== null && (KNOWN_COUNTRY_CODES as readonly string[]).includes(code);
}

/** Feldfehler der Formatregeln; leere Felder werden nicht geprüft. */
export function checkCompanyProfileFormats(
  profile: Pick<CompanyProfile, 'vatId' | 'zip' | 'bic' | 'countryCode' | 'country' | 'phone' | 'website'>,
): Partial<Record<CompanyFormatField, TranslationKey>> {
  const errors: Partial<Record<CompanyFormatField, TranslationKey>> = {};
  const vatId = (profile.vatId ?? '').trim();
  if (vatId && !isPlausibleVatId(vatId)) errors.vatId = COMPANY_FORMAT_ERROR_KEYS.vatId;
  const zip = (profile.zip ?? '').trim();
  if (zip && !isPlausibleZip(zip, zipCountry(profile))) errors.zip = COMPANY_FORMAT_ERROR_KEYS.zip;
  const bic = (profile.bic ?? '').trim();
  if (bic && !BIC_PATTERN.test(normalizeBicInput(bic))) errors.bic = COMPANY_FORMAT_ERROR_KEYS.bic;
  const countryCode = (profile.countryCode ?? '').trim();
  if (countryCode && !isKnownCompanyCountryCode(countryCode)) errors.countryCode = COMPANY_FORMAT_ERROR_KEYS.countryCode;
  const phone = (profile.phone ?? '').trim();
  if (phone && !isPlausibleCompanyPhone(phone)) errors.phone = COMPANY_FORMAT_ERROR_KEYS.phone;
  const website = (profile.website ?? '').trim();
  if (website && !isPlausibleWebsite(website)) errors.website = COMPANY_FORMAT_ERROR_KEYS.website;
  return errors;
}

/** Einheitliche Speicherform der geprüften Felder (nur gültige Werte werden umgeformt). */
export function normalizeCompanyProfileFormats<T extends Partial<CompanyProfile>>(profile: T): T {
  const next = { ...profile };
  if (typeof next.iban === 'string') next.iban = normalizeIbanInput(next.iban);
  if (typeof next.bic === 'string' && next.bic.trim()) next.bic = normalizeBicInput(next.bic);
  if (typeof next.vatId === 'string' && next.vatId.trim() && isPlausibleVatId(next.vatId)) next.vatId = normalizeVatIdInput(next.vatId);
  if (typeof next.countryCode === 'string' && next.countryCode.trim()) {
    next.countryCode = normalizeCountryCodeInput(next.countryCode) ?? next.countryCode.trim();
  }
  return next;
}
