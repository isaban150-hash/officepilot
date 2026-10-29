/**
 * P1-KORREKTURBLOCK A-04 — die Steueraufteilung einer Ausgabe.
 *
 * WEISS-Befund: 119,00 € brutto, Steuerstatus 19 %, ohne Netto- und Steuerangabe → gespeichert und weitergegeben als
 * 119,00 € netto und 0,00 € Steuer, also als bestätigte Nullsteuer. Geprüft wird an den echten Diensten:
 *
 *  A  Erfassen: belegt, gemischt, steuerfrei, offen, Vorsteuerabzug voll/teilweise/keiner, Gutschrift
 *  B  Ändern: offen nachtragen, Altbestand unverändert, Zahlungssperre, Zuordnungen
 *  C  Sperren: Zahlung, Auftragszuordnung, Bankabgleich, Kontierung, Monatsabschluss
 *  D  Weitergabe: Monatsmappe, Abschluss-Fingerprint (serverseitig nachgebaut), buchungen.csv, Datenexport, Übergabe
 *  E  Laden, Abgleich und lesende Bestandsprüfung
 *
 * Synthetische Daten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addExpense,
  assignExpenseToVorgang,
  getExpenseById,
  updateExpense,
} from '../expenseService';
import { canRecordExpensePayment, recordExpensePayment } from '../expensePaymentService';
import { getExpenseFromStoreById, setExpenseStoreForTests } from '../expenseStore';
import { normalizeExpense } from '../expenseNormalize';
import {
  auditLegacyExpenseTaxSplits,
  describeExpenseTaxSplitHint,
  expenseBookingAmounts,
  isExpenseTaxSplitOpen,
  planExpenseTaxSplit,
  resolveExpenseInputTaxDeduction,
  resolveExpenseTaxSplitState,
  TAX_SPLIT_OPEN_HINT,
} from './expenseTaxSplit';
import { buildExpensePushPayload, mapCloudExpenseRow } from './expenseCloudSyncService';
import { suggestExpenseAccounting } from '../accounting/accountingSuggestionService';
import {
  confirmAccountingAssignment,
  ensureExpenseAccountingAssignment,
  updateAccountingAssignment,
} from '../accounting/accountingAssignmentService';
import { getAccountingAssignmentForSource } from '../accounting/accountingStore';
import { collectPeriodBlockers } from '../accounting/accountingPeriodService';
import { buildPeriodCanonicalText, buildPeriodManifest } from '../accounting/accountingPeriodFingerprint';
import { buildBookingExport } from '../accounting/accountingBookingExportService';
import { buildMonatsmappeModel, buildUebersichtCsv, type MonatsmappeInput } from '../steuerberater/monatsmappeModelService';
import { buildDataExportCsvFiles, type CloudStatusLookup } from '../export/dataExportAreas';
import { planBankConfirmation } from '../bank/bankReconciliationService';
import { resetBankReconciliationsForTests } from '../bank/bankReconciliationStore';
import { hydrateVorgangStore } from '../vorgangService';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import { resetTestStores } from '../../test/resetStores';
import { createTestVorgang } from '../../test/fixtures';
import type { AccountingAssignment } from '../../types/accounting';
import type { AppPersistedState } from '../../types/models';
import type { BankSuggestionCandidate } from '../../types/bankSuggestion';
import type { BankTransaction } from '../../types/bankTransaction';
import type { Expense, ExpenseInput } from '../../types/expense';

/* ------------------------------------------------------------------ */

let nummer = 0;
function input(overrides: Partial<ExpenseInput> = {}): ExpenseInput {
  nummer += 1;
  return {
    title: 'A04 Testmaterial',
    category: 'material',
    supplierName: 'A04 Testlieferant GmbH',
    invoiceNumber: `A04-${nummer}`,
    issueDate: '2026-05-12',
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

/** Ein gespeicherter Beleg an der Validierung vorbei — so sieht der Altbestand vor A-04 aus (ohne Kennzeichen). */
function altbestand(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-a04-alt',
    status: 'gebucht',
    category: 'material',
    supplierName: 'A04 Altlieferant',
    invoiceNumber: 'A04-ALT-1',
    title: 'A04 Altbeleg',
    issueDate: '2026-05-04',
    taxStatus: 'standard_19',
    netAmount: 119,
    taxAmount: 0,
    grossAmount: 119,
    ...overrides,
  } as Expense);
}

const leererMonat: Omit<MonatsmappeInput, 'expenses'> = {
  monthKey: '2026-05',
  invoices: [],
  documents: [],
  inboxItems: [],
  fileRefs: [],
};

function mappe(expenses: Expense[]) {
  return buildMonatsmappeModel({ ...leererMonat, expenses });
}

