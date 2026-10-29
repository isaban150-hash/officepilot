/**
 * P1 A-04 — Produktregeln A und B (Auftrag 27.10.2026), Client-Seite. Server: Folgemigration 20261206120000.
 *
 *  A  Eine tatsächlich erfolgte Zahlung darf bei offener Steueraufteilung erfasst werden (bewusst bestätigt). Keine
 *     automatische Steuerfreigabe: Der Beleg bleibt „offen“, Kontierungsbestätigung und Monatsabschluss bleiben gesperrt
 *     (auch für den Monat der Zahlung). Nach der Zahlung bleibt die Klärung möglich; das Brutto bleibt gebunden.
 *  B  0 € Steuer gilt nur mit einem Steuerstatus ohne Umsatzsteuer als begründet; bei 19 %, 7 % und „unklar“ ist sie
 *     keine Klärung — für Neuanlage und Bearbeitung gleich. Gespeicherter Bestand wird nicht umgedeutet.
 *
 * Synthetische Daten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addExpense, getExpenseById, updateExpense } from '../expenseService';
import { calculateExpensePaymentSummary, canRecordExpensePayment, recordExpensePayment } from '../expensePaymentService';
import { getAllExpensesFromStore, getExpenseFromStoreById, setExpenseStoreForTests } from '../expenseStore';
import { normalizeExpense } from '../expenseNormalize';
import { hasPaymentWithOpenTaxReview, resolveExpenseTaxSplitState } from './expenseTaxSplit';
import { expensePaymentStatusLabel } from '../../components/expenses/ExpensePaymentBadge';
import {
  confirmAccountingAssignment,
  ensureExpenseAccountingAssignment,
  updateAccountingAssignment,
} from '../accounting/accountingAssignmentService';
import { getAccountingAssignmentForSource } from '../accounting/accountingStore';
import { collectPeriodBlockers } from '../accounting/accountingPeriodService';
import { buildPeriodManifest } from '../accounting/accountingPeriodFingerprint';
import { buildMonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import { planBankConfirmation } from '../bank/bankReconciliationService';
import { resetBankReconciliationsForTests } from '../bank/bankReconciliationStore';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import { t } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import { resetTestStores } from '../../test/resetStores';
import type { Expense, ExpenseInput } from '../../types/expense';
import type { BankSuggestionCandidate } from '../../types/bankSuggestion';
import type { BankTransaction } from '../../types/bankTransaction';

let nummer = 0;
function input(overrides: Partial<ExpenseInput> = {}): ExpenseInput {
  nummer += 1;
  return {
    title: 'Z Material',
    category: 'material',
    supplierName: 'Z Lieferant GmbH',
    invoiceNumber: `Z-${nummer}`,
    issueDate: '2026-10-15',
    taxStatus: 'standard_19',
    grossAmount: 119,
    ...overrides,
  };
}
function anlegen(overrides: Partial<ExpenseInput> = {}): Expense {
  const result = addExpense(input(overrides));
  if (!result.success) throw new Error(JSON.stringify(result));
  return result.expense;
}
const zahle = (id: string, amount: number, date = '2026-10-20', confirmTaxReviewOpen = true) =>
  recordExpensePayment(id, { date, amount, method: 'bank' }, { confirmTaxReviewOpen });
const zustand = (id: string) => resolveExpenseTaxSplitState(getExpenseFromStoreById(id)!);
const de = (key: string) => t(key as TranslationKey, 'de');
/** Sperrgründe des Monats wie in der Abschlussansicht: Monatsmappe aus dem Bestand → Manifest Fassung 6 → Blocker. */
function blocker(monthKey: string, code: string): readonly string[] {
  const model = buildMonatsmappeModel({
    monthKey, invoices: [], documents: [], inboxItems: [], fileRefs: [], expenses: getAllExpensesFromStore(),
  });
  return collectPeriodBlockers(buildPeriodManifest(model, [], 'SKR03', 6)).find((entry) => entry.code === code)?.sourceIds ?? [];
}

beforeEach(() => {
  resetTestStores();
  setExpenseStoreForTests([]);
});
afterEach(() => {
  resetTestStores();
});

