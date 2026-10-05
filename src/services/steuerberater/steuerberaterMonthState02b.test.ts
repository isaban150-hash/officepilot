/**
 * STEUERBERATER BLOCK 2 — die beiden Restpunkte aus der sichtbaren Abnahme.
 *
 *  1. Ein Monat ohne Beleg, aber mit Zahlungen, galt als leer — obwohl sein
 *     Übergabepaket eine echte Zahlungszeile enthielt.
 *  2. Eine im selben Monat stornierte Rechnung stand zweimal in der Liste und
 *     kollidierte als React-Key.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Expense } from '../../types/expense';
import type { VorgangInvoice } from '../../types/models';
import { getSteuerberaterMonthOverview } from '../steuerberaterOverviewService';
import { hydrateExpenseStore } from '../expenseStore';
import { hydrateVorgangStore } from '../vorgangService';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import { hydrateDocumentStore } from '../documentService';
import { hydrateInboxStore } from '../inboxService';

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-1',
    number: 'RE-2026-001',
    type: 'rechnung',
    positions: [],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'versendet',
    date: '2026-09-10',
    issueDate: '2026-09-10',
    createdAt: '2026-09-10T10:00:00.000Z',
    customerSnapshot: { name: 'Kunde A', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baumarkt GmbH',
    invoiceNumber: 'L-100',
    title: 'Material',
    description: '',
    issueDate: '2026-09-12',
    paymentDueDate: null,
    taxStatus: 'standard_19',
    netAmount: 50,
    taxAmount: 9.5,
    grossAmount: 59.5,
    currency: 'EUR',
    paymentStatus: 'offen',
    payments: [],
    positions: [],
    allocations: [],
    isCreditNote: false,
    dedupeKey: 'baumarkt|l-100',
    tags: [],
    digitalFolder: { id: 'dig', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'f', register: 'A', label: 'x' },
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
    ...overrides,
  };
}

/** Der Store-Aufbau, den die Übersicht liest. */
function aufbauen(opts: { invoices?: VorgangInvoice[]; expenses?: Expense[] } = {}) {
  hydrateDocumentStore([]);
  hydrateInboxStore([]);
  hydrateExpenseStore(opts.expenses ?? []);
  hydrateVorgangStore([
    {
      id: 'v-1',
      title: 'Testauftrag',
      customer: 'Kunde A',
      status: 'laufend',
      createdAt: '2026-09-01T08:00:00.000Z',
      updatedAt: '2026-09-01T08:00:00.000Z',
      invoices: opts.invoices ?? [],
      documents: [],
      notes: [],
      tasks: [],
      photos: [],
      offers: [],
      orderPositions: [],
      allocations: [],
    } as never,
  ]);
  hydrateInvoiceStore(
    (opts.invoices ?? []).map((inv) => ({ vorgangId: 'v-1', invoice: inv })),
  );
}

const uebersicht = (monthKey = '2026-09') =>
  getSteuerberaterMonthOverview('2026-10-05T08:00:00.000Z', 'de-DE', monthKey);

