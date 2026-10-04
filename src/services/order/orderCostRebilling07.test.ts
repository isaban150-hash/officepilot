/**
 * BEREICH-7-V1 — Lieferantenkosten weiterberechnen.
 *
 *  A  Preis und Rundung (Aufschlag 0, 12,5 %, Rundungskante)
 *  B  Doppelberechnungsschutz — in der Fachlogik, nicht nur in der Ansicht
 *  C  Rücknahme: unabgerechnet löschbar, abgerechnet gesperrt
 *  D  Rechnungsstorno — keine Sonderlogik, bestehende Mengenlogik trägt
 *  E  Entwurfsprojektion und Serververtrag
 *  F  Steuer bleibt Sache der Kundenrechnung
 *  G  Vertragsplan gesperrt → Nachtrag
 *  H  Cloud/Sync für Position und Marker
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestVorgang, testSetup } from '../../test/fixtures';
import { addExpense, assignExpenseToVorgang, cancelExpense, getExpenseById } from '../expenseService';
import { hydrateExpenseStore } from '../expenseStore';
import { getVorgangById, hydrateVorgangStore } from '../vorgangService';
import { hydrateInvoiceStore, setInvoicesForVorgang } from '../invoice/invoiceStore';
import {
  buildExpensePushPayload,
  classifyExpenseCloudErrorForTests,
} from '../expense/expenseCloudSyncService';
import { detectFinancialActionDenial } from '../auth/financialActionDenial';
import { normalizeExpense } from '../expenseNormalize';
import { buildRechnungDraft } from '../invoiceService';
import { rebillPriceCents, toCents } from '../invoiceMoney';
import { getOrderCostSummary } from './orderCostService';
import {
  getRebillState,
  getRebillStateById,
  previewRebillNet,
  rebillAllocation,
  undoRebill,
} from './orderCostRebillingService';
import * as persistenceService from '../persistenceService';
import type { Expense } from '../../types/expense';
import type { Vorgang, VorgangInvoice } from '../../types/models';

const V1 = 'v-rebill-1';

function hydrateOrder(overrides: Partial<Vorgang> = {}): void {
  hydrateVorgangStore([
    createTestVorgang({ id: V1, title: 'Bad Sanierung', customer: 'Kunde A', ...overrides }),
  ]);
}

function newExpense(net: number, overrides: Record<string, unknown> = {}): Expense {
  const result = addExpense({
    title: 'Material Baustoffe',
    category: 'material',
    supplierName: 'Baustoff Nord GmbH',
    invoiceNumber: 'LR-4711',
    issueDate: '2026-09-05',
    grossAmount: Math.round(net * 1.19 * 100) / 100,
    netAmount: net,
    taxAmount: Math.round(net * 0.19 * 100) / 100,
    ...overrides,
  } as Parameters<typeof addExpense>[0]);
  if (!result.success) throw new Error(result.errorKey);
  return result.expense;
}

/** Zugeordnete Ausgabe, bereit zur Weiterberechnung. */
function allocated(net: number, amount = net): Expense {
  const expense = newExpense(net);
  const assigned = assignExpenseToVorgang(expense.id, { vorgangId: V1, amount });
  if (!assigned.success) throw new Error(assigned.errorKey);
  return assigned.expense;
}

function rebilledPosition(expenseId: string) {
  const allocation = (getExpenseById(expenseId)!.allocations ?? []).find((a) => a.vorgangId === V1);
  const positionId = allocation?.rebilledOrderPositionId;
  return getVorgangById(V1)!.orderPositions.find((p) => p.id === positionId);
}

beforeEach(() => {
  localStorage.clear();
  hydrateExpenseStore([]);
  hydrateInvoiceStore([]);
  hydrateOrder();
  vi.restoreAllMocks();
  vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: true } as never);
});