describe('A — Zahlung bei offener Steueraufteilung', () => {
  it('A1: Zahlung bewusst erfasst — richtiger Beleg, keine Steuerfreigabe, Beleg unverändert offen', () => {
    const offen = anlegen();
    expect(canRecordExpensePayment(offen)).toBe(true);
    expect(zahle(offen.id, 119, '2026-10-20', false)).toEqual({ success: false, errorKey: 'expense.payment.taxReviewAckRequired' });
    const ergebnis = zahle(offen.id, 119);
    expect(ergebnis.success, JSON.stringify(ergebnis)).toBe(true);
    const danach = getExpenseFromStoreById(offen.id)!;
    expect(danach.payments).toHaveLength(1);
    expect(danach.payments![0]).toMatchObject({ amount: 119, date: '2026-10-20', method: 'bank' });
    expect(zustand(offen.id)).toBe('offen');
    expect([danach.taxSplit, danach.netAmount, danach.taxAmount, danach.grossAmount]).toEqual(['offen', 119, 0, 119]);
    const summary = calculateExpensePaymentSummary(danach);
    expect(summary.status).toBe('bezahlt');
    expect(hasPaymentWithOpenTaxReview(danach, summary.paidAmount)).toBe(true);
    expect(expensePaymentStatusLabel(summary.status, de, true)).toBe('Bezahlt – Steuerprüfung offen');
  });

  it('A2: Kontierungsbestätigung bleibt nach der Zahlung gesperrt', () => {
    const offen = anlegen();
    expect(zahle(offen.id, 119).success).toBe(true);
    const danach = getExpenseFromStoreById(offen.id)!;
    ensureExpenseAccountingAssignment(danach);
    const kontierung = getAccountingAssignmentForSource('expense', offen.id)!;
    expect(kontierung.status).toBe('needs_clarification');
    expect(updateAccountingAssignment(kontierung.id, { accountNumber: '3400' }).success).toBe(true);
    expect(confirmAccountingAssignment(kontierung.id, { sourceTaxTreatment: 'standard_19', sourceTaxSplitOpen: true })).toEqual({
      success: false,
      errorKey: 'accounting.confirmNeedsTaxSplit',
    });
  });

  it('A3: Monatsabschluss gesperrt — im Belegmonat (tax_split_open) und im Zahlungsmonat (tax_split_open_payment)', () => {
    const offen = anlegen({ issueDate: '2026-10-15' });
    expect(zahle(offen.id, 119, '2026-11-05').success).toBe(true);
    expect(blocker('2026-10', 'tax_split_open')).toEqual([offen.id]);
    expect(blocker('2026-11', 'tax_split_open_payment')).toEqual([offen.id]);
    // Liegt die Zahlung im Belegmonat, steht der Beleg nur unter tax_split_open (keine doppelte Meldung).
    const gleich = anlegen({ issueDate: '2026-10-16' });
    expect(zahle(gleich.id, 119, '2026-10-20').success).toBe(true);
    expect(blocker('2026-10', 'tax_split_open_payment')).toEqual([]);
  });

  it('A4: gültige Klärung nach der Zahlung — danach Kontierung bestätigbar, Monate frei', () => {
    const offen = anlegen({ issueDate: '2026-10-15' });
    expect(zahle(offen.id, 119, '2026-11-05').success).toBe(true);
    const klaerung = updateExpense(offen.id, { taxSplit: 'belegt', netAmount: 100, taxAmount: 19 });
    expect(klaerung.success, JSON.stringify(klaerung)).toBe(true);
    expect(zustand(offen.id)).toBe('belegt');
    expect(getExpenseFromStoreById(offen.id)!.payments).toHaveLength(1);
    ensureExpenseAccountingAssignment(getExpenseFromStoreById(offen.id)!);
    const kontierung = getAccountingAssignmentForSource('expense', offen.id)!;
    expect(updateAccountingAssignment(kontierung.id, { accountNumber: '3400' }).success).toBe(true);
    expect(confirmAccountingAssignment(kontierung.id, { sourceTaxTreatment: 'standard_19', sourceTaxSplitOpen: false }).success).toBe(true);
    expect(blocker('2026-10', 'tax_split_open')).toEqual([]);
    expect(blocker('2026-11', 'tax_split_open_payment')).toEqual([]);
  });

  it('A5: nach der Zahlung bleibt das Brutto gebunden; nur die Klärung ist erlaubt', () => {
    const offen = anlegen();
    expect(zahle(offen.id, 50).success).toBe(true);
    expect(updateExpense(offen.id, { grossAmount: 120 })).toEqual({ success: false, errorKey: 'expense.edit.amountLockedAfterPayment' });
    expect(updateExpense(offen.id, { taxSplit: 'belegt', grossAmount: 120, netAmount: 100, taxAmount: 20 })).toEqual({
      success: false,
      errorKey: 'expense.edit.amountLockedAfterPayment',
    });
    // Ein Wechsel innerhalb von „offen“ (anderer Steuersatz, weiter ungeklärt) ist keine Klärung.
    expect(updateExpense(offen.id, { taxStatus: 'standard_7', taxSplit: 'offen' })).toEqual({
      success: false,
      errorKey: 'expense.edit.amountLockedAfterPayment',
    });
    // Klärung als Beleg ohne Umsatzsteuer ist erlaubt.
    expect(updateExpense(offen.id, { taxStatus: 'kleinunternehmer_19' }).success).toBe(true);
    expect(zustand(offen.id)).toBe('steuerfrei');
    // Danach ist der geklärte Beleg wieder ganz gebunden.
    expect(updateExpense(offen.id, { taxStatus: 'standard_19', taxSplit: 'belegt', netAmount: 100, taxAmount: 19 })).toEqual({
      success: false,
      errorKey: 'expense.edit.amountLockedAfterPayment',
    });
  });

  it('A6: Teilzahlungen und Überzahlung — Status mit Zusatz „Steuerprüfung offen“', () => {
    const offen = anlegen();
    expect(zahle(offen.id, 50).success).toBe(true);
    const teil = calculateExpensePaymentSummary(getExpenseFromStoreById(offen.id)!);
    expect(teil.status).toBe('teilbezahlt');
    expect(expensePaymentStatusLabel(teil.status, de, true)).toBe(`${de('payment.status.teilbezahlt')} – Steuerprüfung offen`);
    // Der Hinweis „Als Nächstes“ gilt für Teil- und Vollzahlung — er behauptet kein „Bezahlt“ (Browserbefund 27.10.).
    expect(de('expense.taxSplit.nextActionPaid')).toMatch(/^Zahlung erfasst – Steuerprüfung offen\./);
    expect(zahle(offen.id, 69).success).toBe(true);
    // Mehr als offen nur mit ausdrücklicher Überzahlungsbestätigung (unverändert).
    expect(zahle(offen.id, 10).success).toBe(false);
    expect(getExpenseFromStoreById(offen.id)!.payments).toHaveLength(2);
    expect(calculateExpensePaymentSummary(getExpenseFromStoreById(offen.id)!).status).toBe('bezahlt');
    expect(zustand(offen.id)).toBe('offen');
  });

  it('A7: Bankabgleich — kein Ablehnungsgrund mehr, Hinweis „Steuerprüfung offen“; nach voller Zahlung nichts offen', () => {
    resetBankReconciliationsForTests();
    hydrateInvoiceStore([]);
    const offen = anlegen();
    const bewegung = {
      id: 'btx-z', accountKey: 'bacc-z', importId: 'imp-z', fileName: 'z.csv', importedAt: '2026-10-21T08:00:00.000Z',
      bookingDate: '2026-10-21', amountCents: -11900, currency: 'EUR', counterparty: 'Z Lieferant GmbH',
      purpose: offen.invoiceNumber, fingerprint: 'f-z', occurrence: 1,
    } as BankTransaction;
    const kandidat = {
      targetType: 'expense', targetId: offen.id, documentNumber: offen.invoiceNumber, partyName: offen.supplierName,
      openCents: 11900, grade: 'sehr_passend', reasons: [],
    } as BankSuggestionCandidate;
    const plan = planBankConfirmation(bewegung, kandidat);
    expect([plan.refusal, plan.taxReviewOpen]).toEqual([null, true]);
    // Schon von Hand voll bezahlt: kein offener Betrag, also keine zweite Buchung über den Bankabgleich.
    expect(zahle(offen.id, 119).success).toBe(true);
    expect(planBankConfirmation(bewegung, kandidat).refusal).toBe('nothing_open');
  });
});

