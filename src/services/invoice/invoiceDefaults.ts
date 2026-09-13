import type { CompanyProfile, CompanySetup, TaxStatus } from '../../types/models';
import { addCalendarDays, buildSkontoText } from '../invoiceTaxService';
import {
  resolveProfileDefaultClosingText,
  resolveProfileDefaultIntroText,
  resolveProfileDefaultTaxStatus,
} from '../company/companyProfileSettingsContract';

/**
 * SETTINGS-01B1 — der eine Default-Resolver für neue Rechnungsentwürfe.
 *
 * Vorgangsrechnung und manuelle Rechnung bauen ihre Vorbelegung ausschliesslich
 * hier. Die Regel ist bewusst einfach: Ein Settings-Default wird **einmal**
 * beim Aufbau in einen konkreten Entwurfswert übersetzt; danach gehört der
 * Wert dem Entwurf (Resume/Durability sind autoritativ), und eine spätere
 * Änderung der Einstellungen wirkt nur auf später erzeugte Entwürfe.
 *
 * `taxStatus`: Profil-Default gewinnt, sonst der Legacy-Wert aus dem
 * Onboarding (`CompanySetup.taxStatus`). Beides ist **nur** Vorbelegung —
 * die §13b-Bestätigung ist ein eigener, entwurfsgebundener Nutzerakt
 * (`reverseChargeConfirmationService`) und wird hier nie gesetzt.
 */
export interface InvoiceDraftDefaults {
  issueDate: string;
  paymentDueDate: string;
  paymentTermsText: string;
  skontoText: string;
  taxStatus: TaxStatus;
  introText: string;
  closingText: string;
}

export function standardPaymentTerms(days: number, withoutDeduction: boolean): string {
  return withoutDeduction
    ? `Zahlbar innerhalb von ${days} Tagen ohne Abzug.`
    : `Zahlbar innerhalb von ${days} Tagen.`;
}

/**
 * Unverändert aus `invoiceService` übernommen (SKONTO-INVOICE-TEXT-01B):
 * ein eigener Zahlungstext gewinnt; der Standardsatz folgt dem Skonto.
 */
export function buildDefaultPaymentTerms(profile: CompanyProfile): string {
  const days = profile.defaultPaymentDays;
  const configured = profile.defaultPaymentTerms.trim();
  const grantsSkonto = buildSkontoText(profile).trim().length > 0;

  if (configured && configured !== standardPaymentTerms(days, true)) {
    return configured;
  }

  return standardPaymentTerms(days, !grantsSkonto);
}

export function resolveDefaultTaxStatus(
  profile: Pick<CompanyProfile, 'defaultTaxStatus'>,
  setup: Pick<CompanySetup, 'taxStatus'>,
): TaxStatus {
  return resolveProfileDefaultTaxStatus(profile) ?? setup.taxStatus;
}

export function resolveInvoiceDefaults(
  profile: CompanyProfile,
  setup: Pick<CompanySetup, 'taxStatus'>,
  issueDate: string,
): InvoiceDraftDefaults {
  return {
    issueDate,
    paymentDueDate: addCalendarDays(issueDate, profile.defaultPaymentDays),
    paymentTermsText: buildDefaultPaymentTerms(profile),
    skontoText: buildSkontoText(profile),
    taxStatus: resolveDefaultTaxStatus(profile, setup),
    introText: resolveProfileDefaultIntroText(profile),
    closingText: resolveProfileDefaultClosingText(profile),
  };
}

/**
 * SETTINGS-01B4 — ist der Text einer der beiden bekannten Standardsätze für
 * dieses Zahlungsziel? Nur dann gilt er als „nicht eigener" Text.
 */
export function isStandardPaymentTerms(text: string, days: number): boolean {
  const current = text.trim();
  return current === standardPaymentTerms(days, true) || current === standardPaymentTerms(days, false);
}

/**
 * SETTINGS-01B4 — dieselbe Regel wie `reconcilePaymentTermsWithSkonto`, nur
 * für das Zahlungsziel: Ein Standardsatz folgt der neuen Tageszahl; ein
 * selbst formulierter Text bleibt wortgleich. Wird auf der Einstellungsseite
 * beim Ändern des Zahlungsziels angewendet — nicht beim Lesen, nicht beim
 * Rechnungsaufbau.
 */
export function reconcilePaymentTermsWithDays(
  paymentTermsText: string,
  previousDays: number,
  nextDays: number,
): string {
  const current = paymentTermsText.trim();
  if (current === standardPaymentTerms(previousDays, true)) return standardPaymentTerms(nextDays, true);
  if (current === standardPaymentTerms(previousDays, false)) return standardPaymentTerms(nextDays, false);
  return paymentTermsText;
}
