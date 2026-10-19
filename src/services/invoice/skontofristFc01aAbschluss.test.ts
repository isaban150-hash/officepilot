/**
 * FINANZ-CORE-01A — Gesamtabschluss: Skontofrist nach § 193 BGB, Fristbeginn im Standardtext,
 * 100 % ist kein Skonto.
 *
 * Entscheidung des Auftraggebers (14.10.2026): Fällt das kalendarische Fristende (Rechnungsdatum +
 * Tage) auf Samstag oder Sonntag, gilt der Montag. Für alle Rechnungen, auch bereits ausgestellte. Der
 * Standardtext nennt den Fristbeginn („ab Rechnungsdatum“).
 *
 * Seit der Feiertags-Nacharbeit (15.10.2026, WEISS FC01A-END16-R1, Migration 20261118) verschieben auch
 * gesetzliche Feiertage am Sitz des Kunden; D5 und O4 erwarten das jetzt. Die Feiertagsfälle im Einzelnen:
 * `fristen/fristenFeiertageFc01a.test.ts` und `invoice/feiertagFristFc01a.test.ts`.
 *
 * Dieselben Beispiele prüft der Server in `supabase/tests/fc01a_skontofrist.sql` (SF1–SF12).
 *  D   Fristende (buildSkontoDeadline) — gemeinsame Datumsbeispiele
 *  O   offener Betrag (getOpenAmount) und Bankabgleich (getSkontoSettlementRemainderCents)
 *  S   Schlussrechnung friert gezahlt/Skonto ein (freezeAbschlagDeductionSettlements)
 *  T   Standardtext mit Fristbeginn, Lesart, 100 %
 * Neutrale Beispieldaten.
 */
import { describe, expect, it } from 'vitest';
import { buildSkontoDeadline, buildSkontoText, parseSkontoFromText } from '../invoiceTaxService';
import { ermittleFristLage } from '../fristen/fristende';
import { getOpenAmount } from '../invoicePaymentService';
import { getSkontoSettlementRemainderCents } from './skontoSettlement';
import { freezeAbschlagDeductionSettlements } from './abschlagSettlement';
import { validateCompanyProfileForSettings } from '../setupValidationService';
import { t } from '../../i18n';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import type { AbschlagDeduction, CompanyProfile, VorgangInvoice } from '../../types/models';

const NEU = 'Bei Zahlung innerhalb von 10 Tagen ab Rechnungsdatum gewähren wir 2 % Skonto.';
const ALT = 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.';

function abschlag(issueDate: string, skontoText: string, zahlungen: Array<[number, string]>): VorgangInvoice {
  return {
    id: `ab-${issueDate}`,
    number: '2026-0101',
    type: 'abschlag',
    abschlagNumber: 1,
    calculationMode: 'fixed_amount',
    fixedAmountNet: 400,
    positions: [],
    subtotal: 400,
    taxStatus: 'standard_19',
    amount: 476,
    status: 'versendet',
    date: issueDate,
    createdAt: `${issueDate}T08:00:00.000Z`,
    issueDate,
    skontoText,
    payments: zahlungen.map(([amount, date], index) => ({ id: `p${index}`, amount, date, createdAt: `${date}T09:00:00.000Z` })),
  } as unknown as VorgangInvoice;
}

/** Die Beispielrechnungen tragen keine Anschrift: Ort unbekannt — bundesweite Feiertage verschieben trotzdem. */
const ORT_UNBEKANNT = ermittleFristLage({});

describe('D — Fristende: Samstag, Sonntag und Feiertag → nächster Werktag (gemeinsame Beispiele mit SF1/SF7)', () => {
  it.each([
    ['Do 03.09. + 10 = So 13.09.', '2026-09-03', 10, '2026-09-14'],
    ['Mi 02.09. + 10 = Sa 12.09.', '2026-09-02', 10, '2026-09-14'],
    ['Fr 04.09. + 10 = Mo 14.09. (bleibt)', '2026-09-04', 10, '2026-09-14'],
    ['Di 01.09. + 10 = Fr 11.09. (bleibt)', '2026-09-01', 10, '2026-09-11'],
    ['Di 21.04. + 10 = Fr 01.05., bundesweiter Feiertag → Mo 04.05. (WEISS FC01A-END16-R1)', '2026-04-21', 10, '2026-05-04'],
    ['Jahreswechsel: Mi 23.12.2026 + 10 = Sa 02.01.2027', '2026-12-23', 10, '2027-01-04'],
    ['Schaltjahr: Do 19.02.2028 + 10 = Di 29.02.2028 (bleibt)', '2028-02-19', 10, '2028-02-29'],
  ])('%s', (_name, basis, tage, erwartet) => {
    expect(buildSkontoDeadline(basis, tage, ORT_UNBEKANNT)).toBe(erwartet);
  });
});