describe('A — Preis und Rundung', () => {
  it('A1: Aufschlag 0 ergibt exakt den Einkaufspreis', () => {
    expect(previewRebillNet(250, 0)).toBe(250);
    expect(rebillPriceCents(toCents(250), 0)).toBe(25000);

    const expense = allocated(250);
    const result = rebillAllocation({
      expenseId: expense.id,
      vorgangId: V1,
      description: 'Lieferantenkosten',
      markupPercent: 0,
    });
    expect(result.success).toBe(true);
    expect(rebilledPosition(expense.id)!.unitPrice).toBe(250);
  });

  it('A2: 100,00 + 12,5 % ergibt 112,50', () => {
    expect(rebillPriceCents(10000, 12.5)).toBe(11250);
    expect(previewRebillNet(100, 12.5)).toBe(112.5);
  });

  it('A3: Rundungskante 33,33 + 7 % wird genau einmal gerundet', () => {
    // 3333 × 1,07 = 3566,31 → 3566. Zwei Rundungen ergäben denselben Wert nicht
    // zwangsläufig; geprüft wird die eine, dokumentierte Rechnung.
    expect(rebillPriceCents(3333, 7)).toBe(3566);
    expect(previewRebillNet(33.33, 7)).toBe(35.66);
  });

  it('A4: der Dienst rechnet mit derselben Funktion wie die Vorschau', () => {
    const expense = allocated(33.33);
    const result = rebillAllocation({
      expenseId: expense.id,
      vorgangId: V1,
      description: 'Weiterberechnung',
      markupPercent: 7,
    });
    expect(result.success && result.unitPrice).toBe(35.66);
    expect(rebilledPosition(expense.id)!.unitPrice).toBe(previewRebillNet(33.33, 7));
  });

  it('A5: ein negativer Aufschlag wird abgewiesen statt als Rabatt gedeutet', () => {
    const expense = allocated(100);
    expect(
      rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'x', markupPercent: -5 }),
    ).toEqual({ success: false, errorKey: 'expense.rebill.markupInvalid' });
    expect(getVorgangById(V1)!.orderPositions).toHaveLength(1);
  });
});

describe('B — Doppelberechnungsschutz', () => {
  it('B1: die zweite Weiterberechnung derselben Zuordnung wird in der Fachlogik verhindert', () => {
    const expense = allocated(200);
    expect(
      rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Erste', markupPercent: 0 })
        .success,
    ).toBe(true);

    const zweite = rebillAllocation({
      expenseId: expense.id,
      vorgangId: V1,
      description: 'Zweite',
      markupPercent: 0,
    });
    expect(zweite).toEqual({ success: false, errorKey: 'expense.rebill.alreadyRebilled' });
    // Entscheidend: es ist auch wirklich keine zweite Position entstanden.
    expect(getVorgangById(V1)!.orderPositions).toHaveLength(2);
  });

  it('B2: der Zustand ist für die Ansicht lesbar und nennt die Position', () => {
    const expense = allocated(200);
    rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies', markupPercent: 10 });

    const state = getRebillStateById(expense.id, V1)!;
    expect(state.kind).toBe('already_rebilled');
    if (state.kind !== 'already_rebilled') throw new Error('unerwartet');
    expect(state.position?.description).toBe('Kies');
    expect(state.position?.unitPrice).toBe(220);
    expect(state.billed).toBe(false);
  });

  it('B3: eine Betragsänderung der Zuordnung verliert den Marker nicht', () => {
    const expense = allocated(500, 500);
    rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies', markupPercent: 0 });
    const positionId = rebilledPosition(expense.id)!.id;

    // Genau der Weg, auf dem der Schutz sonst stillschweigend verschwände.
    expect(assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: 300 }).success).toBe(true);

    const allocation = (getExpenseById(expense.id)!.allocations ?? [])[0]!;
    expect(allocation.amount).toBe(300);
    expect(allocation.rebilledOrderPositionId).toBe(positionId);
    expect(getRebillStateById(expense.id, V1)!.kind).toBe('already_rebilled');
  });

  it('B4: eine stornierte Ausgabe ist nicht weiterberechenbar', () => {
    const expense = allocated(100);
    expect(cancelExpense(expense.id, 'Fehlbuchung').success).toBe(true);
    const state = getRebillStateById(expense.id, V1)!;
    expect(state).toEqual({ kind: 'blocked', reason: 'expense_inactive' });
    expect(
      rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'x', markupPercent: 0 }),
    ).toEqual({ success: false, errorKey: 'expense.rebill.expenseInactive' });
  });
});

