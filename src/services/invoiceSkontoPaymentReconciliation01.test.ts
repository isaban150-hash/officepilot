import { describe, expect, it } from 'vitest';
import { calculatePaymentSummary, getOpenAmount } from './invoicePaymentService';
import type { VorgangInvoice } from '../types/models';

/**
 * INVOICE-SKONTO-PAYMENT-RECONCILIATION-01 — ein gewährtes Skonto ist kein
 * offener Rechnungsbetrag.
 *
 * Zahlt der Kunde fristgerecht den um Skonto verminderten Betrag, ist die
 * Rechnung ausgeglichen. Der Nachlass darf weder als Unterzahlung noch als
 * Restforderung erscheinen, und er darf keine Mahnung auslösen.
 *
 * Ebenso wichtig ist die Gegenrichtung: Skonto heilt **nicht** jede beliebige
 * Unterzahlung, und nach Ablauf der Frist heilt es gar nichts mehr. Beide
 * Grenzen stehen hier ausdrücklich als eigene Fälle.
 */

const SKONTO_TEXT = 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.';

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-1',
    number: 'RE-2026-0001',
    type: 'rechnung',
    positions: [],
    subtotal: 1000,
    taxStatus: 'tax_free',
    amount: 1000,
    status: 'versendet',
    date: '2026-03-01',
    createdAt: '2026-03-01T08:00:00.000Z',
    issueDate: '2026-03-01',
    paymentDueDate: '2026-03-31',
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

/** Eine Zahlung, wie sie die Zahlungsmaske erfasst. */
function payment(amount: number, date: string) {
  return { id: `pay-${date}-${amount}`, amount, date, createdAt: `${date}T10:00:00.000Z` };
}

describe('Skonto in der Zahlungsabstimmung', () => {
  it('A: fristgerechte Zahlung des Skontobetrags gilt als vollständig bezahlt', () => {
    const rechnung = invoice({
      skontoText: SKONTO_TEXT,
      payments: [payment(980, '2026-03-05')],
    });

    const summary = calculatePaymentSummary(rechnung, '2026-04-15');

    expect(summary.status).toBe('bezahlt');
    expect(summary.openAmount).toBe(0);
    expect(getOpenAmount(rechnung)).toBe(0);
    /* Der Nachlass ist kein Guthaben des Kunden. */
    expect(summary.overpaidAmount).toBe(0);
  });

  it('A2: der letzte gültige Skontotag zählt noch dazu', () => {
    const rechnung = invoice({
      skontoText: SKONTO_TEXT,
      payments: [payment(980, '2026-03-11')],
    });

    expect(getOpenAmount(rechnung)).toBe(0);
    expect(calculatePaymentSummary(rechnung, '2026-04-15').status).toBe('bezahlt');
  });

  /*
   * Die Frist zählt Kalendertage. Über die Sommerzeitumstellung hinweg wanderte
   * sie einen Tag nach vorn (20.03. + 10 Tage ergab den 29.03.), womit eine
   * fristgerechte Zahlung am letzten Tag als verspätet gegolten hätte.
   */
  it('A3: die Frist überlebt die Sommerzeitumstellung', () => {
    const basis = { skontoText: SKONTO_TEXT, issueDate: '2026-03-20', date: '2026-03-20' };

    const amLetztenTag = invoice({ ...basis, payments: [payment(980, '2026-03-30')] });
    expect(getOpenAmount(amLetztenTag)).toBe(0);
    expect(calculatePaymentSummary(amLetztenTag, '2026-04-30').status).toBe('bezahlt');

    const einenTagSpaeter = invoice({ ...basis, payments: [payment(980, '2026-03-31')] });
    expect(getOpenAmount(einenTagSpaeter)).toBe(20);
  });

  it('A4: ein gewöhnlicher Monatswechsel bleibt unverändert korrekt', () => {
    const basis = { skontoText: SKONTO_TEXT, issueDate: '2026-01-25', date: '2026-01-25' };

    expect(getOpenAmount(invoice({ ...basis, payments: [payment(980, '2026-02-04')] }))).toBe(0);
    expect(getOpenAmount(invoice({ ...basis, payments: [payment(980, '2026-02-05')] }))).toBe(20);
  });

  it('B: nach Ablauf der Skontofrist bleibt der Nachlass offen', () => {
    const rechnung = invoice({
      skontoText: SKONTO_TEXT,
      payments: [payment(980, '2026-03-12')],
    });

    const summary = calculatePaymentSummary(rechnung, '2026-03-20');

    expect(summary.openAmount).toBe(20);
    expect(summary.status).not.toBe('bezahlt');
  });

  it('C: Skonto heilt keine beliebige Unterzahlung', () => {
    const rechnung = invoice({
      skontoText: SKONTO_TEXT,
      payments: [payment(970, '2026-03-05')],
    });

    const summary = calculatePaymentSummary(rechnung, '2026-03-20');

    expect(summary.openAmount).toBe(30);
    expect(summary.status).not.toBe('bezahlt');
  });

  it('D: ohne Skontovereinbarung bleiben 20,00 € offen', () => {
    const rechnung = invoice({ payments: [payment(980, '2026-03-05')] });

    const summary = calculatePaymentSummary(rechnung, '2026-03-20');

    expect(summary.openAmount).toBe(20);
    expect(summary.status).not.toBe('bezahlt');
  });

  it('E: die volle Zahlung erzeugt kein Guthaben aus dem ungenutzten Skonto', () => {
    const rechnung = invoice({
      skontoText: SKONTO_TEXT,
      payments: [payment(1000, '2026-03-05')],
    });

    const summary = calculatePaymentSummary(rechnung, '2026-03-20');

    expect(summary.status).toBe('bezahlt');
    expect(summary.openAmount).toBe(0);
    expect(summary.overpaidAmount).toBe(0);
  });

  it('aus dem Nachlass entsteht keine Mahnung', () => {
    const rechnung = invoice({
      skontoText: SKONTO_TEXT,
      payments: [payment(980, '2026-03-05')],
    });

    /* Weit nach Fälligkeit — trotzdem nichts offen, also nichts zu mahnen. */
    expect(calculatePaymentSummary(rechnung, '2026-06-30').status).toBe('bezahlt');
  });
});
