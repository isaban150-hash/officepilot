import { describe, expect, it } from 'vitest';
import { addCalendarDays } from './invoiceTaxService';
import { calculatePaymentSummary } from './invoicePaymentService';
import type { VorgangInvoice } from '../types/models';

/**
 * INVOICE-PAYMENT-TERMS-DAYS-DRIFT-01A — Zahlungsziel und Fälligkeitsdatum
 * müssen dieselbe Aussage treffen.
 *
 * Gemessener Fehler: Eine Rechnung vom 20.03.2026 wies „Zahlbar innerhalb von
 * 14 Tagen ohne Abzug." aus und nannte daneben den 02.04.2026 — 13 Tage. Über
 * die Sommerzeitumstellung verlor die lokale Datumsarithmetik einen Tag.
 *
 * Eine Zahlungsfrist zählt Kalendertage. Der Fälligkeitstag selbst gehört noch
 * dazu; überfällig wird die Rechnung erst am Tag danach.
 */

describe('Fälligkeit aus Zahlungsziel in Tagen', () => {
  it('rechnet Kalendertage über jede Grenze hinweg', () => {
    const faelle: Array<[string, number, string]> = [
      /* A — der gewöhnliche Fall */
      ['2026-09-10', 14, '2026-09-24'],
      /* B — Monatswechsel */
      ['2026-01-25', 14, '2026-02-08'],
      /* C — Jahreswechsel */
      ['2026-12-20', 14, '2027-01-03'],
      /* D — Schaltjahr, 29. Februar liegt dazwischen */
      ['2028-02-20', 14, '2028-03-05'],
      /* E — Beginn der Sommerzeit */
      ['2026-03-20', 14, '2026-04-03'],
      /* F — Ende der Sommerzeit */
      ['2026-10-20', 14, '2026-11-03'],
    ];

    for (const [basis, tage, erwartet] of faelle) {
      expect(addCalendarDays(basis, tage), `${basis} + ${tage}`).toBe(erwartet);
    }
  });

  it('lässt ein unlesbares Basisdatum unangetastet, statt zu raten', () => {
    expect(addCalendarDays('', 14)).toBe('');
    expect(addCalendarDays('kein Datum', 14)).toBe('kein Datum');
  });
});

function invoice(payments: Array<{ amount: number; date: string }>): VorgangInvoice {
  return {
    id: 'inv-due',
    number: 'RE-2026-0002',
    type: 'rechnung',
    positions: [],
    subtotal: 1000,
    taxStatus: 'tax_free',
    amount: 1000,
    status: 'versendet',
    date: '2026-03-20',
    createdAt: '2026-03-20T08:00:00.000Z',
    issueDate: '2026-03-20',
    paymentDueDate: addCalendarDays('2026-03-20', 14),
    payments: payments.map((entry, index) => ({
      id: `pay-${index}`,
      amount: entry.amount,
      date: entry.date,
      createdAt: `${entry.date}T10:00:00.000Z`,
    })),
  } as VorgangInvoice;
}

describe('Fälligkeitstag in der Zahlungsabstimmung', () => {
  it('G: am Fälligkeitstag ist die Rechnung noch nicht überfällig', () => {
    const offen = invoice([]);
    expect(offen.paymentDueDate).toBe('2026-04-03');
    expect(calculatePaymentSummary(offen, '2026-04-03').status).toBe('offen');
  });

  it('H: einen Tag später ist der Restbetrag überfällig', () => {
    expect(calculatePaymentSummary(invoice([]), '2026-04-04').status).toBe('ueberfaellig');
    /* Mit Teilzahlung bleibt es überfällig, solange etwas offen ist. */
    expect(
      calculatePaymentSummary(invoice([{ amount: 400, date: '2026-03-25' }]), '2026-04-04').status,
    ).toBe('ueberfaellig');
  });

  it('nichts offen heisst nicht überfällig, auch lange nach Fälligkeit', () => {
    expect(
      calculatePaymentSummary(invoice([{ amount: 1000, date: '2026-04-03' }]), '2026-06-30').status,
    ).toBe('bezahlt');
  });
});