describe('C — Rücknahme', () => {
  it('C1: die unabgerechnete Position wird gelöscht, der Marker geräumt, der Betrag ist wieder weiterberechenbar', () => {
    const expense = allocated(400);
    rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies', markupPercent: 0 });
    const positionId = rebilledPosition(expense.id)!.id;

    expect(undoRebill(expense.id, V1)).toEqual({ success: true });

    expect(getVorgangById(V1)!.orderPositions.some((p) => p.id === positionId)).toBe(false);
    expect((getExpenseById(expense.id)!.allocations ?? [])[0]!.rebilledOrderPositionId).toBeUndefined();
    expect(getRebillStateById(expense.id, V1)).toEqual({ kind: 'rebillable' });

    // Und sie lässt sich danach wirklich erneut weiterberechnen.
    expect(
      rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies neu', markupPercent: 5 })
        .success,
    ).toBe(true);
    expect(rebilledPosition(expense.id)!.unitPrice).toBe(420);
  });

  it('C2: eine wirksam abgerechnete Position wird nicht über diesen Weg gelöscht', () => {
    const expense = allocated(400);
    rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies', markupPercent: 0 });
    const positionId = rebilledPosition(expense.id)!.id;

    setInvoicesForVorgang(V1, [billedInvoice(positionId)]);

    expect(undoRebill(expense.id, V1)).toEqual({ success: false, errorKey: 'position.deleteBlocked' });
    // Weder Position noch Marker dürfen dabei verloren gehen.
    expect(getVorgangById(V1)!.orderPositions.some((p) => p.id === positionId)).toBe(true);
    expect((getExpenseById(expense.id)!.allocations ?? [])[0]!.rebilledOrderPositionId).toBe(positionId);
  });

  it('C3: ohne Weiterberechnung gibt es nichts zurückzunehmen', () => {
    const expense = allocated(100);
    expect(undoRebill(expense.id, V1)).toEqual({ success: false, errorKey: 'expense.rebill.notRebilled' });
  });
});

function billedInvoice(orderPositionId: string, overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-rebill-1',
    number: 'RE-1',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId,
        description: 'Kies',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 400,
        lineTotal: 400,
      },
    ],
    subtotal: 400,
    taxStatus: 'standard_19',
    amount: 476,
    status: 'versendet',
    date: '2026-09-10',
    issueDate: '2026-09-10',
    createdAt: '2026-09-10T00:00:00.000Z',
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

describe('D — Rechnungsstorno', () => {
  it('D1: nach dem Storno bleibt die Position verknüpft und wird nach bestehender Mengenlogik wieder offen', () => {
    const expense = allocated(400);
    rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies', markupPercent: 0 });
    const positionId = rebilledPosition(expense.id)!.id;

    setInvoicesForVorgang(V1, [billedInvoice(positionId)]);
    const beforeState = getRebillStateById(expense.id, V1)!;
    expect(beforeState.kind === 'already_rebilled' && beforeState.billed).toBe(true);

    setInvoicesForVorgang(V1, [
      billedInvoice(positionId, { paymentStatus: 'storniert', cancelledAt: '2026-09-20T00:00:00.000Z' }),
    ]);

    const afterState = getRebillStateById(expense.id, V1)!;
    expect(afterState.kind).toBe('already_rebilled');
    if (afterState.kind !== 'already_rebilled') throw new Error('unerwartet');
    // Keine Sonderlogik: `isBillingEffective` allein macht die Menge wieder offen.
    expect(afterState.billed).toBe(false);
    expect(afterState.orderPositionId).toBe(positionId);
    // Und das ist ausdrücklich NICHT dasselbe wie „wieder weiterberechenbar".
    expect(afterState.kind).not.toBe('rebillable');
  });
});

