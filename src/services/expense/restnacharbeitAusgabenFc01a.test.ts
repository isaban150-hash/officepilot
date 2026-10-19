/**
 * FINANZ-CORE-01A — Restnacharbeit nach WEISS-Bericht 18, END18-R3 (P1): Eine endgültig abgewiesene
 * Ausgabenaktion verliert ihre lokale Finanzwirkung (Saldo, offene Posten, Monatsmappe, Export, Abschluss),
 * bleibt aber als Nachweis sichtbar. Netzfehler bleiben wiederholbar, eine angenommene Zahlung mit
 * verlorener Antwort bleibt genau einmal, eine neue bewusste Aktion bleibt möglich.
 *
 *  W   WEISS' drei Varianten über den echten Sync-Adapter (Push → endgültige Abweisung → Pull des Serverstands):
 *      weitere Zahlung 119 (lokal 238), Betrag 119 → 238, Storno trotz Zahlung
 *  P   Persistenz/Neustart: erneuter Abgleich und Laden ändern nichts, kein doppelter Nachweis
 *  G   Grenzen: verlorene Antwort, Netzfehler, abgewiesene Rücknahme/Löschung/Neuanlage, neue bewusste Aktion
 *  M   Monatsmappe, zahlungen.csv und Abschluss zählen nur das Angenommene; Ausstehendes sperrt den Abschluss
 *  K   Koordinator: eine endgültige fachliche Abweisung löst den Abgleich im selben Lauf aus
 *  V   Bericht 19: Fenster bis zum gelungenen Abgleich — bewiesene Abwesenheit sofort, sonst vorläufig + Sperre
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStores } from '../../test/resetStores';
import * as supabaseLib from '../../lib/supabase';
import { addExpense, getExpenseById, updateExpense } from '../expenseService';
import { recordExpensePayment } from '../expensePaymentService';
import { calculateExpensePaymentSummary } from '../expensePaymentCalculations';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { createSupabaseSyncAdapter } from '../sync/supabaseSyncAdapter';
import { SyncCoordinator } from '../sync/syncCoordinator';
import { enqueueSyncOutbox, getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import {
  applyExpensePullToState,
  buildExpensePaymentEntityId,
  buildExpensePushPayload,
  collectDirtyExpenseKeys,
  collectRejectedExpenseEntries,
  collectUnreconciledExpenseRejections,
  type CloudExpensePaymentRow,
  type CloudExpenseRow,
  type ExpenseCloudPull,
} from './expenseCloudSyncService';
import { buildMonatsmappeModel, buildZahlungenCsv } from '../steuerberater/monatsmappeModelService';
import { buildAccountingPeriodState, collectUnconfirmedExpenseSources } from '../accounting/accountingPeriodService';
import { normalizeExpense } from '../expenseNormalize';
import { setExpenseStoreForTests } from '../expenseStore';
import type { AppPersistedState } from '../../types/models';
import type { Expense } from '../../types/expense';
import type { SyncAdapter } from '../sync/syncAdapter';
import type { SyncOutboxEntry } from '../../types/sync';

const WS = '00000000-0000-4000-8000-0000000000c3';
const SYNC = { version: 1, updatedAt: '2026-06-01T10:00:00.000Z', workspaceId: WS, deviceId: 'B', deleted: false };

function ausgabe(): Expense {
  const result = addExpense({
    title: 'R3 Ausgabe',
    category: 'material',
    supplierName: 'R3 Lieferant',
    invoiceNumber: `R3-${Math.random().toString(36).slice(2, 8)}`,
    issueDate: '2026-06-01',
    grossAmount: 119,
    netAmount: 100,
    taxAmount: 19,
    taxStatus: 'standard_19',
    status: 'gebucht',
  });
  if (!result.success) throw new Error(result.errorKey);
  return result.expense;
}

/** Der Server nach A: Beleg 100/19/119 Version 1, eine Zahlung A über 119. */
function serverStand(original: Expense, zahlungen: CloudExpensePaymentRow[] = [zahlungA(original.id)]): ExpenseCloudPull {
  const push = buildExpensePushPayload({ ...original, sync: SYNC }, false);
  const row: CloudExpenseRow = {
    client_expense_id: original.id,
    status: original.status,
    dedupe_key: String(push.dedupe_key),
    linked_inbox_id: null,
    archive_document_id: null,
    payload: push.payload as Record<string, unknown>,
    deleted: false,
    row_version: 1,
    updated_at: '2026-06-01T10:00:00.000Z',
  };
  return { expenses: [row], payments: zahlungen };
}

