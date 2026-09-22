/**
 * RECHNUNGSINTEGRITAET-03B2 — ein Abschlag verbraucht entweder Menge oder Geld.
 *
 * Realbefund der unabhängigen Abnahme: Ein mengenbasierter Abschlag über eine
 * von zwei Einheiten reduzierte die offene Menge **und** wurde in der
 * Schlussrechnung nochmals monetär abgezogen — Restbetrag 0 € statt 5 €.
 *
 * Geprüft werden die vier Fälle des Auftrags (A–D), die Stornosemantik und die
 * Parität zwischen Client- und Serverregel.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Vorgang, VorgangInvoice } from '../../types/models';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../companyProfileService';
import { createCompanyProfileFromSetup } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { hydrateVorgangStore, resetVorgaenge } from '../vorgangService';
import {
  abschlagConsumesOrderQuantity,
  buildInvoiceDraftForType,
  buildSchlussrechnungDraft,
  calculateInvoiceTotals,
  getPreviousAbschlagDeductions,
  refreshDraftOrderProjection,
} from '../invoiceService';
import { getBilledQuantity } from '../orderBillingRules';

const SETUP = { ...DEFAULT_SETUP, taxStatus: 'kleinunternehmer_19' as const };

function vorgang(positionen: Array<{ id: string; menge: number; preis: number }>, invoices: VorgangInvoice[]): Vorgang {
  return {
    id: 'v-03b2',
    title: 'Abzugsprüfung',
    customer: 'Muster Baustoffe GmbH',
    baustelle: '',
    status: 'beauftragt',
    materialSource: 'unclear',
    createdAt: '2026-10-01T08:00:00.000Z',
    orderNumber: 'AU-2026-0005',
    taxStatus: 'kleinunternehmer_19',
    customerBilling: { name: 'Muster Baustoffe GmbH', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
    orderPositions: positionen.map((p) => ({
      id: p.id,
      description: 'Leistung',
      plannedQuantity: p.menge,
      unit: 'Stück',
      unitPrice: p.preis,
      billable: true,
    })),
    documents: [],
    tasks: [],
    photos: [],
    invoices,
  } as unknown as Vorgang;
}

function rechnung(overrides: Partial<VorgangInvoice>): VorgangInvoice {
  return {
    id: 'inv-x',
    number: '2026-0001',
    type: 'rechnung',
    positions: [],
    subtotal: 0,
    taxStatus: 'kleinunternehmer_19',
    amount: 0,
    status: 'vorbereitet',
    date: '2026-10-01',
    createdAt: '2026-10-01T08:00:00.000Z',
    ...overrides,
  } as VorgangInvoice;
}

/** Ein Abschlag, der Menge verbraucht. */
function mengenAbschlag(positionId: string, menge: number, preis: number, overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return rechnung({
    id: 'inv-ab-menge',
    number: '2026-0019',
    type: 'abschlag',
    abschlagNumber: 1,
    calculationMode: 'quantity_based',
    positions: [
      { id: 'l1', orderPositionId: positionId, description: 'Leistung', quantity: menge, unit: 'Stück', unitPrice: preis, lineTotal: menge * preis },
    ],
    subtotal: menge * preis,
    amount: menge * preis,
    ...overrides,
  });
}

/** Ein Abschlag, der nur Geld vorwegnimmt. */
function pauschalAbschlag(betrag: number, overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return rechnung({
    id: 'inv-ab-pauschal',
    number: '2026-0020',
    type: 'abschlag',
    abschlagNumber: 2,
    calculationMode: 'fixed_amount',
    fixedAmountNet: betrag,
    positions: [],
    subtotal: betrag,
    amount: betrag,
    ...overrides,
  });
}

beforeEach(() => {
  localStorage.clear();
  resetVorgaenge();
  resetCompanyProfile();
  hydrateCompanyProfileStore({
    ...createCompanyProfileFromSetup(SETUP),
    companyName: 'Beispiel Haustechnik GmbH',
    defaultTaxStatus: 'kleinunternehmer_19',
  } as never);
});