describe('E — Entwurfsprojektion und Serververtrag', () => {
  it('E1: der Rechnungsentwurf projiziert die erzeugte Position mit Einheit und Preis', () => {
    const expense = allocated(400);
    rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies geliefert', markupPercent: 10 });
    const position = rebilledPosition(expense.id)!;

    const draft = buildRechnungDraft(V1, testSetup)!;
    const line = draft.positions.find((p) => p.orderPositionId === position.id)!;

    expect(line).toBeDefined();
    // Genau die drei Grössen, die der Server gegen den Auftragsplan prüft.
    expect(line.orderPositionId).toBe(position.id);
    expect(line.unit).toBe('Pauschal');
    expect(line.unitPrice).toBe(440);
    expect(line.billable).toBe(true);
  });

  it('E2: die Position ist auch bei materialSource „auftraggeber" abrechenbar', () => {
    // Deshalb `sonstiges` statt `material`: sonst wäre sie hier stumm wirkungslos.
    hydrateOrder({ materialSource: 'auftraggeber' });
    const expense = allocated(400);
    rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies', markupPercent: 0 });
    const position = rebilledPosition(expense.id)!;
    expect(position.category).toBe('sonstiges');

    const draft = buildRechnungDraft(V1, testSetup)!;
    expect(draft.positions.find((p) => p.orderPositionId === position.id)!.billable).toBe(true);
  });

  it('E3: Planmenge 1 — die Position ist genau einmal abrechenbar', () => {
    const expense = allocated(400);
    rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies', markupPercent: 0 });
    const position = rebilledPosition(expense.id)!;
    expect(position.plannedQuantity).toBe(1);

    setInvoicesForVorgang(V1, [billedInvoice(position.id)]);
    const draft = buildRechnungDraft(V1, testSetup)!;
    const line = draft.positions.find((p) => p.orderPositionId === position.id)!;
    expect(line.billedQuantity).toBe(1);
    expect(line.openQuantity).toBe(0);
  });
});

describe('F — Steuer', () => {
  it('F1: der Steuerstatus der Ausgabe beeinflusst die Kundenrechnung nicht', () => {
    const expense = allocated(400);
    rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies', markupPercent: 0 });
    const position = rebilledPosition(expense.id)!;

    // Die Position trägt einen Nettopreis und sonst nichts Steuerliches.
    expect(position.unitPrice).toBe(400);
    expect(Object.keys(position)).not.toContain('taxRate');
    expect(Object.keys(position)).not.toContain('taxStatus');

    const draft = buildRechnungDraft(V1, testSetup)!;
    const line = draft.positions.find((p) => p.orderPositionId === position.id)!;
    expect(Object.keys(line)).not.toContain('taxRate');
    // Die Steuer hängt am Beleg, nicht an der Zeile — und kommt aus dem Entwurf.
    expect(draft.taxStatus).toBe(testSetup.taxStatus ?? draft.taxStatus);
  });

  it('F2: Basis ist der Nettobetrag, nicht der Bruttobetrag der Lieferantenrechnung', () => {
    const expense = allocated(400); // brutto 476,00
    expect(getExpenseById(expense.id)!.grossAmount).toBe(476);
    rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies', markupPercent: 0 });
    expect(rebilledPosition(expense.id)!.unitPrice).toBe(400);
  });
});

describe('G — Vertragsplan', () => {
  it('G1: bei bestätigtem Vertragsplan wird klar auf den Nachtrag verwiesen', () => {
    hydrateOrder({
      contractConfirmation: {
        confirmedAt: '2026-09-01T00:00:00.000Z',
        positions: [],
      } as never,
    });
    const expense = allocated(400);
    const vorher = getVorgangById(V1)!.orderPositions.length;

    expect(getRebillStateById(expense.id, V1)).toEqual({
      kind: 'blocked',
      reason: 'amendment_required',
    });
    expect(
      rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies', markupPercent: 0 }),
    ).toEqual({ success: false, errorKey: 'order_plan_amendment_required' });

    // Keine Umgehung: der Plan bleibt exakt so, wie er war.
    expect(getVorgangById(V1)!.orderPositions).toHaveLength(vorher);
    expect((getExpenseById(expense.id)!.allocations ?? [])[0]!.rebilledOrderPositionId).toBeUndefined();
  });
});

describe('H — Cloud und Sync', () => {
  it('H1: der Marker reist im vorhandenen Expense-Payload mit', () => {
    const expense = allocated(400);
    rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies', markupPercent: 0 });
    const positionId = rebilledPosition(expense.id)!.id;

    const payload = buildExpensePushPayload(getExpenseById(expense.id)!, false);
    const allocations = (payload.payload as { allocations: Array<Record<string, unknown>> }).allocations;
    expect(allocations[0]!.rebilledOrderPositionId).toBe(positionId);
  });

  it('H2: die Normalisierung aus der Cloud trägt den Marker zurück', () => {
    const expense = allocated(400);
    rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies', markupPercent: 0 });
    const positionId = rebilledPosition(expense.id)!.id;

    const roundtrip = normalizeExpense(JSON.parse(JSON.stringify(getExpenseById(expense.id)!)));
    expect(roundtrip.allocations[0]!.rebilledOrderPositionId).toBe(positionId);
  });

  it('H3: die Position reist im vorhandenen Vorgang-Payload mit', () => {
    const expense = allocated(400);
    rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies', markupPercent: 0 });
    const position = rebilledPosition(expense.id)!;

    const roundtrip = JSON.parse(JSON.stringify(getVorgangById(V1)!)) as Vorgang;
    expect(roundtrip.orderPositions.find((p) => p.id === position.id)?.unitPrice).toBe(400);
  });

  it('H4: die Kostenauswertung bleibt unverändert — die Weiterberechnung ist keine zweite Kostenquelle', () => {
    const expense = allocated(400);
    const before = getOrderCostSummary(V1)!.allocatedCostNet;
    rebillAllocation({ expenseId: expense.id, vorgangId: V1, description: 'Kies', markupPercent: 50 });
    expect(getOrderCostSummary(V1)!.allocatedCostNet).toBe(before);
  });
});

