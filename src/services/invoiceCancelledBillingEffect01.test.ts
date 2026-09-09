import { describe, expect, it } from 'vitest';
import {
  getBilledQuantity,
  getBillableOpenQuantity,
  hasAbschlagsrechnung,
  hasFinalSchlussrechnung,
  hasSchlussrechnung,
} from './orderBillingRules';
import type { Vorgang, VorgangInvoice } from '../types/models';

/**
 * FINAL-INVOICE-CANCELLATION-REBILLING-01A — eine stornierte Rechnung rechnet
 * nichts mehr ab.
 *
 * `cancelledAt` kommt aus der Cloud zurück und ist dort ausdrücklich als
 * „projektionsrelevant" erhalten. Die Mengenprojektion las das Feld aber nie:
 * Eine stornierte Schlussrechnung galt weiter als abgerechnet, die Mengen
 * blieben verbraucht, und `hasSchlussrechnung` sperrte den Vorgang dauerhaft —
 * eine Ersatzrechnung war nicht mehr möglich.
 *
 * Die Rechnung selbst bleibt dabei unangetastet im Vorgang stehen. Storniert
 * heisst nicht gelöscht: Der Beleg bleibt nachvollziehbar, er wirkt nur nicht
 * mehr abrechnend.
 */

function line(orderPositionId: string, quantity: number) {
  return {
    id: `line-${orderPositionId}-${quantity}`,
    orderPositionId,
    description: 'Leistung',
    quantity,
    unit: 'Stunden' as const,
    unitPrice: 100,
    total: quantity * 100,
  };
}

function invoice(overrides: Partial<VorgangInvoice>): VorgangInvoice {
  return {
    id: 'inv',
    number: 'RE-2026-0001',
    type: 'schluss',
    positions: [],
    subtotal: 0,
    taxStatus: 'tax_free',
    amount: 0,
    status: 'versendet',
    date: '2026-03-01',
    createdAt: '2026-03-01T08:00:00.000Z',
    ...overrides,
  } as VorgangInvoice;
}

function vorgang(invoices: VorgangInvoice[]): Vorgang {
  return {
    id: 'v-1',
    title: 'Auftrag',
    customer: 'Kunde',
    baustelle: 'Baustelle',
    status: 'in_bearbeitung',
    materialSource: 'betrieb',
    orderPositions: [
      {
        id: 'op-1',
        description: 'Montage',
        plannedQuantity: 10,
        unit: 'Stunden',
        unitPrice: 100,
        category: 'arbeit',
        billable: true,
      },
    ],
    documents: [],
    tasks: [],
    photos: [],
    invoices,
  } as unknown as Vorgang;
}

const SCHLUSS_WIRKSAM = invoice({
  id: 'inv-schluss',
  type: 'schluss',
  positions: [line('op-1', 10)],
  amount: 1000,
});

const SCHLUSS_STORNIERT = invoice({
  ...SCHLUSS_WIRKSAM,
  cancelledAt: '2026-03-15T09:00:00.000Z',
  paymentStatus: 'storniert',
});

const ABSCHLAG_WIRKSAM = invoice({
  id: 'inv-abschlag',
  type: 'abschlag',
  abschlagNumber: 1,
  positions: [line('op-1', 4)],
  amount: 400,
});

describe('Stornierte Rechnungen in der Mengenprojektion', () => {
  it('A: eine wirksame Schlussrechnung verbraucht die Menge und sperrt den Vorgang', () => {
    const auftrag = vorgang([SCHLUSS_WIRKSAM]);

    expect(getBilledQuantity(auftrag, 'op-1')).toBe(10);
    expect(getBillableOpenQuantity(auftrag, 'op-1')).toBe(0);
    expect(hasSchlussrechnung(auftrag)).toBe(true);
    expect(hasFinalSchlussrechnung(auftrag)).toBe(true);
  });

  it('B/G: die stornierte Rechnung bleibt erhalten, wirkt aber nicht mehr', () => {
    const auftrag = vorgang([SCHLUSS_STORNIERT]);

    /* Nicht gelöscht — der Beleg steht weiterhin im Vorgang. */
    expect(auftrag.invoices).toHaveLength(1);
    expect(auftrag.invoices[0]!.number).toBe('RE-2026-0001');

    expect(getBilledQuantity(auftrag, 'op-1')).toBe(0);
  });

  it('C: nach dem Storno ist die Menge wieder abrechenbar und eine neue Schlussrechnung möglich', () => {
    const auftrag = vorgang([SCHLUSS_STORNIERT]);

    expect(getBillableOpenQuantity(auftrag, 'op-1')).toBe(10);
    expect(hasSchlussrechnung(auftrag)).toBe(false);
    expect(hasFinalSchlussrechnung(auftrag)).toBe(false);
  });

  it('D: Abschläge überleben das Storno der Schlussrechnung', () => {
    const auftrag = vorgang([ABSCHLAG_WIRKSAM, SCHLUSS_STORNIERT]);

    expect(hasAbschlagsrechnung(auftrag)).toBe(true);
    /* Nur die 4 Stunden des wirksamen Abschlags zählen. */
    expect(getBilledQuantity(auftrag, 'op-1')).toBe(4);
    expect(getBillableOpenQuantity(auftrag, 'op-1')).toBe(6);
  });

  it('E: eine Ersatzrechnung zählt neben der stornierten nicht doppelt', () => {
    const ersatz = invoice({
      id: 'inv-schluss-2',
      number: 'RE-2026-0002',
      type: 'schluss',
      positions: [line('op-1', 10)],
      amount: 1000,
    });
    const auftrag = vorgang([SCHLUSS_STORNIERT, ersatz]);

    expect(getBilledQuantity(auftrag, 'op-1')).toBe(10);
    expect(getBillableOpenQuantity(auftrag, 'op-1')).toBe(0);
    expect(hasSchlussrechnung(auftrag)).toBe(true);
  });

  it('F: ein zweites Stornokennzeichen ändert nichts mehr', () => {
    const einmal = vorgang([SCHLUSS_STORNIERT]);
    const nochmal = vorgang([
      invoice({ ...SCHLUSS_STORNIERT, cancelledAt: '2026-03-20T09:00:00.000Z' }),
    ]);

    expect(getBilledQuantity(nochmal, 'op-1')).toBe(getBilledQuantity(einmal, 'op-1'));
    expect(getBillableOpenQuantity(nochmal, 'op-1')).toBe(
      getBillableOpenQuantity(einmal, 'op-1'),
    );
  });

  it('das Stornokennzeichen wirkt auch allein über paymentStatus', () => {
    const auftrag = vorgang([
      invoice({ ...SCHLUSS_WIRKSAM, paymentStatus: 'storniert' }),
    ]);

    expect(getBilledQuantity(auftrag, 'op-1')).toBe(0);
    expect(hasSchlussrechnung(auftrag)).toBe(false);
  });
});