describe('A — mengenbasierter Abschlag: kein zweiter Geldabzug', () => {
  it('Auftrag 2 × 5 €, Abschlag 1 × 5 € → Schlussrechnung 5 €, kein Abzug', () => {
    const v = vorgang([{ id: 'p1', menge: 2, preis: 5 }], [mengenAbschlag('p1', 1, 5)]);
    hydrateVorgangStore([v]);

    expect(getBilledQuantity(v, 'p1'), 'die Menge ist verbraucht').toBe(1);
    expect(getPreviousAbschlagDeductions(v), 'kein monetärer Abzug').toEqual([]);

    const schluss = buildSchlussrechnungDraft('v-03b2', SETUP)!;
    expect(schluss.previousAbschlagDeductions).toEqual([]);
    const positions = schluss.positions.map((p) => ({ ...p, quantity: p.openQuantity }));
    const totals = calculateInvoiceTotals({ ...schluss, positions }, SETUP);
    expect(totals.subtotal).toBe(5);
    expect(totals.total, 'Restbetrag — vorher fälschlich 0 €').toBe(5);
  });
});

describe('B — Pauschalabschlag bleibt monetärer Abzug', () => {
  it('Auftrag 100 €, Pauschalabschlag 20 € → Schlussrechnung 80 €', () => {
    const v = vorgang([{ id: 'p1', menge: 10, preis: 10 }], [pauschalAbschlag(20)]);
    hydrateVorgangStore([v]);

    expect(getBilledQuantity(v, 'p1'), 'keine Menge verbraucht').toBe(0);
    expect(getPreviousAbschlagDeductions(v).map((d) => d.amount)).toEqual([20]);

    const schluss = buildSchlussrechnungDraft('v-03b2', SETUP)!;
    const positions = schluss.positions.map((p) => ({ ...p, quantity: p.openQuantity }));
    const totals = calculateInvoiceTotals({ ...schluss, positions }, SETUP);
    expect(totals.subtotal).toBe(100);
    expect(totals.total).toBe(80);
  });

  it('ein Altbestands-Abschlag ohne calculationMode und ohne Positionen zählt weiter als Geldabzug', () => {
    const legacy = rechnung({ id: 'inv-legacy', number: '2025-0007', type: 'abschlag', abschlagNumber: 1, positions: [], subtotal: 30, amount: 30 });
    const v = vorgang([{ id: 'p1', menge: 10, preis: 10 }], [legacy]);
    expect(abschlagConsumesOrderQuantity(legacy)).toBe(false);
    expect(getPreviousAbschlagDeductions(v).map((d) => d.amount)).toEqual([30]);
  });
});

describe('C — gemischt: nur der Pauschalabschlag wird abgezogen', () => {
  it('Auftragswert 110 €, 5 € mengenbasiert, 20 € pauschal → Schlussrechnung 85 €', () => {
    const v = vorgang([{ id: 'p1', menge: 22, preis: 5 }], [mengenAbschlag('p1', 1, 5), pauschalAbschlag(20)]);
    hydrateVorgangStore([v]);

    expect(getPreviousAbschlagDeductions(v).map((d) => d.amount)).toEqual([20]);

    const schluss = buildSchlussrechnungDraft('v-03b2', SETUP)!;
    const positions = schluss.positions.map((p) => ({ ...p, quantity: p.openQuantity }));
    const totals = calculateInvoiceTotals({ ...schluss, positions }, SETUP);
    expect(totals.subtotal, 'offene 21 × 5').toBe(105);
    expect(totals.total).toBe(85);
    // 5 + 20 + 85 = 110 — genau der Auftragswert.
    expect(5 + 20 + totals.total).toBe(110);
  });
});

describe('D — Storno nimmt beiden Abschlagsarten ihre Wirkung', () => {
  it('stornierter mengenbasierter Abschlag: Menge frei, kein Abzug', () => {
    const v = vorgang([{ id: 'p1', menge: 2, preis: 5 }], [mengenAbschlag('p1', 1, 5, { cancelledAt: '2026-10-02T08:00:00.000Z' })]);
    expect(getBilledQuantity(v, 'p1')).toBe(0);
    expect(getPreviousAbschlagDeductions(v)).toEqual([]);
  });

  it('stornierter Pauschalabschlag: kein Abzug', () => {
    const v = vorgang([{ id: 'p1', menge: 10, preis: 10 }], [pauschalAbschlag(20, { paymentStatus: 'storniert' })]);
    expect(getPreviousAbschlagDeductions(v)).toEqual([]);
  });
});

