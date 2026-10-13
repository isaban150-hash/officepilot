/**
 * FINANZ-CORE-01A (SQL-05/ZAH-02, Entscheidung D3) — Überzahlung nur mit Bestätigung,
 * jetzt auch auf dem Server.
 *
 *  U1  der Bestätigungsparameter geht nur mit, wenn der Nutzer bestätigt hat
 *  U2  ein Server ohne den Parameter (PGRST202) bekommt denselben Aufruf ohne ihn
 *  U3  die Serverabweisung ist ein eigener Ausgang, kein Netzproblem
 *  U4  die automatische Nachsicherung wiederholt eine unbestätigte Überzahlung nicht,
 *      bis der Nutzer entscheidet
 *  U5  das Merkmal entsteht bei der bestätigten Erfassung und lässt sich nachträglich
 *      setzen — Kennung, Betrag und Datum bleiben
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import { addInvoicePaymentToCloud } from './workspaceInvoicePaymentCloudService';
import {
  releaseInvoicePaymentResyncConflict,
  resetInvoicePaymentResyncForTests,
  resyncLocalOnlyInvoicePayments,
} from './invoicePaymentCloudResyncService';
import { acknowledgeInvoicePaymentOverpayment, recordPayment } from '../invoicePaymentService';
import { getVorgangInvoice, hydrateVorgangStore } from '../vorgangService';
import type { InvoicePayment, Vorgang, VorgangInvoice } from '../../types/models';

const WORKSPACE = '00000000-0000-4000-8000-0000000fc0d3';
const VORGANG_ID = 'v-ueberzahlung';
const INVOICE_ID = 'inv-ueberzahlung';

function cloudRow(args: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `row-${String(args.p_client_payment_id)}`,
    workspace_id: WORKSPACE,
    client_invoice_id: args.p_client_invoice_id,
    client_payment_id: args.p_client_payment_id,
    amount: args.p_amount,
    paid_on: args.p_paid_on,
    reference: args.p_reference ?? null,
    note: args.p_note ?? null,
    method: args.p_method ?? null,
    created_at: '2026-10-12T10:00:00.000Z',
    updated_at: '2026-10-12T10:00:00.000Z',
    row_version: 1,
    reversed_at: null,
  };
}

const input = {
  clientInvoiceId: INVOICE_ID,
  clientPaymentId: 'pay-1',
  amount: 50,
  paidOn: '2026-10-10',
  method: 'bank' as const,
};

function buildInvoice(): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0099',
    invoiceSequenceNumber: 99,
    type: 'rechnung',
    positions: [
      { id: 'l1', orderPositionId: 'op-1', description: 'Montage', quantity: 1, unit: 'Stück', unitPrice: 100, lineTotal: 100 },
    ],
    subtotal: 100,
    taxStatus: 'kleinunternehmer_19',
    amount: 100,
    status: 'versendet',
    sentAt: '2026-10-01',
    sentVia: 'email',
    date: '2026-10-01',
    issueDate: '2026-10-01',
    createdAt: '2026-10-01T10:00:00.000Z',
    paymentDueDate: '2099-12-31',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
  } as VorgangInvoice;
}

describe('FINANZ-CORE-01A D3 — Überzahlung', () => {
  beforeEach(() => {
    resetTestStores();
    resetInvoicePaymentResyncForTests();
  });
  afterEach(() => resetInvoicePaymentResyncForTests());

  it('U1 sendet den Bestätigungsparameter nur nach ausdrücklicher Bestätigung', async () => {
    const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => ({ data: [cloudRow(args)], error: null }));
    const client = { rpc } as never;

    await addInvoicePaymentToCloud(input, { client, workspaceId: WORKSPACE });
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_overpayment_acknowledged');

    const bestaetigt = await addInvoicePaymentToCloud(
      { ...input, clientPaymentId: 'pay-2', overpaymentAcknowledged: true },
      { client, workspaceId: WORKSPACE },
    );
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_overpayment_acknowledged: true });
    expect(bestaetigt.outcome).toBe('synced');
  });

  it('U2 fällt bei einem Server ohne den Parameter auf den bisherigen Aufruf zurück', async () => {
    const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) =>
      'p_overpayment_acknowledged' in args
        ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.add_workspace_invoice_payment' } }
        : { data: [cloudRow(args)], error: null },
    );
    const result = await addInvoicePaymentToCloud(
      { ...input, overpaymentAcknowledged: true },
      { client: { rpc } as never, workspaceId: WORKSPACE },
    );
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][1]).not.toHaveProperty('p_overpayment_acknowledged');
    expect(result.outcome).toBe('synced');
  });

  it('U3 meldet die Serverabweisung als unbestätigte Überzahlung', async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: 'P0001', message: 'invoice_payment_overpayment_unconfirmed: offen 40.00' },
    }));
    const result = await addInvoicePaymentToCloud(input, { client: { rpc } as never, workspaceId: WORKSPACE });
    expect(result.outcome).toBe('overpayment_unconfirmed');
    // Ein Server ohne die Erweiterung wird hier nicht ein zweites Mal gefragt.
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('U4 wiederholt eine unbestätigte Überzahlung erst nach der Entscheidung des Nutzers', async () => {
    const zahlung = { id: 'pay-x', amount: 100, date: '2026-10-10', createdAt: '2026-10-10T09:00:00.000Z' } as InvoicePayment;
    const rechnung = { ...buildInvoice(), payments: [zahlung] } as VorgangInvoice;
    const push = vi.fn(async () => 'overpayment_unconfirmed' as const);
    const deps = {
      listInvoices: () => [rechnung],
      pull: async () => ({ outcome: 'synced' as const, rows: [] }),
      push,
    };
    let now = 0;
    await resyncLocalOnlyInvoicePayments({ ...deps, now: () => now });
    now += 60 * 60 * 1000;
    await resyncLocalOnlyInvoicePayments({ ...deps, now: () => now });
    expect(push).toHaveBeenCalledTimes(1);

    releaseInvoicePaymentResyncConflict(INVOICE_ID, 'pay-x');
    await resyncLocalOnlyInvoicePayments({ ...deps, now: () => now });
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('U5 setzt das Merkmal bei bestätigter Erfassung und nachträglich, ohne die Zahlung zu ändern', () => {
    hydrateVorgangStore([
      {
        ...createTestVorgang({
          id: VORGANG_ID,
          status: 'beauftragt',
          customer: 'Beispiel GmbH',
          orderPositions: [createOrderPosition({ id: 'op-1', unit: 'Stück', plannedQuantity: 1, unitPrice: 100 })],
        }),
        invoices: [buildInvoice()],
      } as Vorgang,
    ]);

    const normal = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-10-10', amount: 60 });
    expect(normal.success).toBe(true);
    if (!normal.success) return;
    expect(normal.payment.overpaymentAcknowledged).toBeUndefined();

    const ohne = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-10-11', amount: 60 });
    expect(ohne).toEqual({ success: false, errorKey: 'payment.overpaymentConfirmationRequired' });

    const mit = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-10-11', amount: 60 }, { confirmOverpayment: true });
    expect(mit.success).toBe(true);
    if (!mit.success) return;
    expect(mit.payment.overpaymentAcknowledged).toBe(true);

    // Nachträglich: die erste Zahlung (etwa nach einer Serverabweisung) bestätigen.
    const nachher = acknowledgeInvoicePaymentOverpayment(VORGANG_ID, INVOICE_ID, normal.payment.id);
    expect(nachher.success).toBe(true);
    const gespeichert = getVorgangInvoice(VORGANG_ID, INVOICE_ID)!.payments!.find((p) => p.id === normal.payment.id)!;
    expect(gespeichert).toMatchObject({ id: normal.payment.id, amount: 60, date: '2026-10-10', overpaymentAcknowledged: true });
    expect(getVorgangInvoice(VORGANG_ID, INVOICE_ID)!.payments).toHaveLength(2);
  });
});
