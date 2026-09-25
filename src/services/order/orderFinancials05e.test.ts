/**
 * FINANZCORE-05E — Abrechnungsfortschritt und Zahlungsstand eines Auftrags.
 *
 * Der erste Abschnitt prüft die **Annahmen über die bestehende Engine**, auf
 * denen alles andere steht: dass `subtotal` netto ist, dass `amount` brutto und
 * bei der Schlussrechnung bereits um die Abschläge gemindert ist, und dass
 * `invoiceBilledNetCents` jeden Euro genau einmal zählt. Stimmt eine dieser
 * Annahmen eines Tages nicht mehr, soll das hier auffallen und nicht in einer
 * Auftragssumme.
 *
 * Alle Datumsfälle laufen gegen ein festes Betrachtungsdatum.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { summarizeOrderFinancials, getOrderFinancials } from './orderFinancialsService';
import { invoiceBilledNetCents } from './orderCostService';
import { getCurrentBillableOrderNetCents, isBillingEffective } from '../orderBillingRules';
import { calculatePaymentSummary, recordPayment, removePayment } from '../invoicePaymentService';
import { hydrateVorgangStore, getVorgangById } from '../vorgangService';
import { createTestVorgang } from '../../test/fixtures';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { resetTestStores } from '../../test/resetStores';
import type { AbschlagDeduction, OrderPosition, Vorgang, VorgangInvoice } from '../../types/models';

const HEUTE = '2026-09-24';
const VORGANG_ID = 'v-test-1';

function faelligVor(days: number): string {
  const due = new Date(`${HEUTE}T00:00:00.000Z`);
  due.setUTCDate(due.getUTCDate() - days);
  return due.toISOString().slice(0, 10);
}

/** Eine Auftragsposition mit glattem Netto. */
function position(net: number, overrides: Partial<OrderPosition> = {}): OrderPosition {
  return {
    id: `op-${net}`,
    description: 'Leistung',
    plannedQuantity: 1,
    unit: 'Pauschal',
    unitPrice: net,
    ...overrides,
  } as OrderPosition;
}

let nr = 0;

/**
 * Eine Rechnung. `net` ist ihr eigener Nettowert (`subtotal`); `amount` wird
 * wie in der Engine gerechnet: brutto minus Abzüge.
 */
function rechnung(
  net: number,
  overrides: Partial<VorgangInvoice> = {},
  deductions: AbschlagDeduction[] = [],
): VorgangInvoice {
  nr += 1;
  const grossCents = Math.round(net * 1.19 * 100);
  const deductionCents = deductions.reduce((s, d) => s + Math.round(d.amount * 100), 0);
  return {
    id: `inv-${nr}`,
    number: `2026-${String(3000 + nr)}`,
    type: 'rechnung',
    positions: [
      {
        id: `line-${nr}`,
        orderPositionId: 'op-1',
        description: 'Leistung',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: net,
        lineTotal: net,
      },
    ],
    subtotal: net,
    taxStatus: 'standard_19',
    amount: Math.round(Math.max(0, grossCents - deductionCents)) / 100,
    status: 'versendet',
    sentAt: '2026-06-01',
    sentVia: 'email',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    paymentDueDate: '2099-06-15',
    customerSnapshot: {
      name: 'AZ Testbau GmbH',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    },
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Muster GmbH' },
    legalNotices: [],
    previousAbschlagDeductions: deductions,
    ...overrides,
  };
}

/** Ein Abzugseintrag, wie die Schlussrechnung ihn trägt: Netto und Brutto. */
function abzug(invoice: VorgangInvoice): AbschlagDeduction {
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    abschlagNumber: invoice.abschlagNumber,
    date: invoice.issueDate ?? invoice.date,
    subtotal: invoice.subtotal,
    amount: invoice.amount,
  };
}

function zahlung(amount: number, id: string) {
  return { id, date: '2026-06-05', amount, createdAt: '2026-06-05T08:00:00.000Z' };
}

function auftrag(positions: OrderPosition[], invoices: VorgangInvoice[]): Vorgang {
  return createTestVorgang({ id: VORGANG_ID, orderPositions: positions, invoices }) as Vorgang;
}

function finanzen(positions: OrderPosition[], invoices: VorgangInvoice[]) {
  const v = auftrag(positions, invoices);
  hydrateVorgangStore([v]);
  return summarizeOrderFinancials(getVorgangById(VORGANG_ID)!, HEUTE);
}

beforeEach(() => {
  resetTestStores();
  nr = 0;
});

/* ================================================================== */
/* 0 — die Annahmen über die bestehende Engine                        */
/* ================================================================== */

