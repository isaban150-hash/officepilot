/**
 * OFFICEPILOT-V1-A — Ausgabe stornieren und sicher bearbeiten.
 *
 *  A  Storno mit Grund; B bleibt historisch erhalten; C zweites Storno verhindert
 *  D  Monatsmappe: Original bleibt gekennzeichnet, Storno-Beleg im Stornomonat, Summen
 *  E  stornierte Ausgabe ist nicht mehr offen
 *  F  bezahlte Ausgabe: Storno erst nach Rücknahme der Zahlung, Zahlung nie still verändert
 *  G  Bearbeiten vor Zahlung: Kategorie, Beschreibung, Betrag, Datum
 *  H  Bearbeiten nach Zahlung: Beträge fest, Rest änderbar; storniert = nicht bearbeitbar
 *  I  Cloud: Push-Payload trägt den Stornozustand, Pull auf Gerät 2 stellt ihn her
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addExpense,
  cancelExpense,
  getExpenseById,
  updateExpense,
} from './services/expenseService';
import { recordExpensePayment, removeExpensePayment } from './services/expensePaymentService';
import { getAllExpenseOverview } from './services/expenseOverviewService';
import { hydrateExpenseStore } from './services/expenseStore';
import { buildExpensePushPayload, mapCloudExpenseRow } from './services/expense/expenseCloudSyncService';
import { buildMonatsmappeModel, type MonatsmappeInput } from './services/steuerberater/monatsmappeModelService';
import type { Expense } from './types/expense';

function input(overrides: Partial<Parameters<typeof addExpense>[0]> = {}) {
  return {
    title: 'Dachlatten',
    category: 'material' as const,
    supplierName: 'Baustoff Nord GmbH',
    invoiceNumber: 'RE-4711',
    issueDate: '2026-09-01',
    grossAmount: 119,
    netAmount: 100,
    taxAmount: 19,
    ...overrides,
  };
}

function booked(): Expense {
  const created = addExpense(input());
  if (!created.success) throw new Error(created.errorKey);
  return created.expense;
}

function monatsmappe(monthKey: string, expenses: Expense[]) {
  const mi: MonatsmappeInput = { monthKey, invoices: [], expenses, documents: [], inboxItems: [], fileRefs: [] };
  return buildMonatsmappeModel(mi);
}

beforeEach(() => {
  localStorage.clear();
  hydrateExpenseStore([]);
});

describe('V1-A — Storno', () => {
  it('A/B: Storno mit Grund; Beleg bleibt mit allen Daten erhalten', () => {
    const exp = booked();
    const result = cancelExpense(exp.id, '  Beleg doppelt erfasst ');
    expect(result.success).toBe(true);
    const after = getExpenseById(exp.id)!;
    expect(after.status).toBe('storniert');
    expect(after.paymentStatus).toBe('storniert');
    expect(after.cancelReason).toBe('Beleg doppelt erfasst');
    expect(after.cancelledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(after.grossAmount).toBe(119);
    expect(after.supplierName).toBe('Baustoff Nord GmbH');
    expect(after.sync?.deleted).toBeFalsy();
  });

  it('A: ohne Grund kein Storno', () => {
    const exp = booked();
    expect(cancelExpense(exp.id, '   ')).toEqual({ success: false, errorKey: 'expense.cancel.reasonRequired' });
    expect(getExpenseById(exp.id)!.status).toBe('gebucht');
  });

  it('C: zweites Storno wird abgewiesen, Grund und Datum bleiben', () => {
    const exp = booked();
    cancelExpense(exp.id, 'Erster Grund');
    const first = getExpenseById(exp.id)!;
    const second = cancelExpense(exp.id, 'Zweiter Grund');
    expect(second).toEqual({ success: false, errorKey: 'expense.cancel.alreadyCancelled' });
    const after = getExpenseById(exp.id)!;
    expect(after.cancelReason).toBe('Erster Grund');
    expect(after.cancelledAt).toBe(first.cancelledAt);
    expect(after.sync?.version).toBe(first.sync?.version);
  });

  it('E: stornierte Ausgabe ist nicht mehr offen', () => {
    const exp = booked();
    expect(getAllExpenseOverview().some((i) => i.expense.id === exp.id)).toBe(true);
    cancelExpense(exp.id, 'Falscher Beleg');
    expect(getAllExpenseOverview().some((i) => i.expense.id === exp.id)).toBe(false);
    expect(recordExpensePayment(exp.id, { date: '2026-09-10', amount: 10 })).toEqual({
      success: false,
      errorKey: 'expense.payment.notPayable',
    });
  });

  it('F: bezahlte Ausgabe — Storno blockiert, Zahlung unverändert; nach Rücknahme möglich', () => {
    const exp = booked();
    const paid = recordExpensePayment(exp.id, { date: '2026-09-05', amount: 119 });
    expect(paid.success).toBe(true);
    const blocked = cancelExpense(exp.id, 'Falscher Beleg');
    expect(blocked).toEqual({ success: false, errorKey: 'expense.cancel.hasPayments' });
    const still = getExpenseById(exp.id)!;
    expect(still.status).toBe('gebucht');
    expect(still.payments).toHaveLength(1);
    expect(still.paymentStatus).toBe('bezahlt');

    const paymentId = paid.success ? paid.payment.id : '';
    expect(removeExpensePayment(exp.id, paymentId).success).toBe(true);
    expect(cancelExpense(exp.id, 'Falscher Beleg').success).toBe(true);
    expect(getExpenseById(exp.id)!.status).toBe('storniert');
  });
});

describe('V1-A — Monatsmappe (D)', () => {
  it('Original im Belegmonat als storniert, Storno-Beleg im Stornomonat, Summen ohne Doppelzählung', () => {
    const exp = booked();
    cancelExpense(exp.id, 'Beleg doppelt erfasst');
    const cancelledExpense = { ...getExpenseById(exp.id)!, cancelledAt: '2026-10-03T09:00:00.000Z' };

    const sept = monatsmappe('2026-09', [cancelledExpense]);
    expect(sept.eingangsbelege.map((b) => [b.id, b.status, b.zahlungsstatus])).toEqual([[exp.id, 'storniert', 'storniert']]);
    expect(sept.stornos.filter((s) => s.belegart === 'ausgabenstorno')).toHaveLength(0);
    expect(sept.eingangsbelege[0]!.brutto).toBe(119);
    expect(sept.eingangsbelege[0]!.zahlungssumme).toBe(0);

    const okt = monatsmappe('2026-10', [cancelledExpense]);
    expect(okt.eingangsbelege).toHaveLength(0);
    const storno = okt.stornos.filter((s) => s.belegart === 'ausgabenstorno');
    expect(storno).toHaveLength(1);
    expect(storno[0]!.brutto).toBe(-119);
    expect(storno[0]!.datum).toBe('2026-10-03');
    expect(okt.stornosOhneDatum).toHaveLength(0);
    // Netto-Wirkung über beide Monate: +119 im Original, -119 im Storno = 0
    expect(sept.eingangsbelege[0]!.brutto + storno[0]!.brutto).toBe(0);
  });
});

describe('V1-A — Bearbeiten', () => {
  it('G: vor Zahlung sind Kategorie, Beschreibung, Betrag und Datum änderbar', () => {
    const exp = booked();
    const result = updateExpense(exp.id, {
      category: 'werkzeug',
      description: 'Korrigiert',
      grossAmount: 238,
      netAmount: 200,
      taxAmount: 38,
      issueDate: '2026-09-02',
    });
    expect(result.success).toBe(true);
    const after = getExpenseById(exp.id)!;
    expect([after.category, after.description, after.grossAmount, after.issueDate]).toEqual(['werkzeug', 'Korrigiert', 238, '2026-09-02']);
    expect(after.paymentStatus).toBe('offen');
  });

  it('H: nach Zahlung bleiben Beträge fest; Kategorie/Beschreibung/Datum bleiben änderbar', () => {
    const exp = booked();
    expect(recordExpensePayment(exp.id, { date: '2026-09-05', amount: 50 }).success).toBe(true);
    expect(updateExpense(exp.id, { grossAmount: 238 })).toEqual({
      success: false,
      errorKey: 'expense.edit.amountLockedAfterPayment',
    });
    expect(getExpenseById(exp.id)!.grossAmount).toBe(119);

    const ok = updateExpense(exp.id, { category: 'fahrzeug', description: 'Tankfüllung', issueDate: '2026-09-03', grossAmount: 119 });
    expect(ok.success).toBe(true);
    const after = getExpenseById(exp.id)!;
    expect([after.category, after.description, after.issueDate]).toEqual(['fahrzeug', 'Tankfüllung', '2026-09-03']);
    expect(after.payments).toHaveLength(1);
    expect(after.paymentStatus).toBe('teilbezahlt');
  });

  it('H: stornierte Ausgabe wird nicht mehr bearbeitet', () => {
    const exp = booked();
    cancelExpense(exp.id, 'Falscher Beleg');
    expect(updateExpense(exp.id, { description: 'x' })).toEqual({ success: false, errorKey: 'expense.edit.cancelled' });
  });
});

describe('V1-A — Cloud (I)', () => {
  it('Push-Payload trägt Status, Stornodatum und Grund; Pull stellt den Zustand auf Gerät 2 her', () => {
    const exp = booked();
    cancelExpense(exp.id, 'Beleg doppelt erfasst');
    const local = getExpenseById(exp.id)!;
    const payload = buildExpensePushPayload(local, false);
    expect(payload.status).toBe('storniert');
    expect((payload.payload as Record<string, unknown>).cancelReason).toBe('Beleg doppelt erfasst');
    expect((payload.payload as Record<string, unknown>).cancelledAt).toBe(local.cancelledAt);
    expect((payload.payload as Record<string, unknown>).payments).toBeUndefined();

    const deviceTwoBefore: Expense = { ...exp, payments: [], paymentStatus: 'offen' };
    const merged = mapCloudExpenseRow(
      {
        client_expense_id: exp.id,
        status: 'storniert',
        dedupe_key: local.dedupeKey,
        linked_inbox_id: null,
        archive_document_id: null,
        payload: payload.payload as Record<string, unknown>,
        deleted: false,
        row_version: 2,
        updated_at: local.updatedAt,
      },
      deviceTwoBefore,
      { deviceId: 'device-2', workspaceId: 'ws', dirty: new Set() },
    );
    expect(merged.status).toBe('storniert');
    expect(merged.cancelReason).toBe('Beleg doppelt erfasst');
    expect(merged.cancelledAt).toBe(local.cancelledAt);
    expect(merged.sync?.version).toBe(2);
  });
});