function bestaetigteKontierung(expense: Expense, overrides: Partial<AccountingAssignment> = {}): AccountingAssignment {
  return {
    id: `acc-${expense.id}`,
    sourceType: 'expense',
    sourceId: expense.id,
    chartOfAccounts: 'SKR03',
    accountNumber: '3400',
    accountLabel: 'Wareneingang',
    taxTreatment: expense.taxStatus,
    bookingText: 'A04 Testlieferant',
    status: 'confirmed',
    origin: 'manual',
    createdAt: '2026-05-12T08:00:00.000Z',
    updatedAt: '2026-05-12T08:00:00.000Z',
    ...overrides,
  };
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

describe('A — Erfassen: jede Steuerlage für sich', () => {
  it('A1 (WEISS-Befund): 119 € brutto, 19 %, ohne Netto/Steuer → offen, keine bestätigte Nullsteuer', () => {
    const expense = anlegen();
    expect(expense.taxSplit).toBe('offen');
    expect(resolveExpenseTaxSplitState(expense)).toBe('offen');
    expect(isExpenseTaxSplitOpen(expense)).toBe(true);
    // Gespeichert sind nur Platzhalter für den Serververtrag — weitergegeben wird davon nichts.
    expect([expense.netAmount, expense.taxAmount, expense.grossAmount]).toEqual([119, 0, 119]);
    expect(expenseBookingAmounts(expense)).toEqual({ netto: null, steuer: null });
    expect(describeExpenseTaxSplitHint(expense)).toContain('Steueraufteilung offen');
    // Nach dem Neuladen derselbe Zustand.
    expect(resolveExpenseTaxSplitState(getExpenseById(expense.id)!)).toBe('offen');
  });

  it('A2: nichts wird aus dem Steuersatz geschätzt (keine Division durch 1,19)', () => {
    const offen = anlegen({ grossAmount: 238 });
    expect(offen.netAmount).not.toBe(200);
    expect(offen.taxAmount).not.toBe(38);
    const plan = planExpenseTaxSplit({ grossAmount: 119, taxStatus: 'standard_7' });
    expect(plan).toMatchObject({ ok: true, taxSplit: 'offen', netAmount: 119, taxAmount: 0 });
  });

  it('A3: „belegt“ verlangt Beträge — ohne sie keine Speicherung', () => {
    const result = addExpense(input({ taxSplit: 'belegt' }));
    expect(result).toEqual({ success: false, errorKey: 'expense.taxSplit.amountsRequired' });
    const gemischt = addExpense(input({ taxSplit: 'gemischt' }));
    expect(gemischt).toEqual({ success: false, errorKey: 'expense.taxSplit.amountsRequired' });
  });

  it('A4: nachgewiesene Aufteilung — der fehlende Wert ist die Differenz zweier Belegzahlen', () => {
    const mitSteuer = anlegen({ taxSplit: 'belegt', taxAmount: 19 });
    expect([mitSteuer.netAmount, mitSteuer.taxAmount, mitSteuer.taxSplit]).toEqual([100, 19, 'belegt']);
    const mitNetto = anlegen({ taxSplit: 'belegt', netAmount: 100 });
    expect([mitNetto.netAmount, mitNetto.taxAmount]).toEqual([100, 19]);
    expect(resolveExpenseTaxSplitState(mitNetto)).toBe('belegt');
    // Ältere Aufrufer ohne Kennzeichen, aber mit Beträgen: belegt wie bisher.
    const ohneKennzeichen = anlegen({ netAmount: 100, taxAmount: 19 });
    expect(ohneKennzeichen.taxSplit).toBe('belegt');
  });

  it('A5: 0 € Steuer bei 19 % oder 7 % ist kein Belegwert', () => {
    expect(addExpense(input({ taxSplit: 'belegt', taxAmount: 0 }))).toEqual({
      success: false,
      errorKey: 'expense.taxSplit.zeroTaxForTaxableStatus',
    });
    expect(addExpense(input({ taxStatus: 'standard_7', netAmount: 119, taxAmount: 0 }))).toEqual({
      success: false,
      errorKey: 'expense.taxSplit.zeroTaxForTaxableStatus',
    });
  });

  it.each([
    ['tax_free'],
    ['kleinunternehmer_19'],
    ['reverse_charge_13b'],
  ] as const)('A6: echte Nullsteuer (%s) ohne Angaben → steuerfrei, belegt, nicht offen', (taxStatus) => {
    const expense = anlegen({ taxStatus });
    expect([expense.netAmount, expense.taxAmount]).toEqual([119, 0]);
    expect(resolveExpenseTaxSplitState(expense)).toBe('steuerfrei');
    expect(isExpenseTaxSplitOpen(expense)).toBe(false);
    expect(expenseBookingAmounts(expense)).toEqual({ netto: 119, steuer: 0 });
    expect(describeExpenseTaxSplitHint(expense)).toBeUndefined();
    // Eine Steuer bleibt bei diesen Status abgelehnt (05B).
    expect(addExpense(input({ taxStatus, taxAmount: 19 })).success).toBe(false);
  });

  it('A7 (Produktregel B, 27.10.2026): Steuerstatus unklar ohne Beträge → offen; 0 € Steuer bei „unklar“ ist keine Klärung', () => {
    expect(resolveExpenseTaxSplitState(anlegen({ taxStatus: 'unclear' }))).toBe('offen');
    // Bisher galt „unklar“ + 0 € ausdrücklich als belegt; jetzt dieselbe Abweisung wie bei 19 %/7 % (Server ebenso).
    expect(addExpense(input({ taxStatus: 'unclear', netAmount: 119, taxAmount: 0 }))).toEqual({
      success: false,
      errorKey: 'expense.taxSplit.zeroTaxUnclear',
    });
    // Mit ausgewiesener Steuer bleibt „unklar“ möglich; die Kontierung bleibt wegen des Status in Klärung.
    const mitSteuer = anlegen({ taxStatus: 'unclear', netAmount: 100, taxAmount: 19 });
    expect(resolveExpenseTaxSplitState(mitSteuer)).toBe('belegt');
    expect(suggestExpenseAccounting({ expense: mitSteuer }).status).toBe('needs_clarification');
  });

  it('A8: gemischte Steuersätze — Summen laut Beleg, kenntlich gemacht', () => {
    // 50 € netto zu 19 % (9,50) + 50 € netto zu 7 % (3,50) = 100 netto, 13 Steuer, 113 brutto.
    const expense = anlegen({ taxSplit: 'gemischt', grossAmount: 113, netAmount: 100, taxAmount: 13 });
    expect([expense.netAmount, expense.taxAmount, expense.taxSplit]).toEqual([100, 13, 'gemischt']);
    expect(resolveExpenseTaxSplitState(expense)).toBe('gemischt');
    expect(describeExpenseTaxSplitHint(expense)).toContain('Gemischte Steuersätze');
    expect(expenseBookingAmounts(expense)).toEqual({ netto: 100, steuer: 13 });
  });

  it('A9: Vorsteuerabzug teilweise — Betrag zwischen 0 und der Steuer, gleiches Vorzeichen', () => {
    const teilweise = anlegen({ taxSplit: 'belegt', taxAmount: 19, inputTaxDeduction: 'teilweise', deductibleTaxAmount: 9.5 });
    expect(resolveExpenseInputTaxDeduction(teilweise)).toBe('teilweise');
    expect(teilweise.deductibleTaxAmount).toBe(9.5);
    expect(describeExpenseTaxSplitHint(teilweise)).toContain('Vorsteuer teilweise abziehbar: 9,50 €');
    for (const deductibleTaxAmount of [undefined, 0, 19, 20, -5]) {
      expect(
        addExpense(input({ taxSplit: 'belegt', taxAmount: 19, inputTaxDeduction: 'teilweise', deductibleTaxAmount })),
        String(deductibleTaxAmount),
      ).toEqual({ success: false, errorKey: 'expense.inputTaxDeduction.amountInvalid' });
    }
  });

  it('A10: Vorsteuer nicht abziehbar — und voll ist der Normalfall ohne Angabe', () => {
    const keiner = anlegen({ taxSplit: 'belegt', taxAmount: 19, inputTaxDeduction: 'keiner' });
    expect(resolveExpenseInputTaxDeduction(keiner)).toBe('keiner');
    expect(keiner.deductibleTaxAmount).toBeUndefined();
    expect(describeExpenseTaxSplitHint(keiner)).toBe('Vorsteuer nicht abziehbar');
    const voll = anlegen({ taxSplit: 'belegt', taxAmount: 19 });
    expect(resolveExpenseInputTaxDeduction(voll)).toBe('voll');
    expect(describeExpenseTaxSplitHint(voll)).toBeUndefined();
    // Ohne Steuer gibt es nichts abzuziehen.
    expect(resolveExpenseInputTaxDeduction(anlegen({ taxStatus: 'tax_free' }))).toBeUndefined();
  });

  it('A11: Gutschrift — Vorzeichen bleiben, teilweiser Abzug ebenfalls negativ', () => {
    const gutschrift = anlegen({ grossAmount: -119, taxAmount: -19, taxSplit: 'belegt', inputTaxDeduction: 'teilweise', deductibleTaxAmount: -9.5 });
    expect([gutschrift.netAmount, gutschrift.taxAmount, gutschrift.deductibleTaxAmount]).toEqual([-100, -19, -9.5]);
    expect(
      addExpense(input({ grossAmount: -119, taxAmount: -19, taxSplit: 'belegt', inputTaxDeduction: 'teilweise', deductibleTaxAmount: 9.5 })),
    ).toEqual({ success: false, errorKey: 'expense.inputTaxDeduction.amountInvalid' });
    // Eine Gutschrift ohne Aufteilung ist ebenso offen.
    expect(resolveExpenseTaxSplitState(anlegen({ grossAmount: -119 }))).toBe('offen');
  });
});

/* ================================================================== */

describe('B — Ändern', () => {
  it('B1: Titeländerung an einer offenen Ausgabe lässt sie offen und unverändert', () => {
    const offen = anlegen();
    const result = updateExpense(offen.id, { title: 'A04 neuer Titel' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.expense.taxSplit).toBe('offen');
    expect([result.expense.netAmount, result.expense.taxAmount]).toEqual([119, 0]);
  });

  it('B2: offen → belegt nachtragen; die Kontierung geht von „Klärung“ zurück in die Prüfung', () => {
    const offen = anlegen();
    ensureExpenseAccountingAssignment(offen);
    const vorher = getAccountingAssignmentForSource('expense', offen.id)!;
    expect(vorher.status).toBe('needs_clarification');
    expect(vorher.suggestionReason).toBe('accounting.reason.taxSplitOpen');

    const result = updateExpense(offen.id, { taxSplit: 'belegt', taxAmount: 19 });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (!result.success) return;
    expect([result.expense.netAmount, result.expense.taxAmount, result.expense.taxSplit]).toEqual([100, 19, 'belegt']);
    const nachher = getAccountingAssignmentForSource('expense', offen.id)!;
    expect(nachher.status).toBe('needs_review');
    // Abschluss-Rundgang R-05: eigene Begründung — „nach der Bestätigung geändert“ wäre falsch (nie bestätigt).
    expect(nachher.suggestionReason).toBe('accounting.reason.taxSplitEntered');
  });

  it('B3: belegt → offen setzt eine bestätigte Kontierung in die Klärung', () => {
    const belegt = anlegen({ taxSplit: 'belegt', taxAmount: 19 });
    ensureExpenseAccountingAssignment(belegt);
    const kontierung = getAccountingAssignmentForSource('expense', belegt.id)!;
    expect(updateAccountingAssignment(kontierung.id, { accountNumber: '3400' }).success).toBe(true);
    expect(confirmAccountingAssignment(kontierung.id, { sourceTaxTreatment: 'standard_19' }).success).toBe(true);

    const result = updateExpense(belegt.id, { taxSplit: 'offen' });
    expect(result.success, JSON.stringify(result)).toBe(true);
    const nachher = getAccountingAssignmentForSource('expense', belegt.id)!;
    expect(nachher.status).toBe('needs_clarification');
    expect(nachher.suggestionReason).toBe('accounting.reason.taxSplitOpen');
  });

  it('B4: Altbestand — Ändern von Titel/Ablage lässt Beträge und Befund exakt stehen (keine Umrechnung)', () => {
    const alt = altbestand();
    setExpenseStoreForTests([alt]);
    expect(resolveExpenseTaxSplitState(alt)).toBe('altbestand_pruefen');
    const result = updateExpense(alt.id, { title: 'A04 Altbeleg umbenannt', description: 'nur Text' });
    expect(result.success, JSON.stringify(result)).toBe(true);
    const gespeichert = getExpenseFromStoreById(alt.id)!;
    expect([gespeichert.netAmount, gespeichert.taxAmount, gespeichert.grossAmount]).toEqual([119, 0, 119]);
    expect(gespeichert.taxSplit).toBeUndefined();
    expect(resolveExpenseTaxSplitState(gespeichert)).toBe('altbestand_pruefen');
  });

  it('B5: Altbestand ausdrücklich korrigieren — mit belegter Steuer', () => {
    setExpenseStoreForTests([altbestand()]);
    const result = updateExpense('exp-a04-alt', { taxSplit: 'belegt', taxAmount: 19 });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (!result.success) return;
    expect([result.expense.netAmount, result.expense.taxAmount]).toEqual([100, 19]);
    expect(resolveExpenseTaxSplitState(result.expense)).toBe('belegt');
  });

  it('B6: nach einer Zahlung bleibt alles fest — auch eine nur aus der Aufteilung folgende Betragsänderung', () => {
    const belegt = anlegen({ taxSplit: 'belegt', taxAmount: 19 });
    expect(recordExpensePayment(belegt.id, { date: '2026-05-20', amount: 50 }).success).toBe(true);
    expect(updateExpense(belegt.id, { title: 'nur Titel' }).success).toBe(true);
    expect(updateExpense(belegt.id, { taxSplit: 'offen' })).toEqual({
      success: false,
      errorKey: 'expense.edit.amountLockedAfterPayment',
    });
    expect(updateExpense(belegt.id, { taxSplit: 'belegt', taxAmount: 7 })).toEqual({
      success: false,
      errorKey: 'expense.edit.amountLockedAfterPayment',
    });
  });

  it('B7: ältere Aufrufer ohne Kennzeichen — eine offene Ausgabe bleibt bei neuem Brutto offen', () => {
    const offen = anlegen();
    const result = updateExpense(offen.id, { grossAmount: 238 });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (!result.success) return;
    expect([result.expense.netAmount, result.expense.taxAmount, result.expense.taxSplit]).toEqual([238, 0, 'offen']);
  });

  it('B8: eine Ausgabe mit Auftragszuordnung lässt sich nicht auf „offen“ setzen', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'vg-a04', title: 'A04 Testauftrag', customer: 'A04 Testkunde' })]);
    const belegt = anlegen({ taxSplit: 'belegt', taxAmount: 19 });
    expect(assignExpenseToVorgang(belegt.id, { vorgangId: 'vg-a04', amount: 40 }).success).toBe(true);
    expect(updateExpense(belegt.id, { taxSplit: 'offen' })).toEqual({
      success: false,
      errorKey: 'expense.taxSplit.openWithAllocations',
    });
  });
});