describe('0 — Annahmen über die Rechnungsengine', () => {
  it('A1: der Auftragswert ist netto und kommt aus den abrechenbaren Positionen', () => {
    const v = auftrag([position(6000), position(4000)], []);
    expect(getCurrentBillableOrderNetCents(v)).toBe(1_000_000);
  });

  /*
   * A2 — der Kern. `subtotal` einer Schlussrechnung ist der **volle**
   * Auftragsnetto; erst der Abzug der Abschläge macht daraus ihren eigenen
   * Beitrag. Würde man einfach `subtotal` summieren, stünden hier 15.000.
   */
  it('A2: die Schlussrechnung zählt ihre Abschläge nicht doppelt', () => {
    const a1 = rechnung(3000, { type: 'abschlag', abschlagNumber: 1 });
    const a2 = rechnung(2000, { type: 'abschlag', abschlagNumber: 2 });
    const schluss = rechnung(10000, { type: 'schluss' }, [abzug(a1), abzug(a2)]);

    expect(invoiceBilledNetCents(a1)).toBe(300_000);
    expect(invoiceBilledNetCents(a2)).toBe(200_000);
    // 10.000 − (3.000 + 2.000) = 5.000
    expect(invoiceBilledNetCents(schluss)).toBe(500_000);
  });

  it('A3: `amount` ist brutto und bei der Schlussrechnung bereits gemindert', () => {
    const a1 = rechnung(3000, { type: 'abschlag', abschlagNumber: 1 });
    expect(a1.subtotal).toBe(3000);
    expect(a1.amount).toBe(3570); // 3.000 + 19 %
    const schluss = rechnung(10000, { type: 'schluss' }, [abzug(a1)]);
    expect(schluss.subtotal).toBe(10000);
    expect(schluss.amount).toBe(11900 - 3570);
  });

  it('A4: ein Entwurf und ein Storno wirken nicht abrechnend', () => {
    expect(isBillingEffective(rechnung(100, { status: 'entwurf' }))).toBe(false);
    expect(isBillingEffective(rechnung(100, { cancelledAt: '2026-07-01T10:00:00.000Z' }))).toBe(false);
    expect(isBillingEffective(rechnung(100))).toBe(true);
  });
});

/* ================================================================== */
/* W — Abrechnungsfortschritt                                         */
/* ================================================================== */

