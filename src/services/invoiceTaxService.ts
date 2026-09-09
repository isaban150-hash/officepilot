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

/**
 * SKONTO-INVOICE-TEXT-01B — die strukturierten Felder sind die Wahrheit.
 *
 * Bis hierher hatte `defaultSkonto` Vorrang vor allem anderen. Das war eine
 * stille Falle: `FirmendatenPage` leitet `defaultSkonto` selbst aus genau
 * dieser Funktion ab, und weil sie den alten Text zurückgab, sobald er gefüllt
 * war, blieb er nach einer Änderung von Prozentsatz oder Frist unverändert
 * stehen. Wer von 2 % / 10 Tage auf 3 % / 14 Tage wechselte, behielt den alten
 * Satz — in den Firmendaten und damit überall.
 *
 * Ein Eingabefeld für `defaultSkonto` gibt es heute nirgends; der Wert ist
 * ausschliesslich abgeleitet. Deshalb gewinnen jetzt `skontoEnabled`,
 * `skontoPercent` und `skontoDays`, und `defaultSkonto` bleibt nur noch das,
 * was es faktisch ist: ein Bestandswert.
 *
 * Reihenfolge:
 *  1. `skontoEnabled === false` — kein Skonto. Ein alter `defaultSkonto` darf
 *     Skonto **niemals** wieder einschalten.
 *  2. gültige strukturierte Felder — daraus wird der Satz gebildet.
 *  3. Altbestand (`skontoEnabled` nicht gesetzt, aber `defaultSkonto` gefüllt)
 *     — der gespeicherte Text bleibt erhalten, damit vorhandene Profile ihren
 *     Satz nicht verlieren.
 */
export function buildSkontoText(profile: CompanyProfile): string {
  const legacyText = profile.defaultSkonto?.trim() ?? '';

  if (profile.skontoEnabled === false) return '';

  const percentValue = profile.skontoPercent ?? 0;
  const daysValue = profile.skontoDays ?? 0;
  if (profile.skontoEnabled === true && percentValue > 0 && daysValue > 0) {
    const percent = Number.isInteger(percentValue)
      ? String(percentValue)
      : percentValue.toLocaleString('de-DE');
    // „1 Tag", nicht „1 Tagen".
    const days = daysValue === 1 ? '1 Tag' : `${daysValue} Tagen`;
    return `Bei Zahlung innerhalb von ${days} gewähren wir ${percent} % Skonto.`;
  }

  // Altbestand ohne gesetzten Schalter behält seinen gespeicherten Satz.
  if (profile.skontoEnabled === undefined && legacyText) return legacyText;

  return '';
}

/**
 * INVOICE-SKONTO-PAYMENT-RECONCILIATION-01 — die Gegenrichtung zu
 * `buildSkontoText`: aus dem Satz zurück auf Prozentsatz und Frist.
 *
 * Beide Funktionen gehören zusammen und lagen bisher getrennt — das Lesen in
 * `financeIntelligenceService`, das Schreiben hier. Getrennt konnte die
 * Zahlungsabstimmung nicht an das Lesen heran, ohne einen Zyklus zu bauen
 * (`financeIntelligenceService` importiert seinerseits den Zahlungsdienst).
 * Verschoben, nicht verändert: dieselben zwei Muster wie zuvor.
 *
 * `null` heisst „kein belastbarer Skontosatz". Es wird nichts geraten und
 * nichts ergänzt — ohne Prozentsatz **und** Frist gibt es kein Skonto.
 */
export function parseSkontoFromText(text: string): { percent: number; days: number } | null {
  const percentFirst = text.match(/(\d+(?:[.,]\d+)?)\s*%.*?(\d+)\s*tage/i);
  if (percentFirst) {
    const percent = Number(percentFirst[1].replace(',', '.'));
    const days = Number(percentFirst[2]);
    if (Number.isFinite(percent) && Number.isFinite(days) && percent > 0 && days > 0) {
      return { percent, days };
    }
  }

  const daysFirst = text.match(/(\d+)\s*tage.*?(\d+(?:[.,]\d+)?)\s*%/i);
  if (daysFirst) {
    const days = Number(daysFirst[1]);
    const percent = Number(daysFirst[2].replace(',', '.'));
    if (Number.isFinite(percent) && Number.isFinite(days) && percent > 0 && days > 0) {
      return { percent, days };
    }
  }

  return null;
}

/**
 * INVOICE-PAYMENT-TERMS-DAYS-DRIFT-01A — die eine Datumsrechnung für Fristen.
 *
 * Gerechnet wird in UTC, und zwar zwingend: `new Date('2026-03-20')` ist
 * UTC-Mitternacht, `setDate` addiert aber in Ortszeit. Über die
 * Sommerzeitumstellung hinweg verschob das jede Frist um einen Tag nach vorn —
 * gemessen ergab in Europe/Berlin `2026-03-20 + 14 Tage` den 02.04. statt des
 * 03.04. Eine Rechnung wies damit „Zahlbar innerhalb von 14 Tagen" aus und
 * nannte daneben ein Fälligkeitsdatum nach 13 Tagen.
 *
 * Fristen zählen Kalendertage, keine Stunden. Zeitzone und Sommerzeit haben
 * darin nichts zu suchen. Der Zieltag selbst zählt dazu.
 *
 * Unlesbares Basisdatum: der Wert bleibt, wie er ist. Es wird nichts geraten;
 * ungültige Rechnungsdaten fängt die Freigabevalidierung ab.
 */
export function addCalendarDays(baseDate: string, days: number): string {
  const date = new Date(`${baseDate.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return baseDate.slice(0, 10);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Letzter Tag, an dem das Skonto noch gilt — der Tag selbst zählt dazu. */
export function buildSkontoDeadline(baseDate: string, days: number): string {
  return addCalendarDays(baseDate, days);
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