/* ================================================================== */

describe('C — Sperren bei offener Steueraufteilung', () => {
  it('C1 (Produktregel A, 27.10.2026): Zahlung möglich, aber nur bestätigt — die Steueraufteilung bleibt offen', () => {
    const offen = anlegen();
    expect(canRecordExpensePayment(offen)).toBe(true);
    // Ohne ausdrückliche Bestätigung „tatsächlich erfolgt“ keine Zahlung.
    expect(recordExpensePayment(offen.id, { date: '2026-05-20', amount: 119 })).toEqual({
      success: false,
      errorKey: 'expense.payment.taxReviewAckRequired',
    });
    expect(getExpenseFromStoreById(offen.id)!.payments).toEqual([]);
    const bezahlt = recordExpensePayment(offen.id, { date: '2026-05-20', amount: 119 }, { confirmTaxReviewOpen: true });
    expect(bezahlt.success, JSON.stringify(bezahlt)).toBe(true);
    const danach = getExpenseFromStoreById(offen.id)!;
    expect(danach.payments).toHaveLength(1);
    // Keine automatische Steuerfreigabe: Beleg unverändert offen, Netto/Steuer weiter Platzhalter.
    expect(resolveExpenseTaxSplitState(danach)).toBe('offen');
    expect([danach.taxSplit, danach.netAmount, danach.taxAmount]).toEqual(['offen', 119, 0]);
    // Nach der Zahlung bleibt die Klärung möglich (Brutto unverändert).
    expect(updateExpense(offen.id, { taxSplit: 'belegt', taxAmount: 19 }).success).toBe(true);
    expect(resolveExpenseTaxSplitState(getExpenseById(offen.id)!)).toBe('belegt');
  });

  it('C2: keine Auftragszuordnung', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'vg-a04', title: 'A04 Testauftrag', customer: 'A04 Testkunde' })]);
    const offen = anlegen();
    expect(assignExpenseToVorgang(offen.id, { vorgangId: 'vg-a04' })).toEqual({
      success: false,
      errorKey: 'expense.allocation.taxSplitOpen',
    });
  });

  it('C3 (Produktregel A, 27.10.2026): Bankabgleich möglich — mit Hinweis, dass die Steuerprüfung offen bleibt', () => {
    resetBankReconciliationsForTests();
    hydrateInvoiceStore([]);
    const offen = anlegen();
    const bewegung = {
      id: 'btx-a04',
      accountKey: 'bacc-a04',
      importId: 'imp-a04',
      fileName: 'a04.csv',
      importedAt: '2026-05-21T08:00:00.000Z',
      bookingDate: '2026-05-21',
      amountCents: -11900,
      currency: 'EUR',
      counterparty: 'A04 Testlieferant GmbH',
      purpose: offen.invoiceNumber,
      fingerprint: 'f-a04',
      occurrence: 1,
    } as BankTransaction;
    const kandidat = {
      targetType: 'expense',
      targetId: offen.id,
      documentNumber: offen.invoiceNumber,
      partyName: offen.supplierName,
      openCents: 11900,
      grade: 'sehr_passend',
      reasons: [],
    } as BankSuggestionCandidate;
    const plan = planBankConfirmation(bewegung, kandidat);
    expect(plan.refusal).toBeNull();
    expect(plan.taxReviewOpen).toBe(true);
    // Nach der Klärung kein Hinweis mehr.
    expect(updateExpense(offen.id, { taxSplit: 'belegt', taxAmount: 19 }).success).toBe(true);
    expect(planBankConfirmation(bewegung, kandidat).taxReviewOpen).toBe(false);
  });

  it('C4: Kontierung — Vorschlag in Klärung, Bestätigung abgewiesen', () => {
    const offen = anlegen();
    expect(suggestExpenseAccounting({ expense: offen })).toMatchObject({
      status: 'needs_clarification',
      reason: 'accounting.reason.taxSplitOpen',
    });
    ensureExpenseAccountingAssignment(offen);
    const kontierung = getAccountingAssignmentForSource('expense', offen.id)!;
    expect(updateAccountingAssignment(kontierung.id, { accountNumber: '3400' }).success).toBe(true);
    expect(
      confirmAccountingAssignment(kontierung.id, { sourceTaxTreatment: 'standard_19', sourceTaxSplitOpen: true }),
    ).toEqual({ success: false, errorKey: 'accounting.confirmNeedsTaxSplit' });
  });

  it('C5: Monatsabschluss — offene Aufteilung sperrt; Altbestand und Storno sperren nicht', () => {
    const offen = anlegen();
    const belegt = anlegen({ taxSplit: 'belegt', taxAmount: 19 });
    const alt = altbestand();
    const storniertOffen = normalizeExpense({ ...anlegen(), status: 'storniert', cancelledAt: '2026-05-25T10:00:00.000Z', cancelReason: 'Test' });
    setExpenseStoreForTests([offen, belegt, alt, storniertOffen]);
    const model = mappe([offen, belegt, alt, storniertOffen]);
    const blockers = collectPeriodBlockers(buildPeriodManifest(model, [], 'SKR03', 5));
    const sperre = blockers.find((entry) => entry.code === 'tax_split_open');
    expect(sperre?.sourceIds).toEqual([offen.id]);
  });
});