describe('W — Abrechnungsfortschritt', () => {
  it('W1: ein Auftrag ohne Rechnung ist zu 0 % abgerechnet', () => {
    const f = finanzen([position(10000)], []);
    expect(f.orderValueNet).toBe(10000);
    expect(f.invoicedNet).toBe(0);
    expect(f.remainingBillableNet).toBe(10000);
    expect(f.invoicedPercent).toBe(0);
    expect(f.invoiceCount).toBe(0);
    expect(f.isFullyInvoiced).toBe(false);
    expect(f.isFinanciallySettled).toBe(false);
  });

  it('W2: eine normale Rechnung', () => {
    const f = finanzen([position(10000)], [rechnung(10000)]);
    expect(f.invoicedNet).toBe(10000);
    expect(f.remainingBillableNet).toBe(0);
    expect(f.invoicedPercent).toBe(100);
    expect(f.isFullyInvoiced).toBe(true);
  });

  it('W3: eine Abschlagsrechnung', () => {
    const f = finanzen([position(10000)], [rechnung(3000, { type: 'abschlag', abschlagNumber: 1 })]);
    expect(f.invoicedNet).toBe(3000);
    expect(f.remainingBillableNet).toBe(7000);
    expect(f.invoicedPercent).toBe(30);
    expect(f.isFullyInvoiced).toBe(false);
  });

  it('W4: mehrere Abschläge summieren sich', () => {
    const f = finanzen(
      [position(10000)],
      [
        rechnung(3000, { type: 'abschlag', abschlagNumber: 1 }),
        rechnung(2000, { type: 'abschlag', abschlagNumber: 2 }),
      ],
    );
    expect(f.invoicedNet).toBe(5000);
    expect(f.remainingBillableNet).toBe(5000);
    expect(f.invoicedPercent).toBe(50);
  });

  it('W5: eine Teilrechnung', () => {
    const f = finanzen([position(10000)], [rechnung(4000, { type: 'teilrechnung' })]);
    expect(f.invoicedNet).toBe(4000);
    expect(f.remainingBillableNet).toBe(6000);
  });

  it('W6: Abschlag und Teilrechnung nebeneinander', () => {
    const f = finanzen(
      [position(10000)],
      [
        rechnung(3000, { type: 'abschlag', abschlagNumber: 1 }),
        rechnung(2500, { type: 'teilrechnung' }),
      ],
    );
    expect(f.invoicedNet).toBe(5500);
    expect(f.remainingBillableNet).toBe(4500);
  });

  /* W7/W8 — der Kontrollfall aus Abschnitt F des Auftrags. */
  it('W7/W8: Abschläge plus Schlussrechnung ergeben genau den Auftragswert', () => {
    const a1 = rechnung(3000, { type: 'abschlag', abschlagNumber: 1 });
    const a2 = rechnung(2000, { type: 'abschlag', abschlagNumber: 2 });
    const schluss = rechnung(10000, { type: 'schluss' }, [abzug(a1), abzug(a2)]);
    const f = finanzen([position(10000)], [a1, a2, schluss]);

    // 3.000 + 2.000 + 5.000 = 10.000 — nicht 15.000.
    expect(f.invoicedNet).toBe(10000);
    expect(f.remainingBillableNet).toBe(0);
    expect(f.invoicedPercent).toBe(100);
    expect(f.hasFinalInvoice).toBe(true);
    expect(f.isFullyInvoiced).toBe(true);
  });

  it('W9: ein stornierter Abschlag zählt nicht mehr abrechnend', () => {
    const f = finanzen(
      [position(10000)],
      [
        rechnung(3000, { type: 'abschlag', abschlagNumber: 1 }),
        rechnung(2000, {
          type: 'abschlag',
          abschlagNumber: 2,
          cancelledAt: '2026-07-01T10:00:00.000Z',
          paymentStatus: 'storniert',
        }),
      ],
    );
    expect(f.invoicedNet).toBe(3000);
    expect(f.remainingBillableNet).toBe(7000);
    expect(f.cancelledInvoiceCount).toBe(1);
    expect(f.activeInvoiceCount).toBe(1);
    // Sichtbar bleibt sie trotzdem.
    expect(f.invoices).toHaveLength(2);
  });

  it('W10: eine stornierte Teilrechnung ebenso', () => {
    const f = finanzen(
      [position(10000)],
      [
        rechnung(4000, {
          type: 'teilrechnung',
          cancelledAt: '2026-07-01T10:00:00.000Z',
          paymentStatus: 'storniert',
        }),
      ],
    );
    expect(f.invoicedNet).toBe(0);
    expect(f.remainingBillableNet).toBe(10000);
  });

  /*
   * W11/W12 — nach dem Storno der Schlussrechnung ist der Auftrag wieder
   * offen. Das ist die bestehende Engine-Regel
   * (FINAL-INVOICE-CANCELLATION-REBILLING-01A), nicht eine eigene.
   */
  it('W11/W12: eine stornierte Schlussrechnung gibt den Auftrag wieder frei', () => {
    const a1 = rechnung(3000, { type: 'abschlag', abschlagNumber: 1 });
    const schluss = rechnung(10000, {
      type: 'schluss',
      cancelledAt: '2026-07-01T10:00:00.000Z',
      paymentStatus: 'storniert',
    }, [abzug(a1)]);
    const f = finanzen([position(10000)], [a1, schluss]);

    expect(f.hasFinalInvoice).toBe(false);
    expect(f.invoicedNet).toBe(3000);
    expect(f.remainingBillableNet).toBe(7000);
    expect(f.isFullyInvoiced).toBe(false);
  });

  /*
   * W13 — der Sonderfall wird benannt, nicht kaschiert. Ein `Math.max(0, …)`
   * hätte hier 0 gezeigt und die Überschreitung verschwiegen.
   */
  it('W13: mehr abgerechnet als beauftragt bleibt als negativer Rest sichtbar', () => {
    const f = finanzen([position(10000)], [rechnung(12000)]);
    expect(f.invoicedNet).toBe(12000);
    expect(f.remainingBillableNet).toBe(-2000);
    expect(f.isOverInvoiced).toBe(true);
    expect(f.invoicedPercent).toBe(120);
    expect(f.isFullyInvoiced).toBe(true);
  });

  it('W14: krumme Beträge bleiben centgenau', () => {
    const f = finanzen(
      [position(3333.33), position(3333.33), position(3333.34)],
      [rechnung(3333.33, { type: 'abschlag', abschlagNumber: 1 })],
    );
    expect(f.orderValueNet).toBe(10000);
    expect(f.invoicedNet).toBe(3333.33);
    expect(f.remainingBillableNet).toBe(6666.67);
  });

  /*
   * W15 — ohne abrechenbare Positionen gibt es keinen festen Auftragswert.
   * Er wird nicht aus den Rechnungen rückwärts erklärt.
   */
  it('W15: ein Auftrag ohne feste Positionen hat keinen Auftragswert', () => {
    const f = finanzen([], [rechnung(4000)]);
    expect(f.orderValueNet).toBeNull();
    expect(f.remainingBillableNet).toBeNull();
    expect(f.invoicedPercent).toBeNull();
    expect(f.isOverInvoiced).toBe(false);
    // Abgerechnet ist trotzdem bekannt.
    expect(f.invoicedNet).toBe(4000);
    expect(f.isFullyInvoiced).toBe(false);
  });

  it('W15b: mit Schlussrechnung gilt der Auftrag auch ohne Auftragswert als abgerechnet', () => {
    const f = finanzen([], [rechnung(4000, { type: 'schluss' })]);
    expect(f.orderValueNet).toBeNull();
    expect(f.hasFinalInvoice).toBe(true);
    expect(f.isFullyInvoiced).toBe(true);
  });

  it('ein Entwurf zählt nicht als abgerechnet', () => {
    const f = finanzen([position(10000)], [rechnung(3000, { status: 'entwurf' })]);
    expect(f.invoicedNet).toBe(0);
    expect(f.activeInvoiceCount).toBe(0);
    expect(f.invoiceCount).toBe(1);
  });
});

