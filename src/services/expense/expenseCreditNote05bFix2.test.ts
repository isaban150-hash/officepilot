/**
 * FINANZCORE-05B-FIX2 — eine Gutschrift ist keine bezahlte Rechnung.
 *
 * Realbefund der unabhängigen 05B-Abnahme: Eine Lieferantengutschrift über
 * −119 € ohne jede Zahlung zeigte in der Detailansicht „Bezahlt", bezahlt
 * 0,00 €, offen 0,00 € — und **„Überzahlung 119,00 €"**. Daneben stand die
 * Aktion „Zahlung erfassen".
 *
 * Ursache waren zwei Klammern, die stillschweigend einen positiven
 * Forderungsbetrag voraussetzen:
 *
 *   openAmount    = Math.max(0, brutto − bezahlt)   →  0  bei −119
 *   overpaidAmount = Math.max(0, bezahlt − brutto)  → 119 bei −119
 *
 * Aus `openAmount <= 0` folgte „bezahlt", aus der zweiten Klammer eine
 * Überzahlung, die es nie gab.
 *
 * Geprüft wird die Rechnung selbst, nicht ihre Anzeige — und ausdrücklich
 * auch, dass die positiven Fälle unverändert bleiben.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateExpensePaymentSummary,
  getExpenseOpenAmount,
  isCreditNoteExpense,
  isExpenseOverdue,
  isExpensePayable,
  recordExpensePayment,
  resolveExpensePaymentStatus,
} from '../expensePaymentService';
import { checkExpenseMoneyIntegrity } from './expenseMoneyIntegrity';
import { addExpense } from '../expenseService';
import {
  getAllExpensesFromStore,
  getExpenseFromStoreById,
  setExpenseStoreForTests,
} from '../expenseStore';
import { normalizeExpense } from '../expenseNormalize';
import {
  getAllExpenseOverview,
  getOpenExpenses,
  getPaidExpenses,
  summarizeExpenseOverview,
} from '../expenseOverviewService';
import { buildMonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import { resetTestStores } from '../../test/resetStores';
import type { Expense, ExpensePayment } from '../../types/expense';

/* ------------------------------------------------------------------ */

function expense(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'RE-1',
    title: 'Material',
    issueDate: '2026-06-01',
    paymentDueDate: '2026-06-15',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    ...overrides,
  } as Expense);
}

/** Die Gutschrift aus der Abnahme: 05B TEST CREDIT, −100 / −19 / −119. */
function gutschrift(overrides: Partial<Expense> = {}): Expense {
  return expense({
    id: 'exp-credit',
    invoiceNumber: 'GS-1',
    title: '05B TEST CREDIT',
    category: 'gutschrift',
    netAmount: -100,
    taxAmount: -19,
    grossAmount: -119,
    ...overrides,
  });
}

function payment(amount: number, id = 'pay-1'): ExpensePayment {
  return { id, date: '2026-06-10', amount, createdAt: '2026-06-10T08:00:00.000Z' };
}

beforeEach(() => {
  resetTestStores();
  setExpenseStoreForTests([]);
});

afterEach(() => {
  resetTestStores();
  vi.restoreAllMocks();
});

/* ================================================================== */

