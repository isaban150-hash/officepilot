/**
 * P1-KORREKTURBLOCK A-04 — die Steueraufteilung an der Oberfläche: Formular (Erfassen, Bearbeiten, Altbestand,
 * gesperrte Beträge, Vorbelegung), Detailseite (Anzeige, Hinweise, gesperrte Aktionen) und Übersichtskarte.
 * Echte Komponenten, echte Dienste, synthetische Daten.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ExpenseForm } from './ExpenseForm';
import { ExpenseOverviewCard } from './ExpenseOverviewCard';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { AusgabeDetailPage } from '../../pages/AusgabeDetailPage';
import { addExpense, getAllExpenses, getExpenseById } from '../../services/expenseService';
import { calculateExpensePaymentSummary } from '../../services/expensePaymentService';
import { setExpenseStoreForTests } from '../../services/expenseStore';
import { normalizeExpense } from '../../services/expenseNormalize';
import { resolveExpenseTaxSplitState } from '../../services/expense/expenseTaxSplit';
import { resetTestStores } from '../../test/resetStores';
import { alsInhaber } from '../../test/workspaceRoleTestUtils';
import { t } from '../../i18n';
import type { Expense, ExpenseInput } from '../../types/expense';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  alsInhaber();
  resetTestStores();
  localStorage.clear();
  setExpenseStoreForTests([]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetTestStores();
  vi.restoreAllMocks();
});

const de = (key: Parameters<typeof t>[0]) => t(key, 'de');
const q = <T extends Element = HTMLElement>(testId: string) => container.querySelector<T & Element>(`[data-testid="${testId}"]`) as T | null;

function feldMitLabel(label: string): HTMLInputElement {
  const gruppe = Array.from(container.querySelectorAll('label.form-group')).find(
    (element) => element.querySelector('span')?.textContent === label,
  );
  const feld = gruppe?.querySelector('input, textarea, select');
  if (!feld) throw new Error(`Feld fehlt: ${label}`);
  return feld as HTMLInputElement;
}

async function setze(element: Element | null, value: string): Promise<void> {
  if (!element) throw new Error('Element fehlt');
  const proto =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function klicke(element: Element | null): Promise<void> {
  if (!element) throw new Error('Element fehlt');
  await act(async () => {
    (element as HTMLElement).click();
  });
}

async function absenden(): Promise<void> {
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

async function formular(props: { mode: 'add' | 'edit'; expense?: Expense; prefill?: Partial<ExpenseInput> }) {
  let saved: Expense | null = null;
  await act(async () => {
    root.render(
      <AppProvider initialSetup={DEFAULT_SETUP}>
        <ExpenseForm {...props} onSaved={(expense) => { saved = expense; }} onCancel={() => {}} />
      </AppProvider>,
    );
  });
  return { saved: () => saved as Expense | null };
}

async function grunddaten(brutto: string): Promise<void> {
  await setze(feldMitLabel(de('expense.fieldTitle')), 'A04 UI-Test');
  await setze(feldMitLabel(de('expense.fieldSupplier')), 'A04 UI-Lieferant');
  await setze(feldMitLabel(de('expense.fieldInvoiceNumber')), `A04-UI-${Math.random().toString(36).slice(2, 8)}`);
  await setze(q('expense-gross-input'), brutto);
}

function gespeichert(input: Partial<ExpenseInput>): Expense {
  const result = addExpense({
    title: 'A04 Beleg',
    category: 'material',
    supplierName: 'A04 Lieferant',
    invoiceNumber: `A04-G-${Math.random().toString(36).slice(2, 8)}`,
    issueDate: '2026-05-12',
    taxStatus: 'standard_19',
    grossAmount: 119,
    ...input,
  } as ExpenseInput);
  if (!result.success) throw new Error(result.errorKey);
  return getExpenseById(result.expense.id)!;
}

function altbestand(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-a04-ui-alt',
    status: 'gebucht',
    category: 'material',
    supplierName: 'A04 Altlieferant',
    invoiceNumber: 'A04-UI-ALT',
    title: 'A04 Altbeleg',
    issueDate: '2026-05-04',
    taxStatus: 'standard_19',
    netAmount: 119,
    taxAmount: 0,
    grossAmount: 119,
    ...overrides,
  } as Expense);
}

/* ================================================================== */

