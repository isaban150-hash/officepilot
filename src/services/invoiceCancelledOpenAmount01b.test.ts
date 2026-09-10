import { describe, expect, it } from 'vitest';
import {
  calculatePaymentSummary,
  getOpenAmount,
  getPaidAmount,
  summarizeVorgangInvoicePayments,
} from './invoicePaymentService';
import type { VorgangInvoice } from '../types/models';

/**
 * INVOICE-CANCELLED-OPEN-AMOUNT-01B — eine stornierte Rechnung ist keine
 * offene Forderung.
 *
 * Der Storno nimmt der Rechnung ihren Forderungscharakter, nicht ihre
 * Geschichte: Der ursprüngliche Rechnungsbetrag bleibt sichtbar, bereits
 * geflossenes Geld bleibt ausgewiesen — nur „offen" wird zu null.
 *
 * Nachgestellt ist der echte Kontrollfall aus dem Vorgang „TEST Actual
 * Quantity 420": die stornierte Schlussrechnung 2026-0010 und ihre wirksame
 * Ersatzrechnung 2026-0013, beide über 4.210,00 €. Fachlich offen sind
 * 4.210,00 € — nicht 8.420,00 €.
 *
 * Die Stornoregel wird nicht neu erfunden: `isInvoiceCancelled` ist dieselbe
 * Quelle, die `resolvePaymentStatus` längst benutzt.
 */

function schlussrechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-0013',
    number: '2026-0013',
    type: 'schluss',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Testfläche Actual Quantity',
        quantity: 421,
        unit: 'm²',
        unitPrice: 10,
        lineTotal: 4210,
      },
    ],
    subtotal: 4210,
    taxStatus: 'reverse_charge_13b',
    amount: 4210,
    status: 'vorbereitet',
    date: '2026-09-10',
    createdAt: '2026-09-10T13:48:53.402Z',
    issueDate: '2026-09-10',
    paymentDueDate: '2026-09-24',
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

/** Die historische, dauerhaft stornierte Rechnung. */
function storniert(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return schlussrechnung({
    id: 'inv-0010',
    number: '2026-0010',
    date: '2026-09-06',
    issueDate: '2026-09-06',
    paymentDueDate: '2026-09-20',
    paymentStatus: 'storniert',
    cancelledAt: '2026-09-09T23:18:29.476445+00:00',
    cancelReason: 'E2E-Test Stornopfad 2026-09-09',
    ...overrides,
  });
}

function zahlung(amount: number, date: string) {
  return { id: `pay-${date}-${amount}`, amount, date, createdAt: `${date}T10:00:00.000Z` };
}

describe('01B — A1: eine stornierte Rechnung hat keinen offenen Betrag', () => {
  it('A1: Status storniert und offener Betrag null', () => {
    const rechnung = storniert();
    const summary = calculatePaymentSummary(rechnung, '2026-09-30');

    expect(summary.status).toBe('storniert');
    expect(summary.openAmount).toBe(0);
    expect(getOpenAmount(rechnung)).toBe(0);
  });
});

describe('01B — A2: Storno plus Ersatzrechnung ergibt eine Forderung, nicht zwei', () => {
  it('A2: der offene Gesamtbetrag des Vorgangs ist 4.210,00 €', () => {
    const totals = summarizeVorgangInvoicePayments([storniert(), schlussrechnung()]);

    expect(totals.openTotal).toBe(4210);
    /* Gegenprobe: ohne den Storno wären es tatsächlich 8.420 €. */
    expect(
      summarizeVorgangInvoicePayments([
        storniert({ paymentStatus: undefined, cancelledAt: undefined }),
        schlussrechnung(),
      ]).openTotal,
    ).toBe(8420);
  });
});

describe('01B — A3: die Historie bleibt unangetastet', () => {
  it('A3: Rechnungsbetrag, Positionen und Stornogrund überleben den Fix', () => {
    const rechnung = storniert();
    const summary = calculatePaymentSummary(rechnung, '2026-09-30');

    expect(summary.totalDue).toBe(4210);
    expect(rechnung.amount).toBe(4210);
    expect(rechnung.positions[0]?.quantity).toBe(421);
    expect(rechnung.positions[0]?.unitPrice).toBe(10);
    expect(rechnung.cancelReason).toBe('E2E-Test Stornopfad 2026-09-09');
  });
});

describe('01B — A4: nicht stornierte Rechnungen bleiben unverändert', () => {
  it('A4a: aktiv und unbezahlt bleibt offen', () => {
    const rechnung = schlussrechnung();

    expect(getOpenAmount(rechnung)).toBe(4210);
    expect(calculatePaymentSummary(rechnung, '2026-09-11').openAmount).toBe(4210);
  });

  it('A4b: aktiv und vollständig bezahlt ist nicht mehr offen', () => {
    const rechnung = schlussrechnung({ payments: [zahlung(4210, '2026-09-12')] });

    expect(getOpenAmount(rechnung)).toBe(0);
    expect(calculatePaymentSummary(rechnung, '2026-09-13').status).toBe('bezahlt');
  });

  it('A4c: aktiv und teilbezahlt bleibt in Höhe des Rests offen', () => {
    const rechnung = schlussrechnung({ payments: [zahlung(1000, '2026-09-12')] });

    expect(getOpenAmount(rechnung)).toBe(3210);
  });
});

describe('01B — A5: der Skontoausgleich bleibt unverändert', () => {
  /*
   * Der Skontozweig liegt in derselben Funktion und darf durch den Vorrang des
   * Stornos nicht verschoben werden. Die ausführliche Abdeckung steht in
   * `invoiceSkontoPaymentReconciliation01`; hier genügt der Nachweis, dass der
   * Zweig für eine nicht stornierte Rechnung weiterhin erreicht wird.
   */
  const SKONTO_TEXT = 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.';

  it('A5: fristgerechte Skontozahlung gleicht die Rechnung weiterhin aus', () => {
    const rechnung = schlussrechnung({
      skontoText: SKONTO_TEXT,
      payments: [zahlung(4125.8, '2026-09-15')],
    });

    expect(getOpenAmount(rechnung)).toBe(0);
  });
});

describe('01B — A6: Teilzahlung vor dem Storno', () => {
  it('A6: geflossenes Geld bleibt ausgewiesen, offen wird null', () => {
    const rechnung = storniert({ payments: [zahlung(1000, '2026-09-08')] });
    const summary = calculatePaymentSummary(rechnung, '2026-09-30');

    expect(getPaidAmount(rechnung)).toBe(1000);
    expect(summary.paidAmount).toBe(1000);
    expect(summary.openAmount).toBe(0);
    expect(summary.status).toBe('storniert');
    /* Der historische Betrag bleibt vollständig. */
    expect(summary.totalDue).toBe(4210);
  });

  it('A6b: die geleistete Zahlung zählt weiterhin in die Summe des Vorgangs', () => {
    const totals = summarizeVorgangInvoicePayments([
      storniert({ payments: [zahlung(1000, '2026-09-08')] }),
      schlussrechnung(),
    ]);

    expect(totals.paidTotal).toBe(1000);
    expect(totals.openTotal).toBe(4210);
  });
});
