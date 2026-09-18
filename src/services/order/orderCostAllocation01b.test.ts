/**
 * ORDER-COST-ALLOCATION-01B — Auftragszuordnung und Auftragskosten.
 *
 *  A  Zuordnung setzen/ändern/entfernen, Invarianten (>0, ≤ Netto, ein Eintrag
 *     je Auftrag, unbekannter Auftrag, stornierte Ausgabe)
 *  B  Mehrfachzuordnung bleibt erhalten und korrekt
 *  C  Kostenaggregation: nur gebuchte Ausgaben, Teilzuordnung, Cent-Arithmetik
 *  D  Abgerechnet: Rechnung, mehrere Rechnungen, Abschläge, Schluss,
 *     Abschlag+Schluss ohne Doppelzählung, Storno, Entwurf, Zahlung
 *  E  Sync: Payload/Fingerprint/Normalisierung tragen die Zuordnung
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestVorgang } from '../../test/fixtures';
import {
  addExpense,
  assignExpenseToVorgang,
  cancelExpense,
  getAllocatedAmount,
  getExpenseAllocations,
  getExpenseById,
  getUnallocatedAmount,
  removeExpenseAllocation,
  updateExpense,
} from '../expenseService';
import { hydrateExpenseStore } from '../expenseStore';
import { hydrateVorgangStore } from '../vorgangService';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import { recordExpensePayment } from '../expensePaymentService';
import {
  getBilledNetForVorgang,
  getOrderCostSummary,
  invoiceBilledNetCents,
} from './orderCostService';
import { buildExpenseContentKey, buildExpensePushPayload } from '../expense/expenseCloudSyncService';
import { normalizeExpense } from '../expenseNormalize';
import * as persistenceService from '../persistenceService';
import type { Expense } from '../../types/expense';
import type { Vorgang, VorgangInvoice } from '../../types/models';

const V1 = 'v-cost-1';
const V2 = 'v-cost-2';

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-1',
    number: 'RE-1',
    type: 'rechnung',
    positions: [],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'versendet',
    date: '2026-09-01',
    issueDate: '2026-09-01',
    createdAt: '2026-09-01T00:00:00.000Z',
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

function hydrateOrders(invoices: VorgangInvoice[] = [], second: VorgangInvoice[] = []): void {
  hydrateVorgangStore([
    createTestVorgang({ id: V1, title: 'Bad Sanierung', customer: 'Kunde A', invoices }),
    createTestVorgang({ id: V2, title: 'Heizung Neubau', customer: 'Kunde B', invoices: second }),
  ]);
}

function newExpense(net: number, overrides: Partial<Parameters<typeof addExpense>[0]> = {}): Expense {
  const result = addExpense({
    title: 'Material Baustoffe',
    category: 'material',
    supplierName: 'Baustoff Nord GmbH',
    invoiceNumber: `RE-${Math.random().toString(36).slice(2, 8)}`,
    issueDate: '2026-09-05',
    grossAmount: Math.round(net * 1.19 * 100) / 100,
    netAmount: net,
    taxAmount: Math.round(net * 0.19 * 100) / 100,
    ...overrides,
  });
  if (!result.success) throw new Error(result.errorKey);
  return result.expense;
}

beforeEach(() => {
  localStorage.clear();
  hydrateExpenseStore([]);
  hydrateInvoiceStore([]);
  hydrateOrders();
  vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: true } as never);
});

describe('A — Zuordnung und Invarianten', () => {
  it('setzen ohne Betrag ordnet den vollen Nettobetrag zu; Titel und Betrag stehen am Beleg', () => {
    const expense = newExpense(500);
    const result = assignExpenseToVorgang(expense.id, { vorgangId: V1 });
    expect(result.success).toBe(true);
    const allocations = getExpenseAllocations(expense.id);
    expect(allocations).toEqual([{ vorgangId: V1, vorgangTitle: 'Bad Sanierung', amount: 500 }]);
    expect(getAllocatedAmount(getExpenseById(expense.id)!)).toBe(500);
    expect(getUnallocatedAmount(getExpenseById(expense.id)!)).toBe(0);
  });

  it('ändern ersetzt die Zuordnung desselben Auftrags statt sie zu verdoppeln', () => {
    const expense = newExpense(500);
    assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: 500 });
    expect(assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: 200 }).success).toBe(true);
    expect(getExpenseAllocations(expense.id)).toEqual([
      { vorgangId: V1, vorgangTitle: 'Bad Sanierung', amount: 200 },
    ]);
    expect(getUnallocatedAmount(getExpenseById(expense.id)!)).toBe(300);
  });

  it('entfernen löscht genau diese Zuordnung; unbekannte Zuordnung wird gemeldet', () => {
    const expense = newExpense(500);
    assignExpenseToVorgang(expense.id, { vorgangId: V1 });
    expect(removeExpenseAllocation(expense.id, V1).success).toBe(true);
    expect(getExpenseAllocations(expense.id)).toEqual([]);
    expect(removeExpenseAllocation(expense.id, V1)).toEqual({ success: false, errorKey: 'expense.allocation.notFound' });
  });

  it('Betrag ≤ 0, Überzuordnung und unbekannter Auftrag werden abgelehnt', () => {
    const expense = newExpense(500);
    expect(assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: 0 })).toEqual({ success: false, errorKey: 'expense.allocation.amountInvalid' });
    expect(assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: -10 })).toEqual({ success: false, errorKey: 'expense.allocation.amountInvalid' });
    expect(assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: 500.01 })).toEqual({ success: false, errorKey: 'expense.allocation.exceedsAmount' });
    expect(assignExpenseToVorgang(expense.id, { vorgangId: 'v-gibt-es-nicht', amount: 10 })).toEqual({ success: false, errorKey: 'expense.allocation.vorgangMissing' });
    expect(getExpenseAllocations(expense.id)).toEqual([]);
  });

  it('stornierte Ausgabe wird nicht mehr zugeordnet oder geändert; die Historie bleibt', () => {
    const expense = newExpense(500);
    assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: 300 });
    expect(cancelExpense(expense.id, 'Beleg doppelt erfasst').success).toBe(true);
    expect(assignExpenseToVorgang(expense.id, { vorgangId: V2, amount: 100 })).toEqual({ success: false, errorKey: 'expense.allocation.cancelled' });
    expect(removeExpenseAllocation(expense.id, V1)).toEqual({ success: false, errorKey: 'expense.allocation.cancelled' });
    expect(getExpenseAllocations(expense.id)).toEqual([
      { vorgangId: V1, vorgangTitle: 'Bad Sanierung', amount: 300 },
    ]);
  });

  it('eine Nettoänderung unter die zugeordnete Summe wird abgelehnt statt still gekürzt', () => {
    const expense = newExpense(500);
    assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: 400 });
    expect(updateExpense(expense.id, { netAmount: 300, grossAmount: 357, taxAmount: 57 })).toEqual({
      success: false,
      errorKey: 'expense.allocation.editBelowAllocated',
    });
    expect(getExpenseAllocations(expense.id)[0]!.amount).toBe(400);
    expect(updateExpense(expense.id, { netAmount: 450, grossAmount: 535.5, taxAmount: 85.5 }).success).toBe(true);
  });
});

describe('B — Mehrfachzuordnung', () => {
  it('zwei Aufträge teilen sich einen Beleg; die Summe bleibt unter dem Netto', () => {
    const expense = newExpense(500);
    expect(assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: 200 }).success).toBe(true);
    expect(assignExpenseToVorgang(expense.id, { vorgangId: V2, amount: 250 }).success).toBe(true);
    expect(getExpenseAllocations(expense.id).map((a) => [a.vorgangId, a.amount])).toEqual([
      [V1, 200],
      [V2, 250],
    ]);
    expect(getUnallocatedAmount(getExpenseById(expense.id)!)).toBe(50);
    // Die dritte Zuordnung überschreitet den Rest und wird abgelehnt — bestehende bleiben.
    expect(assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: 300 })).toEqual({ success: false, errorKey: 'expense.allocation.exceedsAmount' });
    expect(getExpenseAllocations(expense.id)).toHaveLength(2);
    // Entfernen betrifft nur den genannten Auftrag.
    expect(removeExpenseAllocation(expense.id, V1).success).toBe(true);
    expect(getExpenseAllocations(expense.id).map((a) => a.vorgangId)).toEqual([V2]);
  });
});

describe('C — Kostenaggregation', () => {
  it('nur gebuchte Ausgaben zählen; Teilzuordnung zählt nur ihren Anteil; Cent-genau', () => {
    const a = newExpense(100.05);
    const b = newExpense(0.1);
    assignExpenseToVorgang(a.id, { vorgangId: V1, amount: 100.05 });
    assignExpenseToVorgang(b.id, { vorgangId: V1, amount: 0.1 });
    const summary = getOrderCostSummary(V1)!;
    expect(summary.allocatedCostNet).toBe(100.15);
    expect(summary.entries).toHaveLength(2);
    expect(summary.entries.every((entry) => !entry.cancelled)).toBe(true);

    const partial = newExpense(500);
    assignExpenseToVorgang(partial.id, { vorgangId: V1, amount: 200 });
    expect(getOrderCostSummary(V1)!.allocatedCostNet).toBe(300.15);
  });

  it('eine stornierte Ausgabe verlässt die Summe und bleibt als Historie sichtbar', () => {
    const expense = newExpense(400);
    assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: 400 });
    expect(getOrderCostSummary(V1)!.allocatedCostNet).toBe(400);
    cancelExpense(expense.id, 'Falscher Beleg');
    const summary = getOrderCostSummary(V1)!;
    expect(summary.allocatedCostNet).toBe(0);
    expect(summary.entries).toHaveLength(0);
    expect(summary.cancelledEntries.map((entry) => [entry.expenseId, entry.cancelled, entry.allocatedNet])).toEqual([
      [expense.id, true, 400],
    ]);
  });

  it('unbekannter Auftrag liefert keine erfundene Auswertung', () => {
    expect(getOrderCostSummary('v-gibt-es-nicht')).toBeUndefined();
  });
});

describe('D — Abgerechnet (netto)', () => {
  const billed = (invoices: VorgangInvoice[]): number => {
    hydrateOrders(invoices);
    return getBilledNetForVorgang({ invoices } as Vorgang);
  };

  it('einzelne Rechnung und mehrere Rechnungen', () => {
    expect(billed([invoice()])).toBe(1000);
    expect(billed([invoice(), invoice({ id: 'inv-2', number: 'RE-2', subtotal: 250, amount: 297.5 })])).toBe(1250);
  });

  it('Abschläge einzeln und mehrfach', () => {
    expect(billed([invoice({ id: 'a1', type: 'abschlag', abschlagNumber: 1, subtotal: 300, amount: 357 })])).toBe(300);
    expect(
      billed([
        invoice({ id: 'a1', type: 'abschlag', abschlagNumber: 1, subtotal: 300, amount: 357 }),
        invoice({ id: 'a2', type: 'abschlag', abschlagNumber: 2, subtotal: 200, amount: 238 }),
      ]),
    ).toBe(500);
  });

  it('Abschläge + Schlussrechnung zählen jeden Euro genau einmal', () => {
    const a1 = invoice({ id: 'a1', type: 'abschlag', abschlagNumber: 1, subtotal: 300, amount: 357 });
    const a2 = invoice({ id: 'a2', type: 'abschlag', abschlagNumber: 2, subtotal: 200, amount: 238 });
    const schluss = invoice({
      id: 's1',
      number: 'RE-S',
      type: 'schluss',
      subtotal: 1000,
      amount: 595,
      previousAbschlagDeductions: [
        { invoiceId: 'a1', invoiceNumber: 'RE-A1', abschlagNumber: 1, date: '2026-09-01', subtotal: 300, amount: 357 },
        { invoiceId: 'a2', invoiceNumber: 'RE-A2', abschlagNumber: 2, date: '2026-09-05', subtotal: 200, amount: 238 },
      ],
    });
    expect(invoiceBilledNetCents(schluss)).toBe(50000);
    expect(billed([a1, a2, schluss])).toBe(1000);
  });

  it('stornierte und nicht wirksame Rechnungen zählen nicht', () => {
    expect(billed([invoice({ cancelledAt: '2026-09-10T00:00:00.000Z' })])).toBe(0);
    expect(billed([invoice({ paymentStatus: 'storniert' })])).toBe(0);
    expect(billed([invoice({ status: 'entwurf' })])).toBe(0);
    expect(billed([invoice({ status: 'vorbereitet' })])).toBe(1000);
    expect(
      billed([invoice(), invoice({ id: 'inv-x', number: 'RE-X', subtotal: 500, amount: 595, cancelledAt: '2026-09-11T00:00:00.000Z' })]),
    ).toBe(1000);
  });

  it('Zahlungen verändern den abgerechneten Wert nicht', () => {
    const withPayments = invoice({
      payments: [
        { id: 'p1', date: '2026-09-10', amount: 500, createdAt: '2026-09-10T00:00:00.000Z' },
        { id: 'p2', date: '2026-09-20', amount: 690, createdAt: '2026-09-20T00:00:00.000Z' },
      ],
      paymentStatus: 'bezahlt',
    } as Partial<VorgangInvoice>);
    expect(billed([withPayments])).toBe(1000);
  });

  it('Summary verbindet Abgerechnet und Kosten zu „Verbleibt“', () => {
    hydrateOrders([invoice()]);
    const expense = newExpense(400);
    assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: 400 });
    const summary = getOrderCostSummary(V1)!;
    expect(summary.billedNet).toBe(1000);
    expect(summary.allocatedCostNet).toBe(400);
    expect(summary.remainingNet).toBe(600);
  });
});

describe('E — Persistenz und Cloud-Sync', () => {
  it('Zuordnung steht im Push-Payload, verändert den Fingerabdruck und übersteht die Normalisierung', () => {
    const expense = newExpense(500);
    const before = buildExpenseContentKey(getExpenseById(expense.id)!);
    assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: 250 });
    const after = getExpenseById(expense.id)!;

    expect(buildExpenseContentKey(after)).not.toBe(before);
    const payload = buildExpensePushPayload(after, false).payload as Record<string, unknown>;
    expect(payload.allocations).toEqual([{ vorgangId: V1, vorgangTitle: 'Bad Sanierung', amount: 250 }]);

    const normalized = normalizeExpense(JSON.parse(JSON.stringify(after)) as Expense);
    expect(normalized.allocations).toEqual([{ vorgangId: V1, vorgangTitle: 'Bad Sanierung', amount: 250 }]);
  });

  it('Zahlungen bleiben von der Zuordnung unberührt', () => {
    const expense = newExpense(500);
    expect(recordExpensePayment(expense.id, { date: '2026-09-10', amount: 100 }).success).toBe(true);
    expect(assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: 500 }).success).toBe(true);
    const after = getExpenseById(expense.id)!;
    expect(after.payments).toHaveLength(1);
    expect(after.paymentStatus).toBe('teilbezahlt');
    expect(after.netAmount).toBe(500);
    expect(after.category).toBe('material');
  });
});
