/**
 * MANUAL-INVOICE-01B2 — der Lebenszyklus der Rechnung ohne Auftrag.
 *
 * 01B1 hat das Modell geöffnet; hier muss die freie Rechnung den produktiven
 * Weg wirklich gehen: gespeichert, wiederauffindbar, bezahlbar, stornierbar —
 * und zwar **ohne** dass dabei ein Vorgang entsteht oder ein bestehender sich
 * verändert.
 *
 * Adressiert wird ausschliesslich über `invoice.id`. Das ist der Kern dieses
 * Blocks: Die Rechnung ist ein eigenständiges Objekt, ihr Ablageort eine
 * Eigenschaft — keine Voraussetzung, um sie zu finden.
 *
 * Neutrale Beispieldaten, kein Netzwerk, keine Cloud.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getInvoiceStoreSnapshot,
  hydrateInvoiceStore,
  resetInvoiceStore,
} from './invoiceStore';
import { findInvoiceLocatorById, listInvoices } from './invoiceRegistryService';
import {
  getAllVorgaenge,
  getVorgangById,
  hydrateVorgangStore,
  upsertFinalizedManualInvoice,
} from '../vorgangService';
import { reserveNextInvoiceNumber, resetInvoiceNumberSequence } from '../invoiceNumberService';
import { createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { StoredInvoiceEntry, VorgangInvoice } from '../../types/models';

const YEAR = new Date().getFullYear();

const CUSTOMER = {
  name: 'Müller Bau GmbH',
  contactPerson: '',
  street: 'Hauptstraße 12',
  zip: '45356',
  city: 'Essen',
  email: '',
  phone: '',
};

const COMPANY = {
  companyName: 'Cirmak Haustechnik GmbH',
  legalForm: 'GmbH',
  street: 'Ruhrallee 5',
  zip: '45138',
  city: 'Essen',
  country: 'Deutschland',
  contactPerson: 'Herr Cirmak',
  phone: '0201 999999',
  email: 'buero@cirmak.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

/** Eine freigegebene freie Rechnung: eine Zeile, kein Auftragsbezug. */
function freeInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-free-1',
    number: `${YEAR}-0012`,
    invoiceSequenceNumber: 12,
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        description: 'Anfahrt',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 45,
        lineTotal: 45,
      },
    ],
    subtotal: 45,
    taxStatus: 'standard_19',
    amount: 53.55,
    status: 'vorbereitet',
    date: `${YEAR}-05-04`,
    issueDate: `${YEAR}-05-04`,
    createdAt: `${YEAR}-05-04T09:00:00.000Z`,
    servicePeriodFrom: `${YEAR}-05-01`,
    servicePeriodTo: `${YEAR}-05-01`,
    paymentDueDate: `${YEAR}-05-18`,
    paymentTermsText: '14 Tage netto',
    skontoText: '',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: CUSTOMER,
    companySnapshot: COMPANY,
    ...overrides,
  } as unknown as VorgangInvoice;
}

function orderInvoiceEntry(): StoredInvoiceEntry {
  return {
    invoice: freeInvoice({
      id: 'inv-order-1',
      number: `${YEAR}-0011`,
      invoiceSequenceNumber: 11,
      positions: [
        {
          id: 'line-order-1',
          orderPositionId: 'op-1',
          description: 'Dachabdichtung',
          quantity: 10,
          unit: 'm²',
          unitPrice: 50,
          lineTotal: 500,
        },
      ],
    } as Partial<VorgangInvoice>),
    vorgangId: 'v-1',
  };
}

