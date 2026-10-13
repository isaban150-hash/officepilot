/**
 * FINANZ-CORE-01A (BUH-01) — die Schlussrechnung mit Abschlagsabzug im
 * Steuerberaterpaket.
 *
 * Bisher: Netto = volles Netto, Brutto = Restbetrag, Steuer = Brutto − Netto
 * (negativ), und der Umsatz stand doppelt im Paket (Abschlag + volle
 * Schlussrechnung). Jetzt bucht die Schlussrechnung den Rest; über alle Belege
 * eines Auftrags stehen Umsatz und Umsatzsteuer genau einmal da.
 */
import { describe, expect, it } from 'vitest';
import type { VorgangInvoice } from '../../types/models';
import { buildMonatsmappeModel, type MonatsmappeInput } from './monatsmappeModelService';

function beleg(overrides: Partial<VorgangInvoice>): VorgangInvoice {
  return {
    id: 'x',
    number: '2026-0000',
    type: 'rechnung',
    positions: [],
    subtotal: 0,
    taxStatus: 'standard_19',
    amount: 0,
    status: 'versendet',
    date: '2026-09-10',
    issueDate: '2026-09-10',
    createdAt: '2026-09-10T10:00:00.000Z',
    customerSnapshot: { name: 'Muster GmbH', contactPerson: '', street: 'Weg 1', zip: '33602', city: 'Bielefeld', email: '', phone: '' },
    legalNotices: [],
    previousAbschlagDeductions: [],
    payments: [],
    paymentStatus: 'offen',
    ...overrides,
  } as VorgangInvoice;
}

const abschlag = beleg({
  id: 'inv-ab',
  number: '2026-0011',
  type: 'abschlag',
  abschlagNumber: 1,
  calculationMode: 'fixed_amount',
  fixedAmountNet: 2000,
  subtotal: 2000,
  amount: 2380,
  issueDate: '2026-09-05',
  date: '2026-09-05',
});

const schluss = beleg({
  id: 'inv-schluss',
  number: '2026-0012',
  type: 'schluss',
  subtotal: 10000,
  // 11.900 brutto − 2.380 Abschlag = 9.520
  amount: 9520,
  previousAbschlagDeductions: [
    { invoiceId: 'inv-ab', invoiceNumber: '2026-0011', abschlagNumber: 1, date: '2026-09-05', subtotal: 2000, amount: 2380 },
  ],
  issueDate: '2026-09-20',
  date: '2026-09-20',
});

function input(invoices: VorgangInvoice[]): MonatsmappeInput {
  return {
    monthKey: '2026-09',
    invoices: invoices.map((invoice) => ({ invoice, vorgangId: 'v-buh' })),
    expenses: [],
    documents: [],
    inboxItems: [],
    fileRefs: [],
  };
}

describe('BUH-01 — Schlussrechnung mit Abschlagsabzug', () => {
  it('B1: die Schlussrechnung bucht den Rest — keine negative Steuer', () => {
    const model = buildMonatsmappeModel(input([abschlag, schluss]));
    const s = model.ausgangsrechnungen.find((entry) => entry.id === 'inv-schluss')!;
    expect({ netto: s.netto, steuer: s.steuer, brutto: s.brutto }).toEqual({ netto: 8000, steuer: 1520, brutto: 9520 });
    expect(s.hinweis).toContain('2026-0011');
  });

  it('B2: über Abschlag und Schlussrechnung stehen Umsatz und Umsatzsteuer genau einmal', () => {
    const model = buildMonatsmappeModel(input([abschlag, schluss]));
    const summe = (key: 'netto' | 'steuer' | 'brutto') =>
      Math.round(model.ausgangsrechnungen.reduce((acc, entry) => acc + entry[key], 0) * 100) / 100;
    expect(summe('netto')).toBe(10000);
    expect(summe('steuer')).toBe(1900);
    expect(summe('brutto')).toBe(11900);
  });

  it('B3: eine stornierte Schlussrechnung wird mit denselben Beträgen gegengebucht', () => {
    const storniert = { ...schluss, cancelledAt: '2026-09-25T10:00:00.000Z', cancellationKind: 'correction' as const, paymentStatus: 'storniert' as const };
    const model = buildMonatsmappeModel(input([abschlag, storniert]));
    const gegen = model.stornos.find((entry) => entry.id === 'inv-schluss')!;
    expect({ netto: gegen.netto, steuer: gegen.steuer, brutto: gegen.brutto }).toEqual({ netto: -8000, steuer: -1520, brutto: -9520 });
  });

  it('B4: eine Rechnung ohne Abzug bleibt unverändert', () => {
    const normal = beleg({ id: 'inv-normal', number: '2026-0013', subtotal: 100, amount: 119 });
    const model = buildMonatsmappeModel(input([normal]));
    const r = model.ausgangsrechnungen[0]!;
    expect({ netto: r.netto, steuer: r.steuer, brutto: r.brutto, hinweis: r.hinweis }).toEqual({ netto: 100, steuer: 19, brutto: 119, hinweis: undefined });
  });
});