describe('F — Formular: Erfassen', () => {
  it('F1 (WEISS-Befund): nur Brutto bei 19 % → nicht gespeichert, verständliche Meldung am Formular', async () => {
    const form = await formular({ mode: 'add' });
    expect(q<HTMLInputElement>('expense-tax-split-belegt')?.checked).toBe(true);
    await grunddaten('119,00');
    await absenden();
    expect(form.saved()).toBeNull();
    expect(getAllExpenses()).toHaveLength(0);
    expect(q('expense-form-error')?.textContent).toBe(de('expense.taxSplit.amountsRequired'));
  });

  it('F2: „Noch offen“ — Netto/Steuer verschwinden, der Hinweis erklärt die Folgen, gespeichert als offen', async () => {
    const form = await formular({ mode: 'add' });
    await grunddaten('119,00');
    await klicke(q('expense-tax-split-offen'));
    expect(q('expense-net-input')).toBeNull();
    expect(q('expense-tax-input')).toBeNull();
    expect(q('expense-tax-split-open-hint')?.textContent).toBe(de('expense.taxSplit.openHint'));
    await absenden();
    const expense = form.saved()!;
    expect(expense.taxSplit).toBe('offen');
    expect(resolveExpenseTaxSplitState(getExpenseById(expense.id)!)).toBe('offen');
  });

  it('F3: Steuer vom Beleg → Netto als Differenz; eine eingetragene 0 bei 19 % wird abgewiesen', async () => {
    const form = await formular({ mode: 'add' });
    await grunddaten('119,00');
    await setze(q('expense-tax-input'), '0');
    await absenden();
    expect(form.saved()).toBeNull();
    expect(q('expense-form-error')?.textContent).toBe(de('expense.taxSplit.zeroTaxForTaxableStatus'));
    await setze(q('expense-tax-input'), '19,00');
    await absenden();
    expect(form.saved()).toMatchObject({ netAmount: 100, taxAmount: 19, grossAmount: 119, taxSplit: 'belegt' });
    expect(q('expense-form-error')).toBeNull();
  });

  it('F4: steuerfrei — keine Aufteilungsfrage, echte Nullsteuer', async () => {
    const form = await formular({ mode: 'add' });
    await grunddaten('119,00');
    await setze(q('expense-tax-status-select'), 'tax_free');
    expect(q('expense-tax-split')).toBeNull();
    expect(q('expense-input-tax-deduction-select')).toBeNull();
    await absenden();
    const expense = form.saved()!;
    expect([expense.netAmount, expense.taxAmount]).toEqual([119, 0]);
    expect(resolveExpenseTaxSplitState(expense)).toBe('steuerfrei');
  });

  it('F5: gemischte Steuersätze — Summenhinweis, gespeichert als gemischt', async () => {
    const form = await formular({ mode: 'add' });
    await grunddaten('113,00');
    await klicke(q('expense-tax-split-gemischt'));
    expect(container.textContent).toContain(de('expense.taxSplit.mixedHint'));
    await setze(q('expense-net-input'), '100,00');
    await setze(q('expense-tax-input'), '13,00');
    await absenden();
    expect(form.saved()).toMatchObject({ netAmount: 100, taxAmount: 13, taxSplit: 'gemischt' });
  });

  it('F6: Vorsteuer teilweise abziehbar — Betrag nötig und geprüft', async () => {
    const form = await formular({ mode: 'add' });
    await grunddaten('119,00');
    await setze(q('expense-tax-input'), '19,00');
    expect(q('expense-deductible-tax-input')).toBeNull();
    await setze(q('expense-input-tax-deduction-select'), 'teilweise');
    await absenden();
    expect(form.saved()).toBeNull();
    expect(q('expense-form-error')?.textContent).toBe(de('expense.inputTaxDeduction.amountInvalid'));
    await setze(q('expense-deductible-tax-input'), '9,50');
    await absenden();
    expect(form.saved()).toMatchObject({ taxAmount: 19, inputTaxDeduction: 'teilweise', deductibleTaxAmount: 9.5 });
  });

  it('F7: Vorbelegung aus dem Eingang (nur Brutto) — „Noch offen“ vorgewählt, nie still 0 € Steuer', async () => {
    const form = await formular({
      mode: 'add',
      prefill: { title: 'A04 Eingang', supplierName: 'A04 Eingangslieferant', issueDate: '2026-05-12', grossAmount: 119, linkedInboxId: 'inbox-a04' },
    });
    expect(q<HTMLInputElement>('expense-tax-split-offen')?.checked).toBe(true);
    expect(q('expense-tax-split-open-hint')).not.toBeNull();
    await absenden();
    expect(form.saved()?.taxSplit).toBe('offen');
  });
});

