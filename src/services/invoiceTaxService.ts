import type { CompanyProfile, TaxStatus } from '../types/models';
import { berechneFristFenster, type FristFenster, type FristLage } from './fristen/fristende';

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
    /*
     * FINANZ-CORE-01A (Gesamtabschluss, Entscheidung des Auftraggebers) — der Fristbeginn steht
     * ausdrücklich im Satz. Ohne Angabe beginnt eine Skontofrist nach überwiegender Auffassung erst
     * mit dem Zugang beim Kunden; gerechnet wird ab Rechnungsdatum (`buildSkontoDeadline`). Text und
     * Rechnung stimmen damit überein. Bereits ausgestellte Rechnungen behalten ihren Wortlaut.
     */
    return `Bei Zahlung innerhalb von ${days} ab Rechnungsdatum gewähren wir ${percent} % Skonto.`;
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
 *
 * FC01A-Nacharbeit (A4) — die Frist ist die Tagesangabe, die **zum Skontosatz gehört**:
 * im selben Satz wie der (erste) Satz, nicht als Nettofrist gekennzeichnet („30 Tage
 * netto", „ohne Abzug", „Zahlungsziel 30 Tage"), unter mehreren die nächstliegende.
 * Bisher nahm die Lesart die erste Tagesangabe *nach* dem Satz — bei „Bei Zahlung
 * innerhalb von 10 Tagen 2 % Skonto, sonst 30 Tage netto" also 30 Tage: Eine verspätete
 * Zahlung galt als fristgerechtes Skonto. Eine Nettofrist ist nie die Skontofrist, und über
 * Satzgrenzen hinweg wird nichts zusammengesetzt. Der Server liest genauso
 * (`workspace_skonto_terms`); die gemeinsamen Beispiele stehen in beiden Tests.
 */
const SKONTO_PERCENT = /(\d+(?:[.,]\d+)?)\s*%/;
const SKONTO_DAYS = /(\d+)\s*tag(?:e|en)?\b/gi;
const SKONTO_NET_AFTER = /^[\s,:]*(?:(?:rein\s+)?netto\b|ohne\s+(?:(?:jeden|jeglichen)\s+)?abzug)/i;
const SKONTO_NET_BEFORE = /(?:zahlungsziel|netto(?:zahlungsziel)?)\s*(?::|von|innerhalb(?:\s+von)?|bis\s+zu)?\s*$/i;
const SKONTO_MAX_DAYS = 3660;

function isSentenceBoundary(text: string, index: number): boolean {
  const ch = text[index];
  if (ch === '!' || ch === '?' || ch === ';' || ch === '\n' || ch === '\r') return true;
  if (ch !== '.') return false;
  // Dezimalpunkt und Datum („2.5 %", „01.10.2026") trennen keinen Satz.
  return !(/\d/.test(text[index - 1] ?? '') && /\d/.test(text[index + 1] ?? ''));
}

export function parseSkontoFromText(rawText: string): { percent: number; days: number } | null {
  // Geschützte Leerzeichen (etwa aus einer Textverarbeitung) liest der Server nicht als Leerraum.
  const text = rawText.replace(/[  ]/g, ' ');
  const percentMatch = SKONTO_PERCENT.exec(text);
  if (!percentMatch) return null;
  const percent = Number(percentMatch[1].replace(',', '.'));
  // FINANZ-CORE-01A (Gesamtabschluss) — 100 % und mehr sind kein Skonto, sondern ein Erlass; der
  // Server rechnet ebenso (`workspace_invoice_open_cents`: 0 < Satz < 100). Bisher galt eine Rechnung
  // mit „100 % Skonto …“ im Client ohne Zahlung als ausgeglichen, auf dem Server nicht.
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) return null;
  const percentStart = percentMatch.index;
  const percentEnd = percentStart + percentMatch[0].length;

  let sentenceStart = percentStart;
  while (sentenceStart > 0 && !isSentenceBoundary(text, sentenceStart - 1)) sentenceStart -= 1;
  let sentenceEnd = percentEnd;
  while (sentenceEnd < text.length && !isSentenceBoundary(text, sentenceEnd)) sentenceEnd += 1;

  let best: { days: number; distance: number } | null = null;
  for (const match of text.matchAll(SKONTO_DAYS)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start < sentenceStart || end > sentenceEnd) continue;
    const after = text.slice(end, Math.min(sentenceEnd, end + 20));
    const before = text.slice(Math.max(sentenceStart, start - 25), start);
    if (SKONTO_NET_AFTER.test(after) || SKONTO_NET_BEFORE.test(before)) continue;
    const days = Number(match[1]);
    if (!Number.isFinite(days) || days <= 0 || days > SKONTO_MAX_DAYS) continue;
    const distance = end <= percentStart ? percentStart - end : start - percentEnd;
    if (!best || distance < best.distance) best = { days, distance };
  }
  return best ? { percent, days: best.days } : null;
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

/**
 * Letzter Tag, an dem das Skonto noch gilt — der Tag selbst zählt dazu.
 *
 * FINANZ-CORE-01A (Feiertage, Entscheidung des Auftraggebers vom 15.10.2026) — § 193 BGB:
 * Fällt das kalendarische Fristende (Rechnungsdatum + Tage, OLG Hamm 21 U 134/04: Kalendertage)
 * auf Samstag, Sonntag oder einen gesetzlichen Feiertag am Sitz des Kunden, tritt der nächste
 * Werktag an seine Stelle — dieselbe Regel wie beim Zahlungsziel. Ist der Ort nicht eindeutig,
 * liefert das Fenster jedes mögliche Ende (`fristen/fristende.ts`). Gilt für alle Rechnungen, auch
 * bereits ausgestellte. Der Server rechnet gleich (`workspace_invoice_open_cents`, Migration
 * 20261118). Bisher (20261117) verschob nur Samstag/Sonntag — WEISS-FAIL FC01A-END16-R1.
 */
export function buildSkontoDeadlineWindow(baseDate: string, days: number, lage: FristLage): FristFenster {
  return berechneFristFenster(addCalendarDays(baseDate, days), lage);
}

/** Frühestes wirksames Skonto-Fristende am Ort `lage` (bei eindeutigem Ort: das Fristende). */
export function buildSkontoDeadline(baseDate: string, days: number, lage: FristLage): string {
  return buildSkontoDeadlineWindow(baseDate, days, lage).fruehestens;
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
