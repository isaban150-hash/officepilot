/**
 * EINGANG-01D-1 Nacharbeit 2 (P1) — Beträge überstehen das Formular unverändert.
 *
 * Realbefund Schwarz: Eine gespeicherte Ausgabe 92,95 / 78,11 / 14,84 wurde
 * durch Öffnen und unverändertes Speichern zu 9295 / 7811 / 1484. Ursache:
 * Das Formular schrieb `String(92.95)` = „92.95"; beim Speichern gilt der Punkt
 * als Tausendertrenner.
 *
 * Geprüft am echten Formular (`AppProvider` + `ExpenseForm`) und am echten
 * Dienst: Ausgabe anlegen → im Bearbeiten-Modus öffnen → nichts ändern →
 * speichern → gespeicherte Ausgabe erneut lesen. Dazu die Vorbelegung neuer
 * Ausgaben (Gutschrift aus dem Eingang).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExpenseForm } from './ExpenseForm';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { addExpense, getExpenseById } from '../../services/expenseService';
import { setExpenseStoreForTests } from '../../services/expenseStore';
import type { Expense, ExpenseInput } from '../../types/expense';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  setExpenseStoreForTests([]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(props: { mode: 'add' | 'edit'; expense?: Expense; prefill?: Partial<ExpenseInput> }) {
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

async function submitUnchanged(): Promise<void> {
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

function amountInputs(): string[] {
  return Array.from(container.querySelectorAll('form input'))
    .map((element) => (element as HTMLInputElement).value)
    .filter((value) => /^-?\d+,\d{2}$/.test(value));
}

function createStored(input: Partial<ExpenseInput>): Expense {
  const result = addExpense({
    title: 'Beleg',
    category: 'material',
    supplierName: 'Lieferant GmbH',
    invoiceNumber: `RT-${Math.random().toString(36).slice(2, 9)}`,
    issueDate: '2026-10-01',
    grossAmount: 0,
    ...input,
  } as ExpenseInput);
  if (!result.success) throw new Error(`addExpense: ${result.errorKey}`);
  return getExpenseById(result.expense.id)!;
}

describe('Ausgabe bearbeiten: Öffnen + unverändert speichern ändert keinen Betrag', () => {
  it.each([
    ['A: 92,95 / 78,11 / 14,84', { grossAmount: 92.95, netAmount: 78.11, taxAmount: 14.84 }, ['92,95', '78,11', '14,84']],
    ['B: Gutschrift −186,30 / −156,55 / −29,75', { grossAmount: -186.3, netAmount: -156.55, taxAmount: -29.75 }, ['-186,30', '-156,55', '-29,75']],
    ['C: 1190,50 / 1000,42 / 190,08', { grossAmount: 1190.5, netAmount: 1000.42, taxAmount: 190.08 }, ['1190,50', '1000,42', '190,08']],
    ['D: 119 / 100 / 19', { grossAmount: 119, netAmount: 100, taxAmount: 19 }, ['119,00', '100,00', '19,00']],
  ] as const)('%s', async (_label, amounts, shown) => {
    const before = createStored(amounts);
    expect({ g: before.grossAmount, n: before.netAmount, t: before.taxAmount }).toEqual({
      g: amounts.grossAmount,
      n: amounts.netAmount,
      t: amounts.taxAmount,
    });

    const form = await render({ mode: 'edit', expense: before });
    expect(amountInputs()).toEqual(shown);
    await submitUnchanged();
    expect(form.saved(), 'gespeichert').not.toBeNull();

    const after = getExpenseById(before.id)!;
    expect(after.grossAmount).toBe(amounts.grossAmount);
    expect(after.netAmount).toBe(amounts.netAmount);
    expect(after.taxAmount).toBe(amounts.taxAmount);
    expect(after.isCreditNote).toBe(amounts.grossAmount < 0);
  });
});

describe('Neue Ausgabe aus Vorbelegung: dieselbe Schreibweise', () => {
  it('Gutschrift −186,30 → Formular „-186,30" → gespeichert −186,30', async () => {
    const form = await render({
      mode: 'add',
      prefill: { title: 'Gutschrift', supplierName: 'GC GmbH', issueDate: '2026-10-01', grossAmount: -186.3, linkedInboxId: 'inbox-rt-1' },
    });
    expect(amountInputs()).toEqual(['-186,30']);
    await submitUnchanged();
    expect(form.saved()!.grossAmount).toBe(-186.3);
    expect(form.saved()!.isCreditNote).toBe(true);
  });

  it('ohne sicheren Betrag bleibt das Feld leer', async () => {
    await render({ mode: 'add', prefill: { title: 'Rechnung', supplierName: 'X', issueDate: '2026-10-01', grossAmount: 0 } });
    expect(amountInputs()).toEqual([]);
  });
});
