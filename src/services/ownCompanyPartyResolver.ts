/**
 * OWN-COMPANY-PARTY-RESOLUTION — which of a document's parties IS the own company.
 *
 * Identity first, role never. A party's contractual role cannot prove whose
 * company it is: in a subcontract the user can just as well be the Auftraggeber,
 * and then the foreign company sits in the Auftragnehmer slot. Callers that need
 * a direction read the role of the identified party afterwards.
 *
 * Neutral by design — this module knows nothing about order confirmation,
 * customer prefill, Vorgänge or UI, reads no store and takes the company profile
 * as an explicit input.
 *
 * Conservative by construction: a single weak trait (a contact name, a city, a
 * phone number) never proves a company identity, and anything unclear yields no
 * identification at all.
 */
import { normalizeCompanyIdentityValue } from './companyRelevanceService';
import { isOwnCompanyName } from './customerOwnCompanyGuard';
import type { CompanyProfile } from '../types/models';
import type { DetectedContractParty } from '../types/documentIntelligence';

/** True when this party is, with sufficient certainty, the own company. */
export function isOwnCompanyParty(
  party: DetectedContractParty,
  profile: CompanyProfile,
): boolean {
  const norm = normalizeCompanyIdentityValue;
  const profileName = norm(profile.companyName ?? '');
  if (!profileName) return false;

  const partyName = norm(party.name ?? '');

  // A. Exact name match — the established strong signal, unchanged semantics.
  if (isOwnCompanyName(party.name, profile.companyName)) return true;

  /**
   * The full postal address of the own company. All three parts must be present
   * and match; a city alone is far too common to identify anyone.
   */
  const addressConfirms =
    Boolean(profile.street?.trim() && profile.zip?.trim() && profile.city?.trim()) &&
    norm(party.street ?? '') === norm(profile.street) &&
    norm(party.zip ?? '') === norm(profile.zip) &&
    norm(party.city ?? '') === norm(profile.city);

  // C. No usable name, but the complete address matches — sufficiently unique.
  if (addressConfirms) return true;

  /**
   * B. Legal form or spelling differs. One name must fully contain the other,
   * both must be reasonably long, and a second stable trait has to confirm it.
   */
  const nameRelated =
    partyName.length >= 4 &&
    profileName.length >= 4 &&
    (partyName.includes(profileName) || profileName.includes(partyName));
  if (!nameRelated) return false;

  const contactConfirms =
    Boolean(profile.contactPerson?.trim()) &&
    norm(party.contactPerson ?? '') === norm(profile.contactPerson);
  const emailConfirms =
    Boolean(profile.email?.trim()) && norm(party.email ?? '') === norm(profile.email);
  const phoneConfirms =
    Boolean(profile.phone?.trim()) && norm(party.phone ?? '') === norm(profile.phone);

  return contactConfirms || emailConfirms || phoneConfirms;
}

/**
 * Exactly one identified party, or none. Two candidates mean the document does
 * not tell us apart — picking the first would be a guess.
 */
export function findOwnCompanyParty(
  parties: readonly DetectedContractParty[] | undefined,
  profile: CompanyProfile,
): DetectedContractParty | undefined {
  const matches = (parties ?? []).filter((party) => isOwnCompanyParty(party, profile));
  return matches.length === 1 ? matches[0] : undefined;
}
