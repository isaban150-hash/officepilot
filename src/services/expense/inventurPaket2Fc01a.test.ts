/**
 * FINANZ-CORE-01A — Gesamtnacharbeit Paket 2 (WEISS-Gesamtmängelinventur vom 15.10.2026): derselbe
 * Ausgabenvertrag im Client wie auf dem Server (`supabase/tests/fc01a_inventur_paket2.sql`, Wettläufe in
 * `fc01a_inventur_ausgaben_parallel.mjs`).
 *
 *  A   INV-08 Zahlung: Cent vor Erfolg (0,004/0,005/1,005), NaN/Unendlich, ungültiger Tag, Entwurf,
 *      Gutschrift, Überzahlung mit/ohne Bestätigung (die Bestätigung reist mit)
 *  B   INV-09 generischer Setter: kein Storno/Entwurf/Betrag/Steuer/Gutschrift nach Zahlung, Storno nur aus
 *      gebucht, Cent-Vergleich
 *  C   Cloud: Bestätigung im Aufruf, fachliche Abweisung endgültig, Netzfehler wiederholbar
 *  D   Warteschlange: endgültig abgewiesen → kein Nachholen nach Neustart, eine bewusste Änderung löst ab
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resetTestStores } from '../../test/resetStores';
import { addExpense, getExpenseById, updateExpense } from '../expenseService';
import { recordExpensePayment } from '../expensePaymentService';
import { rpcAddWorkspaceExpensePayment, rpcUpsertWorkspaceExpense } from './expenseCloudSyncService';
import { WorkspaceCloudError } from '../workspace/workspaceCloudService';
import {
  enqueueBackfillSyncOutbox,
  enqueueSyncOutbox,
  getSyncOutboxSnapshot,
  resetSyncOutboxForTests,
} from '../sync/syncOutboxService';
import { isFinalBusinessRejectionMessage, isFinallyDeniedOutboxEntry, isRoleDenialMessage } from '../sync/syncRoleDenial';
import { mapSyncErrorReason } from '../sync/syncOutboxDescriptionService';
import { t } from '../../i18n';
import type { Expense, ExpenseInput, ExpensePayment } from '../../types/expense';
import type { SyncOutboxEntry } from '../../types/sync';

let nummer = 0;

function ausgabe(extra: Partial<ExpenseInput> = {}): Expense {
  nummer += 1;
  const result = addExpense({
    title: 'Inventur',
    category: 'material',
    supplierName: 'Lieferant GmbH',
    invoiceNumber: `RE-INV2-${nummer}`,
    issueDate: '2026-06-01',
    grossAmount: 119,
    netAmount: 100,
    taxAmount: 19,
    taxStatus: 'standard_19',
    status: 'gebucht',
    ...extra,
  });
  if (!result.success) throw new Error(result.errorKey);
  return result.expense;
}

beforeEach(() => {
  resetTestStores();
  resetSyncOutboxForTests([]);
});

describe('A — INV-08 Zahlung: derselbe Vertrag vor dem lokalen Erfolg', () => {
  it('A1 WEISS: 0,004 ist keine Zahlung — kein lokaler Erfolg, nichts gespeichert, nichts eingereiht', () => {
    const e = ausgabe();
    expect(recordExpensePayment(e.id, { amount: 0.004, date: '2026-06-02' })).toEqual({ success: false, errorKey: 'payment.amountInvalid' });
    expect(getExpenseById(e.id)!.payments).toEqual([]);
    expect(getSyncOutboxSnapshot().filter((x) => x.entityType === 'expense_payment')).toEqual([]);
  });

  it('A2 0,005 → 0,01 und 1,005 → 1,01 (kaufmännisch wie der Server); NaN, Unendlich, ungültiger Tag abgewiesen', () => {
    const e = ausgabe();
    const a = recordExpensePayment(e.id, { amount: 0.005, date: '2026-06-02' });
    const b = recordExpensePayment(e.id, { amount: 1.005, date: '2026-06-02' });
    expect(a.success && a.payment.amount).toBe(0.01);
    expect(b.success && b.payment.amount).toBe(1.01);
    expect(recordExpensePayment(e.id, { amount: Number.NaN, date: '2026-06-02' })).toMatchObject({ errorKey: 'payment.amountInvalid' });
    expect(recordExpensePayment(e.id, { amount: Number.POSITIVE_INFINITY, date: '2026-06-02' })).toMatchObject({ errorKey: 'payment.amountInvalid' });
    expect(recordExpensePayment(e.id, { amount: 5, date: '2026-02-30' })).toMatchObject({ errorKey: 'payment.dateInvalid' });
    expect(t('payment.dateInvalid')).not.toBe('payment.dateInvalid');
  });

  it('A3 Entwurf, Gutschrift (Betrag negativ oder Kennzeichen) und Storno sind nicht zahlbar', () => {
    expect(recordExpensePayment(ausgabe({ status: 'entwurf' }).id, { amount: 10, date: '2026-06-02' })).toMatchObject({ errorKey: 'expense.payment.notPayable' });
    expect(
      recordExpensePayment(ausgabe({ grossAmount: -119, netAmount: -100, taxAmount: -19 }).id, { amount: 10, date: '2026-06-02' }, { confirmOverpayment: true }),
    ).toMatchObject({ errorKey: 'expense.payment.notPayable' });
    const e = ausgabe();
    updateExpense(e.id, { status: 'storniert' });
    expect(recordExpensePayment(e.id, { amount: 10, date: '2026-06-02' }).success).toBe(false);
  });

  it('A4 WEISS S5: zweite Zahlung über den offenen Betrag nur bestätigt — die Bestätigung steht an der Zahlung', () => {
    const e = ausgabe();
    const erste = recordExpensePayment(e.id, { amount: 119, date: '2026-06-01' });
    expect(erste.success && erste.payment.overpaymentAcknowledged).toBeFalsy();
    expect(recordExpensePayment(e.id, { amount: 119, date: '2026-06-02' })).toEqual({ success: false, errorKey: 'payment.overpaymentConfirmationRequired' });
    const zweite = recordExpensePayment(e.id, { amount: 119, date: '2026-06-02' }, { confirmOverpayment: true });
    expect(zweite.success && zweite.payment.overpaymentAcknowledged).toBe(true);
  });
});

describe('B — INV-09 generischer Setter auf den Vertrag von cancelExpense und Server', () => {
  function bezahlt(): Expense {
    const e = ausgabe();
    const r = recordExpensePayment(e.id, { amount: 119, date: '2026-06-01' });
    if (!r.success) throw new Error(r.errorKey);
    return getExpenseById(e.id)!;
  }

  it('B1 WEISS: updateExpense(status storniert) trotz Zahlung → abgewiesen, Ausgabe bleibt gebucht', () => {
    const e = bezahlt();
    expect(updateExpense(e.id, { status: 'storniert' })).toEqual({ success: false, errorKey: 'expense.cancel.hasPayments' });
    expect(getExpenseById(e.id)).toMatchObject({ status: 'gebucht' });
    expect(getExpenseById(e.id)!.cancelledAt).toBeUndefined();
  });

  it('B2 nach Zahlung: kein Entwurf, kein Betrag, kein Steuerstatus, kein Gutschriftkennzeichen; Titel geht', () => {
    const e = bezahlt();
    expect(updateExpense(e.id, { status: 'entwurf' })).toMatchObject({ errorKey: 'expense.edit.statusLockedAfterPayment' });
    expect(updateExpense(e.id, { grossAmount: 238, netAmount: 200, taxAmount: 38 })).toMatchObject({ errorKey: 'expense.edit.amountLockedAfterPayment' });
    expect(updateExpense(e.id, { taxStatus: 'unclear' })).toMatchObject({ errorKey: 'expense.edit.amountLockedAfterPayment' });
    expect(updateExpense(e.id, { isCreditNote: true })).toMatchObject({ errorKey: 'expense.edit.amountLockedAfterPayment' });
    expect(updateExpense(e.id, { title: 'Inventur (neu)' }).success).toBe(true);
    // Cent-Vergleich: 119,004 ist derselbe Centbetrag, keine Änderung.
    expect(updateExpense(e.id, { grossAmount: 119.004 }).success).toBe(true);
    expect(t('expense.edit.statusLockedAfterPayment')).not.toBe('expense.edit.statusLockedAfterPayment');
  });

  it('B3 ohne Zahlung: Storno aus gebucht wie bisher, aus Entwurf nicht', () => {
    expect(updateExpense(ausgabe({ status: 'entwurf' }).id, { status: 'storniert' })).toMatchObject({ errorKey: 'expense.cancel.notBooked' });
    const e = ausgabe();
    expect(updateExpense(e.id, { status: 'storniert' }).success).toBe(true);
    expect(getExpenseById(e.id)!.cancelledAt).toBeTruthy();
  });
});

function fakeClient(antwort: { data?: unknown; error?: { message: string; code?: string } | null }) {
  const rpc = vi.fn().mockResolvedValue({ data: antwort.data ?? null, error: antwort.error ?? null });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const zahlung = (extra: Partial<ExpensePayment> = {}): ExpensePayment => ({
  id: 'pay-1', date: '2026-06-02', amount: 119, createdAt: '2026-06-02T10:00:00.000Z', ...extra,
});

describe('C — Cloud: Bestätigung im Aufruf, fachliche Abweisung endgültig', () => {
  it('C1 p_overpayment_acknowledged nur bei bestätigter Überzahlung', async () => {
    const ohne = fakeClient({ data: [] });
    await rpcAddWorkspaceExpensePayment('ws-1', 'exp-1', zahlung(), ohne.client);
    expect(ohne.rpc.mock.calls[0]![1]).not.toHaveProperty('p_overpayment_acknowledged');
    const mit = fakeClient({ data: [] });
    await rpcAddWorkspaceExpensePayment('ws-1', 'exp-1', zahlung({ overpaymentAcknowledged: true }), mit.client);
    expect(mit.rpc.mock.calls[0]![1]).toMatchObject({ p_overpayment_acknowledged: true });
  });

  it('C2 Serverabweisungen der Ausgabenregeln: nicht wiederholbar; Netz und Unbekanntes wiederholbar', async () => {
    const endgueltig = [
      'expense_payment_not_payable: Status entwurf',
      'expense_payment_not_payable: Gutschrift',
      'expense_payment_overpayment_unconfirmed: offen 0.00',
      'amount ungueltig',
      'paid_on ungueltig',
      'Ausgabe storniert',
      'Ausgabe geloescht',
    ];
    for (const message of endgueltig) {
      const { client } = fakeClient({ error: { message } });
      const fehler = await rpcAddWorkspaceExpensePayment('ws-1', 'exp-1', zahlung(), client).catch((e: unknown) => e);
      expect(fehler).toBeInstanceOf(WorkspaceCloudError);
      expect((fehler as WorkspaceCloudError).retryable).toBe(false);
      expect(isFinalBusinessRejectionMessage(message)).toBe(true);
      expect(isRoleDenialMessage(message)).toBe(false);
    }
    for (const message of ['expense_amount_locked_after_payment: 1 aktive Zahlung(en)', 'expense_cancel_has_payments: 1', 'expense_status_locked_after_payment: 1', 'expense_cancelled_immutable: x', 'expense_cancel_not_booked: x', 'Ausgabe hat gebuchte Zahlungen']) {
      const { client } = fakeClient({ error: { message } });
      const fehler = await rpcUpsertWorkspaceExpense('ws-1', {}, 1, client).catch((e: unknown) => e);
      expect((fehler as WorkspaceCloudError).retryable).toBe(false);
    }
    for (const message of ['Failed to fetch', 'Irgendein unbekannter Ausfall']) {
      const { client } = fakeClient({ error: { message } });
      const fehler = await rpcAddWorkspaceExpensePayment('ws-1', 'exp-1', zahlung(), client).catch((e: unknown) => e);
      expect((fehler as WorkspaceCloudError).retryable).toBe(true);
    }
  });
});

describe('D — Warteschlange: endgültig heißt endgültig', () => {
  const abgewiesen = (message: string): SyncOutboxEntry => ({
    id: 'outbox-1', entityType: 'expense_payment', entityId: 'exp-1:pay-1', operation: 'create', status: 'failed',
    createdAt: '2026-06-02T10:00:00.000Z', updatedAt: '2026-06-02T10:00:01.000Z', retryCount: 1, version: 1,
    lastErrorMessage: message, lastErrorRetryable: false,
  } as SyncOutboxEntry);

  it('D1 fachlich abgewiesen: Neustart-Backfill reiht nicht neu ein; eine bewusste Änderung löst ab', () => {
    resetSyncOutboxForTests([abgewiesen('expense_payment_overpayment_unconfirmed: offen 0.00')]);
    expect(isFinallyDeniedOutboxEntry(getSyncOutboxSnapshot()[0]!)).toBe(true);
    expect(enqueueBackfillSyncOutbox({ entityType: 'expense_payment', entityId: 'exp-1:pay-1', operation: 'create', version: 1 })).toBeNull();
    expect(getSyncOutboxSnapshot().filter((x) => x.status === 'pending')).toEqual([]);
    enqueueSyncOutbox({ entityType: 'expense_payment', entityId: 'exp-1:pay-1', operation: 'create', version: 1 });
    expect(getSyncOutboxSnapshot().filter((x) => x.status === 'pending')).toHaveLength(1);
  });

  it('D2 ein Netzfehler bleibt ein wiederholbarer Auftrag', () => {
    resetSyncOutboxForTests([{ ...abgewiesen('Failed to fetch'), status: 'error', lastErrorRetryable: true }]);
    expect(isFinallyDeniedOutboxEntry(getSyncOutboxSnapshot()[0]!)).toBe(false);
  });

  it('D3 die Sync-Seite nennt den fachlichen Grund, nicht „unbekannt“ und nicht „keine Berechtigung“', () => {
    const key = mapSyncErrorReason('expense_cancel_has_payments: 1 aktive Zahlung(en)', 'failed');
    expect(key).toBe('sync.failure.reason.expenseRejected');
    expect(t(key)).toContain('nicht erneut gesendet');
  });
});
