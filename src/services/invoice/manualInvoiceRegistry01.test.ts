/**
 * MANUAL-INVOICE-01B1 — die freie Rechnung zählt im Nummernkreis mit.
 *
 * `StoredInvoiceEntry.vorgangId` ist seit dem First-Class-Rechnungsspeicher
 * `string | null`; `null` ist dort ausdrücklich als „Rechnung ohne Auftrag"
 * vorgesehen. Die globale Registry filterte solche Einträge bisher jedoch
 * heraus — und genau sie ist die Quelle des Rechnungsnummernkreises.
 *
 * Damit wäre eine manuelle Rechnung für die Nummernvergabe unsichtbar und ihre
 * Nummer ein zweites Mal vergeben worden. Eine doppelte Rechnungsnummer ist
 * kein Schönheitsfehler, sondern ein Beleg­fehler.
 *
 * Abgegrenzt bleibt die vorgangsbezogene Sicht: `listInvoicesForVorgang` liefert
 * weiterhin ausschliesslich die Rechnungen **eines** Vorgangs.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hydrateInvoiceStore,
  listInvoicesForVorgang,
  resetInvoiceStore,
} from './invoiceStore';
import { listInvoiceEntries, listInvoices } from './invoiceRegistryService';
import {
  getNextInvoiceNumberPreview,
  hydrateInvoiceNumberSequence,
  resetInvoiceNumberSequence,
} from '../invoiceNumberService';
import { resetTestStores } from '../../test/resetStores';
import type { StoredInvoiceEntry, VorgangInvoice } from '../../types/models';

const YEAR = new Date().getFullYear();

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-manual-1',
    number: `${YEAR}-0012`,
    invoiceSequenceNumber: 12,
    type: 'rechnung',
    positions: [],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'vorbereitet',
    date: `${YEAR}-05-04`,
    issueDate: `${YEAR}-05-04`,
    createdAt: `${YEAR}-05-04T09:00:00.000Z`,
    paymentDueDate: `${YEAR}-05-18`,
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  } as VorgangInvoice;
}

function seed(entries: StoredInvoiceEntry[]): void {
  hydrateInvoiceStore(entries);
  hydrateInvoiceNumberSequence({ year: YEAR, lastIssuedNumber: 0 });
}

describe('MANUAL-INVOICE-01B1 — freie Rechnung in der globalen Registry', () => {
  beforeEach(() => {
    resetInvoiceStore();
    resetInvoiceNumberSequence();
  });

  afterEach(() => {
    resetTestStores();
  });

  it('R1: eine Rechnung ohne Vorgang erscheint in der globalen Registry', () => {
    seed([{ invoice: invoice(), vorgangId: null }]);

    expect(listInvoices().map((i) => i.number), 'Die freie Rechnung fehlt').toEqual([
      `${YEAR}-0012`,
    ]);
    expect(listInvoiceEntries()).toHaveLength(1);
    expect(listInvoiceEntries()[0]!.vorgangId, 'Ein Vorgang wurde erfunden').toBeNull();
  });

  it('R2: der Nummernkreis vergibt die Nummer einer freien Rechnung nicht erneut', () => {
    seed([{ invoice: invoice(), vorgangId: null }]);

    expect(
      getNextInvoiceNumberPreview(),
      'Die Nummer der freien Rechnung wurde erneut vergeben',
    ).toBe(`${YEAR}-0013`);
  });

  it('R3: freie und auftragsgebundene Rechnungen teilen einen Nummernkreis', () => {
    seed([
      { invoice: invoice({ id: 'inv-order-1', number: `${YEAR}-0011`, invoiceSequenceNumber: 11 }), vorgangId: 'v-1' },
      { invoice: invoice({ id: 'inv-manual-1', number: `${YEAR}-0012`, invoiceSequenceNumber: 12 }), vorgangId: null },
    ]);

    expect(listInvoices()).toHaveLength(2);
    expect(getNextInvoiceNumberPreview()).toBe(`${YEAR}-0013`);
  });

  it('R4: die vorgangsbezogene Sicht bleibt auf ihren Vorgang beschränkt', () => {
    seed([
      { invoice: invoice({ id: 'inv-order-1', number: `${YEAR}-0011`, invoiceSequenceNumber: 11 }), vorgangId: 'v-1' },
      { invoice: invoice({ id: 'inv-manual-1' }), vorgangId: null },
    ]);

    expect(listInvoicesForVorgang('v-1').map((i) => i.id)).toEqual(['inv-order-1']);
    // Die freie Rechnung gehört zu keinem Vorgang — auch zu keinem fremden.
    expect(listInvoicesForVorgang('v-2')).toEqual([]);
  });
});