function zahlungA(expenseId: string, id = 'pay-A', reversed: string | null = null): CloudExpensePaymentRow {
  return {
    client_expense_id: expenseId,
    client_payment_id: id,
    amount: 119,
    paid_on: '2026-06-02',
    reference: null,
    note: null,
    method: 'bank',
    created_at: '2026-06-02T09:00:00.000Z',
    row_version: 1,
    reversed_at: reversed,
  };
}

function auftrag(entityType: 'expense' | 'expense_payment', entityId: string, operation: SyncOutboxEntry['operation']): SyncOutboxEntry {
  return { id: `ob-${entityType}-${operation}-${entityId}`, entityType, entityId, operation, version: 1, queuedAt: '2026-06-02T10:00:00.000Z', retryCount: 0, status: 'pending' };
}

function zustand(expense: Expense, outbox: SyncOutboxEntry[]): AppPersistedState {
  return {
    ...buildPersistedStateSnapshot(),
    expenses: [{ ...expense, sync: SYNC }],
    syncClient: { deviceId: 'B', workspaceId: WS, serverWorkspaceId: WS } as AppPersistedState['syncClient'],
    syncOutbox: outbox,
  };
}

/** Der echte Adapter gegen einen Server, der genau eine Meldung zurückgibt (fachliche Abweisung). */
async function pushMitAbweisung(state: AppPersistedState, meldung: string) {
  const rpc = vi.fn(async () => ({ data: null, error: { message: meldung, code: 'P0001' } }));
  const adapter = createSupabaseSyncAdapter({ rpc } as never);
  const result = await adapter.pushChanges({ state, outbox: state.syncOutbox ?? [], deviceId: 'B', workspaceId: WS });
  return { result, rpc };
}

function abgleich(state: AppPersistedState, pull: ExpenseCloudPull): AppPersistedState {
  return applyExpensePullToState(state, pull, {
    deviceId: 'B',
    workspaceId: WS,
    dirty: collectDirtyExpenseKeys(state.syncOutbox),
    now: '2026-06-03T08:00:00.000Z',
  }).state;
}

/** Wie die App: Der übernommene Zustand steht im Speicher, aus dem der Abschluss liest. */
function periodeWieApp(expenses: Expense[], outbox: SyncOutboxEntry[]) {
  setExpenseStoreForTests(expenses);
  return buildAccountingPeriodState(mappe(expenses), [], 'SKR03', [], outbox);
}

function mappe(expenses: Expense[]) {
  return buildMonatsmappeModel({ monthKey: '2026-06', invoices: [], expenses, documents: [], inboxItems: [], fileRefs: [] } as never);
}

