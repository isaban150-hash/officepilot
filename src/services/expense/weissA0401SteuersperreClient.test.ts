/**
 * WEISS-A04-01 — die Client-Seite der Steuersperre.
 *
 * Befund (WEISS, 27.10.2026): Ein berechtigter Aufrufer konnte ein gespeichertes `taxSplit: "offen"` serverseitig durch
 * `taxSplit: null` entfernen; der Beleg galt danach als Altbestand und war für Zahlung, Kontierung und Abschluss frei.
 * Die Korrektur liegt im Server (Folgemigration 20261205120000, `upsert_workspace_expense`). Hier geprüft:
 *
 *  K1–K5  derselbe Übergang wie Serverregel (e): „offen“ endet nur mit belegter Steuer (≠ 0) oder einem Steuerstatus
 *         ohne Umsatzsteuer — der Client weist den einzigen sonst erreichbaren Randfall (Status „unklar“, „belegt“,
 *         0 € Steuer) vor dem Speichern ab, statt einen Auftrag zu erzeugen, den der Server endgültig abweist;
 *  K6     der Client sendet die Aufteilung immer ausdrücklich: Kennzeichen 1 als Zahl, nie `taxSplit: null`;
 *  K7     die neuen Servercodes gelten als endgültige Abweisung (kein endloses Wiederholen);
 *  K8     der Hinweistext steht in allen drei Sprachen.
 *
 * Synthetische Daten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addExpense, updateExpense } from '../expenseService';
import { getExpenseFromStoreById, setExpenseStoreForTests } from '../expenseStore';
import { resolveExpenseTaxSplitState } from './expenseTaxSplit';
import { buildExpensePushPayload } from './expenseCloudSyncService';
import { isFinalBusinessRejectionMessage } from '../sync/syncRoleDenial';
import { t } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import { resetTestStores } from '../../test/resetStores';
import type { Expense, ExpenseInput } from '../../types/expense';

let nummer = 0;
function anlegen(overrides: Partial<ExpenseInput> = {}): Expense {
  nummer += 1;
  const result = addExpense({
    title: 'W A04-01 Material',
    category: 'material',
    supplierName: 'W Lieferant GmbH',
    invoiceNumber: `W-${nummer}`,
    issueDate: '2026-11-12',
    taxStatus: 'standard_19',
    grossAmount: 119,
    ...overrides,
  });
  if (!result.success) throw new Error(JSON.stringify(result));
  return result.expense;
}

const zustand = (id: string) => resolveExpenseTaxSplitState(getExpenseFromStoreById(id)!);

beforeEach(() => {
  resetTestStores();
  setExpenseStoreForTests([]);
});

afterEach(() => {
  resetTestStores();
});

describe('WEISS-A04-01 — Übergang aus „offen“ (wie Serverregel e)', () => {
  it('K1: offen → Steuerstatus „unklar“, „belegt“ mit 0 € Steuer wird abgewiesen; der Beleg bleibt offen', () => {
    const offen = anlegen();
    expect(zustand(offen.id)).toBe('offen');
    const result = updateExpense(offen.id, { taxStatus: 'unclear', taxSplit: 'belegt', netAmount: 119, taxAmount: 0 });
    // Produktregel B (27.10.2026): Schon die Aufteilung weist 0 € bei „unklar“ ab — mit demselben Text wie die Neuanlage.
    expect(result).toEqual({ success: false, errorKey: 'expense.taxSplit.zeroTaxUnclear' });
    expect(zustand(offen.id)).toBe('offen');
    expect(getExpenseFromStoreById(offen.id)!.taxStatus).toBe('standard_19');
  });

  it('K2: offen → „belegt“ 100/19 bleibt die reguläre Klärung', () => {
    const offen = anlegen();
    const result = updateExpense(offen.id, { taxSplit: 'belegt', netAmount: 100, taxAmount: 19 });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(zustand(offen.id)).toBe('belegt');
  });

  it('K3: offen → Steuerstatus ohne Umsatzsteuer bleibt möglich (steuerfrei)', () => {
    const offen = anlegen();
    const result = updateExpense(offen.id, { taxStatus: 'tax_free' });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(zustand(offen.id)).toBe('steuerfrei');
  });

  it('K4: offen → Steuerstatus „unklar“ mit belegter Steuer 100/19 bleibt möglich', () => {
    const offen = anlegen();
    const result = updateExpense(offen.id, { taxStatus: 'unclear', taxSplit: 'belegt', netAmount: 100, taxAmount: 19 });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(zustand(offen.id)).toBe('belegt');
  });

  it('K5 (Produktregel B, 27.10.2026): dieselbe Regel für die Neuanlage — „unklar“ mit 0 € Steuer ist keine Klärung', () => {
    // Bisher war die Neuanlage erlaubt (nur der Übergang aus „offen“ gesperrt); jetzt gilt für beide dieselbe Regel.
    expect(addExpense({
      title: 'W A04-01 unklar 0',
      category: 'material',
      supplierName: 'W Lieferant GmbH',
      invoiceNumber: 'W-K5',
      issueDate: '2026-11-12',
      taxStatus: 'unclear',
      grossAmount: 119,
      netAmount: 119,
      taxAmount: 0,
    })).toEqual({ success: false, errorKey: 'expense.taxSplit.zeroTaxUnclear' });
    // Titeländerungen an einer offenen Ausgabe bleiben frei und lassen sie offen.
    const offen = anlegen();
    const titel = updateExpense(offen.id, { title: 'W neuer Titel' });
    expect(titel.success).toBe(true);
    expect(zustand(offen.id)).toBe('offen');
  });
});

describe('WEISS-A04-01 — was der Client sendet', () => {
  it('K6: Kennzeichen taxSplitSchema = 1 (Zahl); eine offene Aufteilung reist als „offen“, nie als null', () => {
    const offen = anlegen();
    const belegt = anlegen({ taxSplit: 'belegt', netAmount: 100, taxAmount: 19 });
    for (const [expense, erwartet] of [[offen, 'offen'], [belegt, 'belegt']] as const) {
      const push = buildExpensePushPayload(expense, false) as { payload: Record<string, unknown> };
      expect(push.payload.taxSplitSchema).toBe(1);
      expect(typeof push.payload.taxSplitSchema).toBe('number');
      expect(push.payload.taxSplit).toBe(erwartet);
      expect(JSON.stringify(push.payload)).not.toMatch(/"(taxSplit|taxSplitSchema|inputTaxDeduction|deductibleTaxAmount)":null/);
    }
  });

  it('K7: die neuen Servercodes sind endgültige Abweisungen', () => {
    expect(isFinalBusinessRejectionMessage('expense_tax_split_open_unresolved: offene Steueraufteilung nur mit belegter Steuer')).toBe(true);
    expect(isFinalBusinessRejectionMessage('expense_tax_split_schema_invalid: taxSplitSchema "1" ist unbekannt (erlaubt: 1)')).toBe(true);
  });

  it('K8: der Hinweistext steht in de, tr und bg', () => {
    const key = 'expense.taxSplit.openNeedsTax' as TranslationKey;
    for (const sprache of ['de', 'tr', 'bg'] as const) {
      const text = t(key, sprache);
      expect(text, sprache).not.toBe(key);
      expect(text.length, sprache).toBeGreaterThan(40);
    }
    expect(t(key, 'de')).toContain('Steuerstatus');
  });
});
