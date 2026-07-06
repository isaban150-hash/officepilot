import type { CompanyProfile, TaxStatus } from '../types/models';

export function getTaxRateForStatus(status: TaxStatus | string): number {
  switch (status) {
    case 'standard_19':
      return 19;
    case 'standard_7':
      return 7;
    case 'kleinunternehmer_19':
    case 'reverse_charge_13b':
    case 'tax_free':
    case 'unclear':
      return 0;
    default:
      return 0;
  }
}

export function buildLegalNotices(
  taxStatus: TaxStatus,
  profile?: Pick<CompanyProfile, 'taxFreeNotice'>,
): string[] {
  switch (taxStatus) {
    case 'kleinunternehmer_19':
      return ['Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.'];
    case 'reverse_charge_13b':
      return ['Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.'];
    case 'tax_free':
      return [
        profile?.taxFreeNotice?.trim() ||
          'Die Leistung ist steuerfrei bzw. ohne Umsatzsteuer.',
      ];
    case 'unclear':
      return ['Steuerhinweis: Bitte ergänzen Sie den Steuerstatus in den Firmendaten.'];
    default:
      return [];
  }
}

export function buildSkontoText(profile: CompanyProfile): string {
  if (profile.defaultSkonto.trim()) {
    return profile.defaultSkonto.trim();
  }
  if (!profile.skontoEnabled || (profile.skontoPercent ?? 0) <= 0 || (profile.skontoDays ?? 0) <= 0) {
    return '';
  }
  const percent = Number.isInteger(profile.skontoPercent ?? 0)
    ? String(profile.skontoPercent ?? 0)
    : (profile.skontoPercent ?? 0).toLocaleString('de-DE');
  return `Bei Zahlung innerhalb von ${profile.skontoDays ?? 0} Tagen gewähren wir ${percent} % Skonto.`;
}

export function getTaxStatusLabel(taxStatus: TaxStatus): string {
  switch (taxStatus) {
    case 'standard_19':
      return 'Normalbesteuerung (19 % USt)';
    case 'standard_7':
      return 'Normalbesteuerung (7 % USt)';
    case 'kleinunternehmer_19':
      return '§19 Kleinunternehmer';
    case 'reverse_charge_13b':
      return '§13b Reverse Charge';
    case 'tax_free':
      return 'Steuerfrei / ohne USt';
    default:
      return 'Steuerstatus unklar – bitte prüfen';
  }
}