beforeEach(() => {
  resetTestStores();
  resetSyncOutboxForTests([]);
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('W — WEISS END18-R3: abgewiesene Aktion verliert die lokale Wirkung (echter Adapter, Serverstand)', () => {
  it('W1 weitere Zahlung 119 ohne Bestätigung: abgewiesen → lokal nur A (119), B als Nachweis', async () => {
    const e = ausgabe();
    const original = getExpenseById(e.id)!;
    const b = recordExpensePayment(e.id, { amount: 119, date: '2026-06-02' });
    expect(b.success).toBe(true);
    const zahlungB = getExpenseById(e.id)!.payments![0];
    const state = zustand(getExpenseById(e.id)!, [auftrag('expense_payment', buildExpensePaymentEntityId(e.id, zahlungB.id), 'create')]);

    const { result } = await pushMitAbweisung(state, 'expense_payment_overpayment_unconfirmed: offen 0.00');
    expect(result.success).toBe(false);
    expect(result.state.syncOutbox![0]).toMatchObject({ status: 'failed', lastErrorRetryable: false });

    const nach = abgleich(result.state, serverStand(original));
    const x = nach.expenses!.find((item) => item.id === e.id)!;
    expect(x.payments!.map((p) => p.id)).toEqual(['pay-A']);
    expect(calculateExpensePaymentSummary(x)).toMatchObject({ paidAmount: 119, overpaidAmount: 0, openAmount: 0, status: 'bezahlt' });
    expect(x.rejectedPayments).toHaveLength(1);
    expect(x.rejectedPayments![0]).toMatchObject({ id: zahlungB.id, amount: 119, reason: 'expense_payment_overpayment_unconfirmed: offen 0.00' });
    // Export: genau eine Zahlung zu 119.
    const model = mappe(nach.expenses!);
    expect(model.zahlungenEingang.reduce((sum, z) => sum + z.betrag, 0)).toBe(119);
    expect(buildZahlungenCsv(model).trim().split('\n')).toHaveLength(2);
    // Der Fehlauftrag bleibt als Nachweis, wird aber nicht erneut gesendet.
    expect(nach.syncOutbox![0].status).toBe('failed');
  });

  it('W2 Betrag 119 → 238 trotz Zahlung: abgewiesen → Beleg wieder 100/19/119, Rest 0, Nachweis der Änderung', async () => {
    const e = ausgabe();
    const original = getExpenseById(e.id)!;
    expect(updateExpense(e.id, { grossAmount: 238, netAmount: 200, taxAmount: 38 }).success).toBe(true);
    const state = zustand(getExpenseById(e.id)!, [auftrag('expense', e.id, 'update')]);

    const { result } = await pushMitAbweisung(state, 'expense_amount_locked_after_payment: 1 aktive Zahlung(en)');
    expect(result.state.syncOutbox![0].status).toBe('failed');
    const x = abgleich(result.state, serverStand(original)).expenses!.find((item) => item.id === e.id)!;
    expect([x.netAmount, x.taxAmount, x.grossAmount]).toEqual([100, 19, 119]);
    expect(calculateExpensePaymentSummary(x)).toMatchObject({ paidAmount: 119, openAmount: 0 });
    expect(x.rejectedChanges).toEqual([
      expect.objectContaining({ kind: 'update', attempted: expect.objectContaining({ grossAmount: 238, netAmount: 200, taxAmount: 38 }) }),
    ]);
  });

  it('W3 Storno trotz Zahlung: abgewiesen → gebucht mit Zahlung A, kein Stornodatum, Nachweis „Storno zurückgenommen“', async () => {
    const e = ausgabe();
    const original = getExpenseById(e.id)!;
    expect(updateExpense(e.id, { status: 'storniert' }).success).toBe(true);
    expect(getExpenseById(e.id)!.status).toBe('storniert');
    const state = zustand(getExpenseById(e.id)!, [auftrag('expense', e.id, 'update')]);

    const { result } = await pushMitAbweisung(state, 'expense_cancel_has_payments: 1 aktive Zahlung(en)');
    const x = abgleich(result.state, serverStand(original)).expenses!.find((item) => item.id === e.id)!;
    expect(x.status).toBe('gebucht');
    expect(x.cancelledAt).toBeUndefined();
    expect(x.payments!.map((p) => p.id)).toEqual(['pay-A']);
    expect(x.rejectedChanges![0]).toMatchObject({ kind: 'cancel', attempted: { status: 'storniert' } });
  });
});

describe('P — Persistenz und Neustart', () => {
  it('P1 erneuter Abgleich und Laden (normalizeExpense) ändern nichts; kein doppelter Nachweis', async () => {
    const e = ausgabe();
    const original = getExpenseById(e.id)!;
    recordExpensePayment(e.id, { amount: 119, date: '2026-06-02' });
    const zahlungB = getExpenseById(e.id)!.payments![0];
    const state = zustand(getExpenseById(e.id)!, [auftrag('expense_payment', buildExpensePaymentEntityId(e.id, zahlungB.id), 'create')]);
    const { result } = await pushMitAbweisung(state, 'expense_payment_overpayment_unconfirmed: offen 0.00');
    const einmal = abgleich(result.state, serverStand(original));
    const gespeichert = JSON.parse(JSON.stringify(einmal)) as AppPersistedState;
    const geladen = { ...gespeichert, expenses: gespeichert.expenses!.map((item) => normalizeExpense(item)) };
    const zweimal = abgleich(geladen, serverStand(original));
    const x = zweimal.expenses!.find((item) => item.id === e.id)!;
    expect(x.payments!.map((p) => p.id)).toEqual(['pay-A']);
    expect(x.rejectedPayments).toHaveLength(1);
    expect(calculateExpensePaymentSummary(x).paidAmount).toBe(119);
  });
});

describe('G — Grenzen: nicht blind zurückbuchen', () => {
  it('G1 angenommene Zahlung mit verlorener Antwort (Server kennt sie): bleibt genau einmal, kein Nachweis', () => {
    const e = ausgabe();
    const original = getExpenseById(e.id)!;
    const b = recordExpensePayment(e.id, { amount: 50, date: '2026-06-02' });
    if (!b.success) throw new Error('b');
    const failed = { ...auftrag('expense_payment', buildExpensePaymentEntityId(e.id, b.payment.id), 'create'), status: 'failed' as const, lastErrorMessage: 'Ausgabe storniert', lastErrorRetryable: false };
    const server = serverStand(original, [{ ...zahlungA(e.id, b.payment.id), amount: 50 }]);
    const x = abgleich(zustand(getExpenseById(e.id)!, [failed]), server).expenses!.find((item) => item.id === e.id)!;
    expect(x.payments!.map((p) => p.id)).toEqual([b.payment.id]);
    expect(x.rejectedPayments ?? []).toEqual([]);
  });

  it('G2 Netzfehler: Auftrag bleibt wiederholbar, nichts wird zurückgenommen; der Monat ist vorläufig (Sperre)', () => {
    const e = ausgabe();
    const original = getExpenseById(e.id)!;
    const b = recordExpensePayment(e.id, { amount: 119, date: '2026-06-02' });
    if (!b.success) throw new Error('b');
    const netz = { ...auftrag('expense_payment', buildExpensePaymentEntityId(e.id, b.payment.id), 'create'), status: 'error' as const, lastErrorMessage: 'Failed to fetch', lastErrorRetryable: true };
    const nach = abgleich(zustand(getExpenseById(e.id)!, [netz]), serverStand(original));
    const x = nach.expenses!.find((item) => item.id === e.id)!;
    expect(x.payments!.map((p) => p.id).sort()).toEqual([b.payment.id, 'pay-A'].sort());
    expect(collectRejectedExpenseEntries([netz]).size).toBe(0);
    const state = periodeWieApp(nach.expenses!, [netz]);
    expect(collectUnconfirmedExpenseSources(state.currentManifest, [netz], nach.expenses!)).toEqual([e.id]);
    expect(state.blockers.map((item) => item.code)).toContain('unconfirmed_financial_changes');
  });

  it('G3 abgewiesene Rücknahme: die Zahlung lebt beim Server weiter und steht wieder da; Nachweis „payment_reverse“', () => {
    const e = ausgabe();
    const original = getExpenseById(e.id)!;
    const lokal = { ...getExpenseById(e.id)!, payments: [] };
    const failed = { ...auftrag('expense_payment', buildExpensePaymentEntityId(e.id, 'pay-A'), 'delete'), status: 'failed' as const, lastErrorMessage: 'finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht', lastErrorRetryable: false };
    const x = abgleich(zustand(lokal, [failed]), serverStand(original)).expenses!.find((item) => item.id === e.id)!;
    expect(x.payments!.map((p) => p.id)).toEqual(['pay-A']);
    expect(x.rejectedChanges![0]).toMatchObject({ kind: 'payment_reverse', paymentId: 'pay-A' });
  });

  it('G4 abgewiesenes Löschen: der Beleg kommt mit dem Serverstand zurück; Nachweis „delete“', () => {
    const e = ausgabe();
    const original = getExpenseById(e.id)!;
    const grabstein = { ...getExpenseById(e.id)!, sync: { ...SYNC, deleted: true } };
    const failed = { ...auftrag('expense', e.id, 'delete'), status: 'failed' as const, lastErrorMessage: 'Ausgabe hat gebuchte Zahlungen', lastErrorRetryable: false };
    const state = { ...zustand(grabstein, [failed]), expenses: [grabstein] };
    const x = abgleich(state, serverStand(original)).expenses!.find((item) => item.id === e.id)!;
    expect(x.sync?.deleted).toBe(false);
    expect(x.rejectedChanges![0]).toMatchObject({ kind: 'delete' });
  });

  it('G5 abgewiesene Neuanlage ohne Serverzeile: bleibt lokal mit Nachweis und sperrt den Monat', () => {
    const e = ausgabe();
    const lokal = { ...getExpenseById(e.id)!, sync: undefined };
    const failed = { ...auftrag('expense', e.id, 'create'), status: 'failed' as const, lastErrorMessage: 'finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht', lastErrorRetryable: false };
    const state = { ...zustand(lokal, [failed]), expenses: [lokal] };
    const nach = abgleich(state, { expenses: [], payments: [] });
    const x = nach.expenses!.find((item) => item.id === e.id)!;
    expect(x.rejectedChanges![0]).toMatchObject({ kind: 'create' });
    const periode = periodeWieApp(nach.expenses!, [failed]);
    expect(collectUnconfirmedExpenseSources(periode.currentManifest, [failed], nach.expenses!)).toEqual([e.id]);
  });

  it('G6 eine neue bewusste Änderung löst die Abweisung ab: kein Rücksetzen, sie wird gesendet', () => {
    const e = ausgabe();
    resetSyncOutboxForTests([{ ...auftrag('expense', e.id, 'update'), status: 'failed', lastErrorMessage: 'expense_amount_locked_after_payment: 1 aktive Zahlung(en)', lastErrorRetryable: false }]);
    enqueueSyncOutbox({ entityType: 'expense', entityId: e.id, operation: 'update', version: 1 });
    const outbox = getSyncOutboxSnapshot();
    expect(collectRejectedExpenseEntries(outbox).size).toBe(0);
    expect(collectDirtyExpenseKeys(outbox).has(`expense:${e.id}`)).toBe(true);
  });
});

describe('M — Abschluss zählt nur Angenommenes', () => {
  it('M1 nach der Abweisung bindet der Abschluss genau die angenommene Zahlung (Fassung 4)', async () => {
    const e = ausgabe();
    const original = getExpenseById(e.id)!;
    recordExpensePayment(e.id, { amount: 119, date: '2026-06-02' });
    const zahlungB = getExpenseById(e.id)!.payments![0];
    const state = zustand(getExpenseById(e.id)!, [auftrag('expense_payment', buildExpensePaymentEntityId(e.id, zahlungB.id), 'create')]);
    const { result } = await pushMitAbweisung(state, 'expense_payment_overpayment_unconfirmed: offen 0.00');
    const nach = abgleich(result.state, serverStand(original));
    const periode = periodeWieApp(nach.expenses!, nach.syncOutbox ?? []);
    const zahlungen = (periode.currentManifest.payments ?? []).filter((p) => p.sourceType === 'expense');
    expect(zahlungen.map((p) => p.paymentId)).toEqual(['pay-A']);
    // Der endgültig abgewiesene Auftrag ist Nachweis, keine Sperre.
    expect(periode.blockers.map((item) => item.code)).not.toContain('unconfirmed_financial_changes');
  });
});

describe('K — Koordinator: Abgleich im selben Lauf', () => {
  function stub(meldung: string, retryable: boolean): SyncAdapter {
    const leer = { startedAt: '', finishedAt: '', durationMs: 0, pushCount: 0, pullCount: 0, mergedEntityCount: 0, conflictCount: 0, errorCount: 0, completedOutboxCount: 0, syncedEntities: [], conflicts: [], errors: [] };
    return {
      providerKind: 'local',
      pushChanges: vi.fn(async (input) => ({ success: false, state: input.state, completedOutboxIds: [], failedOutbox: [{ outboxId: 'ob-1', message: meldung, retryable }], report: leer })),
      pullChanges: vi.fn(async (input) => ({ success: true, state: input.state, report: leer })),
      acknowledgeChanges: vi.fn(async () => undefined),
      reserveInvoiceNumber: vi.fn(),
      uploadBlob: vi.fn(),
      downloadBlob: vi.fn(),
      getSyncStatus: vi.fn(() => ({ syncState: 'idle', pendingChanges: 1 })),
    } as unknown as SyncAdapter;
  }
  const state = () =>
    ({
      ...buildPersistedStateSnapshot(),
      syncClient: { deviceId: 'B', workspaceId: WS, syncPolicy: 'supabase' },
      syncOutbox: [{ ...auftrag('expense', 'x', 'update') }],
    }) as unknown as AppPersistedState;

  it('K1 vollständiger Lauf: nach endgültiger fachlicher Abweisung folgt der Abgleich', async () => {
    const adapter = stub('expense_amount_locked_after_payment: 1 aktive Zahlung(en)', false);
    await new SyncCoordinator(adapter).runSync(state());
    expect(adapter.pullChanges).toHaveBeenCalledTimes(1);
  });

  it('K2 reines Senden: endgültige fachliche Abweisung verlangt den vollständigen Abgleich', async () => {
    const result = await new SyncCoordinator(stub('expense_payment_overpayment_unconfirmed: offen 0.00', false)).runPushOnly(state());
    expect(result.needsFullSync).toBe(true);
  });

  it('K3 Netzfehler: kein Abgleich erzwungen (wie bisher, der Auftrag wird wiederholt)', async () => {
    const adapter = stub('Failed to fetch', true);
    await new SyncCoordinator(adapter).runSync(state());
    expect(adapter.pullChanges).not.toHaveBeenCalled();
    const result = await new SyncCoordinator(stub('Failed to fetch', true)).runPushOnly(state());
    expect(result.needsFullSync).toBe(false);
  });
});

describe('V — Bericht 19: das Fenster zwischen Abweisung und gelungenem Abgleich (echte App, Abzug gescheitert)', () => {
  function sperrtAbschluss(state: AppPersistedState): boolean {
    const periode = periodeWieApp(state.expenses!, state.syncOutbox ?? []);
    return periode.blockers.some((item) => item.code === 'unconfirmed_financial_changes');
  }

  it('V1 bewiesene Abwesenheit (Überzahlung ohne Bestätigung): schon das Senden nimmt die Zahlung heraus — ohne Abzug', async () => {
    const e = ausgabe();
    const b = recordExpensePayment(e.id, { amount: 119, date: '2026-06-02' });
    if (!b.success) throw new Error('b');
    const state = zustand(getExpenseById(e.id)!, [auftrag('expense_payment', buildExpensePaymentEntityId(e.id, b.payment.id), 'create')]);
    const { result } = await pushMitAbweisung(state, 'expense_payment_overpayment_unconfirmed: offen 0.00');
    // Kein Abgleich: genau der Zustand, den das Gerät hält, wenn der Abzug danach scheitert.
    const x = result.state.expenses!.find((item) => item.id === e.id)!;
    expect(x.payments ?? []).toEqual([]);
    expect(x.rejectedPayments).toEqual([expect.objectContaining({ id: b.payment.id, amount: 119, reason: 'expense_payment_overpayment_unconfirmed: offen 0.00' })]);
    expect(mappe(result.state.expenses!).zahlungenEingang).toEqual([]);
    expect(collectUnreconciledExpenseRejections(x, result.state.syncOutbox)).toEqual([]);
    // Der spätere Abgleich ändert daran nichts (kein doppelter Nachweis).
    const nach = abgleich(result.state, serverStand(getExpenseById(e.id)!, [])).expenses!.find((item) => item.id === e.id)!;
    expect(nach.rejectedPayments).toHaveLength(1);
    expect(nach.payments ?? []).toEqual([]);
  });

  it('V2 nicht beweisende fachliche Abweisung (Ausgabe storniert): bis zum Abgleich vorläufig, Abschluss gesperrt; danach zurückgenommen', async () => {
    const e = ausgabe();
    const original = getExpenseById(e.id)!;
    const b = recordExpensePayment(e.id, { amount: 50, date: '2026-06-02' });
    if (!b.success) throw new Error('b');
    const state = zustand(getExpenseById(e.id)!, [auftrag('expense_payment', buildExpensePaymentEntityId(e.id, b.payment.id), 'create')]);
    const { result } = await pushMitAbweisung(state, 'Ausgabe storniert');
    const vorher = result.state.expenses!.find((item) => item.id === e.id)!;
    expect(vorher.payments!.map((p) => p.id)).toEqual([b.payment.id]);
    expect(collectUnreconciledExpenseRejections(vorher, result.state.syncOutbox)).toEqual([
      expect.objectContaining({ kind: 'payment', reason: 'Ausgabe storniert' }),
    ]);
    expect(sperrtAbschluss(result.state)).toBe(true);
    const nach = abgleich(result.state, serverStand({ ...original, status: 'storniert' }, []));
    const x = nach.expenses!.find((item) => item.id === e.id)!;
    expect(x.payments ?? []).toEqual([]);
    expect(collectUnreconciledExpenseRejections(x, nach.syncOutbox)).toEqual([]);
  });

  it('V3 abgewiesene Belegänderung (Betrag nach Zahlung): bis zum Abgleich vorläufig und gesperrt; danach Serverstand und Nachweis', async () => {
    const e = ausgabe();
    const original = getExpenseById(e.id)!;
    expect(updateExpense(e.id, { grossAmount: 238, netAmount: 200, taxAmount: 38 }).success).toBe(true);
    const state = zustand(getExpenseById(e.id)!, [auftrag('expense', e.id, 'update')]);
    const { result } = await pushMitAbweisung(state, 'expense_amount_locked_after_payment: 1 aktive Zahlung(en)');
    const vorher = result.state.expenses!.find((item) => item.id === e.id)!;
    expect(vorher.grossAmount).toBe(238);
    expect(collectUnreconciledExpenseRejections(vorher, result.state.syncOutbox)).toEqual([expect.objectContaining({ kind: 'change' })]);
    expect(sperrtAbschluss(result.state)).toBe(true);
    const nach = abgleich(result.state, serverStand(original));
    const x = nach.expenses!.find((item) => item.id === e.id)!;
    expect(x.grossAmount).toBe(119);
    expect(collectUnreconciledExpenseRejections(x, nach.syncOutbox)).toEqual([]);
    expect(sperrtAbschluss(nach)).toBe(false);
  });

  it('V6 Sicherheitsnetz: beim Senden herausgenommen, der Abzug zeigt sie aber beim Server → genau einmal gebucht, kein falscher Nachweis', async () => {
    const e = ausgabe();
    const original = getExpenseById(e.id)!;
    const b = recordExpensePayment(e.id, { amount: 119, date: '2026-06-02' });
    if (!b.success) throw new Error('b');
    const state = zustand(getExpenseById(e.id)!, [auftrag('expense_payment', buildExpensePaymentEntityId(e.id, b.payment.id), 'create')]);
    const { result } = await pushMitAbweisung(state, 'expense_payment_overpayment_unconfirmed: offen 0.00');
    expect(result.state.expenses!.find((item) => item.id === e.id)!.rejectedPayments).toHaveLength(1);
    const nach = abgleich(result.state, serverStand(original, [{ ...zahlungA(e.id, b.payment.id) }]));
    const x = nach.expenses!.find((item) => item.id === e.id)!;
    expect(x.payments!.map((p) => p.id)).toEqual([b.payment.id]);
    expect(x.rejectedPayments ?? []).toEqual([]);
  });

  it('V5 Bearbeiten des Belegs (echte App: Betrag ändern) erhält die Nachweise abgewiesener Aktionen', () => {
    const e = ausgabe();
    const nachweis = {
      id: 'pay-B', date: '2026-06-02', amount: 119, createdAt: '2026-06-02T10:00:00.000Z',
      rejectedAt: '2026-06-02T10:00:05.000Z', reason: 'expense_payment_overpayment_unconfirmed: offen 0.00', outboxId: 'ob-1',
    };
    const aenderung = { outboxId: 'ob-2', kind: 'update' as const, reason: 'expense_amount_locked_after_payment', rejectedAt: '2026-06-02T10:01:00.000Z' };
    setExpenseStoreForTests([{ ...getExpenseById(e.id)!, rejectedPayments: [nachweis], rejectedChanges: [aenderung] }]);
    expect(updateExpense(e.id, { title: 'R3 Ausgabe (bearbeitet)' }).success).toBe(true);
    const x = getExpenseById(e.id)!;
    expect(x.title).toBe('R3 Ausgabe (bearbeitet)');
    expect(x.rejectedPayments).toEqual([nachweis]);
    expect(x.rejectedChanges).toEqual([aenderung]);
  });

  it('V4 Rechteabweisung eines Nachweis-Schritts einer angenommenen Zahlung: nichts wird beim Senden herausgenommen', async () => {
    const e = ausgabe();
    const original = getExpenseById(e.id)!;
    const b = recordExpensePayment(e.id, { amount: 119, date: '2026-06-02' });
    if (!b.success) throw new Error('b');
    const state = zustand(getExpenseById(e.id)!, [auftrag('expense_payment', buildExpensePaymentEntityId(e.id, b.payment.id), 'create')]);
    const { result } = await pushMitAbweisung(state, 'finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht');
    const x = result.state.expenses!.find((item) => item.id === e.id)!;
    expect(x.payments!.map((p) => p.id)).toEqual([b.payment.id]);
    expect(x.rejectedPayments ?? []).toEqual([]);
    // Kennt der Server sie, bleibt sie nach dem Abgleich genau einmal (Rechteweg, keine Sperre aus dieser Regel).
    const nach = abgleich(result.state, serverStand(original, [{ ...zahlungA(e.id, b.payment.id) }]));
    const y = nach.expenses!.find((item) => item.id === e.id)!;
    expect(y.payments!.map((p) => p.id)).toEqual([b.payment.id]);
    expect(collectUnreconciledExpenseRejections(y, nach.syncOutbox)).toEqual([]);
  });
});
