/**
 * TEILRECHNUNG-03C — die sichtbare Teilrechnung.
 *
 * Sie ist kein neues Rechenmodell: eine echte Rechnung über einen abgegrenzten
 * Teil der Leistung. Mengen, Nummernkreis, Steuer, Zahlungsbedingungen und die
 * 03B-Regeln bleiben die der normalen Rechnung; sichtbar ist nur der Belegtyp.
 *
 * A  Typauswahl und Route kennen die Teilrechnung.
 * B  Mengenwirkung: 4 von 10 → 6 offen, Folgerechnungen sehen den Rest.
 * C  Schlussrechnung: keine zweite Wirkung der Teilrechnung, Pauschalabschlag
 *    bleibt Geldabzug.
 * D  Storno: erlaubt, gibt Menge frei, wirkt nicht in die Schlussrechnung.
 * E  Beleg: Titel, Steuer, Zahlungsbedingungen.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { InvoiceDraft, Vorgang, VorgangInvoice } from '../../types/models';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../companyProfileService';
import { createCompanyProfileFromSetup } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { hydrateVorgangStore, resetVorgaenge } from '../vorgangService';
import {
  buildInvoiceDraftForType,
  calculateInvoiceTotals,
  getPreviousAbschlagDeductions,
  refreshDraftOrderProjection,
} from '../invoiceService';
import { getBilledQuantity, getBillableOpenQuantity } from '../orderBillingRules';
import {
  CONTRACT_ORDER_INVOICE_TYPES,
  getInvoiceDocumentTitle,
  parseInvoiceDocumentType,
  prefillsOpenQuantity,
  usesAbschlagDeductions,
  usesAbschlagNumber,
} from '../invoiceTypeService';
import { buildInvoiceCreatePath, type InvoiceCreateType } from '../invoiceNavigation';
import { buildInvoicePrintModel } from '../invoicePrintModel';

const SETUP = { ...DEFAULT_SETUP, taxStatus: 'kleinunternehmer_19' as const };
const VORGANG_ID = 'v-03c';

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
    date: '2026-10-03',
    createdAt: '2026-10-03T08:00:00.000Z',
    ...overrides,
  } as VorgangInvoice;
}

/** Eine finalisierte Teilrechnung über `menge` Einheiten à 100 €. */
function teilrechnung(menge: number, overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return rechnung({
    id: 'inv-teil',
    number: '2026-0020',
    type: 'teilrechnung',
    positions: [
      { id: 'l-teil', orderPositionId: 'tp1', description: 'Montagestunden', quantity: menge, unit: 'Stück', unitPrice: 100, lineTotal: menge * 100 },
    ],
    subtotal: menge * 100,
    amount: menge * 100,
    ...overrides,
  });
}

function pauschalAbschlag(betrag: number, overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return rechnung({
    id: 'inv-pauschal',
    number: '2026-0021',
    type: 'abschlag',
    abschlagNumber: 1,
    calculationMode: 'fixed_amount',
    fixedAmountNet: betrag,
    positions: [],
    subtotal: betrag,
    amount: betrag,
    ...overrides,
  });
}

function vorgang(invoices: VorgangInvoice[]): Vorgang {
  return {
    id: VORGANG_ID,
    title: 'Teilrechnungsprobe',
    customer: 'Muster Baustoffe GmbH',
    baustelle: 'Musterweg 1',
    status: 'beauftragt',
    materialSource: 'unclear',
    createdAt: '2026-10-01T08:00:00.000Z',
    orderNumber: 'AU-2026-0010',
    taxStatus: 'kleinunternehmer_19',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    customerBilling: { name: 'Muster Baustoffe GmbH', contactPerson: '', street: 'Musterweg 1', zip: '33602', city: 'Bielefeld', email: '', phone: '' },
    orderPositions: [
      { id: 'tp1', description: 'Montagestunden', plannedQuantity: 10, unit: 'Stück', unitPrice: 100, billable: true },
    ],
    documents: [],
    tasks: [],
    photos: [],
    invoices,
  } as unknown as Vorgang;
}

