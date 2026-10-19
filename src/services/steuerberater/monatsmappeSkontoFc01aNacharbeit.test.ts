/**
 * FC01A-Nacharbeit (A5) — der Skontoabzug steht im Monat der Zahlung, die ihn auslöst.
 *
 * Gefunden in der Fachprüfung: BUH-10 vermerkte den Skontoabzug nur am Beleg, zum Monatsende des
 * Belegmonats. Rechnung vom 28.09., fristgerechte Skontozahlung am 05.10.: Im September-Paket war
 * die Rechnung offen, im Oktober-Paket stand nur die Zahlung — die Entgeltminderung (§ 17 UStG)
 * stand in keinem Paket. Jetzt trägt die ausgleichende Zahlung den Abzug (Zahlungen.csv, Spalte am
 * Ende); der Beleg im Belegmonat bleibt, wie er war.
 *
 * Neutrale Beispieldaten.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { buildMonatsmappeModel, buildZahlungenCsv, type MonatsmappeInput, type MonatsmappeModel } from './monatsmappeModelService';
import { buildPeriodFingerprint, buildPeriodManifest } from '../accounting/accountingPeriodFingerprint';
import type { InvoicePayment, VorgangInvoice } from '../../types/models';

function zahlung(id: string, date: string, amount: number): InvoicePayment {
  return { id, date, amount, method: 'bank', createdAt: `${date}T10:00:00.000Z` } as InvoicePayment;
}

function rechnung(datum: string, payments: InvoicePayment[]): VorgangInvoice {
  return {
    id: 'inv-sk',
    number: '2026-0930',
    type: 'rechnung',
    positions: [{ id: 'l1', orderPositionId: 'op-1', description: 'Arbeit', quantity: 1, unit: 'Stück', unitPrice: 100, lineTotal: 100 }],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'versendet',
    date: datum,
    createdAt: `${datum}T08:00:00.000Z`,
    issueDate: datum,
    paymentDueDate: datum,
    paymentTermsText: 'Zahlbar innerhalb von 30 Tagen.',
    skontoText: '2 % Skonto bei Zahlung innerhalb von 10 Tagen',
    currencyCode: 'EUR',
    customerSnapshot: { name: 'Kunde A', contactPerson: '', street: 'Weg 1', zip: '10115', city: 'Berlin', email: '', phone: '' },
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb', street: 'Werkstraße 2', zip: '54321', city: 'Betriebsstadt', taxNumber: '11/222/33333' },
    legalNotices: [],
    previousAbschlagDeductions: [],
    payments,
  } as unknown as VorgangInvoice;
}

function mappe(monthKey: string, invoice: VorgangInvoice): MonatsmappeModel {
  const input: MonatsmappeInput = { monthKey, invoices: [{ invoice, vorgangId: 'v-1' }], expenses: [], documents: [], inboxItems: [], fileRefs: [] };
  return buildMonatsmappeModel(input);
}

function zahlungszeilen(csv: string): string[][] {
  return csv.replace(/^﻿/, '').trim().split('\r\n').map((line) => line.split(';'));
}

describe('FC01A-Nacharbeit A5 — Skontoabzug im Monat der ausgleichenden Zahlung', () => {
  it('S1: Rechnung im September, Skontozahlung im Oktober — der Abzug steht im Oktober-Paket', () => {
    const invoice = rechnung('2026-09-28', [zahlung('pay-okt', '2026-10-05', 116.62)]);

    const september = mappe('2026-09', invoice);
    expect(september.ausgangsrechnungen[0]?.skontoAbzug).toBeUndefined();
    expect(september.ausgangsrechnungen[0]?.offenerBetrag).toBe(119);
    expect(september.zahlungenAusgang).toEqual([]);

    const oktober = mappe('2026-10', invoice);
    expect(oktober.ausgangsrechnungen).toEqual([]);
    expect(oktober.zahlungenAusgang[0]).toMatchObject({ zahlungId: 'pay-okt', betrag: 116.62, skontoAbzug: 2.38 });
    const [kopf, zeile] = zahlungszeilen(buildZahlungenCsv(oktober));
    expect(kopf!.at(-1)).toBe('Skontoabzug');
    expect(zeile![kopf!.indexOf('Skontoabzug')]).toBe('2,38');
  });

  it('S2: Skontozahlung im selben Monat — Beleg (wie bisher) und Zahlung tragen den Abzug', () => {
    const september = mappe('2026-09', rechnung('2026-09-02', [zahlung('pay-sep', '2026-09-05', 116.62)]));
    expect(september.ausgangsrechnungen[0]?.skontoAbzug).toBe(2.38);
    expect(september.zahlungenAusgang[0]?.skontoAbzug).toBe(2.38);
  });

  it('S3: volle Zahlung und Teilzahlung tragen keinen Abzug', () => {
    const voll = mappe('2026-10', rechnung('2026-09-28', [zahlung('pay-voll', '2026-10-05', 119)]));
    expect(voll.zahlungenAusgang[0]?.skontoAbzug).toBeUndefined();
    const teil = mappe('2026-10', rechnung('2026-09-28', [zahlung('pay-teil', '2026-10-05', 50)]));
    expect(teil.zahlungenAusgang[0]?.skontoAbzug).toBeUndefined();
    const [kopf, zeile] = zahlungszeilen(buildZahlungenCsv(teil));
    expect(zeile![kopf!.indexOf('Skontoabzug')]).toBe('');
  });

  it('S4: zwei Zahlungen in der Frist — nur die ausgleichende zweite trägt den Abzug', () => {
    const oktober = mappe(
      '2026-10',
      rechnung('2026-09-28', [zahlung('pay-1', '2026-10-01', 60), zahlung('pay-2', '2026-10-05', 56.62)]),
    );
    expect(oktober.zahlungenAusgang.map((entry) => [entry.zahlungId, entry.skontoAbzug])).toEqual([
      ['pay-1', undefined],
      ['pay-2', 2.38],
    ]);
  });

  it('S5: verspätet gekürzt gezahlt — kein Skonto, kein Abzug', () => {
    const november = mappe('2026-10', rechnung('2026-09-28', [zahlung('pay-spaet', '2026-10-20', 116.62)]));
    expect(november.zahlungenAusgang[0]?.skontoAbzug).toBeUndefined();
  });

  it('S6: ein Abschluss älterer Fassung (Version 3) bleibt gleich — er kennt das Feld nicht und wird nicht umgedeutet', () => {
    const oktober = mappe('2026-10', rechnung('2026-09-28', [zahlung('pay-okt', '2026-10-05', 116.62)]));
    const ohneFeld: MonatsmappeModel = {
      ...oktober,
      zahlungenAusgang: oktober.zahlungenAusgang.map(({ skontoAbzug: _skonto, ...rest }) => rest),
    };
    expect(buildPeriodFingerprint(buildPeriodManifest(oktober, [], 'SKR03', 3))).toBe(
      buildPeriodFingerprint(buildPeriodManifest(ohneFeld, [], 'SKR03', 3)),
    );
  });

  it('S6b: ein neuer Abschluss (Version 4) bindet den Skontoabzug — fehlt er, ist es ein anderer Stand (WEISS INV-04)', () => {
    const oktober = mappe('2026-10', rechnung('2026-09-28', [zahlung('pay-okt', '2026-10-05', 116.62)]));
    const ohneFeld: MonatsmappeModel = {
      ...oktober,
      zahlungenAusgang: oktober.zahlungenAusgang.map(({ skontoAbzug: _skonto, ...rest }) => rest),
    };
    expect(buildPeriodFingerprint(buildPeriodManifest(oktober, [], 'SKR03'))).not.toBe(
      buildPeriodFingerprint(buildPeriodManifest(ohneFeld, [], 'SKR03')),
    );
  });
});
