import { getCompanyProfile } from './companyProfileService';
import { getAllVorgaenge } from './vorgangService';
import type {
  CompanyProfile,
  CompanyRelevanceInput,
  CompanyRelevanceReason,
  CompanyRelevanceResult,
  InboxItem,
} from '../types/models';

const AUTHORITY_PATTERN = /bg[\s-]?bau|aok|soka[\s-]?bau|finanzamt|berufsgenossenschaft/i;
const CUSTOMER_NUMBER_PATTERN = /kundennummer[:\s]+[\w-]+/i;
const BETRIEBSNUMMER_PATTERN = /betriebsnummer[:\s]+[\w-]+/i;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\wäöüß0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsNormalized(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalize(needle);
  if (!normalizedNeedle || normalizedNeedle.length < 2) return false;
  return normalize(haystack).includes(normalizedNeedle);
}

function addReason(
  result: CompanyRelevanceResult,
  reason: CompanyRelevanceReason,
  hint: string,
): void {
  if (!result.reasons.includes(reason)) {
    result.reasons.push(reason);
  }
  if (!result.matchedHints.includes(hint)) {
    result.matchedHints.push(hint);
  }
  result.isRelevant = true;
}

function checkProfileFields(
  input: CompanyRelevanceInput,
  profile: CompanyProfile,
  result: CompanyRelevanceResult,
): void {
  const text = input.text;

  if (profile.companyName.trim() && containsNormalized(text, profile.companyName)) {
    addReason(result, 'company_name', profile.companyName);
  }

  if (profile.contactPerson.trim() && containsNormalized(text, profile.contactPerson)) {
    addReason(result, 'contact_person', profile.contactPerson);
  }

  if (profile.street.trim() && containsNormalized(text, profile.street)) {
    addReason(result, 'company_address', profile.street);
  }

  const zipCity = [profile.zip, profile.city].filter(Boolean).join(' ');
  if (profile.zip.trim() && profile.city.trim() && containsNormalized(text, zipCity)) {
    addReason(result, 'company_address', zipCity);
  }

  if (profile.taxNumber.trim() && containsNormalized(text, profile.taxNumber)) {
    addReason(result, 'tax_number', profile.taxNumber);
  }

  if (profile.vatId.trim() && containsNormalized(text, profile.vatId)) {
    addReason(result, 'vat_id', profile.vatId);
  }
}

function checkVorgangAndCustomer(
  input: CompanyRelevanceInput,
  result: CompanyRelevanceResult,
): void {
  if (input.vorgangId) {
    const vorgang = getAllVorgaenge().find((v) => v.id === input.vorgangId);
    if (vorgang) {
      addReason(result, 'vorgang_reference', vorgang.title);
    }
  }

  const vorgangTitle = input.vorgangTitle ?? input.recognizedData?.Vorgang;
  if (vorgangTitle) {
    for (const vorgang of getAllVorgaenge()) {
      if (
        containsNormalized(vorgang.title, vorgangTitle) ||
        containsNormalized(vorgangTitle, vorgang.title)
      ) {
        addReason(result, 'vorgang_reference', vorgang.title);
        break;
      }
    }
  }

  const baustelle = input.recognizedData?.Baustelle;
  if (baustelle) {
    for (const vorgang of getAllVorgaenge()) {
      if (
        containsNormalized(vorgang.baustelle, baustelle) ||
        containsNormalized(baustelle, vorgang.baustelle)
      ) {
        addReason(result, 'vorgang_reference', vorgang.baustelle);
        break;
      }
    }
  }

  const customer =
    input.recognizedData?.Kunde ?? input.recognizedData?.Auftraggeber ?? input.sender;
  if (customer) {
    for (const vorgang of getAllVorgaenge()) {
      if (
        containsNormalized(vorgang.customer, customer) ||
        containsNormalized(customer, vorgang.customer)
      ) {
        addReason(result, 'customer_reference', vorgang.customer);
        break;
      }
    }
  }
}

function checkAuthorityAndNumbers(
  input: CompanyRelevanceInput,
  profile: CompanyProfile,
  result: CompanyRelevanceResult,
): void {
  const text = input.text;
  const hasAuthority = AUTHORITY_PATTERN.test(text);
  const hasCompanyAnchor =
    (profile.companyName.trim() && containsNormalized(text, profile.companyName)) ||
    (profile.taxNumber.trim() && containsNormalized(text, profile.taxNumber)) ||
    (profile.vatId.trim() && containsNormalized(text, profile.vatId)) ||
    BETRIEBSNUMMER_PATTERN.test(text);

  if (hasAuthority && hasCompanyAnchor) {
    addReason(result, 'authority_reference', 'Behörden-/Kassenbezug zur Firma');
  }

  if (CUSTOMER_NUMBER_PATTERN.test(text)) {
    addReason(result, 'customer_number', 'Kundennummer erkannt');
  }

  if (BETRIEBSNUMMER_PATTERN.test(text)) {
    addReason(result, 'customer_number', 'Betriebsnummer erkannt');
  }
}

export function checkCompanyRelevance(
  input: CompanyRelevanceInput,
  profile: CompanyProfile = getCompanyProfile(),
): CompanyRelevanceResult {
  const result: CompanyRelevanceResult = {
    isRelevant: false,
    reasons: [],
    matchedHints: [],
  };

  if (input.markedAsCompanyDocument) {
    addReason(result, 'manual_override', 'Manuell als Firmendokument markiert');
    return result;
  }

  checkProfileFields(input, profile, result);
  checkVorgangAndCustomer(input, result);
  checkAuthorityAndNumbers(input, profile, result);

  return result;
}

export function buildCompanyRelevanceInputFromInbox(item: InboxItem): CompanyRelevanceInput {
  const dataValues = Object.entries(item.recognizedData ?? {})
    .filter(([key]) => !key.startsWith('_'))
    .map(([, value]) => value);

  const text = [
    item.title,
    item.sender,
    item.officePilotSuggestion,
    item.recognizedData?._vertragstext ?? '',
    ...dataValues,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    text,
    recognizedData: item.recognizedData,
    sender: item.sender,
    title: item.title,
    vorgangId: item.vorgangId,
    vorgangTitle: item.vorgangTitle,
    markedAsCompanyDocument: item.markedAsCompanyDocument,
  };
}

export function isDocumentAnalysisAllowed(
  item: InboxItem,
  profile: CompanyProfile = getCompanyProfile(),
): boolean {
  return checkCompanyRelevance(buildCompanyRelevanceInputFromInbox(item), profile).isRelevant;
}

export function checkCompanyRelevanceFromInbox(
  item: InboxItem,
  profile: CompanyProfile = getCompanyProfile(),
): CompanyRelevanceResult {
  return checkCompanyRelevance(buildCompanyRelevanceInputFromInbox(item), profile);
}