describe('A — die Gutschrift ohne Zahlung', () => {
  const heute = '2026-09-01';

  // T1 — der sichtbare Fehler der Abnahme.
  it('T1: ist nicht „bezahlt"', () => {
    const summary = calculateExpensePaymentSummary(gutschrift(), heute);
    expect(summary.status).toBe('gutschrift');
    expect(summary.status).not.toBe('bezahlt');
  });

  // T2/T3 — die erfundene Überzahlung.
  it('T2/T3: hat keine Überzahlung', () => {
    const summary = calculateExpensePaymentSummary(gutschrift(), heute);
    expect(summary.overpaidAmount, 'keine Überzahlung ohne Geldbewegung').toBe(0);
    expect(summary.paidAmount).toBe(0);
    expect(summary.openAmount).toBe(0);
    // Der Bruttobetrag bleibt, wie er gespeichert ist.
    expect(summary.totalDue).toBe(-119);
  });

  it('T3b: der Betrag selbst erzeugt keine Überzahlung — gegengeprüft an der alten Formel', () => {
    const alteFormel = Math.max(0, 0 - -119);
    expect(alteFormel, 'so entstand die Meldung „Überzahlung 119,00"').toBe(119);
    expect(calculateExpensePaymentSummary(gutschrift(), heute).overpaidAmount).toBe(0);
  });

  // T4 — keine Zahlungserfassung.
  it('T4: die normale Zahlungserfassung wird nicht angeboten', () => {
    expect(isCreditNoteExpense(gutschrift())).toBe(true);
    expect(isExpensePayable(gutschrift())).toBe(false);
  });

  /*
   * Und der Dienst weist sie auch dann ab, wenn sie jemand direkt aufruft. Das
   * Zahlungsmodell kennt nur positive Auszahlungen — client- wie serverseitig
   * (`amount > 0`). Eine positive Zahlung gegen einen negativen Beleg wäre
   * keine Erfassung, sondern eine Erfindung.
   */
  it('T4b: recordExpensePayment lehnt eine Zahlung auf eine Gutschrift ab', () => {
    setExpenseStoreForTests([gutschrift()]);
    const result = recordExpensePayment('exp-credit', { date: '2026-06-10', amount: 119 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('expense.payment.notPayable');
    expect(getExpenseFromStoreById('exp-credit')!.payments ?? []).toHaveLength(0);
  });

  it('eine Gutschrift wird nie überfällig', () => {
    expect(isExpenseOverdue(gutschrift(), '2099-01-01')).toBe(false);
    expect(getExpenseOpenAmount(gutschrift())).toBe(0);
  });

  // T12 — die Steuerwerte bleiben unangetastet.
  it('T12: Netto, Steuer und Brutto bleiben −100 / −19 / −119', () => {
    const g = gutschrift();
    expect(g.netAmount).toBe(-100);
    expect(g.taxAmount).toBe(-19);
    expect(g.grossAmount).toBe(-119);
    expect(checkExpenseMoneyIntegrity(g)).toEqual({ ok: true });
  });

  // T13 — nach dem Neuladen unverändert.
  it('T13: nach dem Neuladen ist die Gutschrift identisch', () => {
    const created = addExpense({
      title: '05B TEST CREDIT',
      category: 'gutschrift',
      supplierName: 'Baustoff Süd GmbH',
      invoiceNumber: 'GS-RELOAD',
      issueDate: '2026-06-01',
      taxStatus: 'standard_19',
      netAmount: -100,
      taxAmount: -19,
      grossAmount: -119,
    });
    expect(created.success, created.success ? '' : JSON.stringify(created)).toBe(true);
    if (!created.success) return;

    setExpenseStoreForTests([created.expense]);
    const wieder = getExpenseFromStoreById(created.expense.id)!;
    expect(wieder.netAmount).toBe(-100);
    expect(wieder.taxAmount).toBe(-19);
    expect(wieder.grossAmount).toBe(-119);
    expect(wieder.isCreditNote).toBe(true);
    expect(calculateExpensePaymentSummary(wieder).status).toBe('gutschrift');
  });
});

describe('B — positive Ausgaben bleiben unverändert', () => {
  const heute = '2026-06-10';

  // T5 — Teilzahlung.
  it('T5: 119 mit Zahlung 70 bleibt teilbezahlt', () => {
    const summary = calculateExpensePaymentSummary(
      expense({ payments: [payment(70)] }),
      heute,
    );
    expect(summary.paidAmount).toBe(70);
    expect(summary.openAmount).toBe(49);
    expect(summary.overpaidAmount).toBe(0);
    expect(summary.status).toBe('teilbezahlt');
  });

  // T6 — vollständig bezahlt.
  it('T6: 119 mit Zahlung 119 bleibt bezahlt', () => {
    const summary = calculateExpensePaymentSummary(
      expense({ payments: [payment(119)] }),
      heute,
    );
    expect(summary.paidAmount).toBe(119);
    expect(summary.openAmount).toBe(0);
    expect(summary.overpaidAmount).toBe(0);
    expect(summary.status).toBe('bezahlt');
  });

  /*
   * T7 — die **echte** Überzahlung einer positiven Ausgabe. Sie ist Thema von
   * 05C; hier wird ausschliesslich festgehalten, dass FIX2 nichts daran
   * verändert hat.
   */
  it('T7: eine echte Überzahlung rechnet unverändert weiter', () => {
    const summary = calculateExpensePaymentSummary(
      expense({ payments: [payment(150)] }),
      heute,
    );
    expect(summary.paidAmount).toBe(150);
    expect(summary.openAmount).toBe(0);
    expect(summary.overpaidAmount, 'aus echtem Geld, nicht aus einem Vorzeichen').toBe(31);
    /*
     * FINANZCORE-05C hat den Status nachgezogen: Die Ueberzahlung heisst jetzt
     * so, statt unter „bezahlt" zu verschwinden. Der Punkt dieses Tests bleibt
     * derselbe — der Betrag stammt aus echtem Geld, nicht aus einem Vorzeichen.
     */
    expect(summary.status).toBe('ueberbezahlt');
  });

  it('eine offene positive Ausgabe bleibt offen und wird überfällig', () => {
    expect(resolveExpensePaymentStatus(expense(), '2026-06-10')).toBe('offen');
    expect(resolveExpensePaymentStatus(expense(), '2026-07-01')).toBe('ueberfaellig');
  });

  it('ein Storno gewinnt weiterhin über alles — auch bei negativem Betrag', () => {
    expect(resolveExpensePaymentStatus(expense({ status: 'storniert' }))).toBe('storniert');
    expect(resolveExpensePaymentStatus(gutschrift({ status: 'storniert' }))).toBe('storniert');
  });
});

describe('C — Listen, Summen und Monatsmappe', () => {
  /*
   * T8/T9 — die Summen waren in der Abnahme bereits richtig. Sie dürfen es
   * bleiben: 119 + 107 − 119 = 107 an Ausgaben, und die Gutschrift zählt nicht
   * als offene Verbindlichkeit.
   */
  it('T8/T9: die Gutschrift erhöht keine offene Verbindlichkeit', () => {
    setExpenseStoreForTests([
      expense({ id: 'exp-a', invoiceNumber: 'A', grossAmount: 119, netAmount: 100, taxAmount: 19 }),
      expense({
        id: 'exp-b',
        invoiceNumber: 'B',
        grossAmount: 107,
        netAmount: 100,
        taxAmount: 7,
        taxStatus: 'standard_7',
      }),
      gutschrift(),
    ]);

    const totals = summarizeExpenseOverview(getAllExpenseOverview('2026-06-10'));
    expect(totals.openLiabilities).toBe(226);
    expect(totals.openExpenseCount).toBe(2);
    expect(totals.overdueLiabilities).toBe(0);
    // Ohne Zahlungen ist nichts bezahlt — auch die Gutschrift trägt hier nichts bei.
    expect(totals.paidTotal).toBe(0);
    expect(totals.totalExpenseCount).toBe(3);
  });

  // T10 — die Gutschrift erscheint weder unter offen noch unter bezahlt.
  it('T10: die Listen zeigen die Gutschrift an der richtigen Stelle', () => {
    setExpenseStoreForTests([expense({ id: 'exp-a', invoiceNumber: 'A' }), gutschrift()]);

    expect(getOpenExpenses('2026-06-10').map((item) => item.expense.id)).toEqual(['exp-a']);
    expect(getPaidExpenses('2026-06-10')).toHaveLength(0);
    // In der Gesamtliste bleibt sie sichtbar.
    expect(getAllExpenseOverview('2026-06-10').map((item) => item.expense.id)).toContain(
      'exp-credit',
    );
  });

  // T11 — die Monatsmappe.
  it('T11: die Monatsmappe führt die Gutschrift mit ihren echten Beträgen', () => {
    const model = buildMonatsmappeModel({
      monthKey: '2026-06',
      invoices: [],
      expenses: [gutschrift()],
      documents: [],
      inboxItems: [],
      fileRefs: [],
    });

    expect(model.eingangsbelege).toHaveLength(1);
    const beleg = model.eingangsbelege[0];
    expect(beleg.netto).toBe(-100);
    expect(beleg.steuer).toBe(-19);
    expect(beleg.brutto).toBe(-119);
    expect(beleg.zahlungsstatus).toBe('gutschrift');
    expect(beleg.zahlungssumme).toBe(0);
    // Kein Widerspruchshinweis — die Beträge sind stimmig.
    expect(beleg.hinweis ?? '').not.toContain('widersprüchlich');
  });
});

describe('D — Altbestand', () => {
  /*
   * T14 — kann an einer Gutschrift historisch schon eine Zahlung hängen? Im
   * heutigen Modell entsteht sie nicht mehr. Ein alter Datensatz wird deshalb
   * gelesen, nicht umgeschrieben: Der Betrag bleibt sichtbar, die Zahlung
   * bleibt stehen, und nichts wird nachgerechnet.
   */
  it('T14: eine Gutschrift mit alter Zahlung wird nicht verändert', () => {
    const alt = gutschrift({ payments: [payment(119, 'pay-alt')] });
    setExpenseStoreForTests([alt]);

    const geladen = getExpenseFromStoreById('exp-credit')!;
    expect(geladen.payments).toHaveLength(1);
    expect(geladen.payments![0].id).toBe('pay-alt');
    expect(geladen.payments![0].amount).toBe(119);
    expect(geladen.grossAmount).toBe(-119);

    const summary = calculateExpensePaymentSummary(geladen);
    // Der Status bleibt „Gutschrift"; die geflossene Zahlung wird ehrlich gezeigt.
    expect(summary.status).toBe('gutschrift');
    expect(summary.paidAmount).toBe(119);
    // Und auch hier keine erfundene Überzahlung.
    expect(summary.overpaidAmount).toBe(0);
    expect(summary.openAmount).toBe(0);
  });

  it('T14b: der Altbestand wird beim Lesen nicht neu berechnet', () => {
    const alt = gutschrift({ payments: [payment(119, 'pay-alt')] });
    setExpenseStoreForTests([alt]);
    const vorher = JSON.stringify(getAllExpensesFromStore());
    calculateExpensePaymentSummary(getExpenseFromStoreById('exp-credit')!);
    expect(JSON.stringify(getAllExpensesFromStore())).toBe(vorher);
  });
});
