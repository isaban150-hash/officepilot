/**
 * STEUERBERATER & BUCHFUEHRUNGSINTELLIGENZ 02B / Block 5 — optionale Zahlungsart.
 *
 *   bank | cash | other | nicht erfasst — für Rechnungs- und Ausgabenzahlungen,
 *   lokal, in der Cloud (nur gesendet, wenn gesetzt), beim Zusammenführen und in
 *   der Monatsmappe. Ein Altbestand ohne Angabe bleibt ohne Angabe; eine
 *   Barzahlung gilt sofort als Zahlung.
 *
 * Neutrale Beispieldaten; der Cloud-Client ist ein Stub, kein Netzwerk.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTestVorgang } from '../../test/fixtures';
import { hydrateVorgangStore, getVorgangInvoice, mergeCloudPaymentsIntoInvoice } from '../vorgangService';
import { calculatePaymentSummary, recordPayment, removePayment } from '../invoicePaymentService';
import { recordExpensePayment } from '../expensePaymentService';
import { getAllExpensesFromStore, setExpenseStoreForTests } from '../expenseStore';
import { buildPersistedStateSnapshot, persistAll } from '../persistenceService';
import {
  addInvoicePaymentToCloud,
  parseWorkspaceInvoicePaymentRow,
} from '../invoice/workspaceInvoicePaymentCloudService';
import { mergeExpensesFromPull, rpcAddWorkspaceExpensePayment } from '../expense/expenseCloudSyncService';
import { buildMonatsmappeModel, buildZahlungenCsv } from '../steuerberater/monatsmappeModelService';
import { collectMonatsmappeInput } from '../steuerberater/monatsmappeInputService';
import { normalizeExpense } from '../expenseNormalize';
import type { Expense } from '../../types/expense';
import type { VorgangInvoice } from '../../types/models';

const VORGANG = 'v-pm';
const INVOICE = 'inv-pm';
const WS = '00000000-0000-0000-0000-0000000a0001';

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE,
    number: 'RE-2026-301',
    type: 'rechnung',
    positions: [],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'versendet',
    date: '2026-09-02',
    issueDate: '2026-09-02',
    paymentDueDate: '2026-09-30',
    createdAt: '2026-09-02T10:00:00.000Z',
    customerSnapshot: { name: 'Kunde B', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-real-pm',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Lieferant C',
    invoiceNumber: 'L-300',
    title: 'Material',
    issueDate: '2026-09-03',
    taxStatus: 'standard_19',
    netAmount: 50,
    taxAmount: 9.5,
    grossAmount: 59.5,
    ...overrides,
  } as Expense);
}

/** Ein Supabase-Stub, der die RPC-Argumente festhält und die Zeile zurückgibt. */
function stubClient(respond: (args: Record<string, unknown>) => unknown) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: respond(args), error: null };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

function cloudRow(args: Record<string, unknown>, withMethodColumn = true) {
  return [{
    workspace_id: WS,
    client_invoice_id: args.p_client_invoice_id,
    client_payment_id: args.p_client_payment_id,
    amount: args.p_amount,
    paid_on: args.p_paid_on,
    reference: args.p_reference,
    note: args.p_note,
    ...(withMethodColumn ? { method: args.p_method ?? null } : {}),
    created_at: '2026-09-05T10:00:00.000Z',
    updated_at: '2026-09-05T10:00:00.000Z',
    row_version: 1,
    reversed_at: null,
  }];
}

beforeEach(() => {
  hydrateVorgangStore([createTestVorgang({ id: VORGANG, title: 'Zahlungsart', invoices: [rechnung()] })]);
  setExpenseStoreForTests([ausgabe()]);
});