/* ================================================================== */
/* X — Zahlungsstand                                                  */
/* ================================================================== */

describe('X — Zahlungsstand', () => {
  it('X1: eine offene Rechnung', () => {
    const f = finanzen([position(10000)], [rechnung(1000)]);
    expect(f.paidAmount).toBe(0);
    expect(f.openReceivables).toBe(1190);
    expect(f.netReceivable).toBe(1190);
    expect(f.openInvoiceCount).toBe(1);
  });

  it('X2: eine teilbezahlte Rechnung', () => {
    const f = finanzen([position(10000)], [rechnung(1000, { payments: [zahlung(500, 'p1')] })]);
    expect(f.paidAmount).toBe(500);
    expect(f.openReceivables).toBe(690);
  });

  it('X3: eine bezahlte Rechnung', () => {
    const f = finanzen([position(10000)], [rechnung(1000, { payments: [zahlung(1190, 'p1')] })]);
    expect(f.paidAmount).toBe(1190);
    expect(f.openReceivables).toBe(0);
    expect(f.overpaidCredit).toBe(0);
    expect(f.isFinanciallySettled).toBe(true);
  });

  it('X4: eine überbezahlte Rechnung', () => {
    const f = finanzen([position(10000)], [rechnung(1000, { payments: [zahlung(1300, 'p1')] })]);
    expect(f.openReceivables).toBe(0);
    expect(f.overpaidCredit).toBe(110);
    expect(f.netReceivable).toBe(-110);
    expect(f.overpaidInvoiceCount).toBe(1);
    expect(f.isFinanciallySettled).toBe(false);
  });

  /* X5–X10 — der Kontrollfall aus Abschnitt I. */
  it('X5–X10: offen und überbezahlt nebeneinander, ohne Verrechnung', () => {
    const a = rechnung(1000, { type: 'abschlag', abschlagNumber: 1 });
    const b = rechnung(1000, { type: 'abschlag', abschlagNumber: 2, payments: [zahlung(1300, 'p1')] });
    const f = finanzen([position(10000)], [a, b]);

    expect(f.openReceivables).toBe(1190);
    expect(f.overpaidCredit).toBe(110);
    expect(f.netReceivable).toBe(1080);

    // Rechnung A bleibt unverändert offen — nichts wird umgebucht.
    const eintragA = f.invoices.find((i) => i.invoiceId === a.id)!;
    expect(eintragA.openAmount).toBe(1190);
    expect(eintragA.paidAmount).toBe(0);
  });

  it('X7: überfällige Forderungen werden getrennt ausgewiesen', () => {
    const f = finanzen(
      [position(10000)],
      [
        rechnung(1000, { paymentDueDate: faelligVor(40) }),
        rechnung(2000, { paymentDueDate: '2099-01-01' }),
      ],
    );
    expect(f.openReceivables).toBe(1190 + 2380);
    expect(f.overdueReceivables).toBe(1190);
    expect(f.overdueInvoiceCount).toBe(1);
  });

  /*
   * X11 — Skonto. Die kanonische Summary sagt „bezahlt"; der Auftrag darf
   * daraus keine Restforderung machen. Der tatsächlich geflossene Betrag
   * bleibt sichtbar, und der Abrechnungsfortschritt bleibt davon unberührt —
   * genau die Trennung aus Abschnitt K.
   */
  it('X11: eine per Skonto ausgeglichene Rechnung lässt keinen Rest übrig', () => {
    const invoice = rechnung(10000, {
      skontoText: '2% Skonto bei Zahlung innerhalb von 10 Tagen',
      payments: [zahlung(11662, 'p1')],
    });
    expect(calculatePaymentSummary(invoice, HEUTE).status).toBe('bezahlt');

    const f = finanzen([position(10000)], [invoice]);
    expect(f.openReceivables).toBe(0);
    expect(f.overpaidCredit).toBe(0);
    expect(f.paidAmount).toBe(11662);
    // Abgerechnet ist weiterhin der volle Netto-Auftragswert.
    expect(f.invoicedNet).toBe(10000);
    expect(f.isFullyInvoiced).toBe(true);
    expect(f.isFinanciallySettled).toBe(true);
  });

  it('X14: eine stornierte Rechnung zählt in keiner aktiven Zahlungssumme', () => {
    const f = finanzen(
      [position(10000)],
      [
        rechnung(1000, {
          cancelledAt: '2026-07-01T10:00:00.000Z',
          paymentStatus: 'storniert',
          payments: [zahlung(500, 'p1')],
        }),
      ],
    );
    expect(f.openReceivables).toBe(0);
    expect(f.paidAmount).toBe(0);
    expect(f.overpaidCredit).toBe(0);
    expect(f.activeInvoiceCount).toBe(0);
  });

  /* X12/X13 — der Zustand folgt den Zahlungen sofort. */
  it('X12/X13: Zahlung und Rücknahme schlagen sofort durch', () => {
    hydrateVorgangStore([auftrag([position(10000)], [rechnung(1000, { id: 'inv-live' })])]);
    const stand = () => getOrderFinancials(VORGANG_ID, HEUTE)!;

    expect(stand().openReceivables).toBe(1190);

    recordPayment(VORGANG_ID, 'inv-live', { date: '2026-06-08', amount: 500 }, {});
    expect(stand().openReceivables).toBe(690);

    recordPayment(
      VORGANG_ID,
      'inv-live',
      { date: '2026-06-09', amount: 800 },
      { confirmOverpayment: true },
    );
    expect(stand().openReceivables).toBe(0);
    expect(stand().overpaidCredit).toBe(110);
    expect(stand().netReceivable).toBe(-110);

    const zuViel = getVorgangById(VORGANG_ID)!.invoices[0].payments!.find((p) => p.amount === 800)!;
    removePayment(VORGANG_ID, 'inv-live', zuViel.id);
    expect(stand().openReceivables).toBe(690);
    expect(stand().overpaidCredit).toBe(0);
  });
});