describe('E — normale Rechnung + mengenbasierter Abschlag + Schluss', () => {
  it('ergibt in Summe genau den Auftragswert', () => {
    const normal = rechnung({
      id: 'inv-normal',
      number: '2026-0018',
      type: 'rechnung',
      positions: [{ id: 'l0', orderPositionId: 'p1', description: 'Leistung', quantity: 20, unit: 'Stück', unitPrice: 5, lineTotal: 100 }],
      subtotal: 100,
      amount: 100,
    });
    const v = vorgang([{ id: 'p1', menge: 22, preis: 5 }], [normal, mengenAbschlag('p1', 1, 5)]);
    hydrateVorgangStore([v]);

    expect(getBilledQuantity(v, 'p1')).toBe(21);
    expect(getPreviousAbschlagDeductions(v)).toEqual([]);

    const schluss = buildSchlussrechnungDraft('v-03b2', SETUP)!;
    const positions = schluss.positions.map((p) => ({ ...p, quantity: p.openQuantity }));
    const totals = calculateInvoiceTotals({ ...schluss, positions }, SETUP);
    expect(totals.total).toBe(5);
    expect(100 + 5 + totals.total).toBe(110);
  });
});

describe('F — die Regel selbst', () => {
  it('unterscheidet verbrauchte Menge von reinem Geld', () => {
    expect(abschlagConsumesOrderQuantity(mengenAbschlag('p1', 1, 5))).toBe(true);
    expect(abschlagConsumesOrderQuantity(pauschalAbschlag(20))).toBe(false);
    // Menge 0 verbraucht nichts.
    expect(abschlagConsumesOrderQuantity(mengenAbschlag('p1', 0, 5))).toBe(false);
  });
});