describe('O — offener Betrag und Bankabgleich nach der neuen Frist (wie SF3–SF8)', () => {
  it('O1 Fristende Sonntag, 466,48 am Montag: ausgeglichen — auch mit dem bisherigen Wortlaut (Bestand)', () => {
    expect(getOpenAmount(abschlag('2026-09-03', ALT, [[466.48, '2026-09-14']]))).toBe(0);
    expect(getOpenAmount(abschlag('2026-09-03', NEU, [[466.48, '2026-09-14']]))).toBe(0);
  });

  it('O2 dieselbe Zahlung am Dienstag: verspätet, 9,52 bleiben offen', () => {
    expect(getOpenAmount(abschlag('2026-09-03', NEU, [[466.48, '2026-09-15']]))).toBe(9.52);
  });

  it('O3 Fristende Samstag: Montag noch fristgerecht', () => {
    expect(getOpenAmount(abschlag('2026-09-02', NEU, [[466.48, '2026-09-14']]))).toBe(0);
  });

  it('O4 Fristende Montag (Werktag) bleibt; Fristende Feiertag Fr 01.05. verschiebt auf Mo 04.05. (WEISS)', () => {
    expect(getOpenAmount(abschlag('2026-09-04', NEU, [[466.48, '2026-09-15']]))).toBe(9.52);
    expect(getOpenAmount(abschlag('2026-04-21', NEU, [[466.48, '2026-05-04']]))).toBe(0);
    expect(getOpenAmount(abschlag('2026-04-21', NEU, [[466.48, '2026-05-05']]))).toBe(9.52);
  });

  it('O5 Bankabgleich: am Montag wird noch der Skontobetrag erwartet, am Dienstag nicht mehr', () => {
    const offen = abschlag('2026-09-03', NEU, []);
    expect(getSkontoSettlementRemainderCents(offen, '2026-09-14')).toBe(46648);
    expect(getSkontoSettlementRemainderCents(offen, '2026-09-15')).toBeNull();
  });

  it('O6 100 % ist kein Skonto: ohne Zahlung bleibt alles offen (wie der Server)', () => {
    expect(getOpenAmount(abschlag('2026-09-03', 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 100 % Skonto.', []))).toBe(476);
  });
});

describe('S — Schlussrechnung friert die Aufteilung nach der neuen Frist ein (wie SF9/SF10)', () => {
  const deduction = (id: string): AbschlagDeduction => ({ invoiceId: id, invoiceNumber: '2026-0101', abschlagNumber: 1, date: '2026-09-03', subtotal: 400, amount: 476 });

  it('S1 Zahlung am Montag nach dem Sonntag-Fristende: gezahlt 466,48 + Skonto 9,52', () => {
    const ab = abschlag('2026-09-03', NEU, [[466.48, '2026-09-14']]);
    const [eingefroren] = freezeAbschlagDeductionSettlements([deduction(ab.id)], () => ab);
    expect(eingefroren).toMatchObject({ paidAmount: 466.48, skontoAmount: 9.52 });
  });

  it('S2 Zahlung am Dienstag: kein Skonto — der Abschlag ist nicht beglichen', () => {
    const ab = abschlag('2026-09-03', NEU, [[466.48, '2026-09-15']]);
    expect(getOpenAmount(ab)).toBe(9.52);
  });
});

describe('T — Standardtext mit Fristbeginn, Lesart, 100 %', () => {
  const profil = (o: Partial<CompanyProfile>): CompanyProfile => ({ ...DEFAULT_COMPANY_PROFILE, skontoEnabled: true, ...o }) as CompanyProfile;

  it('T1 der Standardtext nennt den Fristbeginn und wird gelesen wie bisher', () => {
    expect(buildSkontoText(profil({ skontoPercent: 2, skontoDays: 10 }))).toBe(NEU);
    expect(buildSkontoText(profil({ skontoPercent: 2.5, skontoDays: 1 }))).toBe(
      'Bei Zahlung innerhalb von 1 Tag ab Rechnungsdatum gewähren wir 2,5 % Skonto.',
    );
    expect(parseSkontoFromText(NEU)).toEqual({ percent: 2, days: 10 });
    expect(parseSkontoFromText('Bei Zahlung innerhalb von 1 Tag ab Rechnungsdatum gewähren wir 2,5 % Skonto.')).toEqual({ percent: 2.5, days: 1 });
  });

  it('T2 bereits ausgestellte Wortlaute bleiben lesbar und unverändert gültig', () => {
    expect(parseSkontoFromText(ALT)).toEqual({ percent: 2, days: 10 });
  });

  it('T3 100 % und mehr sind kein Skonto; die Einstellungen lassen 100 % nicht zu, 99 % schon', () => {
    expect(parseSkontoFromText('Bei Zahlung innerhalb von 10 Tagen gewähren wir 100 % Skonto.')).toBeNull();
    expect(parseSkontoFromText('Bei Zahlung innerhalb von 10 Tagen gewähren wir 120 % Skonto.')).toBeNull();
    expect(validateCompanyProfileForSettings(profil({ skontoPercent: 100, skontoDays: 10, defaultPaymentDays: 14 })).errors.skontoPercent).toBe(
      'companyProfile.skontoPercentInvalid',
    );
    expect(validateCompanyProfileForSettings(profil({ skontoPercent: 99, skontoDays: 10, defaultPaymentDays: 14 })).errors.skontoPercent).toBeUndefined();
    // Die Meldung nennt dieselbe Grenze (vorher „höchstens 100“, obwohl 100 abgewiesen wird).
    expect(t('companyProfile.skontoPercentInvalid')).toBe('Skonto-Prozentsatz muss grösser als 0 und kleiner als 100 sein.');
  });
});