/* ================================================================== */
/* Y — Schlussrechnung und Zustand                                    */
/* ================================================================== */

describe('Y — Schlussrechnung und Zustand', () => {
  it('Y1: eine wirksame Schlussrechnung wird erkannt', () => {
    const f = finanzen([position(10000)], [rechnung(10000, { type: 'schluss' })]);
    expect(f.hasFinalInvoice).toBe(true);
    expect(f.invoices.find((i) => i.isFinalInvoice)).toBeDefined();
  });

  it('Y3/Y4: eine stornierte Schlussrechnung gilt nicht mehr als aktiv', () => {
    const f = finanzen(
      [position(10000)],
      [
        rechnung(10000, {
          type: 'schluss',
          cancelledAt: '2026-07-01T10:00:00.000Z',
          paymentStatus: 'storniert',
        }),
      ],
    );
    expect(f.hasFinalInvoice).toBe(false);
    expect(f.isFullyInvoiced).toBe(false);
    // Sie bleibt in der Historie stehen.
    expect(f.invoices.find((i) => i.isFinalInvoice)?.cancelled).toBe(true);
  });

  it('Y5: eine stornierte und eine neue Schlussrechnung — nur die neue zählt', () => {
    const alt = rechnung(10000, {
      type: 'schluss',
      cancelledAt: '2026-07-01T10:00:00.000Z',
      paymentStatus: 'storniert',
    });
    const neu = rechnung(9000, { type: 'schluss' });
    const f = finanzen([position(10000)], [alt, neu]);

    expect(f.hasFinalInvoice).toBe(true);
    expect(f.invoicedNet).toBe(9000);
    expect(f.cancelledInvoiceCount).toBe(1);
    expect(f.activeInvoiceCount).toBe(1);
  });

  /*
   * Y6/Y7 — die beiden Begriffe sind ausdrücklich nicht dasselbe. Der Auftrag
   * ist vollständig fakturiert, aber niemand hat gezahlt.
   */
  it('Y6/Y7: vollständig abgerechnet heisst nicht bezahlt', () => {
    const f = finanzen([position(10000)], [rechnung(10000, { type: 'schluss' })]);
    expect(f.isFullyInvoiced).toBe(true);
    expect(f.isFinanciallySettled).toBe(false);
    expect(f.openReceivables).toBe(11900);
  });

  it('Y7b: und bezahlt heisst nicht vollständig abgerechnet', () => {
    const f = finanzen(
      [position(10000)],
      [rechnung(3000, { type: 'abschlag', abschlagNumber: 1, payments: [zahlung(3570, 'p1')] })],
    );
    expect(f.isFinanciallySettled).toBe(true);
    expect(f.isFullyInvoiced).toBe(false);
    expect(f.remainingBillableNet).toBe(7000);
  });

  it('ein Auftrag ohne wirksame Rechnung gilt nicht als ausgeglichen', () => {
    expect(finanzen([position(10000)], []).isFinanciallySettled).toBe(false);
    expect(
      finanzen([position(10000)], [rechnung(1000, { status: 'entwurf' })]).isFinanciallySettled,
    ).toBe(false);
  });
});

