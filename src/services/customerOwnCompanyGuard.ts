/**
 * CUSTOMER-OWN-COMPANY-GUARD-01 — the own company is never a customer.
 *
 * Deliberately tiny and dependency-light: only the company profile is read, and
 * only at call time. No store, no matching heuristics, no fuzzy substring check.
 */
import { getCompanyProfile } from './companyProfileService';

/** Trim, collapse inner whitespace, lowercase. Nothing else. */
export function normalizeCompanyNameForComparison(value: string | undefined | null): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * True only on full normalized equality with the own company name.
 * An empty own company name never blocks a candidate.
 */
export function isOwnCompanyName(
  candidate: string | undefined | null,
  ownCompanyName: string = getCompanyProfile().companyName,
): boolean {
  const own = normalizeCompanyNameForComparison(ownCompanyName);
  if (!own) return false;
  const value = normalizeCompanyNameForComparison(candidate);
  if (!value) return false;
  return value === own;
}

/**
 * Walks the given customer-source chain in order and returns the first candidate
 * that is neither empty nor the own company. Returns '' (the established
 * unknown-customer state) when every candidate is the own company.
 */
export function pickExternalCustomerName(
  candidates: Array<string | undefined | null>,
  ownCompanyName?: string,
): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    if (isOwnCompanyName(trimmed, ownCompanyName ?? getCompanyProfile().companyName)) continue;
    return trimmed;
  }
  return '';
}
