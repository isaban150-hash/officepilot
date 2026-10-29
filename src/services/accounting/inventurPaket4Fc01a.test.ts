/**
 * FINANZ-CORE-01A — Gesamtnacharbeit Paket 4 (WEISS-Gesamtmängelinventur vom 15.10.2026, INV-04): der
 * Monatsabschluss erkennt steuerlich relevante Änderungen an Zahlungen und Skonto — verglichen an den echten
 * Exportdateien (`zahlungen.csv`, `buchungen.csv`, offene Posten), nicht nur am Fingerabdruck.
 *
 *  M1  WEISS I01: Skontoabzug fällt aus der Zahlungsdatei (Kundenort, ungebundene Rechnung) → Abschluss ungültig
 *  M2  Abschluss älterer Fassung (Version 3) wird nicht umgedeutet und zeigt seine Grenze
 *  M3  gebundene Rechnung (INV-03): Kundenumzug ändert weder Datei noch Abschluss
 *  M4  Zahlungsart einer Zahlung (Bank → bar) ändert Datei und Abschluss
 *  M5  INV-05 über den Monatswechsel: Juni bleibt gültig, Juli trägt die Rücknahme; Rücknahme der Restzahlung ändert Juli
 *  M6  Beleg-Skonto in buchungen.csv; derselbe Stand ergibt dieselben Dateien und denselben Fingerabdruck
 *  M7  Cloud-Rundweg behält die Fassung (neue Stände: Version 6 seit P1-KORREKTUR A04-WEISS-R2; Version 4 bleibt Version 4)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStores } from '../../test/resetStores';
import { hydrateCustomerStore } from '../customerStoreService';
import { buildMonatsmappeModel, buildOffenePostenCsv, buildZahlungenCsv } from '../steuerberater/monatsmappeModelService';
import { buildBookingCsv, buildBookingExport } from './accountingBookingExportService';
import { buildPeriodFingerprint, buildPeriodManifest, closureFingerprintVersion } from './accountingPeriodFingerprint';
import { buildAccountingPeriodState } from './accountingPeriodService';
import { rowToAccountingPeriodClosure } from './accountingPeriodCloudSyncService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import type { AccountingPeriodClosure, AccountingPeriodFingerprintVersion } from '../../types/accountingPeriod';
import type { InvoicePayment, VorgangInvoice } from '../../types/models';
import type { AccountingAssignment } from '../../types/accounting';
import type { MonatsmappeModel } from '../steuerberater/monatsmappeModelService';

const SKONTO = 'Bei Zahlung innerhalb von 10 Tagen ab Rechnungsdatum gewähren wir 2 % Skonto.';

function zahlung(id: string, amount: number, date: string, method?: InvoicePayment['method']): InvoicePayment {
  return { id, amount, date, createdAt: `${date}T10:00:00Z`, ...(method ? { method } : {}) };
}

/** WEISS I01: Mairechnung 400/76/476 an den Grenzkunden (48431), Junizahlung 466,48 am Fr 05.06. */
function rechnung(payments: InvoicePayment[], extra: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'wi-inv', number: 'WEISS-INVENTUR-01', type: 'rechnung',
    positions: [{ id: 'p', description: 'Testleistung', quantity: 1, unit: 'Stück', unitPrice: 400, lineTotal: 400 }],
    subtotal: 400, amount: 476, taxStatus: 'standard_19', status: 'versendet', date: '2026-05-25', issueDate: '2026-05-25',
    createdAt: '2026-05-25T08:00:00Z', paymentDueDate: '2026-06-08', skontoText: SKONTO, customerId: 'wi-cust',
    customerSnapshot: { name: 'WEISS Testkunde', contactPerson: '', street: 'Testweg 1', zip: '48431', city: 'Rheine', email: '', phone: '', countryCode: 'DE' },
    currencyCode: 'EUR', servicePeriodFrom: '2026-05-25', servicePeriodTo: '2026-05-25', servicePeriodConfirmed: true,
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'WEISS Testbetrieb', legalForm: 'GmbH', street: 'Werkweg 1', zip: '33100', city: 'Paderborn', countryCode: 'DE' },
    legalNotices: [], payments, ...extra,
  } as VorgangInvoice;
}