/* ================================================================== */
/* Rechnungsverlauf, Isolation, Regression                            */
/* ================================================================== */

describe('Rechnungsverlauf und Abgrenzung', () => {
  it('der Verlauf trägt lesbare Bezeichnungen, keine Enum-Werte', () => {
    const f = finanzen(
      [position(10000)],
      [
        rechnung(3000, { type: 'abschlag', abschlagNumber: 1 }),
        rechnung(2000, { type: 'teilrechnung' }),
        rechnung(10000, { type: 'schluss' }),
      ],
    );
    const labels = f.invoices.map((i) => i.typeLabel);
    expect(labels).toContain('Abschlagsrechnung 1');
    expect(labels).toContain('Teilrechnung');
    expect(labels).toContain('Schlussrechnung');
    for (const label of labels) {
      expect(label).not.toMatch(/abschlag|teilrechnung|schluss/);
    }
  });

  it('der Verlauf steht in Abrechnungsfolge', () => {
    const f = finanzen(
      [position(10000)],
      [
        rechnung(2000, { type: 'schluss', issueDate: '2026-08-01' }),
        rechnung(3000, { type: 'abschlag', abschlagNumber: 1, issueDate: '2026-06-01' }),
      ],
    );
    expect(f.invoices.map((i) => i.issueDate)).toEqual(['2026-06-01', '2026-08-01']);
  });

  /*
   * T — Workspace-Isolation. Der Dienst liest allein aus dem übergebenen
   * Auftrag beziehungsweise dem Speicher des aktiven Workspace; nach einem
   * Wechsel bleibt nichts vom vorigen übrig.
   */
  it('T: ein Workspace-Wechsel lässt keine Zahl des vorigen übrig', () => {
    hydrateVorgangStore([auftrag([position(10000)], [rechnung(3000)])]);
    expect(getOrderFinancials(VORGANG_ID, HEUTE)!.invoicedNet).toBe(3000);

    hydrateVorgangStore([auftrag([position(500)], [rechnung(100)])]);
    expect(getOrderFinancials(VORGANG_ID, HEUTE)!.invoicedNet).toBe(100);
    expect(getOrderFinancials(VORGANG_ID, HEUTE)!.orderValueNet).toBe(500);

    hydrateVorgangStore([]);
    expect(getOrderFinancials(VORGANG_ID, HEUTE)).toBeUndefined();
  });

  it('die Rechnung eines anderen Auftrags zählt nicht mit', () => {
    hydrateVorgangStore([
      auftrag([position(10000)], [rechnung(3000)]),
      createTestVorgang({ id: 'v-fremd', orderPositions: [position(999)], invoices: [rechnung(999)] }),
    ]);
    const f = getOrderFinancials(VORGANG_ID, HEUTE)!;
    expect(f.invoicedNet).toBe(3000);
    expect(f.invoices).toHaveLength(1);
  });

  /* AA — keine automatische Verrechnung, wie in 05C/05D. */
  it('AA: eine Überzahlung schliesst keine andere Rechnung des Auftrags', () => {
    const a = rechnung(1000, { type: 'abschlag', abschlagNumber: 1 });
    const b = rechnung(1000, { type: 'abschlag', abschlagNumber: 2, payments: [zahlung(2000, 'p1')] });
    const f = finanzen([position(10000)], [a, b]);

    expect(f.invoices.find((i) => i.invoiceId === a.id)!.openAmount).toBe(1190);
    expect(f.invoices.find((i) => i.invoiceId === a.id)!.status).toBe('offen');
    expect(f.overpaidCredit).toBe(810);
    expect(f.openReceivables).toBe(1190);
  });

  it('nach erneutem Hydrieren steht derselbe Stand', () => {
    const invoices = [rechnung(3000, { type: 'abschlag', abschlagNumber: 1, payments: [zahlung(1000, 'p1')] })];
    hydrateVorgangStore([auftrag([position(10000)], invoices)]);
    const vorher = getOrderFinancials(VORGANG_ID, HEUTE)!;

    hydrateVorgangStore([auftrag([position(10000)], invoices)]);
    const nachher = getOrderFinancials(VORGANG_ID, HEUTE)!;

    expect(nachher.invoicedNet).toBe(vorher.invoicedNet);
    expect(nachher.openReceivables).toBe(vorher.openReceivables);
    expect(nachher.netReceivable).toBe(vorher.netReceivable);
  });
});