/* ================================================================== */

describe('D — Weitergabe', () => {
  it('D1: Monatsmappe — offen steht leer, mit Hinweis und als unklarer Fall; Altbestand unverändert mit Prüfhinweis', () => {
    const offen = anlegen();
    const alt = altbestand();
    const model = mappe([offen, alt]);
    const offenerBeleg = model.eingangsbelege.find((beleg) => beleg.id === offen.id)!;
    expect(offenerBeleg.netto).toBeNull();
    expect(offenerBeleg.steuer).toBeNull();
    expect(offenerBeleg.brutto).toBe(119);
    expect(offenerBeleg.hinweis).toContain(TAX_SPLIT_OPEN_HINT);
    expect(model.offeneSteueraufteilung).toEqual([{ id: offen.id, belegnummer: offen.invoiceNumber }]);

    const alterBeleg = model.eingangsbelege.find((beleg) => beleg.id === alt.id)!;
    expect([alterBeleg.netto, alterBeleg.steuer]).toEqual([119, 0]);
    expect(alterBeleg.hinweis).toContain('Bitte prüfen: Altbestand');
    expect(alterBeleg.fingerprintBetraege).toBeUndefined();

    // Uebersicht.csv der Monatsmappe: Netto/Steuer leer, Hinweis in der Zeile; Altbestand mit seinen Werten.
    const zeilen = buildUebersichtCsv(model).replace(/^﻿/, '').split('\r\n').filter(Boolean);
    const kopf = zeilen[0].split(';');
    const zeile = (id: string) => zeilen.find((z) => z.includes(`;${id};`))!.split(';');
    expect(zeile(offen.id)[kopf.indexOf('Netto')]).toBe('');
    expect(zeile(offen.id)[kopf.indexOf('Steuer')]).toBe('');
    expect(zeilen.find((z) => z.includes(`;${offen.id};`))).toContain('Steueraufteilung offen');
    expect(zeile(alt.id)[kopf.indexOf('Steuer')]).toMatch(/^0(,00)?$/);
  });

  it('D1b: auch stornierte offene Ausgaben (Beleg und Stornobeleg) zählen je einmal als unklarer Fall', () => {
    const storniert = normalizeExpense({ ...anlegen(), status: 'storniert', cancelledAt: '2026-05-25T10:00:00.000Z', cancelReason: 'Test' });
    const model = mappe([storniert]);
    expect(model.eingangsbelege.map((beleg) => [beleg.status, beleg.netto])).toEqual([['storniert', null]]);
    expect(model.stornos.map((beleg) => [beleg.belegart, beleg.netto, beleg.steuer])).toEqual([['ausgabenstorno', null, null]]);
    expect(model.offeneSteueraufteilung).toEqual([{ id: storniert.id, belegnummer: storniert.invoiceNumber }]);
    // Kein Klärungsauftrag an der Kontierung einer stornierten Ausgabe — sie lässt sich nicht mehr nachtragen.
    expect(suggestExpenseAccounting({ expense: storniert }).reason).not.toBe('accounting.reason.taxSplitOpen');
  });

  it('D2: Abschluss-Fingerprint — gebunden bleibt das Gespeicherte, bytegleich mit dem Altbestand (Server baut Fassung 5 nach)', () => {
    const offen = altbestand({ id: 'exp-a04-fp', taxSplit: 'offen' });
    const ohneKennzeichen = altbestand({ id: 'exp-a04-fp' });
    for (const version of [2, 3, 4, 5] as const) {
      const mitOffen = buildPeriodCanonicalText(buildPeriodManifest(mappe([offen]), [], 'SKR03', version));
      const alt = buildPeriodCanonicalText(buildPeriodManifest(mappe([ohneKennzeichen]), [], 'SKR03', version));
      expect(mitOffen, `Fassung ${version}`).toBe(alt);
    }
    const v5 = buildPeriodCanonicalText(buildPeriodManifest(mappe([offen]), [], 'SKR03', 5));
    expect(v5).toContain('E|expense|exp-a04-fp|eingangsbeleg|2026-05-04|11900|11900|0|0|aktiv|');
    // Der Storno einer offenen Ausgabe bindet die negierten Platzhalter — wie der Server (-netto, -steuer).
    const storno = normalizeExpense({ ...offen, status: 'storniert', cancelledAt: '2026-05-20T10:00:00.000Z', cancelReason: 'Test' });
    const stornoText = buildPeriodCanonicalText(buildPeriodManifest(mappe([storno]), [], 'SKR03', 5));
    expect(stornoText).toContain('E|expense|exp-a04-fp|ausgabenstorno|2026-05-20|-11900|-11900|0|0|storno|');
  });

  it('D3: buchungen.csv — keine Buchungszeile aus einer offenen Aufteilung, auch nicht mit (fremd) bestätigter Kontierung', () => {
    const offen = anlegen();
    const exportStand = buildBookingExport(mappe([offen]), [bestaetigteKontierung(offen)], 'SKR03');
    expect(exportStand.rows).toEqual([]);
    expect(exportStand.netUnresolved).toEqual([
      { sourceId: offen.id, belegnummer: offen.invoiceNumber, grund: 'steueraufteilung_offen' },
    ]);
  });

  it('D4: buchungen.csv — gemischt und nicht voll abziehbar stehen als Zusatz am Steuerstatus; der Normalfall bleibt gleich', () => {
    const gemischt = anlegen({ taxSplit: 'gemischt', grossAmount: 113, netAmount: 100, taxAmount: 13 });
    const keiner = anlegen({ taxSplit: 'belegt', taxAmount: 19, inputTaxDeduction: 'keiner' });
    const teilweise = anlegen({ taxSplit: 'belegt', taxAmount: 19, inputTaxDeduction: 'teilweise', deductibleTaxAmount: 9.5 });
    const normal = anlegen({ taxSplit: 'belegt', taxAmount: 19 });
    const alle = [gemischt, keiner, teilweise, normal];
    const exportStand = buildBookingExport(mappe(alle), alle.map((e) => bestaetigteKontierung(e)), 'SKR03');
    const status = (id: string) => exportStand.rows.find((row) => row.sourceId === id)?.steuerstatus;
    expect(status(gemischt.id)).toBe('Umsatzsteuer 19 % – gemischte Steuersätze (Summen laut Beleg)');
    expect(status(keiner.id)).toBe('Umsatzsteuer 19 % – Vorsteuer nicht abziehbar');
    expect(status(teilweise.id)).toBe('Umsatzsteuer 19 % – Vorsteuer teilweise abziehbar (9,50)');
    expect(status(normal.id)).toBe('Umsatzsteuer 19 %');
    expect(exportStand.totals).toMatchObject({ netto: 400, steuer: 70 });
  });

  it('D5: Datenexport ausgaben.csv — offen leer, Altbestand unverändert gekennzeichnet, Vorsteuerabzug lesbar', () => {
    const offen = anlegen();
    const teilweise = anlegen({ taxSplit: 'belegt', taxAmount: 19, inputTaxDeduction: 'teilweise', deductibleTaxAmount: 9.5 });
    const alt = altbestand();
    const lookup: CloudStatusLookup = {
      entity: () => 'local',
      invoice: () => 'local',
      invoicePayment: () => 'local',
      expensePayment: () => 'local',
    };
    const dateien = buildDataExportCsvFiles({
      state: { expenses: [offen, teilweise, alt] } as unknown as AppPersistedState,
      sentEmails: [],
      role: 'local',
      lookup,
      files: [],
      invoiceNetCents: () => null,
      invoiceOpenAmount: () => 0,
    });
    const ausgaben = dateien.find((datei) => datei.area === 'ausgaben')!;
    const zeilen = ausgaben.content.split('\r\n').filter(Boolean);
    const kopf = zeilen[0].replace(/^﻿/, '').split(';');
    const spalte = (name: string) => kopf.indexOf(name);
    const zeile = (id: string) => zeilen.find((z) => z.startsWith(`${id};`))!.split(';');
    expect(kopf.slice(-5)).toEqual(['Steuerstatus', 'Steueraufteilung', 'Vorsteuerabzug', 'Abziehbare Vorsteuer', 'Cloud-Status']);

    const o = zeile(offen.id);
    expect([o[spalte('Netto')], o[spalte('Umsatzsteuer')], o[spalte('Brutto')]]).toEqual(['', '', '119,00']);
    expect(o[spalte('Steueraufteilung')]).toBe('offen – Netto und Vorsteuer nicht belegt');

    const a = zeile(alt.id);
    expect([a[spalte('Netto')], a[spalte('Umsatzsteuer')]]).toEqual(['119,00', '0,00']);
    expect(a[spalte('Steueraufteilung')]).toContain('Altbestand – bitte prüfen');

    const t = zeile(teilweise.id);
    expect([t[spalte('Netto')], t[spalte('Umsatzsteuer')], t[spalte('Vorsteuerabzug')], t[spalte('Abziehbare Vorsteuer')]]).toEqual([
      '100,00', '19,00', 'teilweise', '9,50',
    ]);
  });
});