describe('F — Formular: Bearbeiten', () => {
  it('F8: offene Ausgabe nachtragen — keine Platzhalter im Formular, danach belegt', async () => {
    const offen = gespeichert({});
    const form = await formular({ mode: 'edit', expense: offen });
    expect(q<HTMLInputElement>('expense-tax-split-offen')?.checked).toBe(true);
    expect(q('expense-net-input')).toBeNull();
    await klicke(q('expense-tax-split-belegt'));
    expect(q<HTMLInputElement>('expense-net-input')?.value).toBe('');
    expect(q<HTMLInputElement>('expense-tax-input')?.value).toBe('');
    await setze(q('expense-tax-input'), '19,00');
    await absenden();
    expect(form.saved()).toMatchObject({ netAmount: 100, taxAmount: 19, taxSplit: 'belegt' });
  });

  it('F9: Altbestand — Prüfhinweis, keine Vorbelegung; nur Titel geändert → Beträge und Befund unverändert', async () => {
    const alt = altbestand();
    setExpenseStoreForTests([alt]);
    const form = await formular({ mode: 'edit', expense: alt });
    expect(q('expense-tax-split-legacy-hint')?.textContent).toBe(de('expense.taxSplit.legacyHint'));
    expect(container.querySelectorAll('input[name="expense-tax-split"]:checked')).toHaveLength(0);
    expect(q<HTMLInputElement>('expense-net-input')?.value).toBe('');
    await setze(feldMitLabel(de('expense.fieldTitle')), 'A04 Altbeleg umbenannt');
    await absenden();
    expect(form.saved()?.title).toBe('A04 Altbeleg umbenannt');
    const danach = getExpenseById(alt.id)!;
    expect([danach.netAmount, danach.taxAmount, danach.grossAmount, danach.taxSplit]).toEqual([119, 0, 119, undefined]);
    expect(resolveExpenseTaxSplitState(danach)).toBe('altbestand_pruefen');
  });

  it('F10: nach einer Zahlung ist die Aufteilung gesperrt; Titel bleibt änderbar', async () => {
    const belegt = normalizeExpense({
      ...gespeichert({ taxSplit: 'belegt', taxAmount: 19 }),
      payments: [{ id: 'pay-a04', date: '2026-05-20', amount: 50, createdAt: '2026-05-20T09:00:00.000Z' }],
    } as Expense);
    setExpenseStoreForTests([belegt]);
    const form = await formular({ mode: 'edit', expense: belegt });
    expect(q('expense-amounts-locked')).not.toBeNull();
    expect(q<HTMLInputElement>('expense-tax-split-offen')?.disabled).toBe(true);
    await setze(feldMitLabel(de('expense.fieldTitle')), 'A04 bezahlt umbenannt');
    await absenden();
    expect(form.saved()).toMatchObject({ title: 'A04 bezahlt umbenannt', netAmount: 100, taxAmount: 19 });
  });

  it('F10b (Abschluss-Rundgang R-08): nach einer Zahlung bleibt der Vorsteuerabzug änderbar — Beträge bleiben fest', async () => {
    const belegt = normalizeExpense({
      ...gespeichert({ taxSplit: 'belegt', taxAmount: 19 }),
      payments: [{ id: 'pay-a04', date: '2026-05-20', amount: 50, createdAt: '2026-05-20T09:00:00.000Z' }],
    } as Expense);
    setExpenseStoreForTests([belegt]);
    const form = await formular({ mode: 'edit', expense: belegt });
    expect(q<HTMLInputElement>('expense-net-input')?.disabled).toBe(true);
    expect(q<HTMLSelectElement>('expense-input-tax-deduction-select')?.disabled).toBe(false);
    expect(q('expense-amounts-locked')?.textContent).toBe(de('expense.edit.amountLockedHint'));
    await setze(q('expense-input-tax-deduction-select'), 'keiner');
    await absenden();
    expect(form.saved()).toMatchObject({ netAmount: 100, taxAmount: 19, grossAmount: 119, inputTaxDeduction: 'keiner' });
    expect(getExpenseById(belegt.id)).toMatchObject({ inputTaxDeduction: 'keiner', netAmount: 100, taxAmount: 19 });
  });
});

/* ================================================================== */