describe('G — gespeicherte Entwürfe werden beim Öffnen wieder richtig (03B3)', () => {
  /** Ein Entwurf, wie ihn OfficeTakt **vor** der 03B2-Regel gespeichert hat. */
  function altEntwurf(v: Vorgang, stale: Array<{ invoiceId: string; amount: number }>) {
    hydrateVorgangStore([v]);
    const frisch = buildSchlussrechnungDraft('v-03b2', SETUP)!;
    return {
      ...frisch,
      // bewusste Benutzereingaben
      positions: frisch.positions.map((p) => ({ ...p, quantity: 1 })),
      servicePeriodFrom: '2026-09-01',
      servicePeriodTo: '2026-09-15',
      servicePeriodConfirmed: true,
      paymentDueDate: '2026-11-30',
      introText: 'Wie besprochen.',
      closingText: 'Vielen Dank.',
      // der alte, materialisierte Abzug
      previousAbschlagDeductions: stale.map((d) => ({
        invoiceId: d.invoiceId,
        invoiceNumber: '2026-0019',
        abschlagNumber: 1,
        date: '2026-10-01',
        subtotal: d.amount,
        amount: d.amount,
      })),
    };
  }

  it('der alte Abzug eines mengenbasierten Abschlags verschwindet beim Öffnen', () => {
    const v = vorgang([{ id: 'p1', menge: 2, preis: 5 }], [mengenAbschlag('p1', 1, 5)]);
    const alt = altEntwurf(v, [{ invoiceId: 'inv-ab-menge', amount: 5 }]);
    expect(calculateInvoiceTotals(alt, SETUP).total, 'so sah es der Nutzer').toBe(0);

    const { draft, changed } = refreshDraftOrderProjection(alt, v);
    expect(changed).toBe(true);
    expect(draft.previousAbschlagDeductions).toEqual([]);
    expect(calculateInvoiceTotals(draft, SETUP).total, 'Restbetrag').toBe(5);
  });

  it('bewusste Eingaben bleiben beim Auffrischen erhalten', () => {
    const v = vorgang([{ id: 'p1', menge: 2, preis: 5 }], [mengenAbschlag('p1', 1, 5)]);
    const alt = altEntwurf(v, [{ invoiceId: 'inv-ab-menge', amount: 5 }]);
    const { draft } = refreshDraftOrderProjection(alt, v);

    expect(draft.positions[0]!.quantity, 'eingegebene Menge').toBe(1);
    expect(draft.servicePeriodFrom).toBe('2026-09-01');
    expect(draft.servicePeriodTo).toBe('2026-09-15');
    expect(draft.servicePeriodConfirmed).toBe(true);
    expect(draft.paymentDueDate).toBe('2026-11-30');
    expect(draft.introText).toBe('Wie besprochen.');
    expect(draft.closingText).toBe('Vielen Dank.');
  });

  it('ein Pauschalabschlag bleibt auch nach dem Auffrischen abgezogen', () => {
    const v = vorgang([{ id: 'p1', menge: 10, preis: 10 }], [pauschalAbschlag(20)]);
    const alt = altEntwurf(v, [{ invoiceId: 'inv-ab-pauschal', amount: 20 }]);
    const { draft } = refreshDraftOrderProjection(alt, v);

    expect(draft.previousAbschlagDeductions?.map((d) => d.amount)).toEqual([20]);
    const positions = draft.positions.map((p) => ({ ...p, quantity: p.openQuantity }));
    expect(calculateInvoiceTotals({ ...draft, positions }, SETUP).total).toBe(80);
  });

  it('ein inzwischen stornierter Pauschalabschlag verschwindet aus dem Entwurf', () => {
    const wirksam = vorgang([{ id: 'p1', menge: 10, preis: 10 }], [pauschalAbschlag(20)]);
    const alt = altEntwurf(wirksam, [{ invoiceId: 'inv-ab-pauschal', amount: 20 }]);

    const storniert = vorgang(
      [{ id: 'p1', menge: 10, preis: 10 }],
      [pauschalAbschlag(20, { cancelledAt: '2026-10-05T08:00:00.000Z' })],
    );
    const { draft, changed } = refreshDraftOrderProjection(alt, storniert);
    expect(changed).toBe(true);
    expect(draft.previousAbschlagDeductions).toEqual([]);
  });

  it('ein neu hinzugekommener Pauschalabschlag erscheint beim Auffrischen', () => {
    const ohne = vorgang([{ id: 'p1', menge: 10, preis: 10 }], []);
    const alt = altEntwurf(ohne, []);
    expect(alt.previousAbschlagDeductions).toEqual([]);

    const mit = vorgang([{ id: 'p1', menge: 10, preis: 10 }], [pauschalAbschlag(20)]);
    const { draft, changed } = refreshDraftOrderProjection(alt, mit);
    expect(changed).toBe(true);
    expect(draft.previousAbschlagDeductions?.map((d) => d.amount)).toEqual([20]);
  });

  it('ein frischer Entwurf und ein aufgefrischter Alt-Entwurf ergeben dieselbe Rechnung', () => {
    const v = vorgang([{ id: 'p1', menge: 2, preis: 5 }], [mengenAbschlag('p1', 1, 5)]);
    const alt = altEntwurf(v, [{ invoiceId: 'inv-ab-menge', amount: 5 }]);
    const { draft: aufgefrischt } = refreshDraftOrderProjection(alt, v);

    hydrateVorgangStore([v]);
    const frisch = buildSchlussrechnungDraft('v-03b2', SETUP)!;
    const frischMitMenge = { ...frisch, positions: frisch.positions.map((p) => ({ ...p, quantity: 1 })) };

    expect(aufgefrischt.previousAbschlagDeductions).toEqual(frischMitMenge.previousAbschlagDeductions);
    expect(calculateInvoiceTotals(aufgefrischt, SETUP)).toEqual(calculateInvoiceTotals(frischMitMenge, SETUP));
  });

  it('eine normale Rechnung trägt nie Abzüge — ein Altbestand wird bereinigt', () => {
    const v = vorgang([{ id: 'p1', menge: 10, preis: 10 }], [pauschalAbschlag(20)]);
    hydrateVorgangStore([v]);
    const normal = buildInvoiceDraftForType('v-03b2', SETUP, 'rechnung')!;
    const mitAltlast = {
      ...normal,
      previousAbschlagDeductions: [
        { invoiceId: 'inv-ab-pauschal', invoiceNumber: '2026-0020', abschlagNumber: 1, date: '2026-10-01', subtotal: 20, amount: 20 },
      ],
    };
    const { draft, changed } = refreshDraftOrderProjection(mitAltlast, v);
    expect(changed).toBe(true);
    expect(draft.previousAbschlagDeductions).toEqual([]);
  });
});