/* ================================================================== */

describe('E — Laden, Abgleich, Bestandsprüfung', () => {
  it('E1: Laden behält die Kennzeichen und verwirft ungültige', () => {
    const geladen = normalizeExpense({ ...altbestand(), taxSplit: 'offen', inputTaxDeduction: 'teilweise', deductibleTaxAmount: 3 } as Expense);
    expect([geladen.taxSplit, geladen.inputTaxDeduction, geladen.deductibleTaxAmount]).toEqual(['offen', 'teilweise', 3]);
    const unsinn = normalizeExpense({ ...altbestand(), taxSplit: 'irgendwas', inputTaxDeduction: 'halb', deductibleTaxAmount: 3 } as never);
    expect([unsinn.taxSplit, unsinn.inputTaxDeduction, unsinn.deductibleTaxAmount]).toEqual([undefined, undefined, undefined]);
    // Der abziehbare Betrag gehört nur zu „teilweise“.
    const veraltet = normalizeExpense({ ...altbestand(), inputTaxDeduction: 'voll', deductibleTaxAmount: 3 } as Expense);
    expect(veraltet.deductibleTaxAmount).toBeUndefined();
  });

  it('E2: Cloud-Abgleich — das Kennzeichen reist im Payload und übersteht den Abzug', () => {
    const offen = anlegen();
    const push = buildExpensePushPayload(offen, false) as { payload: Record<string, unknown> };
    expect(push.payload.taxSplit).toBe('offen');
    const zurueck = mapCloudExpenseRow(
      {
        client_expense_id: offen.id,
        status: 'gebucht',
        payload: push.payload,
        dedupe_key: offen.dedupeKey,
        linked_inbox_id: null,
        archive_document_id: null,
      } as never,
      undefined,
      {} as never,
    );
    expect(resolveExpenseTaxSplitState(zurueck)).toBe('offen');
  });

  it('E3: Bestandsprüfung ist rein lesend und findet nur den Altbefund', () => {
    const alt = altbestand();
    const steuerfrei = altbestand({ id: 'exp-a04-frei', taxStatus: 'tax_free' });
    const belegt = altbestand({ id: 'exp-a04-belegt', netAmount: 100, taxAmount: 19 });
    const offen = altbestand({ id: 'exp-a04-offen', taxSplit: 'offen' });
    const bestand = [alt, steuerfrei, belegt, offen];
    const vorher = JSON.stringify(bestand);
    const befund = auditLegacyExpenseTaxSplits(bestand);
    expect(befund.map((entry) => entry.id)).toEqual([alt.id]);
    expect(befund[0]).toMatchObject({ taxStatus: 'standard_19', grossAmount: 119, hasPayments: false });
    expect(JSON.stringify(bestand)).toBe(vorher);
  });

  it('E4: ein Kennzeichen „offen“ mit nachgetragenen Beträgen (älterer Client) gilt als belegt', () => {
    const nachgetragen = altbestand({ taxSplit: 'offen', netAmount: 100, taxAmount: 19 });
    expect(resolveExpenseTaxSplitState(nachgetragen)).toBe('belegt');
    expect(expenseBookingAmounts(nachgetragen)).toEqual({ netto: 100, steuer: 19 });
  });
});
