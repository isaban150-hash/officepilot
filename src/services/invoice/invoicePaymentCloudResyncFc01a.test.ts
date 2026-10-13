/**
 * FINANZ-CORE-01A (ZAH-02) — nie gesicherte Rechnungszahlungen werden
 * automatisch nachgesichert.
 *
 *  R1  gesendet wird nur, was die Cloud gar nicht kennt — Grabsteine zählen als bekannt;
 *      stornierte Rechnungen und Entwürfe bleiben aussen vor
 *  R2  eine Rollenablehnung beendet den Lauf und alle weiteren dieser Sitzung
 *  R3  zehn Minuten Abstand; ein gescheiterter Versand kommt nach dem Abstand wieder, ein Konflikt nicht
 *  R4  ohne erfolgreichen Abzug wird nichts gesendet
 *  R5  scheitert ein Versand in der Oberfläche, wiederholt der nächste Lauf sofort — auch Fehlschläge davor
 *  R6  Auslöser: Planerstart nach dem Bootstrap und erfolgreiche Läufe — nie während oder nach einem Fehlschlag
 *  N01 (WEISS-Nacharbeit) endgültige Abweisungen bleiben über einen Neustart vermerkt (je Betrieb);
 *      Netzfehler bleiben flüchtig; entsperrt nur eine bewusste Handlung
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvoicePayment, VorgangInvoice } from '../../types/models';
import {
  getInvoicePaymentResyncBlocks,
  isFinalInvoicePaymentResyncOutcome,
  markInvoicePaymentResyncNeeded,
  recordInvoicePaymentResyncBlock,
  resetInvoicePaymentResyncForTests,
  resyncLocalOnlyInvoicePayments,
  shouldResyncAfterSyncStatus,
  subscribeInvoicePaymentResyncBlocks,
} from './invoicePaymentCloudResyncService';
import { setActiveStorageScope } from '../storage/storageScopeService';
import type { InvoicePaymentCloudOutcome, WorkspaceInvoicePaymentRow } from './workspaceInvoicePaymentCloudService';

function payment(id: string, amount = 100): InvoicePayment {
  return { id, amount, date: '2026-10-01', createdAt: '2026-10-01T09:00:00.000Z' } as InvoicePayment;
}

function invoice(id: string, payments: InvoicePayment[], overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id,
    number: `RE-${id}`,
    type: 'rechnung',
    positions: [],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'versendet',
    date: '2026-09-01',
    createdAt: '2026-09-01T08:00:00.000Z',
    payments,
    ...overrides,
  } as VorgangInvoice;
}

function row(invoiceId: string, paymentId: string, reversed = false): WorkspaceInvoicePaymentRow {
  return {
    workspaceId: 'ws',
    clientInvoiceId: invoiceId,
    clientPaymentId: paymentId,
    amount: 100,
    paidOn: '2026-10-01',
    createdAt: '2026-10-01T09:00:00.000Z',
    ...(reversed ? { reversedAt: '2026-10-02T09:00:00.000Z' } : {}),
  } as WorkspaceInvoicePaymentRow;
}

const synced = (rows: WorkspaceInvoicePaymentRow[]) => async () => ({ outcome: 'synced' as const, rows });
const MIN = 60_000;

beforeEach(() => resetInvoicePaymentResyncForTests());
afterEach(() => resetInvoicePaymentResyncForTests());

describe('ZAH-02 — automatische Nachsicherung', () => {
  it('R1: nur Unbekanntes wird gesendet; Grabsteine, Stornos und Entwürfe nicht', async () => {
    const push = vi.fn(async (): Promise<InvoicePaymentCloudOutcome> => 'synced');
    const report = await resyncLocalOnlyInvoicePayments({
      now: () => 1_000,
      listInvoices: () => [
        invoice('inv-a', [payment('pay-bekannt'), payment('pay-neu'), payment('pay-grabstein')]),
        invoice('inv-storno', [payment('pay-storno')], { cancelledAt: '2026-10-05T10:00:00.000Z', paymentStatus: 'storniert' }),
        invoice('inv-entwurf', [payment('pay-entwurf')], { status: 'entwurf' }),
      ],
      pull: synced([row('inv-a', 'pay-bekannt'), row('inv-a', 'pay-grabstein', true)]),
      push,
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('inv-a', expect.objectContaining({ id: 'pay-neu' }));
    expect(report).toEqual({ candidates: 1, synced: 1, failed: 0, denied: false });
  });

  it('R2: eine Rollenablehnung beendet den Lauf und ruht für die Sitzung', async () => {
    const push = vi.fn(async (): Promise<InvoicePaymentCloudOutcome> => 'denied');
    const deps = {
      now: () => 1_000,
      listInvoices: () => [invoice('inv-a', [payment('pay-1'), payment('pay-2')])],
      pull: synced([]),
      push,
    };
    const first = await resyncLocalOnlyInvoicePayments(deps);
    expect(first.denied).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    const second = await resyncLocalOnlyInvoicePayments({ ...deps, now: () => 10_000_000 }, { force: true });
    expect(second.skipped).toBe('denied_earlier');
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('R3: Abstand zwischen Läufen; Fehlschlag kommt nach dem Abstand wieder, ein Konflikt nicht', async () => {
    const outcomes: Record<string, InvoicePaymentCloudOutcome> = { 'pay-netz': 'failed', 'pay-konflikt': 'conflict' };
    const push = vi.fn(async (_invoiceId: string, p: InvoicePayment): Promise<InvoicePaymentCloudOutcome> => outcomes[p.id]);
    const deps = {
      listInvoices: () => [invoice('inv-a', [payment('pay-netz'), payment('pay-konflikt')])],
      pull: synced([]),
      push,
    };

    expect((await resyncLocalOnlyInvoicePayments({ ...deps, now: () => 0 })).failed).toBe(2);
    expect((await resyncLocalOnlyInvoicePayments({ ...deps, now: () => 1 * MIN })).skipped).toBe('throttled');

    outcomes['pay-netz'] = 'synced';
    const later = await resyncLocalOnlyInvoicePayments({ ...deps, now: () => 11 * MIN });
    // WEISS-N01 — der Konflikt ist dauerhaft vermerkt und wird übergangen, nicht gesendet.
    expect(later).toEqual({ candidates: 1, synced: 1, failed: 0, denied: false, blocked: 1 });
    expect(push.mock.calls.filter(([, p]) => p.id === 'pay-konflikt')).toHaveLength(1);
  });

  it('R4: ohne erfolgreichen Abzug wird nichts gesendet', async () => {
    const push = vi.fn(async (): Promise<InvoicePaymentCloudOutcome> => 'synced');
    const report = await resyncLocalOnlyInvoicePayments({
      now: () => 0,
      listInvoices: () => [invoice('inv-a', [payment('pay-1')])],
      pull: async () => ({ outcome: 'failed' as const, detail: 'offline' }),
      push,
    });
    expect(report.skipped).toBe('pull_failed');
    expect(push).not.toHaveBeenCalled();
  });

  it('R5: ein in der Oberfläche gescheiterter Versand hebt Abstand und Wartezeit auf', async () => {
    let outcome: InvoicePaymentCloudOutcome = 'failed';
    const push = vi.fn(async (): Promise<InvoicePaymentCloudOutcome> => outcome);
    const deps = { listInvoices: () => [invoice('inv-a', [payment('pay-1')])], pull: synced([]), push };

    expect((await resyncLocalOnlyInvoicePayments({ ...deps, now: () => 0 })).failed).toBe(1);
    markInvoicePaymentResyncNeeded();
    outcome = 'synced';
    const sofort = await resyncLocalOnlyInvoicePayments({ ...deps, now: () => 1 * MIN });
    expect(sofort).toEqual({ candidates: 1, synced: 1, failed: 0, denied: false });
  });

  it('R6: Planerstart und erfolgreiche Läufe lösen aus, laufende und gescheiterte nicht', () => {
    expect(shouldResyncAfterSyncStatus(null)).toBe(false);
    expect(shouldResyncAfterSyncStatus({ running: false, lastOutcome: null })).toBe(true);
    expect(shouldResyncAfterSyncStatus({ running: false, lastOutcome: 'ok' })).toBe(true);
    expect(shouldResyncAfterSyncStatus({ running: true, lastOutcome: 'ok' })).toBe(false);
    expect(shouldResyncAfterSyncStatus({ running: false, lastOutcome: 'retryable' })).toBe(false);
    expect(shouldResyncAfterSyncStatus({ running: false, lastOutcome: 'stop' })).toBe(false);
  });
});

/*
 * FINANZ-CORE-01A (WEISS-Nacharbeit N01) — eine endgültige Abweisung bleibt dauerhaft, bis
 * jemand bewusst neu handelt. WEISS: „frisches Modul nach Entsperrung überträgt dieselbe alte
 * Zahlung erneut". Ein Neustart ist hier genau das: ein frisch geladenes Modul — der
 * Arbeitsspeicher ist leer, der Gerätespeicher (localStorage) bleibt.
 */