async function detail(value: Expense): Promise<void> {
  setExpenseStoreForTests([value]);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/ausgaben/${value.id}`]}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/ausgaben/:id" element={<AusgabeDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
}

describe('G — Detailseite', () => {
  it('G1: offen — Netto/Steuer „nicht belegt“, Hinweis mit Korrekturweg, Zahlung möglich (Produktregel A), keine Zuordnung', async () => {
    const offen = altbestand({ id: 'exp-a04-ui-offen', taxSplit: 'offen' });
    await detail(offen);
    expect(q('ausgabe-net-amount')?.textContent).toBe(de('expense.taxSplit.notProvided'));
    expect(q('ausgabe-tax-amount')?.textContent).toBe(de('expense.taxSplit.notProvided'));
    expect(q('ausgabe-tax-split-state')?.textContent).toBe(de('expense.taxSplit.state.offen'));
    expect(q('ausgabe-tax-split-open')?.textContent).toContain(de('expense.taxSplit.detailOpenNotice'));
    expect(q('ausgabe-next-action')?.textContent).toBe(de('expense.taxSplit.nextAction'));
    // Produktregel A (27.10.2026; bisher: kein Zahlungsknopf) — eine tatsächlich erfolgte Zahlung ist erfassbar.
    expect(q('ausgabe-record-payment')).not.toBeNull();
    expect(q('ausgabe-allocation-assign')).toBeNull();
    // Der Korrekturweg öffnet das Formular.
    await klicke(q('ausgabe-tax-split-enter'));
    expect(q('ausgabe-detail-edit')).not.toBeNull();
    expect(q<HTMLInputElement>('expense-tax-split-offen')?.checked).toBe(true);
  });

  it('G2: Altbestand — Werte unverändert angezeigt, mit Prüfhinweis', async () => {
    await detail(altbestand());
    expect(q('ausgabe-net-amount')?.textContent).toContain('119,00');
    expect(q('ausgabe-tax-amount')?.textContent).toContain('0,00');
    expect(q('ausgabe-tax-split-legacy')?.textContent).toContain('Bitte prüfen');
    expect(q('ausgabe-tax-split-state')?.textContent).toBe(de('expense.taxSplit.state.altbestand_pruefen'));
    expect(q('ausgabe-record-payment')).not.toBeNull();
  });

  it('G3: belegt mit teilweisem Vorsteuerabzug — Zustand und Betrag lesbar, keine Warnung', async () => {
    await detail(altbestand({ id: 'exp-a04-ui-teil', netAmount: 100, taxAmount: 19, taxSplit: 'belegt', inputTaxDeduction: 'teilweise', deductibleTaxAmount: 9.5 }));
    expect(q('ausgabe-tax-split-state')?.textContent).toBe(de('expense.taxSplit.state.belegt'));
    expect(q('ausgabe-input-tax-deduction')?.textContent).toContain('9,50');
    expect(q('ausgabe-tax-split-open')).toBeNull();
    expect(q('ausgabe-tax-split-legacy')).toBeNull();
  });
});

describe('G — Detailseite: storniert', () => {
  it('G4: stornierte offene Ausgabe — Zeilen sagen „nicht belegt“, aber kein Nachtragsauftrag', async () => {
    await detail(altbestand({ id: 'exp-a04-ui-storno', taxSplit: 'offen', status: 'storniert', cancelledAt: '2026-05-20T10:00:00.000Z', cancelReason: 'Test' }));
    expect(q('ausgabe-tax-split-state')?.textContent).toBe(de('expense.taxSplit.state.offen'));
    expect(q('ausgabe-net-amount')?.textContent).toBe(de('expense.taxSplit.notProvided'));
    expect(q('ausgabe-tax-split-open')).toBeNull();
    expect(q('ausgabe-next-action')?.textContent).toBe(de('expense.nextAction.cancelled'));
  });
});

describe('H — Übersichtskarte', () => {
  it('H1: offen und Altbestand tragen ihren Vermerk; belegt nicht', async () => {
    const offen = altbestand({ id: 'exp-a04-ui-k1', taxSplit: 'offen' });
    const alt = altbestand({ id: 'exp-a04-ui-k2' });
    const belegt = altbestand({ id: 'exp-a04-ui-k3', netAmount: 100, taxAmount: 19, taxSplit: 'belegt' });
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            {[offen, alt, belegt].map((expense) => (
              <div key={expense.id} data-testid={`karte-${expense.id}`}>
                <ExpenseOverviewCard item={{ expense, paymentSummary: calculateExpensePaymentSummary(expense) }} translate={(key) => de(key)} />
              </div>
            ))}
          </AppProvider>
        </MemoryRouter>,
      );
    });
    const vermerk = (id: string) => q(`karte-${id}`)?.querySelector('[data-testid="expense-overview-tax-split"]')?.textContent ?? null;
    expect(vermerk(offen.id)).toContain(de('expense.taxSplit.overviewOpen'));
    expect(vermerk(alt.id)).toContain(de('expense.taxSplit.overviewLegacy'));
    expect(vermerk(belegt.id)).toBeNull();
    // Produktregel A (27.10.2026; bisher keine Zahlungsschaltfläche): Zahlung auch an der offenen Ausgabe erfassbar.
    const knoepfe = (id: string) => Array.from(q(`karte-${id}`)?.querySelectorAll('button') ?? []).map((b) => b.textContent);
    expect(knoepfe(offen.id)).toContain(de('payment.recordShort'));
    expect(knoepfe(belegt.id)).toContain(de('payment.recordShort'));
  });
});