/* ================================================================== */
/* 01H — „Vollständig abgerechnet" nur, wenn es endgültig stimmt       */
/* ================================================================== */

/*
 * Befund „Delbrück": Ein einzelner pauschaler Abschlag zeigte „Vollständig
 * abgerechnet". Ein Abschlag ist vorläufig — er wird mit der Schlussrechnung
 * abgerechnet. Der rechnerische Fortschritt zählt ihn weiter, der Abschluss
 * nicht.
 */
describe('01H — Abrechnungszustand', () => {
  const storno = { cancelledAt: '2026-07-01T10:00:00.000Z', paymentStatus: 'storniert' as const };

  it('nur ein Abschlag unter dem Auftragswert: nicht vollständig, keine Schlussrechnung erwartet', () => {
    const f = finanzen([position(10000)], [rechnung(3000, { type: 'abschlag', abschlagNumber: 1 })]);
    expect(f.isFullyInvoiced).toBe(false);
    expect(f.awaitsFinalInvoice).toBe(false);
  });

  it('Delbrück: ein pauschaler Abschlag in Höhe des Auftragswerts ist nicht vollständig abgerechnet', () => {
    const f = finanzen([position(10000)], [rechnung(10000, { type: 'abschlag', abschlagNumber: 1 })]);
    // Rechnerisch erreicht …
    expect(f.invoicedNet).toBe(10000);
    expect(f.remainingBillableNet).toBe(0);
    expect(f.invoicedPercent).toBe(100);
    // … aber nicht abgeschlossen.
    expect(f.isFullyInvoiced).toBe(false);
    expect(f.awaitsFinalInvoice).toBe(true);
    expect(f.hasFinalInvoice).toBe(false);
  });

  it('mehrere Abschläge, die den Auftragswert erreichen: Schlussrechnung steht aus', () => {
    const f = finanzen(
      [position(10000)],
      [
        rechnung(6000, { type: 'abschlag', abschlagNumber: 1 }),
        rechnung(4000, { type: 'abschlag', abschlagNumber: 2 }),
      ],
    );
    expect(f.remainingBillableNet).toBe(0);
    expect(f.isFullyInvoiced).toBe(false);
    expect(f.awaitsFinalInvoice).toBe(true);
  });

  it('Teilrechnungen, die den Auftragswert erreichen: vollständig abgerechnet', () => {
    const f = finanzen(
      [position(10000)],
      [rechnung(4000, { type: 'teilrechnung' }), rechnung(6000, { type: 'teilrechnung' })],
    );
    expect(f.isFullyInvoiced).toBe(true);
    expect(f.awaitsFinalInvoice).toBe(false);
  });

  it('Abschlag plus Teilrechnung bis zum Auftragswert: der Abschlag bleibt vorläufig', () => {
    const f = finanzen(
      [position(10000)],
      [
        rechnung(3000, { type: 'abschlag', abschlagNumber: 1 }),
        rechnung(7000, { type: 'teilrechnung' }),
      ],
    );
    expect(f.remainingBillableNet).toBe(0);
    expect(f.isFullyInvoiced).toBe(false);
    expect(f.awaitsFinalInvoice).toBe(true);
  });

  it('Abschlag plus Schlussrechnung: vollständig abgerechnet', () => {
    const a1 = rechnung(10000, { type: 'abschlag', abschlagNumber: 1 });
    const schluss = rechnung(10000, { type: 'schluss' }, [abzug(a1)]);
    const f = finanzen([position(10000)], [a1, schluss]);
    expect(f.invoicedNet).toBe(10000);
    expect(f.isFullyInvoiced).toBe(true);
    expect(f.awaitsFinalInvoice).toBe(false);
  });

  it('stornierte Schlussrechnung nach vollem Abschlag: wieder Schlussrechnung ausstehend', () => {
    const a1 = rechnung(10000, { type: 'abschlag', abschlagNumber: 1 });
    const schluss = rechnung(10000, { type: 'schluss', ...storno }, [abzug(a1)]);
    const f = finanzen([position(10000)], [a1, schluss]);
    expect(f.isFullyInvoiced).toBe(false);
    expect(f.awaitsFinalInvoice).toBe(true);
  });

  it('stornierte Teilrechnung zählt nicht zum endgültigen Wert', () => {
    const f = finanzen([position(10000)], [rechnung(10000, { type: 'teilrechnung', ...storno })]);
    expect(f.isFullyInvoiced).toBe(false);
    expect(f.awaitsFinalInvoice).toBe(false);
  });

  it('Überabrechnung durch normale Rechnung: vollständig und als überzogen benannt', () => {
    const f = finanzen([position(10000)], [rechnung(12000)]);
    expect(f.isFullyInvoiced).toBe(true);
    expect(f.isOverInvoiced).toBe(true);
    expect(f.awaitsFinalInvoice).toBe(false);
  });

  it('Überabrechnung allein durch Abschlag: überzogen benannt, aber nicht abgeschlossen', () => {
    const f = finanzen([position(10000)], [rechnung(12000, { type: 'abschlag', abschlagNumber: 1 })]);
    expect(f.isOverInvoiced).toBe(true);
    expect(f.remainingBillableNet).toBe(-2000);
    expect(f.isFullyInvoiced).toBe(false);
    expect(f.awaitsFinalInvoice).toBe(true);
  });

  it('Auftrag ohne abrechenbaren Wert: ein Abschlag behauptet nichts', () => {
    const f = finanzen([], [rechnung(4000, { type: 'abschlag', abschlagNumber: 1 })]);
    expect(f.orderValueNet).toBeNull();
    expect(f.isFullyInvoiced).toBe(false);
    expect(f.awaitsFinalInvoice).toBe(false);
  });
});

