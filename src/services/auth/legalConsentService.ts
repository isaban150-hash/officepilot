import { getSupabaseClient } from '../../lib/supabase';
import { LEGAL_DOCUMENT_VERSIONS } from '../../config/legalVersions';
import type { UserAccount } from '../../types/auth';

/**
 * EINRICHTUNG-01 (AP2, EIN-19; A-13, A-14) — Zustimmung zu den geltenden Rechtstexten.
 *
 * Gültig ist sie nur für genau die geltende Fassung von AGB, Datenschutz und Lizenzbedingungen und nur mit einem
 * Zeitpunkt, den der Server gesetzt hat. Fehlt sie, ist sie unvollständig oder gilt eine neue Fassung, zeigt die App
 * die Zustimmungsseite, bevor irgendetwas anderes geschieht (A-13.3, A-14.1).
 */
export function hasCurrentLegalConsent(user: UserAccount | null | undefined): boolean {
  if (!user) return false;
  return (
    user.acceptedTermsVersion === LEGAL_DOCUMENT_VERSIONS.terms &&
    user.acceptedPrivacyVersion === LEGAL_DOCUMENT_VERSIONS.privacy &&
    user.acceptedLicenseVersion === LEGAL_DOCUMENT_VERSIONS.license &&
    Boolean(user.legalAcceptedAt)
  );
}

export type LegalConsentResult = 'ok' | 'account_mismatch' | 'version_unknown' | 'blocked' | 'session' | 'failed';

/**
 * Stimmt für genau dieses Konto zu. Der Server prüft, dass die Anmeldung noch diesem Konto gehört (A-14.3), setzt die
 * Serverzeit und ändert sonst nichts (A-14.4).
 */
export async function acceptCurrentLegalTerms(userId: string): Promise<LegalConsentResult> {
  const client = getSupabaseClient();
  if (!client) return 'failed';
  try {
    const { error } = await client.rpc('accept_current_legal_terms', {
      p_user_id: userId,
      p_terms_version: LEGAL_DOCUMENT_VERSIONS.terms,
      p_privacy_version: LEGAL_DOCUMENT_VERSIONS.privacy,
      p_license_version: LEGAL_DOCUMENT_VERSIONS.license,
    });
    if (!error) return 'ok';
    const message = error.message ?? '';
    if (message.startsWith('consent_account_mismatch')) return 'account_mismatch';
    if (message.startsWith('legal_version_unknown')) return 'version_unknown';
    if (message.startsWith('account_blocked')) return 'blocked';
    if (message.startsWith('session_not_active') || message.startsWith('Nicht angemeldet')) return 'session';
    return 'failed';
  } catch {
    return 'failed';
  }
}
