/**
 * ORDER-COST-ALLOCATION-01B — Oberfläche: Zuordnungsdialog und Kostenabschnitt.
 *
 *  U1  Ausgabe ohne Zuordnung: „Auftrag zuordnen", keine technische Kennung
 *  U2  Dialog: Vorbelegung, Auswahl, Speichern, Steuerhinweis, Fehlermeldung
 *  U3  Ausgabe mit Zuordnung: Auftragsname, Nettobetrag, Ändern/Entfernen
 *  U4  Auftrag ohne Kosten / mit Kosten: Abgerechnet, Kosten, Verbleibt, Hinweis
 *  U5  Stornierter Beleg erscheint als Historie, nicht in der Summe
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { createTestVorgang } from '../../test/fixtures';
import { ExpenseAllocationDialog } from './ExpenseAllocationDialog';
import { VorgangCostPanel } from '../vorgang/VorgangCostPanel';
import {
  addExpense,
  assignExpenseToVorgang,
  cancelExpense,
  getExpenseById,
} from '../../services/expenseService';
import { hydrateExpenseStore } from '../../services/expenseStore';
import { hydrateVorgangStore } from '../../services/vorgangService';
import { hydrateInvoiceStore } from '../../services/invoice/invoiceStore';
import * as persistenceService from '../../services/persistenceService';
import { de } from '../../i18n';
import type { Expense } from '../../types/expense';
import type { VorgangInvoice } from '../../types/models';

const V1 = 'v-ui-cost';
const translate = (key: string) => (de as Record<string, string>)[key] ?? key;
let root: Root;
let host: HTMLDivElement;

function q(id: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${id}"]`);
}

async function mount(node: React.ReactNode): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>{node}</AppProvider>
      </MemoryRouter>,
    );
  });
}

function invoice(): VorgangInvoice {
  return {
    id: 'inv-ui-1', number: 'RE-77', type: 'rechnung', positions: [], subtotal: 1000,
    taxStatus: 'standard_19', amount: 1190, status: 'versendet', date: '2026-09-01',
    issueDate: '2026-09-01', createdAt: '2026-09-01T00:00:00.000Z', payments: [],
  } as VorgangInvoice;
}

function newExpense(net = 500): Expense {
  const result = addExpense({
    title: 'Material Baustoffe',
    category: 'material',
    supplierName: 'Baustoff Nord GmbH',
    invoiceNumber: `RE-${Math.random().toString(36).slice(2, 8)}`,
    issueDate: '2026-09-05',
    grossAmount: Math.round(net * 1.19 * 100) / 100,
    netAmount: net,
    taxAmount: Math.round(net * 0.19 * 100) / 100,
  });
  if (!result.success) throw new Error(result.errorKey);
  return result.expense;
}

beforeEach(() => {
  localStorage.clear();
  hydrateExpenseStore([]);
  hydrateInvoiceStore([]);
  hydrateVorgangStore([createTestVorgang({ id: V1, title: 'Bad Sanierung', customer: 'Kunde A', invoices: [invoice()] })]);
  vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: true } as never);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('U2/U3 — Zuordnungsdialog', () => {
  it('belegt den offenen Nettobetrag vor, zeigt Auftrag mit Kunde und speichert ohne technische Kennung', async () => {
    const expense = newExpense(500);
    const saved: Expense[] = [];
    await mount(
      <ExpenseAllocationDialog expense={expense} open onClose={() => {}} onSaved={(next) => saved.push(next)} />,
    );
    expect(q('expense-allocation-dialog')).not.toBeNull();
    expect((q('expense-allocation-amount') as HTMLInputElement).value).toBe('500');
    expect(q('expense-allocation-tax-hint')?.textContent).toContain('betrieblichen Auswertung');

    const select = q('expense-allocation-order') as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((option) => option.textContent);
    expect(optionLabels).toContain('Bad Sanierung · Kunde A');
    expect(host.textContent).not.toContain(V1);

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, V1);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      (q('expense-allocation-save') as HTMLButtonElement).click();
    });
    expect(saved).toHaveLength(1);
    expect(getExpenseById(expense.id)!.allocations).toEqual([
      { vorgangId: V1, vorgangTitle: 'Bad Sanierung', amount: 500 },
    ]);
  });

  it('meldet fehlende Auswahl und zu hohen Betrag verständlich, ohne zu speichern', async () => {
    const expense = newExpense(500);
    await mount(<ExpenseAllocationDialog expense={expense} open onClose={() => {}} onSaved={() => {}} />);
    await act(async () => {
      (q('expense-allocation-save') as HTMLButtonElement).click();
    });
    expect(q('expense-allocation-error')?.textContent).toBe('Bitte einen Auftrag auswählen.');

    const select = q('expense-allocation-order') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, V1);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const amount = q('expense-allocation-amount') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(amount, '900');
      amount.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (q('expense-allocation-save') as HTMLButtonElement).click();
    });
    expect(q('expense-allocation-error')?.textContent).toContain('höher als der noch nicht zugeordnete');
    expect(getExpenseById(expense.id)!.allocations).toEqual([]);
  });
});

describe('U4/U5 — Kostenabschnitt im Auftrag', () => {
  it('ohne Zuordnung: Abgerechnet sichtbar, Kosten 0, ehrlicher Hinweis, kein Deckungsbeitrag', async () => {
    await mount(<VorgangCostPanel vorgangId={V1} translate={translate as never} />);
    expect(q('vorgang-cost-billed')?.textContent).toContain('1.000,00');
    expect(q('vorgang-cost-allocated')?.textContent).toContain('0,00');
    expect(q('vorgang-cost-remaining')?.textContent).toContain('1.000,00');
    expect(q('vorgang-cost-hint')?.textContent).toBe('Arbeitszeit und Löhne sind hier nicht enthalten.');
    expect(q('vorgang-cost-empty')).not.toBeNull();
    expect(host.textContent).not.toContain('Deckungsbeitrag');
    expect(host.textContent).not.toContain(V1);
  });

  it('mit Zuordnung: Kosten und Verbleibt stimmen, Beleg verlinkt zur Ausgabe', async () => {
    const expense = newExpense(400);
    assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: 400 });
    await mount(<VorgangCostPanel vorgangId={V1} translate={translate as never} />);
    expect(q('vorgang-cost-allocated')?.textContent).toContain('400,00');
    expect(q('vorgang-cost-remaining')?.textContent).toContain('600,00');
    const entry = q('vorgang-cost-entry');
    expect(entry?.textContent).toContain('Material Baustoffe');
    expect(entry?.textContent).toContain('Baustoff Nord GmbH');
    expect(host.querySelector('a[href="/ausgaben/' + expense.id + '"]')).not.toBeNull();
  });

  it('stornierter Beleg: eigene Historienliste, nicht in der Summe', async () => {
    const expense = newExpense(400);
    assignExpenseToVorgang(expense.id, { vorgangId: V1, amount: 400 });
    cancelExpense(expense.id, 'Falscher Beleg');
    await mount(<VorgangCostPanel vorgangId={V1} translate={translate as never} />);
    expect(q('vorgang-cost-allocated')?.textContent).toContain('0,00');
    expect(q('vorgang-cost-remaining')?.textContent).toContain('1.000,00');
    expect(q('vorgang-cost-entry')).toBeNull();
    expect(q('vorgang-cost-cancelled-title')).not.toBeNull();
    expect(q('vorgang-cost-entry-cancelled')?.textContent).toContain('Storniert');
  });
});