describe('BLOCK 2 — Monatsstatus kennt Zahlungen', () => {
  beforeEach(() => {
    localStorage.clear();
    aufbauen();
  });

  it('A1 — weder Belege noch Zahlungen: leer', () => {
    const o = uebersicht();
    expect(o.documentCount).toBe(0);
    expect(o.paymentCount).toBe(0);
    expect(o.state).toBe('empty');
  });

  it('A2 — nur Belege, keine Zahlungen: nicht leer', () => {
    aufbauen({ expenses: [expense()] });
    const o = uebersicht();
    expect(o.documentCount).toBe(1);
    expect(o.paymentCount).toBe(0);
    expect(o.state).not.toBe('empty');
  });

  it('A3 — nur Zahlungen, kein Beleg des Monats: NICHT leer', () => {
    /*
     * Der Beleg liegt im August, die Zahlung im September. Genau dieser Fall
     * stand in der Abnahme als „Noch keine Belege" da.
     */
    aufbauen({
      expenses: [
        expense({
          issueDate: '2026-08-12',
          payments: [{ id: 'pay-1', date: '2026-09-20', amount: 59.5, method: 'cash', createdAt: 'x' }],
        }),
      ],
    });
    const o = uebersicht();
    expect(o.documentCount).toBe(0);
    expect(o.paymentCount).toBe(1);
    expect(o.state).toBe('open');
    expect(o.state).not.toBe('empty');
  });

  it('A4 — Belege und Zahlungen: beides gezählt', () => {
    aufbauen({
      expenses: [expense({ payments: [{ id: 'pay-1', date: '2026-09-20', amount: 59.5, method: 'cash', createdAt: 'x' }] })],
    });
    const o = uebersicht();
    expect(o.documentCount).toBe(1);
    expect(o.paymentCount).toBe(1);
    expect(o.state).not.toBe('empty');
  });

  it('A5 — eine Zahlung macht den Monat nicht „bereit"', () => {
    aufbauen({
      expenses: [
        expense({
          issueDate: '2026-08-12',
          payments: [{ id: 'pay-1', date: '2026-09-20', amount: 59.5, method: 'cash', createdAt: 'x' }],
        }),
      ],
    });
    /* Ohne Belege und ohne gültigen Abschluss bleibt es „offen". */
    expect(uebersicht().state).toBe('open');
    expect(uebersicht().isComplete).toBe(false);
  });

  it('A6 — Rechnungszahlungen zählen genauso', () => {
    aufbauen({
      invoices: [
        invoice({
          issueDate: '2026-08-10',
          date: '2026-08-10',
          payments: [{ id: 'pay-i', date: '2026-09-15', amount: 119, method: 'bank', createdAt: 'x' }],
        }),
      ],
    });
    const o = uebersicht();
    expect(o.documentCount).toBe(0);
    expect(o.paymentCount).toBe(1);
    expect(o.state).toBe('open');
  });
});

describe('BLOCK 2 — stabile Renderidentität der Belegliste', () => {
  beforeEach(() => {
    localStorage.clear();
    aufbauen();
  });

  it('B1 — jeder Eintrag trägt eine Renderidentität', () => {
    aufbauen({ expenses: [expense()] });
    const o = uebersicht();
    expect(o.documents).toHaveLength(1);
    expect(o.documents[0]?.entryKey).toBe(`eingangsbeleg:${o.documents[0]?.id}`);
  });

  it('B2 — eine im selben Monat stornierte Rechnung steht zweimal, aber mit zwei Keys', () => {
    aufbauen({
      invoices: [
        invoice({
          cancelledAt: '2026-09-15T00:00:00.000Z',
          cancelReason: 'Fehler',
          cancellationKind: 'correction',
          correctionNumber: 'RK-2026-001',
        } as Partial<VorgangInvoice>),
      ],
    });
    const o = uebersicht();
    const ids = o.documents.map((d) => d.id);
    const keys = o.documents.map((d) => d.entryKey);

    /* Fachlich gewollt: derselbe Beleg erscheint als Buchung und als Storno. */
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBeLessThan(ids.length);
    /* Als Renderidentität darf nichts kollidieren. */
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('B3 — über alle gerenderten Listen hinweg keine doppelte Identität', () => {
    aufbauen({
      invoices: [
        invoice({
          cancelledAt: '2026-09-15T00:00:00.000Z',
          cancelReason: 'Fehler',
          cancellationKind: 'correction',
          correctionNumber: 'RK-2026-001',
        } as Partial<VorgangInvoice>),
      ],
      expenses: [expense()],
    });
    const o = uebersicht();
    const alle = [...o.documents, ...o.unclearDocuments].map((d) => d.entryKey);
    expect(new Set(alle).size).toBe(alle.length);
  });

  it('B4 — die Reihenfolge bleibt: Rechnungen, Eingangsbelege, Stornos', () => {
    aufbauen({
      invoices: [
        invoice({
          cancelledAt: '2026-09-15T00:00:00.000Z',
          cancelReason: 'Fehler',
          cancellationKind: 'correction',
          correctionNumber: 'RK-2026-001',
        } as Partial<VorgangInvoice>),
      ],
      expenses: [expense()],
    });
    const arten = uebersicht().documents.map((d) => d.kind);
    expect(arten.indexOf('eingangsbeleg')).toBeGreaterThan(arten.indexOf('ausgangsrechnung'));
    expect(arten.lastIndexOf('rechnungsstorno')).toBe(arten.length - 1);
  });
});