describe('Rechnungszahlung', () => {
  it.each([['bank'], ['cash'], ['other']] as const)('speichert die Zahlungsart %s', (method) => {
    expect(recordPayment(VORGANG, INVOICE, { amount: 50, date: '2026-09-05', method }).success).toBe(true);
    expect(getVorgangInvoice(VORGANG, INVOICE)!.payments![0].method).toBe(method);
  });

  it('ohne Angabe bleibt sie nicht erfasst — nie „bank“; ungültige Werte werden verworfen', () => {
    recordPayment(VORGANG, INVOICE, { amount: 50, date: '2026-09-05' });
    recordPayment(VORGANG, INVOICE, { amount: 10, date: '2026-09-06', method: 'scheck' as never });
    const payments = getVorgangInvoice(VORGANG, INVOICE)!.payments!;
    expect(payments.map((p) => 'method' in p)).toEqual([false, false]);
  });

  it('Barzahlung gilt sofort als Zahlung — ohne Bankabgleich', () => {
    recordPayment(VORGANG, INVOICE, { amount: 119, date: '2026-09-05', method: 'cash' });
    expect(calculatePaymentSummary(getVorgangInvoice(VORGANG, INVOICE)!).status).toBe('bezahlt');
  });

  it('übersteht Persistenz; Rücknahme entfernt nur die zurückgenommene Zahlung', () => {
    recordPayment(VORGANG, INVOICE, { amount: 50, date: '2026-09-05', method: 'cash' });
    recordPayment(VORGANG, INVOICE, { amount: 20, date: '2026-09-06', method: 'bank' });
    persistAll();
    const persisted = buildPersistedStateSnapshot().invoiceEntries!.find((e) => e.invoice.id === INVOICE)!.invoice;
    expect(persisted.payments!.map((p) => p.method)).toEqual(['cash', 'bank']);

    const first = getVorgangInvoice(VORGANG, INVOICE)!.payments![0];
    expect(removePayment(VORGANG, INVOICE, first.id).success).toBe(true);
    expect(getVorgangInvoice(VORGANG, INVOICE)!.payments!.map((p) => [p.amount, p.method])).toEqual([[20, 'bank']]);
  });
});

describe('Ausgabenzahlung', () => {
  it.each([['bank'], ['cash'], ['other']] as const)('speichert die Zahlungsart %s', (method) => {
    expect(recordExpensePayment('exp-real-pm', { amount: 20, date: '2026-09-05', method }).success).toBe(true);
    expect(getAllExpensesFromStore()[0].payments![0].method).toBe(method);
  });

  it('ohne Angabe bleibt sie nicht erfasst', () => {
    recordExpensePayment('exp-real-pm', { amount: 20, date: '2026-09-05' });
    expect('method' in getAllExpensesFromStore()[0].payments![0]).toBe(false);
  });
});