/* ================================================================== */
/* 01H — Zahlungszustand                                               */
/* ================================================================== */

/*
 * Befund AU-2026-0006: „Zahlungen noch offen" bei „Offen 0,00 €" und nur
 * stornierten Rechnungen. Offen ist nur, was als offener Betrag dasteht.
 */
describe('01H — Zahlungszustand', () => {
  const storno = { cancelledAt: '2026-07-01T10:00:00.000Z', paymentStatus: 'storniert' as const };

  it('aktive offene Forderung: open', () => {
    expect(finanzen([position(10000)], [rechnung(1000)]).paymentState).toBe('open');
  });

  it('teilbezahlt: open', () => {
    const f = finanzen([position(10000)], [rechnung(1000, { payments: [zahlung(500, 'p1')] })]);
    expect(f.paymentState).toBe('open');
  });

  it('vollständig bezahlt: settled', () => {
    const f = finanzen([position(10000)], [rechnung(1000, { payments: [zahlung(1190, 'p1')] })]);
    expect(f.paymentState).toBe('settled');
    expect(f.isFinanciallySettled).toBe(true);
  });

  it('überbezahlt ohne offenen Rest: overpaid, nicht open', () => {
    const f = finanzen([position(10000)], [rechnung(1000, { payments: [zahlung(1300, 'p1')] })]);
    expect(f.openReceivables).toBe(0);
    expect(f.paymentState).toBe('overpaid');
    expect(f.isFinanciallySettled).toBe(false);
  });

  it('AU-2026-0006: nur stornierte Rechnungen — keine aktive Forderung, weder offen noch bezahlt', () => {
    const f = finanzen(
      [position(10000)],
      [rechnung(1000, { ...storno }), rechnung(2000, { ...storno, payments: [zahlung(500, 'p1')] })],
    );
    expect(f.openReceivables).toBe(0);
    expect(f.paymentState).toBe('noActiveClaim');
    expect(f.isFinanciallySettled).toBe(false);
  });

  it('keine Rechnung: keine aktive Forderung', () => {
    expect(finanzen([position(10000)], []).paymentState).toBe('noActiveClaim');
  });

  it('nur Entwurf: keine aktive Forderung', () => {
    const f = finanzen([position(10000)], [rechnung(1000, { status: 'entwurf' })]);
    expect(f.paymentState).toBe('noActiveClaim');
  });

  it('gemischt aktiv offen + storniert: open', () => {
    const f = finanzen([position(10000)], [rechnung(1000, { ...storno }), rechnung(2000)]);
    expect(f.paymentState).toBe('open');
    expect(f.openReceivables).toBe(2380);
  });

  it('gemischt aktiv bezahlt + storniert: settled', () => {
    const f = finanzen(
      [position(10000)],
      [rechnung(1000, { ...storno }), rechnung(2000, { payments: [zahlung(2380, 'p1')] })],
    );
    expect(f.paymentState).toBe('settled');
  });

  it('offen und überbezahlt nebeneinander: open — die Überzahlung verrechnet nichts', () => {
    const f = finanzen(
      [position(10000)],
      [rechnung(1000), rechnung(1000, { payments: [zahlung(1300, 'p1')] })],
    );
    expect(f.paymentState).toBe('open');
    expect(f.overpaidCredit).toBe(110);
  });
});
