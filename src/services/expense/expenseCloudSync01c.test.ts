/**
 * FINANZ-CORE-DURABILITY-01C — Ausgaben in die Cloud.
 *
 *  - Content-Key/Payload: Zahlungen und Zahlstatus sind keine Belegaenderung
 *  - Merge: Remote neuer + lokal sauber -> uebernehmen; lokal schmutzig -> Konflikt (kein local-wins)
 *  - Zahlungen: Kennung entscheidet, Grabstein entfernt, ausstehendes Reversal belebt nicht wieder,
 *    lokale ungepushte Zahlung bleibt, `paymentStatus` wird abgeleitet
 *  - Buchen/Entfernen reihen `expense_payment` in die Outbox ein; Beleg mit Zahlungen nicht loeschbar
 *  - Backfill: Ausgaben ohne Cloud-Version + alle Zahlungen; Demo-Ausgaben nie
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppPersistedState } from '../../types/models';
import type { Expense } from '../../types/expense';
import type { SyncMeta } from '../../types/sync';
import {
  buildExpenseContentKey,
  buildExpensePaymentEntityId,
  buildExpensePushPayload,
  collectDirtyExpenseKeys,
  isCloudSyncBlockedMockExpenseId,
  mergeExpensesFromPull,
  parseExpensePaymentEntityId,
  type CloudExpenseRow,
} from './expenseCloudSyncService';
import { planIntakeBackfill } from '../document/intakeCloudBackfillService';
import { hydrateExpenseStore } from '../expenseStore';
import { recordExpensePayment, removeExpensePayment } from '../expensePaymentService';
import { deleteExpense } from '../expenseService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';

const WS = '11111111-1111-4111-8111-111111111111';
const ctx = (dirty: string[] = []) => ({ deviceId: 'dev-1', workspaceId: WS, dirty: new Set(dirty) });
const meta = (version: number): SyncMeta => ({ updatedAt: '2026-06-01T10:00:00.000Z', version, deleted: false, deviceId: 'dev-1', workspaceId: WS });

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-real-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Lieferant GmbH',
    invoiceNumber: 'RE-900',
    title: 'Test Ausgabe',
    description: '',
    issueDate: '2026-06-01',
    paymentDueDate: '2099-06-15',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    currency: 'EUR',
    paymentStatus: 'offen',
    payments: [],
    positions: [],
    allocations: [],
    isCreditNote: false,
    dedupeKey: 'lieferant gmbh|re-900',
    tags: [],
    digitalFolder: { id: 'dig-1', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'folder-1', register: 'A', label: 'Test' },
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

function row(e: Expense, version: number, deleted = false): CloudExpenseRow {
  const payload = buildExpensePushPayload(e, deleted);
  return {
    client_expense_id: e.id,
    status: e.status,
    dedupe_key: e.dedupeKey,
    linked_inbox_id: e.linkedInboxId ?? null,
    archive_document_id: e.archiveDocumentId ?? null,
    payload: payload.payload as Record<string, unknown>,
    deleted,
    row_version: version,
    updated_at: '2026-06-02T10:00:00.000Z',
  };
}

describe('01C — Kennungen und Content-Key', () => {
  it('Zahlungen, Zahlstatus, updatedAt und sync aendern den Beleg-Fingerabdruck nicht', () => {
    const a = expense();
    const b = expense({ payments: [{ id: 'pay-1', date: '2026-06-05', amount: 50, createdAt: 'x' }], paymentStatus: 'teilbezahlt', updatedAt: '2026-07-01T00:00:00.000Z', sync: meta(3) });
    expect(buildExpenseContentKey(a)).toBe(buildExpenseContentKey(b));
    expect(buildExpenseContentKey(expense({ title: 'anders' }))).not.toBe(buildExpenseContentKey(a));
  });

  it('Push-Payload traegt keine Zahlungen; Kennung der Zahlung ist expense|payment', () => {
    const payload = buildExpensePushPayload(expense({ payments: [{ id: 'pay-1', date: '2026-06-05', amount: 50, createdAt: 'x' }], linkedInboxId: 'inbox-upload-1' }), false);
    expect(payload.client_expense_id).toBe('exp-real-1');
    expect(payload.linked_inbox_id).toBe('inbox-upload-1');
    expect((payload.payload as Record<string, unknown>).payments).toBeUndefined();
    expect((payload.payload as Record<string, unknown>).sync).toBeUndefined();
    expect(parseExpensePaymentEntityId(buildExpensePaymentEntityId('exp-real-1', 'pay-1'))).toEqual({ expenseId: 'exp-real-1', paymentId: 'pay-1' });
    expect(parseExpensePaymentEntityId('kaputt')).toBeNull();
    expect(isCloudSyncBlockedMockExpenseId('exp-001')).toBe(true);
    expect(isCloudSyncBlockedMockExpenseId('exp-real-1')).toBe(false);
  });
});

describe('01C — Merge Beleg', () => {
  it('lokal unbekannt -> uebernommen (mit Cloud-Version); Remote <= lokal -> lokal bleibt', () => {
    const remote = expense({ title: 'Cloud' });
    const merged = mergeExpensesFromPull([], { expenses: [row(remote, 2)], payments: [] }, ctx());
    expect(merged.expenses).toHaveLength(1);
    expect(merged.expenses[0].title).toBe('Cloud');
    expect(merged.expenses[0].sync?.version).toBe(2);

    const local = expense({ title: 'Lokal', sync: meta(2) });
    const kept = mergeExpensesFromPull([local], { expenses: [row(expense({ title: 'Alt' }), 2)], payments: [] }, ctx());
    expect(kept.expenses[0].title).toBe('Lokal');
  });

  it('Remote neuer + lokal schmutzig -> Konflikt, lokal bleibt; sauber -> uebernommen', () => {
    const local = expense({ title: 'Lokal', sync: meta(1) });
    const conflict = mergeExpensesFromPull([local], { expenses: [row(expense({ title: 'Cloud' }), 2)], payments: [] }, ctx(['expense:exp-real-1']));
    expect(conflict.conflicts).toEqual(['expense:exp-real-1']);
    expect(conflict.expenses[0].title).toBe('Lokal');

    const clean = mergeExpensesFromPull([local], { expenses: [row(expense({ title: 'Cloud' }), 2)], payments: [] }, ctx());
    expect(clean.conflicts).toEqual([]);
    expect(clean.expenses[0].title).toBe('Cloud');
    expect(clean.expenses[0].sync?.version).toBe(2);
  });

  it('Grabstein kommt als sync.deleted an', () => {
    const merged = mergeExpensesFromPull([expense({ sync: meta(1) })], { expenses: [row(expense(), 2, true)], payments: [] }, ctx());
    expect(merged.expenses[0].sync?.deleted).toBe(true);
  });
});

describe('01C — Merge Zahlungen', () => {
  const pay = (id: string, amount: number, reversed: string | null = null) => ({
    client_expense_id: 'exp-real-1', client_payment_id: id, amount, paid_on: '2026-06-05', reference: null, note: null,
    created_at: '2026-06-05T10:00:00.000Z', row_version: 1, reversed_at: reversed,
  });

  it('Cloud-Zahlung wird eingeflochten, Zahlstatus abgeleitet, lokale ungepushte Zahlung bleibt', () => {
    const local = expense({ sync: meta(1), payments: [{ id: 'pay-local', date: '2026-06-06', amount: 19, createdAt: 'x' }] });
    const merged = mergeExpensesFromPull([local], { expenses: [], payments: [pay('pay-cloud', 100)] }, ctx());
    const ids = merged.expenses[0].payments!.map((p) => p.id).sort();
    expect(ids).toEqual(['pay-cloud', 'pay-local']);
    expect(merged.expenses[0].paymentStatus).toBe('bezahlt');
    expect(merged.counts.payments).toBe(1);
  });

  it('Grabstein entfernt die gleichnamige lokale Zahlung; ausstehendes Reversal belebt nicht wieder', () => {
    const local = expense({ sync: meta(1), payments: [{ id: 'pay-1', date: '2026-06-05', amount: 100, createdAt: 'x' }], paymentStatus: 'teilbezahlt' });
    const removed = mergeExpensesFromPull([local], { expenses: [], payments: [pay('pay-1', 100, '2026-06-07T00:00:00.000Z')] }, ctx());
    expect(removed.expenses[0].payments).toEqual([]);
    expect(removed.expenses[0].paymentStatus).toBe('offen');

    const localWithout = expense({ sync: meta(1), payments: [] });
    const pending = mergeExpensesFromPull([localWithout], { expenses: [], payments: [pay('pay-1', 100)] }, ctx([`expense_payment:${buildExpensePaymentEntityId('exp-real-1', 'pay-1')}`]));
    expect(pending.expenses[0].payments).toEqual([]);

    const notPending = mergeExpensesFromPull([localWithout], { expenses: [], payments: [pay('pay-1', 100)] }, ctx());
    expect(notPending.expenses[0].payments!.map((p) => p.id)).toEqual(['pay-1']);
  });

  it('collectDirtyExpenseKeys kennt Beleg und Zahlung, aber keine erledigten Eintraege', () => {
    const dirty = collectDirtyExpenseKeys([
      { id: 'o1', entityType: 'expense', entityId: 'exp-real-1', operation: 'update', status: 'pending', version: 1, retryCount: 0, queuedAt: 'x' },
      { id: 'o2', entityType: 'expense_payment', entityId: 'exp-real-1|pay-1', operation: 'delete', status: 'error', version: 1, retryCount: 1, queuedAt: 'x' },
      { id: 'o3', entityType: 'expense', entityId: 'exp-real-2', operation: 'update', status: 'completed', version: 1, retryCount: 0, queuedAt: 'x' },
    ] as never);
    expect([...dirty].sort()).toEqual(['expense:exp-real-1', 'expense_payment:exp-real-1|pay-1']);
  });
});

describe('01C — lokale Dienste reihen Zahlungen ein', () => {
  beforeEach(() => {
    resetSyncOutboxForTests([]);
    hydrateExpenseStore([expense()]);
  });

  it('Buchen -> expense_payment create; Entfernen -> expense_payment delete; gleiche Kennung', () => {
    const booked = recordExpensePayment('exp-real-1', { date: '2026-06-05', amount: 50 });
    expect(booked.success).toBe(true);
    const paymentId = booked.success ? booked.payment.id : '';
    let outbox = getSyncOutboxSnapshot().filter((e) => e.entityType === 'expense_payment');
    expect(outbox).toHaveLength(1);
    expect(outbox[0].operation).toBe('create');
    expect(outbox[0].entityId).toBe(buildExpensePaymentEntityId('exp-real-1', paymentId));

    expect(removeExpensePayment('exp-real-1', paymentId).success).toBe(true);
    outbox = getSyncOutboxSnapshot().filter((e) => e.entityType === 'expense_payment');
    // Die Outbox faltet create+delete derselben Kennung zum delete: das Reversal einer nie gepushten Zahlung ist ein No-op.
    expect(outbox.map((e) => e.operation)).toEqual(['delete']);
    expect(outbox[0].entityId).toBe(buildExpensePaymentEntityId('exp-real-1', paymentId));
  });

  it('Beleg mit gebuchter Zahlung ist nicht loeschbar — dieselbe Regel wie die Cloud', () => {
    expect(recordExpensePayment('exp-real-1', { date: '2026-06-05', amount: 50 }).success).toBe(true);
    const blocked = deleteExpense('exp-real-1');
    expect(blocked.success).toBe(false);
    expect(blocked.success ? '' : blocked.errorKey).toBe('expense.delete.hasPayments');
  });
});

describe('01C — Backfill-Plan', () => {
  it('nimmt echte Ausgaben ohne Cloud-Version und alle Zahlungen; Demo-Ausgaben und Grabsteine nie', () => {
    const state = {
      inboxItems: [], documents: [], documentFileRefs: [], documentFileRepresentationBindings: [], documentWorkResults: [],
      expenses: [
        expense({ id: 'exp-real-1', payments: [{ id: 'pay-1', date: '2026-06-05', amount: 50, createdAt: 'x' }] }),
        expense({ id: 'exp-real-2', sync: meta(2), payments: [{ id: 'pay-2', date: '2026-06-05', amount: 50, createdAt: 'x' }] }),
        expense({ id: 'exp-001', payments: [{ id: 'pay-3', date: '2026-06-05', amount: 50, createdAt: 'x' }] }),
        expense({ id: 'exp-real-3', sync: { ...meta(2), deleted: true } }),
      ],
    } as unknown as AppPersistedState;
    const plan = planIntakeBackfill(state);
    expect(plan.counts.expenses).toBe(1);
    expect(plan.counts.expensePayments).toBe(2);
    expect(plan.entries.map((e) => `${e.entityType}:${e.entityId}`).sort()).toEqual([
      'expense:exp-real-1',
      'expense_payment:exp-real-1|pay-1',
      'expense_payment:exp-real-2|pay-2',
    ]);
  });
});
