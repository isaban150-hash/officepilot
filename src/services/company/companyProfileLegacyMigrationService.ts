/**
 * PRODUCT-BASIS-FIRMENPROFIL-01B — deterministische Migration bestehender
 * Profile auf die eine Wahrheit.
 *
 * Regeln (rein, idempotent, nie ein erfundener Wert):
 *
 *  defaultTaxStatus
 *   A) im Profil gesetzt            -> bleibt, das Setup wird nie darueber gelegt
 *   B) fehlt, Setup.taxStatus gueltig -> einmalig uebernommen (Onboarding-Entscheidung)
 *   C) beide fehlen/ungueltig        -> nichts erzeugen
 *
 *  currency
 *   - im Profil gesetzt             -> bleibt
 *   - fehlt, und **alle** kanonischen Belege mit Waehrung (Ausgaben) sind EUR
 *     oder es gibt keine             -> EUR (die bisher implizite Produktwaehrung)
 *   - fehlt, und ein Beleg traegt eine andere Waehrung -> **nicht** setzen,
 *     Konflikt wird gemeldet (kein stilles Ueberschreiben)
 *
 * Finalisierte Rechnungen und ihre Snapshots werden hier nie beruehrt.
 */
import type { CompanyProfile, CompanySetup } from '../../types/models';
import { DEFAULT_PROFILE_CURRENCY, isCurrencyCode, isTaxStatus } from './companyProfileSettingsContract';

export interface CompanyProfileMigrationInput {
  profile: CompanyProfile;
  setup: Pick<CompanySetup, 'taxStatus'>;
  /** Waehrungen der kanonischen Belege (z. B. `expense.currency`); leer erlaubt. */
  documentCurrencies: ReadonlyArray<string | undefined | null>;
}

export type CompanyProfileMigrationChange = 'defaultTaxStatus_from_setup' | 'currency_default_eur';
export type CompanyProfileMigrationConflict = 'currency_ambiguous';

export interface CompanyProfileMigrationResult {
  profile: CompanyProfile;
  changes: CompanyProfileMigrationChange[];
  conflicts: CompanyProfileMigrationConflict[];
}

export function migrateCompanyProfileLegacyFields(input: CompanyProfileMigrationInput): CompanyProfileMigrationResult {
  const changes: CompanyProfileMigrationChange[] = [];
  const conflicts: CompanyProfileMigrationConflict[] = [];
  let profile = input.profile;

  if (!isTaxStatus(profile.defaultTaxStatus) && isTaxStatus(input.setup.taxStatus)) {
    profile = { ...profile, defaultTaxStatus: input.setup.taxStatus };
    changes.push('defaultTaxStatus_from_setup');
  }

  if (!isCurrencyCode(profile.currency)) {
    const foreign = input.documentCurrencies.some((currency) => {
      const code = (currency ?? '').trim().toUpperCase();
      return code !== '' && code !== DEFAULT_PROFILE_CURRENCY;
    });
    if (foreign) {
      conflicts.push('currency_ambiguous');
    } else {
      profile = { ...profile, currency: DEFAULT_PROFILE_CURRENCY };
      changes.push('currency_default_eur');
    }
  }

  return { profile, changes, conflicts };
}