function kundeIn(region: 'NW' | 'NI') {
  hydrateCustomerStore([
    { id: 'wi-cust', name: 'WEISS Testkunde', contactPerson: '', street: 'Testweg 1', zip: '48431', city: 'Rheine', email: '', phone: '', holidayLocation: { region }, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
  ]);
}

function mappe(invoice: VorgangInvoice, monthKey: string): MonatsmappeModel {
  return buildMonatsmappeModel({ monthKey, invoices: [{ invoice, vorgangId: 'wi-v' }], expenses: [], documents: [], inboxItems: [], fileRefs: [] } as never);
}

function abschluss(model: MonatsmappeModel, version?: AccountingPeriodFingerprintVersion): AccountingPeriodClosure {
  const manifest = buildPeriodManifest(model, [], 'SKR03', version);
  return {
    id: `close-${model.monthKey}-${version ?? 'neu'}`, monthKey: model.monthKey, revision: 1, closedAt: '2026-07-01T10:00:00Z',
    fingerprint: buildPeriodFingerprint(manifest), manifest, createdAt: '2026-07-01T10:00:00Z', updatedAt: '2026-07-01T10:00:00Z',
  } as AccountingPeriodClosure;
}

/** Eine bestätigte Kontierung der Rechnung, damit buchungen.csv den Beleg führt. */
const KONTIERUNG: AccountingAssignment = {
  id: 'k-inv', sourceType: 'invoice', sourceId: 'wi-inv', chartOfAccounts: 'SKR03', accountNumber: '8400', accountLabel: 'Erlöse 19 %',
  taxTreatment: 'standard_19', bookingText: 'WEISS-INVENTUR-01', status: 'confirmed', origin: 'manual',
  confirmedAt: '2026-06-01T10:00:00Z', createdAt: '2026-06-01T10:00:00Z', updatedAt: '2026-06-01T10:00:00Z',
};

function dateien(model: MonatsmappeModel): { zahlungen: string; buchungen: string; offen: string } {
  return {
    zahlungen: buildZahlungenCsv(model),
    buchungen: buildBookingCsv(buildBookingExport(model, [KONTIERUNG], 'SKR03')),
    offen: buildOffenePostenCsv(model),
  };
}

beforeEach(() => {
  resetTestStores();
});

describe('INV-04 — der Abschluss bindet, was der Export über Zahlungen und Skonto sagt', () => {
  it('M0 ein neuer Abschluss entsteht mit Version 6 (der Dienst bildet den Stand zum Abschließen so)', () => {
    kundeIn('NW');
    const state = buildAccountingPeriodState(mappe(rechnung([zahlung('p1', 466.48, '2026-06-05')]), '2026-06'), [], 'SKR03', []);
    // Systemische Gesamtnacharbeit — Fassung 5: servervalidierbar, inklusive kumulierter offener Posten.
    // P1-KORREKTUR A04-WEISS-R2 — neue Stände in Fassung 6 (zusätzlich Steueraufteilung und Vorsteuerabzug).
    expect(state.currentManifest.fingerprintVersion).toBe(6);
    expect(state.currentFingerprint.startsWith('p6:')).toBe(true);
  });

  it('M1 WEISS I01: Skontoabzug fällt aus der Zahlungsdatei → neuer Abschluss (Version 6) ist ungültig', () => {
    kundeIn('NW');
    const vorher = mappe(rechnung([zahlung('p1', 466.48, '2026-06-05')]), '2026-06');
    const closure = abschluss(vorher);
    expect(closureFingerprintVersion(closure)).toBe(6);
    kundeIn('NI');
    const nachher = mappe(rechnung([zahlung('p1', 466.48, '2026-06-05')]), '2026-06');
    expect(vorher.zahlungenAusgang[0]!.skontoAbzug).toBe(9.52);
    expect(nachher.zahlungenAusgang[0]!.skontoAbzug).toBeUndefined();
    expect(dateien(nachher).zahlungen).not.toBe(dateien(vorher).zahlungen);
    const state = buildAccountingPeriodState(nachher, [], 'SKR03', [closure]);
    expect(state.isCurrentClosureValid).toBe(false);
    expect(state.readiness).toBe('changed_after_close');
    expect(state.currentFingerprint).not.toBe(closure.fingerprint);
  });

  it('M2 ein Abschluss der Version 3 bleibt nach seiner Regel gültig (keine stille Umdeutung)', () => {
    kundeIn('NW');
    const closure = abschluss(mappe(rechnung([zahlung('p1', 466.48, '2026-06-05')]), '2026-06'), 3);
    kundeIn('NI');
    const state = buildAccountingPeriodState(mappe(rechnung([zahlung('p1', 466.48, '2026-06-05')]), '2026-06'), [], 'SKR03', [closure]);
    expect(closureFingerprintVersion(closure)).toBe(3);
    expect(state.isCurrentClosureValid).toBe(true);
    expect(state.currentFingerprint.startsWith('p3:')).toBe(true);
  });

  it('M3 gebundene Rechnung (INV-03): Kundenumzug ändert weder Zahlungsdatei noch Abschluss', () => {
    const gebunden = (payments: InvoicePayment[]) =>
      rechnung(payments, { fristBasis: { lage: { art: 'inland', laender: ['NW'], gemeinde: {}, quelle: 'kunde' }, quelle: 'freigabe' } });
    kundeIn('NW');
    const vorher = mappe(gebunden([zahlung('p1', 466.48, '2026-06-05')]), '2026-06');
    const closure = abschluss(vorher);
    kundeIn('NI');
    const nachher = mappe(gebunden([zahlung('p1', 466.48, '2026-06-05')]), '2026-06');
    expect(dateien(nachher)).toEqual(dateien(vorher));
    expect(buildAccountingPeriodState(nachher, [], 'SKR03', [closure]).isCurrentClosureValid).toBe(true);
  });

  it('M4 Zahlungsart Bank → bar: Datei und Abschluss (Version 4) ändern sich; Version 3 kannte das Feld nicht', () => {
    kundeIn('NW');
    const bank = mappe(rechnung([zahlung('p1', 476, '2026-06-05', 'bank')]), '2026-06');
    const bar = mappe(rechnung([zahlung('p1', 476, '2026-06-05', 'cash')]), '2026-06');
    expect(dateien(bar).zahlungen).not.toBe(dateien(bank).zahlungen);
    expect(buildAccountingPeriodState(bar, [], 'SKR03', [abschluss(bank)]).isCurrentClosureValid).toBe(false);
    expect(buildAccountingPeriodState(bar, [], 'SKR03', [abschluss(bank, 3)]).isCurrentClosureValid).toBe(true);
  });

  it('M5 INV-05 über den Monatswechsel: Juni bleibt gültig, Juli trägt die Rücknahme und erkennt ihre Zurücknahme', () => {
    kundeIn('NW');
    const ohneRest = rechnung([zahlung('p1', 466.48, '2026-06-05')]);
    const mitRest = rechnung([zahlung('p1', 466.48, '2026-06-05'), zahlung('p2', 9.52, '2026-07-03')]);
    const juni = abschluss(mappe(ohneRest, '2026-06'));
    expect(buildAccountingPeriodState(mappe(mitRest, '2026-06'), [], 'SKR03', [juni]).isCurrentClosureValid).toBe(true);
    const juliMitRest = mappe(mitRest, '2026-07');
    expect(juliMitRest.zahlungenAusgang.map((z) => z.skontoAbzug)).toEqual([-9.52]);
    const juli = abschluss(juliMitRest);
    const juliOhneRest = mappe(ohneRest, '2026-07');
    expect(dateien(juliOhneRest).zahlungen).not.toBe(dateien(juliMitRest).zahlungen);
    expect(buildAccountingPeriodState(juliOhneRest, [], 'SKR03', [juli]).isCurrentClosureValid).toBe(false);
  });

  it('M6 Beleg-Skonto in buchungen.csv bindet den Abschluss; derselbe Stand ergibt dieselben Dateien und denselben Fingerabdruck', () => {
    // Zahlung noch im Rechnungsmonat: Der Beleg trägt das Skonto zum Monatsende (Mai).
    const maiZahlung = (zip: string) =>
      rechnung([zahlung('p1', 466.48, '2026-05-29')], { date: '2026-05-25', customerId: undefined, customerSnapshot: { name: 'X', contactPerson: '', street: 'W', zip, city: 'C', email: '', phone: '' } });
    const mai = mappe(maiZahlung('33602'), '2026-05');
    expect(mai.ausgangsrechnungen[0]!.skontoAbzug).toBe(9.52);
    expect(dateien(mappe(maiZahlung('33602'), '2026-05'))).toEqual(dateien(mai));
    expect(buildPeriodFingerprint(buildPeriodManifest(mappe(maiZahlung('33602'), '2026-05'), [], 'SKR03'))).toBe(
      buildPeriodFingerprint(buildPeriodManifest(mai, [], 'SKR03')),
    );
    const ohneSkonto: MonatsmappeModel = {
      ...mai,
      ausgangsrechnungen: mai.ausgangsrechnungen.map(({ skontoAbzug: _s, ...rest }) => rest),
    };
    expect(dateien(mai).buchungen).toContain('9,52');
    expect(dateien(ohneSkonto).buchungen).not.toBe(dateien(mai).buchungen);
    expect(buildAccountingPeriodState(ohneSkonto, [], 'SKR03', [abschluss(mai)]).isCurrentClosureValid).toBe(false);
  });

  it('M7 die Cloud-Zeile eines Abschlusses behält ihre Fassung und denselben Fingerabdruck', () => {
    kundeIn('NW');
    const alt = abschluss(mappe(rechnung([zahlung('p1', 466.48, '2026-06-05')]), '2026-06'), 4);
    const altZurueck = rowToAccountingPeriodClosure({
      client_closure_id: alt.id, period_year: 2026, period_month: 6, revision: 1, closed_at: alt.closedAt, closed_by: null,
      fingerprint: alt.fingerprint, manifest: JSON.parse(JSON.stringify(alt.manifest)), reopened_at: null, reopened_by: null,
      reopen_reason: null, created_at: alt.createdAt, updated_at: alt.updatedAt,
    } as unknown as Parameters<typeof rowToAccountingPeriodClosure>[0]);
    expect(altZurueck.manifest.fingerprintVersion).toBe(4);
    expect(buildPeriodFingerprint(altZurueck.manifest)).toBe(alt.fingerprint);
    const neu = abschluss(mappe(rechnung([zahlung('p1', 466.48, '2026-06-05')]), '2026-06'));
    const zurueck = rowToAccountingPeriodClosure({
      client_closure_id: neu.id, period_year: 2026, period_month: 6, revision: 1, closed_at: neu.closedAt, closed_by: null,
      fingerprint: neu.fingerprint, manifest: JSON.parse(JSON.stringify(neu.manifest)), reopened_at: null, reopened_by: null,
      reopen_reason: null, created_at: neu.createdAt, updated_at: neu.updatedAt,
    } as unknown as Parameters<typeof rowToAccountingPeriodClosure>[0]);
    expect(zurueck.manifest.fingerprintVersion).toBe(6);
    expect(buildPeriodFingerprint(zurueck.manifest)).toBe(neu.fingerprint);
  });
});