describe('WEISS-N01 — endgültige Abweisung über einen Neustart', () => {
  async function neustart() {
    vi.resetModules();
    return import('./invoicePaymentCloudResyncService');
  }

  it('N01a: Rollenabweisung — nach Neustart und Rechtewechsel geht keine der damals offenen Zahlungen still hinaus', async () => {
    const deps = {
      now: () => 1_000,
      listInvoices: () => [invoice('inv-a', [payment('pay-1'), payment('pay-2')])],
      pull: synced([]),
    };
    const abgewiesen = vi.fn(async (): Promise<InvoicePaymentCloudOutcome> => 'denied');
    expect((await resyncLocalOnlyInvoicePayments({ ...deps, push: abgewiesen })).denied).toBe(true);
    expect(abgewiesen).toHaveBeenCalledTimes(1);

    const frisch = await neustart();
    // Der Server nähme jetzt an (Rechtewechsel) — trotzdem kein Versand ohne bewusste Handlung.
    const angenommen = vi.fn(async (): Promise<InvoicePaymentCloudOutcome> => 'synced');
    const report = await frisch.resyncLocalOnlyInvoicePayments({ ...deps, now: () => 50 * MIN, push: angenommen }, { force: true });
    expect(angenommen).not.toHaveBeenCalled();
    expect(report).toMatchObject({ candidates: 0, synced: 0, blocked: 2 });
    expect(frisch.getInvoicePaymentResyncBlocks('inv-a')).toEqual({ 'pay-1': 'denied', 'pay-2': 'denied' });
  });

  it('N01b: eine danach bewusst erfasste Zahlung geht normal hinaus', async () => {
    const abgewiesen = vi.fn(async (): Promise<InvoicePaymentCloudOutcome> => 'denied');
    await resyncLocalOnlyInvoicePayments({
      now: () => 1_000,
      listInvoices: () => [invoice('inv-a', [payment('pay-1')])],
      pull: synced([]),
      push: abgewiesen,
    });

    const frisch = await neustart();
    const angenommen = vi.fn(async (): Promise<InvoicePaymentCloudOutcome> => 'synced');
    const report = await frisch.resyncLocalOnlyInvoicePayments({
      now: () => 50 * MIN,
      listInvoices: () => [invoice('inv-a', [payment('pay-1'), payment('pay-neu')])],
      pull: synced([]),
      push: angenommen,
    });
    expect(angenommen).toHaveBeenCalledTimes(1);
    expect(angenommen).toHaveBeenCalledWith('inv-a', expect.objectContaining({ id: 'pay-neu' }));
    expect(report).toMatchObject({ candidates: 1, synced: 1, blocked: 1 });
  });

  it('N01c: Konflikt, unbestätigte Überzahlung und stornierte Rechnung bleiben über den Neustart vermerkt', async () => {
    const ausgang: Record<string, InvoicePaymentCloudOutcome> = {
      'pay-k': 'conflict',
      'pay-u': 'overpayment_unconfirmed',
      'pay-s': 'invoice_cancelled',
    };
    const deps = {
      listInvoices: () => [invoice('inv-a', [payment('pay-k'), payment('pay-u'), payment('pay-s')])],
      pull: synced([]),
    };
    await resyncLocalOnlyInvoicePayments({ ...deps, now: () => 0, push: async (_i, p) => ausgang[p.id]! });

    const frisch = await neustart();
    const push = vi.fn(async (): Promise<InvoicePaymentCloudOutcome> => 'synced');
    const report = await frisch.resyncLocalOnlyInvoicePayments({ ...deps, now: () => 60 * MIN, push }, { force: true });
    expect(push).not.toHaveBeenCalled();
    expect(report.blocked).toBe(3);
    expect(frisch.getInvoicePaymentResyncBlocks('inv-a')).toEqual({
      'pay-k': 'conflict',
      'pay-u': 'overpayment_unconfirmed',
      'pay-s': 'invoice_cancelled',
    });
  });

  it('N01d: ein Netzfehler bleibt flüchtig — nach dem Neustart wird sofort wiederholt', async () => {
    const deps = { listInvoices: () => [invoice('inv-a', [payment('pay-netz')])], pull: synced([]) };
    expect((await resyncLocalOnlyInvoicePayments({ ...deps, now: () => 0, push: async () => 'failed' })).failed).toBe(1);

    const frisch = await neustart();
    const push = vi.fn(async (): Promise<InvoicePaymentCloudOutcome> => 'synced');
    const report = await frisch.resyncLocalOnlyInvoicePayments({ ...deps, now: () => 1 * MIN, push });
    expect(push).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ candidates: 1, synced: 1, failed: 0, denied: false });
    expect(frisch.getInvoicePaymentResyncBlocks('inv-a')).toEqual({});
  });

  it('N01e: entsperrt wird nur durch eine bewusste Handlung — und nur diese eine Zahlung', async () => {
    const deps = {
      listInvoices: () => [invoice('inv-a', [payment('pay-1'), payment('pay-2')])],
      pull: synced([]),
    };
    await resyncLocalOnlyInvoicePayments({ ...deps, now: () => 0, push: async () => 'denied' });

    const frisch = await neustart();
    frisch.releaseInvoicePaymentResyncConflict('inv-a', 'pay-1');
    const push = vi.fn(async (): Promise<InvoicePaymentCloudOutcome> => 'synced');
    const report = await frisch.resyncLocalOnlyInvoicePayments({ ...deps, now: () => 60 * MIN, push });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('inv-a', expect.objectContaining({ id: 'pay-1' }));
    expect(report).toMatchObject({ synced: 1, blocked: 1 });
    expect(frisch.getInvoicePaymentResyncBlocks('inv-a')).toEqual({ 'pay-2': 'denied' });
  });

  it('N01f: Vermerke aus der Oberfläche wirken genauso; kennt die Cloud die Zahlung, fällt der Vermerk', async () => {
    recordInvoicePaymentResyncBlock('inv-a', 'pay-ui', 'conflict');
    const frisch = await neustart();
    const push = vi.fn(async (): Promise<InvoicePaymentCloudOutcome> => 'synced');
    const deps = { listInvoices: () => [invoice('inv-a', [payment('pay-ui')])], push };
    expect((await frisch.resyncLocalOnlyInvoicePayments({ ...deps, now: () => 0, pull: synced([]) })).blocked).toBe(1);
    expect(push).not.toHaveBeenCalled();
    // Ein anderes Gerät hat sie gesichert: der alte Vermerk ist erledigt.
    await frisch.resyncLocalOnlyInvoicePayments({ ...deps, now: () => 20 * MIN, pull: synced([row('inv-a', 'pay-ui')]) });
    expect(frisch.getInvoicePaymentResyncBlocks('inv-a')).toEqual({});
    expect(push).not.toHaveBeenCalled();
  });

  it('N01g: Vermerke gelten je Betrieb (Speicherbereich)', async () => {
    try {
      setActiveStorageScope({ type: 'workspace', workspaceId: 'ws-a' });
      recordInvoicePaymentResyncBlock('inv-a', 'pay-1', 'denied');
      expect(getInvoicePaymentResyncBlocks('inv-a')).toEqual({ 'pay-1': 'denied' });
      setActiveStorageScope({ type: 'workspace', workspaceId: 'ws-b' });
      expect(getInvoicePaymentResyncBlocks('inv-a')).toEqual({});
      setActiveStorageScope({ type: 'workspace', workspaceId: 'ws-a' });
      expect(getInvoicePaymentResyncBlocks('inv-a')).toEqual({ 'pay-1': 'denied' });
      resetInvoicePaymentResyncForTests();
    } finally {
      setActiveStorageScope({ type: 'guest' });
    }
  });

  it('N01i: wer die Vermerke anzeigt, erfährt sofort von einer Abweisung des Hintergrundlaufs', async () => {
    const signal = vi.fn();
    const abmelden = subscribeInvoicePaymentResyncBlocks(signal);
    await resyncLocalOnlyInvoicePayments({
      now: () => 0,
      listInvoices: () => [invoice('inv-a', [payment('pay-u')])],
      pull: synced([]),
      push: async () => 'overpayment_unconfirmed',
    });
    expect(signal).toHaveBeenCalled();
    expect(getInvoicePaymentResyncBlocks('inv-a')).toEqual({ 'pay-u': 'overpayment_unconfirmed' });
    signal.mockClear();
    abmelden();
    recordInvoicePaymentResyncBlock('inv-a', 'pay-x', 'conflict');
    expect(signal).not.toHaveBeenCalled();
  });

  it('N01h: endgültig sind genau Rolle, Konflikt, Überzahlung und Storno — Netz und fehlende Konfiguration nicht', () => {
    for (const outcome of ['denied', 'conflict', 'overpayment_unconfirmed', 'invoice_cancelled'] as const) {
      expect(isFinalInvoicePaymentResyncOutcome(outcome)).toBe(true);
    }
    for (const outcome of ['failed', 'supabase_not_configured', 'workspace_missing', 'synced'] as const) {
      expect(isFinalInvoicePaymentResyncOutcome(outcome)).toBe(false);
    }
  });
});