describe('MANUAL-INVOICE-01B2 — Lebenszyklus ohne Auftrag', () => {
  beforeEach(() => {
    resetTestStores();
    resetInvoiceStore();
    resetInvoiceNumberSequence();
    hydrateVorgangStore([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('F1: die freigegebene freie Rechnung wird gespeichert, ohne einen Vorgang zu erzeugen', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-1', title: 'Bestandsvorgang' })]);
    const vorgaengeBefore = getAllVorgaenge();

    const result = upsertFinalizedManualInvoice(freeInvoice());

    expect(result.ok, `Nicht gespeichert: ${JSON.stringify(result)}`).toBe(true);

    const entry = findInvoiceLocatorById('inv-free-1');
    expect(entry, 'Die Rechnung ist über ihre Kennung nicht auffindbar').toBeDefined();
    expect(entry!.vorgangId, 'Ein Vorgang wurde erfunden').toBeNull();
    expect(entry!.invoice.number).toBe(`${YEAR}-0012`);
    expect(entry!.invoice.customerSnapshot?.name).toBe(CUSTOMER.name);
    expect(entry!.invoice.companySnapshot?.companyName).toBe(COMPANY.companyName);
    expect(entry!.invoice.positions[0]!.orderPositionId, 'Eine Auftragskennung wurde erfunden')
      .toBeUndefined();

    // Kein Vorgang entstanden, keiner verändert.
    expect(getAllVorgaenge()).toEqual(vorgaengeBefore);
    expect(getVorgangById('v-1')!.invoices, 'Die Rechnung landete in einem Vorgang').toEqual([]);
  });

  it('F2: derselbe Beleg ein zweites Mal geschrieben bleibt ein Beleg', () => {
    expect(upsertFinalizedManualInvoice(freeInvoice()).ok).toBe(true);
    const second = upsertFinalizedManualInvoice(freeInvoice());

    expect(second.ok).toBe(true);
    expect(second.ok && second.action, 'Der Replay erzeugte einen neuen Beleg').toBe('noop');
    expect(listInvoices()).toHaveLength(1);
  });

  it('F3: ein Persistenzfehler hinterlässt keine halbe freie Rechnung', () => {
    const before = getInvoiceStoreSnapshot();
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    const result = upsertFinalizedManualInvoice(freeInvoice());

    expect(result.ok, 'Trotz Persistenzfehler wurde Erfolg gemeldet').toBe(false);
    expect(getInvoiceStoreSnapshot(), 'Der Speicher blieb verändert').toEqual(before);
    expect(findInvoiceLocatorById('inv-free-1')).toBeUndefined();
  });

  it('F3b: nach dem Fehlschlag gelingt ein erneuter Versuch vollständig', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(upsertFinalizedManualInvoice(freeInvoice()).ok).toBe(false);
    spy.mockRestore();

    expect(upsertFinalizedManualInvoice(freeInvoice()).ok).toBe(true);
    expect(listInvoices()).toHaveLength(1);
  });

  it('F4: die freie Rechnung steht global, aber in keinem Vorgang', () => {
    hydrateInvoiceStore([orderInvoiceEntry()]);
    expect(upsertFinalizedManualInvoice(freeInvoice()).ok).toBe(true);

    expect(listInvoices().map((i) => i.id).sort()).toEqual(['inv-free-1', 'inv-order-1']);
    expect(findInvoiceLocatorById('inv-order-1')!.vorgangId).toBe('v-1');
    expect(findInvoiceLocatorById('inv-free-1')!.vorgangId).toBeNull();
  });

  it('F5: der gemeinsame Nummernkreis zählt die freie Rechnung mit', () => {
    hydrateInvoiceStore([orderInvoiceEntry()]);
    expect(upsertFinalizedManualInvoice(freeInvoice()).ok).toBe(true);

    // 0011 auftragsgebunden, 0012 frei → als nächstes 0013.
    expect(reserveNextInvoiceNumber().formatted).toBe(`${YEAR}-0013`);
  });

  it('F6: eine fremde Kennung wird nicht still zur freien Rechnung umgehängt', () => {
    hydrateInvoiceStore([orderInvoiceEntry()]);

    const result = upsertFinalizedManualInvoice(freeInvoice({ id: 'inv-order-1' }));

    expect(result.ok, 'Eine auftragsgebundene Rechnung wurde stillschweigend gelöst').toBe(false);
    expect(findInvoiceLocatorById('inv-order-1')!.vorgangId).toBe('v-1');
  });
});