describe('Cloud — Rechnungszahlung', () => {
  it('sendet p_method nur, wenn gesetzt, und prüft die Antwort', async () => {
    const mit = stubClient((args) => cloudRow(args));
    const ok = await addInvoicePaymentToCloud(
      { clientInvoiceId: INVOICE, clientPaymentId: 'pay-a', amount: 50, paidOn: '2026-09-05', method: 'cash' },
      { client: mit.client, workspaceId: WS },
    );
    expect(ok.outcome).toBe('synced');
    expect(mit.calls[0].args.p_method).toBe('cash');

    const ohne = stubClient((args) => cloudRow(args, false));
    const altServer = await addInvoicePaymentToCloud(
      { clientInvoiceId: INVOICE, clientPaymentId: 'pay-b', amount: 50, paidOn: '2026-09-05' },
      { client: ohne.client, workspaceId: WS },
    );
    expect(altServer.outcome).toBe('synced');
    expect('p_method' in ohne.calls[0].args).toBe(false);

    // Server bestätigt eine andere Zahlungsart → kein Erfolg.
    const falsch = stubClient((args) => cloudRow({ ...args, p_method: 'bank' }));
    const mismatch = await addInvoicePaymentToCloud(
      { clientInvoiceId: INVOICE, clientPaymentId: 'pay-c', amount: 50, paidOn: '2026-09-05', method: 'cash' },
      { client: falsch.client, workspaceId: WS },
    );
    expect(mismatch.outcome).toBe('failed');
  });

  it('liest method: fehlt das Feld → unbekannt; null → nicht erfasst', () => {
    const base = cloudRow({ p_client_invoice_id: INVOICE, p_client_payment_id: 'p', p_amount: 1, p_paid_on: '2026-09-05' }, false)[0];
    expect(parseWorkspaceInvoicePaymentRow(base)!.method).toBeUndefined();
    expect(parseWorkspaceInvoicePaymentRow({ ...base, method: null })!.method).toBeNull();
    expect(parseWorkspaceInvoicePaymentRow({ ...base, method: 'cash' })!.method).toBe('cash');
  });

  it('Zusammenführen: Serverfeld gilt; ohne Serverfeld bleibt die lokale Angabe', () => {
    const local = rechnung({ payments: [{ id: 'pay-x', date: '2026-09-05', amount: 50, method: 'cash', createdAt: 'x' }] });
    const entry = { clientInvoiceId: INVOICE, clientPaymentId: 'pay-x', amount: 50, paidOn: '2026-09-05', createdAt: 'x' };
    expect(mergeCloudPaymentsIntoInvoice(local, [entry])[0].method).toBe('cash');
    expect(mergeCloudPaymentsIntoInvoice(local, [{ ...entry, method: 'bank' }])[0].method).toBe('bank');
    expect('method' in mergeCloudPaymentsIntoInvoice(local, [{ ...entry, method: null }])[0]).toBe(false);
  });
});

describe('Cloud — Ausgabenzahlung', () => {
  it('sendet p_method nur, wenn gesetzt', async () => {
    const stub = stubClient(() => null);
    await rpcAddWorkspaceExpensePayment(WS, 'exp-real-pm', { id: 'p1', date: '2026-09-05', amount: 10, method: 'other', createdAt: 'x' }, stub.client);
    await rpcAddWorkspaceExpensePayment(WS, 'exp-real-pm', { id: 'p2', date: '2026-09-05', amount: 10, createdAt: 'x' }, stub.client);
    expect(stub.calls[0].args.p_method).toBe('other');
    expect('p_method' in stub.calls[1].args).toBe(false);
  });

  it('Zusammenführen: Serverfeld gilt; ohne Serverfeld bleibt die lokale Angabe', () => {
    const local = ausgabe({ payments: [{ id: 'p1', date: '2026-09-05', amount: 10, method: 'cash', createdAt: 'x' }] });
    const row = { client_expense_id: 'exp-real-pm', client_payment_id: 'p1', amount: 10, paid_on: '2026-09-05', reference: null, note: null, created_at: 'x', row_version: 1, reversed_at: null };
    const context = { deviceId: 'd', workspaceId: WS, dirty: new Set<string>() };
    const ohneFeld = mergeExpensesFromPull([local], { expenses: [], payments: [row] }, context);
    expect(ohneFeld.expenses[0].payments![0].method).toBe('cash');
    const mitFeld = mergeExpensesFromPull([local], { expenses: [], payments: [{ ...row, method: 'bank' }] }, context);
    expect(mitFeld.expenses[0].payments![0].method).toBe('bank');
  });
});

describe('Monatsmappe', () => {
  it('Zahlungen.csv führt die Zahlungsart in Klartext; nicht erfasst bleibt leer', () => {
    recordPayment(VORGANG, INVOICE, { amount: 50, date: '2026-09-05', method: 'cash' });
    recordPayment(VORGANG, INVOICE, { amount: 20, date: '2026-09-06' });
    const csv = buildZahlungenCsv(buildMonatsmappeModel(collectMonatsmappeInput('2026-09')));
    const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    expect(lines[0].endsWith(';Zahlungsart')).toBe(true);
    expect(lines.slice(1).map((line) => line.split(';').pop())).toEqual(['Bar', '']);
  });
});