/** Der Entwurf, wie ihn der Nutzer nach „alle offenen Mengen" absendet. */
function mitOffenenMengen(draft: InvoiceDraft): InvoiceDraft {
  return { ...draft, positions: draft.positions.map((p) => ({ ...p, quantity: p.openQuantity })) };
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

describe('A — Typauswahl und Route', () => {
  it('der Auftrag bietet die Teilrechnung an zweiter Stelle an', () => {
    expect(CONTRACT_ORDER_INVOICE_TYPES).toEqual(['rechnung', 'teilrechnung', 'abschlag', 'schluss']);
  });

  it('die Anlegeroute akzeptiert teilrechnung', () => {
    const type: InvoiceCreateType = 'teilrechnung';
    expect(buildInvoiceCreatePath(VORGANG_ID, type)).toBe(`/vorgaenge/${VORGANG_ID}/rechnung?type=teilrechnung`);
    expect(parseInvoiceDocumentType('teilrechnung')).toBe('teilrechnung');
  });

  it('sie rechnet wie eine Rechnung, nicht wie ein Abschlag', () => {
    expect(prefillsOpenQuantity('teilrechnung')).toBe(true);
    expect(usesAbschlagDeductions('teilrechnung')).toBe(false);
    expect(usesAbschlagNumber('teilrechnung')).toBe(false);
    expect(getInvoiceDocumentTitle('teilrechnung')).toBe('Teilrechnung');
  });
});

describe('B — Mengenwirkung', () => {
  it('4 von 10 abgerechnet lassen 6 offen', () => {
    const v = vorgang([teilrechnung(4)]);
    hydrateVorgangStore([v]);

    expect(getBilledQuantity(v, 'tp1')).toBe(4);
    expect(getBillableOpenQuantity(v, 'tp1')).toBe(6);
  });

  it('eine zweite Teilrechnung und eine Schlussrechnung sehen nur noch 6', () => {
    hydrateVorgangStore([vorgang([teilrechnung(4)])]);

    for (const type of ['teilrechnung', 'rechnung', 'schluss'] as const) {
      const draft = buildInvoiceDraftForType(VORGANG_ID, SETUP, type)!;
      expect(draft.positions[0]!.openQuantity, type).toBe(6);
      expect(draft.positions[0]!.billedQuantity, type).toBe(4);
    }
  });

  it('der Entwurf trägt seinen Typ', () => {
    hydrateVorgangStore([vorgang([])]);
    const draft = buildInvoiceDraftForType(VORGANG_ID, SETUP, 'teilrechnung')!;
    expect(draft.type).toBe('teilrechnung');
    expect(draft.abschlagNumber).toBeUndefined();
    expect(draft.previousAbschlagDeductions).toEqual([]);
  });
});

describe('C — Schlussrechnung', () => {
  it('Szenario 1: 400 Teilrechnung + 600 Schlussrechnung = 1.000, kein zweiter Abzug', () => {
    const v = vorgang([teilrechnung(4)]);
    hydrateVorgangStore([v]);

    expect(getPreviousAbschlagDeductions(v)).toEqual([]);
    const schluss = mitOffenenMengen(buildInvoiceDraftForType(VORGANG_ID, SETUP, 'schluss')!);
    const totals = calculateInvoiceTotals(schluss, SETUP);
    expect(totals.subtotal).toBe(600);
    expect(totals.total).toBe(600);
    expect(400 + totals.total).toBe(1000);
  });

  it('Szenario 2: Teilrechnung 400 + normale Rechnung 200 + Schluss 400 = 1.000', () => {
    const normal = rechnung({
      id: 'inv-normal',
      number: '2026-0022',
      positions: [{ id: 'l-n', orderPositionId: 'tp1', description: 'Montagestunden', quantity: 2, unit: 'Stück', unitPrice: 100, lineTotal: 200 }],
      subtotal: 200,
      amount: 200,
    });
    hydrateVorgangStore([vorgang([teilrechnung(4), normal])]);

    const schluss = mitOffenenMengen(buildInvoiceDraftForType(VORGANG_ID, SETUP, 'schluss')!);
    const totals = calculateInvoiceTotals(schluss, SETUP);
    expect(totals.total).toBe(400);
    expect(400 + 200 + totals.total).toBe(1000);
  });

  it('Szenario 3: mengenbasierter Abschlag wirkt ebenfalls nur über die Menge', () => {
    const mengenAbschlag = rechnung({
      id: 'inv-ab-menge',
      number: '2026-0023',
      type: 'abschlag',
      abschlagNumber: 1,
      calculationMode: 'quantity_based',
      positions: [{ id: 'l-ab', orderPositionId: 'tp1', description: 'Montagestunden', quantity: 2, unit: 'Stück', unitPrice: 100, lineTotal: 200 }],
      subtotal: 200,
      amount: 200,
    });
    const v = vorgang([teilrechnung(4), mengenAbschlag]);
    hydrateVorgangStore([v]);

    expect(getPreviousAbschlagDeductions(v), 'kein Geldabzug für beide').toEqual([]);
    const schluss = mitOffenenMengen(buildInvoiceDraftForType(VORGANG_ID, SETUP, 'schluss')!);
    const totals = calculateInvoiceTotals(schluss, SETUP);
    expect(totals.total).toBe(400);
    expect(400 + 200 + totals.total).toBe(1000);
  });

  it('Szenario 4: Pauschalabschlag bleibt Geldabzug — 600 − 200 = 400', () => {
    const v = vorgang([teilrechnung(4), pauschalAbschlag(200)]);
    hydrateVorgangStore([v]);

    expect(getPreviousAbschlagDeductions(v).map((d) => d.amount)).toEqual([200]);
    const schluss = mitOffenenMengen(buildInvoiceDraftForType(VORGANG_ID, SETUP, 'schluss')!);
    const totals = calculateInvoiceTotals(schluss, SETUP);
    expect(totals.subtotal).toBe(600);
    expect(totals.total).toBe(400);
    expect(400 + 200 + totals.total).toBe(1000);
  });
});

describe('D — Storno', () => {
  it('eine stornierte Teilrechnung gibt ihre Menge frei', () => {
    const v = vorgang([teilrechnung(4, { cancelledAt: '2026-10-04T08:00:00.000Z' })]);
    hydrateVorgangStore([v]);

    expect(getBilledQuantity(v, 'tp1')).toBe(0);
    expect(getBillableOpenQuantity(v, 'tp1')).toBe(10);
    expect(getPreviousAbschlagDeductions(v)).toEqual([]);
  });

  it('ein vorher geöffneter Schlussrechnungsentwurf rechnet nach dem Storno mit 10', () => {
    // Entwurf entsteht, solange die Teilrechnung wirksam ist: 6 offen.
    hydrateVorgangStore([vorgang([teilrechnung(4)])]);
    const alt = mitOffenenMengen(buildInvoiceDraftForType(VORGANG_ID, SETUP, 'schluss')!);
    expect(calculateInvoiceTotals(alt, SETUP).total).toBe(600);

    // Danach wird die Teilrechnung storniert — der gespeicherte Entwurf wird beim Öffnen aufgefrischt.
    const nachStorno = vorgang([teilrechnung(4, { cancelledAt: '2026-10-04T08:00:00.000Z' })]);
    const { draft, changed } = refreshDraftOrderProjection(alt, nachStorno);
    expect(changed).toBe(true);
    expect(draft.positions[0]!.billedQuantity).toBe(0);
    expect(draft.positions[0]!.openQuantity).toBe(10);
    expect(draft.previousAbschlagDeductions).toEqual([]);
    // Die eingegebene Menge bleibt die Entscheidung des Nutzers.
    expect(draft.positions[0]!.quantity).toBe(6);
  });
});

describe('E — Beleg, Steuer und Konditionen', () => {
  it('Druckmodell und Titel nennen die Teilrechnung', () => {
    hydrateVorgangStore([vorgang([])]);
    const draft = buildInvoiceDraftForType(VORGANG_ID, SETUP, 'teilrechnung')!;
    const model = buildInvoicePrintModel(mitOffenenMengen(draft), SETUP);
    expect(model.documentTitle).toBe('Teilrechnung');
  });

  it('Steuerstatus und Zahlungsbedingungen kommen wie bei jeder Rechnung aus dem Auftrag', () => {
    hydrateVorgangStore([vorgang([])]);
    const teil = buildInvoiceDraftForType(VORGANG_ID, SETUP, 'teilrechnung')!;
    const normal = buildInvoiceDraftForType(VORGANG_ID, SETUP, 'rechnung')!;

    expect(teil.taxStatus).toBe('kleinunternehmer_19');
    expect(teil.paymentTermsText).toBe(normal.paymentTermsText);
    expect(teil.customerBilling).toEqual(normal.customerBilling);
    expect(calculateInvoiceTotals(mitOffenenMengen(teil), SETUP).tax).toBe(0);
  });

  it('mit 19 % rechnet sie wie die normale Rechnung', () => {
    const v = { ...vorgang([]), taxStatus: 'standard_19' } as Vorgang;
    hydrateVorgangStore([v]);
    const teil = mitOffenenMengen(buildInvoiceDraftForType(VORGANG_ID, DEFAULT_SETUP, 'teilrechnung')!);
    const totals = calculateInvoiceTotals(teil, DEFAULT_SETUP);
    expect(totals.subtotal).toBe(1000);
    expect(totals.tax).toBe(190);
    expect(totals.total).toBe(1190);
  });
});