describe('B — Nullsteuer', () => {
  it('B1: „unklar“ mit 0 € Steuer — Neuanlage und Bearbeitung abgewiesen, mit demselben Hinweis', () => {
    expect(addExpense(input({ taxStatus: 'unclear', netAmount: 119, taxAmount: 0 }))).toEqual({
      success: false,
      errorKey: 'expense.taxSplit.zeroTaxUnclear',
    });
    expect(addExpense(input({ taxStatus: 'unclear', taxSplit: 'gemischt', netAmount: 119, taxAmount: 0 }))).toEqual({
      success: false,
      errorKey: 'expense.taxSplit.zeroTaxUnclear',
    });
    const mitSteuer = anlegen({ taxStatus: 'unclear', netAmount: 100, taxAmount: 19 });
    expect(updateExpense(mitSteuer.id, { taxSplit: 'belegt', netAmount: 119, taxAmount: 0 })).toEqual({
      success: false,
      errorKey: 'expense.taxSplit.zeroTaxUnclear',
    });
    const offen = anlegen();
    expect(updateExpense(offen.id, { taxStatus: 'unclear', taxSplit: 'belegt', netAmount: 119, taxAmount: 0 })).toEqual({
      success: false,
      errorKey: 'expense.taxSplit.zeroTaxUnclear',
    });
    expect(resolveExpenseTaxSplitState(getExpenseById(offen.id)!)).toBe('offen');
  });

  it('B2: begründete Nullsteuer — Beleg ohne Umsatzsteuer über den Steuerstatus (Neuanlage und Bearbeitung)', () => {
    for (const taxStatus of ['tax_free', 'kleinunternehmer_19', 'reverse_charge_13b'] as const) {
      expect(resolveExpenseTaxSplitState(anlegen({ taxStatus }))).toBe('steuerfrei');
    }
    const offen = anlegen();
    expect(updateExpense(offen.id, { taxStatus: 'tax_free' }).success).toBe(true);
    expect(resolveExpenseTaxSplitState(getExpenseById(offen.id)!)).toBe('steuerfrei');
  });

  it('B3: nicht abziehbare Vorsteuer ist keine Nullsteuer — Steuer eintragen, Abzug „keiner“', () => {
    const beleg = anlegen({ taxSplit: 'belegt', netAmount: 100, taxAmount: 19, inputTaxDeduction: 'keiner' });
    expect(resolveExpenseTaxSplitState(beleg)).toBe('belegt');
    expect([beleg.taxAmount, beleg.inputTaxDeduction]).toEqual([19, 'keiner']);
    // 0 € bei 19 % bleibt abgewiesen; der Hinweis nennt den Weg „Nicht abziehbar“.
    expect(addExpense(input({ taxSplit: 'belegt', netAmount: 119, taxAmount: 0 }))).toEqual({
      success: false,
      errorKey: 'expense.taxSplit.zeroTaxForTaxableStatus',
    });
    expect(de('expense.taxSplit.zeroTaxForTaxableStatus')).toContain('Nicht abziehbar');
  });

  it('B4: Altbestand „unklar“ + belegt + 0 € — keine stille Umdeutung; erst eine Geldänderung braucht die Begründung', () => {
    const alt = normalizeExpense({
      id: 'exp-z-alt', status: 'gebucht', category: 'material', supplierName: 'Z Alt', invoiceNumber: 'Z-ALT', title: 'Z Alt',
      issueDate: '2026-10-03', taxStatus: 'unclear', netAmount: 119, taxAmount: 0, grossAmount: 119, taxSplit: 'belegt',
    } as Expense);
    setExpenseStoreForTests([alt]);
    expect(resolveExpenseTaxSplitState(alt)).toBe('belegt');
    expect(updateExpense(alt.id, { title: 'Z Alt umbenannt' }).success).toBe(true);
    const danach = getExpenseFromStoreById(alt.id)!;
    expect([danach.taxSplit, danach.netAmount, danach.taxAmount, danach.title]).toEqual(['belegt', 119, 0, 'Z Alt umbenannt']);
    expect(updateExpense(alt.id, { grossAmount: 120 })).toEqual({ success: false, errorKey: 'expense.taxSplit.zeroTaxUnclear' });
    expect(getExpenseFromStoreById(alt.id)!.grossAmount).toBe(119);
  });

  it('B5: alle neuen Texte stehen in de, tr und bg', () => {
    const keys = [
      'expense.taxSplit.zeroTaxUnclear', 'expense.payment.taxReviewOpenNotice', 'expense.payment.taxReviewAck',
      'expense.payment.taxReviewAckRequired', 'expense.payment.statusTaxReviewOpen', 'bankConfirm.taxReviewOpenNotice',
      'accountingPeriod.blocker.tax_split_open_payment', 'expense.taxSplit.nextActionPaid', 'expense.edit.grossLockedTaxReviewHint',
    ];
    for (const key of keys) {
      for (const sprache of ['de', 'tr', 'bg'] as const) {
        const text = t(key as TranslationKey, sprache);
        expect(text, `${sprache} ${key}`).not.toBe(key);
        expect(text.length, `${sprache} ${key}`).toBeGreaterThan(10);
      }
    }
    // Die alten Sperrtexte gibt es nicht mehr (sie versprachen eine Zahlungssperre).
    expect(de('expense.taxSplit.detailOpenNotice')).toContain('tatsächlich erfolgte Zahlung');
    expect(de('expense.taxSplit.openHint')).not.toMatch(/Zahlung, Bankabgleich/);
  });
});