describe('K — Finanzrecht-Ablehnung', () => {
  /*
   * Die Weiterberechnung schreibt den Marker über denselben Expense-Weg wie
   * jede andere Belegänderung — also über das seit R1-SEC-01 autorisierte
   * `upsert_workspace_expense`. Geprüft wird, dass sie dabei **keine zweite
   * Liste von finance_-Codes** mitbringt, sondern die vorhandene zentrale
   * Klassifikation greift und die Ablehnung eine fachliche bleibt.
   */
  const ABLEHNUNGEN = [
    'finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht',
    'finance_account_blocked: Konto ist gesperrt',
    'finance_account_not_approved: Konto ist nicht freigegeben',
    'finance_license_expired: Lizenz ist abgelaufen',
    'finance_license_inactive: Keine aktive Lizenz',
  ];

  it('K1: eine Ablehnung wird nicht wiederholt und ist als Grund lesbar', () => {
    for (const meldung of ABLEHNUNGEN) {
      /*
       * Der Fehlercode bleibt bewusst 'rls' — die Codeliste teilen sich
       * Rechnungs- und Workspace-Weg. Entscheidend ist, dass **nicht**
       * wiederholt wird: Dasselbe Konto bekommt dieselbe Antwort.
       */
      const eingestuft = classifyExpenseCloudErrorForTests({ message: meldung });
      expect(eingestuft.retryable, meldung).toBe(false);
      /* Und der konkrete Grund kommt aus der einen zentralen Klassifikation. */
      expect(detectFinancialActionDenial(meldung), meldung).not.toBeNull();
    }
  });

  it('K2: ein echter Transportfehler bleibt wiederholbar', () => {
    expect(classifyExpenseCloudErrorForTests({ message: 'Failed to fetch' }).retryable).toBe(true);
    expect(detectFinancialActionDenial('Failed to fetch')).toBeNull();
  });
});

describe('I — Rücknahme bei fehlgeschlagener Markierung', () => {
  it('I1: scheitert das Markieren, bleibt keine Position ohne Herkunft zurück', () => {
    const expense = allocated(400);
    const vorher = getVorgangById(V1)!.orderPositions.length;

    /*
     * Der gefährliche Zustand des Blocks: Position angelegt, Marker fehlt —
     * dann wäre dieselbe Zuordnung ein zweites Mal weiterberechenbar.
     * Simuliert über ein fehlschlagendes Speichern beim zweiten Schreibweg.
     */
    const persist = vi.spyOn(persistenceService, 'persistAll');
    let aufrufe = 0;
    persist.mockImplementation(
      () => (++aufrufe === 2 ? { success: false, failure: {} } : { success: true }) as never,
    );

    const result = rebillAllocation({
      expenseId: expense.id,
      vorgangId: V1,
      description: 'Kies',
      markupPercent: 0,
    });
    expect(result.success).toBe(false);

    persist.mockReturnValue({ success: true } as never);
    expect(getVorgangById(V1)!.orderPositions).toHaveLength(vorher);
    expect(getRebillStateById(expense.id, V1)).toEqual({ kind: 'rebillable' });
  });
});

describe('J — getRebillState ohne Zuordnung', () => {
  it('J1: eine Ausgabe ohne Zuordnung auf diesen Auftrag ist kein Kandidat', () => {
    const expense = newExpense(100);
    expect(getRebillState(getExpenseById(expense.id)!, getVorgangById(V1)!)).toEqual({
      kind: 'blocked',
      reason: 'expense_inactive',
    });
  });
});
