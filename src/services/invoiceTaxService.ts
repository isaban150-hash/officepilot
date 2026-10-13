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

/**
 * FINANZ-CORE-01A (AUS-11/EIN-07) — § 14 Abs. 4 Satz 1 Nr. 9 UStG: Bei einer Leistung im
 * Zusammenhang mit einem Grundstück an einen Nichtunternehmer muss die Rechnung auf dessen
 * Aufbewahrungspflicht hinweisen (zwei Jahre, § 14b Abs. 1 Satz 5 UStG). Ein Kundentyp im
 * Stamm fehlt; der Hinweis wird je Rechnung bewusst gesetzt.
 */
export const PRIVATE_RETENTION_NOTICE =
  'Hinweis: Als privater Leistungsempfänger sind Sie verpflichtet, diese Rechnung zwei Jahre lang aufzubewahren (§ 14b Abs. 1 Satz 5 UStG).';

export function hasPrivateRetentionNotice(notices: readonly string[] | undefined): boolean {
  return (notices ?? []).some((text) => text.trim() === PRIVATE_RETENTION_NOTICE);
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
 * FINANZ-CORE-01A (SQL-09) — die Steuerhinweise eines Belegs passend zu seinem
 * Steuerstatus.
 *
 * Der Entwurf trägt seine Hinweise seit dem Anlegen. Wechselte der Steuerstatus auf
 * einem Weg, der sie nicht neu bildete (Altentwurf, anderes Gerät), stand auf einer
 * 19-%-Rechnung noch „Gemäß § 19 UStG …" oder auf einer Kleinunternehmerrechnung
 * gar kein Hinweis — der Server weist das jetzt ab (`invoice_legal_notice_missing`).
 *
 * Regel: Standardhinweise anderer Steuerstatus fallen weg, der Pflichthinweis des
 * eigenen Status steht vorn, eigene Zusätze bleiben. Passt alles schon, bleibt die
 * Liste unverändert (auch in der Reihenfolge).
 */
export function normalizeLegalNoticesForTaxStatus(
  taxStatus: TaxStatus,
  notices: readonly string[],
  profile?: Pick<CompanyProfile, 'taxFreeNotice'>,
): string[] {
  const own = buildLegalNotices(taxStatus, profile);
  const standard = new Set(
    (['kleinunternehmer_19', 'reverse_charge_13b', 'tax_free', 'unclear'] as TaxStatus[])
      .flatMap((status) => [...buildLegalNotices(status, profile), ...buildLegalNotices(status)])
      .map((text) => text.trim()),
  );
  const ownSet = new Set(own.map((text) => text.trim()));
  const foreign = notices.some((text) => standard.has(text.trim()) && !ownSet.has(text.trim()));
  const missing = own.some((text) => !notices.some((entry) => entry.trim() === text.trim()));
  if (!foreign && !missing) return [...notices];
  const custom = notices.filter((text) => text.trim() && !standard.has(text.trim()));
  return [...own, ...custom];
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
 * Verschoben; seit FINANZ-CORE-01A (ZAH-15) erkennen beide Muster auch die
 * Einzahl „1 Tag", die `buildSkontoText` für eine eintägige Frist schreibt.
 *
 * `null` heisst „kein belastbarer Skontosatz". Es wird nichts geraten und
 * nichts ergänzt — ohne Prozentsatz **und** Frist gibt es kein Skonto.
 */
export function parseSkontoFromText(text: string): { percent: number; days: number } | null {
  const percentFirst = text.match(/(\d+(?:[.,]\d+)?)\s*%.*?(\d+)\s*tag(?:e|en)?\b/i);
  if (percentFirst) {
    const percent = Number(percentFirst[1].replace(',', '.'));
    const days = Number(percentFirst[2]);
    if (Number.isFinite(percent) && Number.isFinite(days) && percent > 0 && days > 0) {
      return { percent, days };
    }
  }

  const daysFirst = text.match(/(\d+)\s*tag(?:e|en)?\b.*?(\d+(?:[.,]\d+)?)\s*%/i);
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
