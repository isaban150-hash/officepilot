/**
 * BEREICH-7-V1 — Oberfläche der Weiterberechnung.
 *
 *  U1  Kostenzeile: Aktion „Weiterberechnen" am richtigen Ort
 *  U2  Dialog: Vorbelegung, Vorschau, Anlegen
 *  U3  Zustand danach: Abzeichen und nachvollziehbarer Bezug statt zweiter Aktion
 *  U4  Rücknahme aus der Ansicht
 *  U5  Gesperrter Vertragsplan: Nachtraghinweis statt Aktion
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { createTestVorgang } from '../../test/fixtures';
import { VorgangCostPanel } from './VorgangCostPanel';
import { addExpense, assignExpenseToVorgang, getExpenseById } from '../../services/expenseService';
import { hydrateExpenseStore } from '../../services/expenseStore';
import { getVorgangById, hydrateVorgangStore } from '../../services/vorgangService';
import { hydrateInvoiceStore } from '../../services/invoice/invoiceStore';
import * as persistenceService from '../../services/persistenceService';
import { de } from '../../i18n';
import type { Vorgang } from '../../types/models';

const V1 = 'v-ui-rebill';
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

async function click(id: string): Promise<void> {
  const element = q(id);
  if (!element) throw new Error(`fehlt: ${id}`);
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function type(id: string, value: string): Promise<void> {
  const input = q(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function hydrateOrder(overrides: Partial<Vorgang> = {}): void {
  hydrateVorgangStore([
    createTestVorgang({ id: V1, title: 'Bad Sanierung', customer: 'Kunde A', ...overrides }),
  ]);
}

function allocatedExpense(net = 400): string {
  const added = addExpense({
    title: 'Material Baustoffe',
    category: 'material',
    supplierName: 'Baustoff Nord GmbH',
    invoiceNumber: 'LR-4711',
    issueDate: '2026-09-05',
    grossAmount: Math.round(net * 1.19 * 100) / 100,
    netAmount: net,
    taxAmount: Math.round(net * 0.19 * 100) / 100,
  } as Parameters<typeof addExpense>[0]);
  if (!added.success) throw new Error(added.errorKey);
  const assigned = assignExpenseToVorgang(added.expense.id, { vorgangId: V1, amount: net });
  if (!assigned.success) throw new Error(assigned.errorKey);
  return added.expense.id;
}

beforeEach(() => {
  localStorage.clear();
  hydrateExpenseStore([]);
  hydrateInvoiceStore([]);
  hydrateOrder();
  vi.restoreAllMocks();
  vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: true } as never);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('U1/U2 — von der Kostenzeile zur Auftragsposition', () => {
  it('U1: die zugeordnete Ausgabe bietet „Weiterberechnen" an', async () => {
    allocatedExpense();
    await mount(<VorgangCostPanel vorgangId={V1} translate={translate} />);

    expect(q('vorgang-cost-rebill')).not.toBeNull();
    expect(q('vorgang-cost-rebill')!.textContent).toBe(de['expense.rebill.action']);
    // Die vorhandene Zeile bleibt unangetastet klickbar.
    expect(q('vorgang-cost-entry-link')!.getAttribute('href')).toContain('/ausgaben/');
  });

  it('U2: der Dialog belegt Bezeichnung und Einkaufspreis vor und zeigt die Vorschau', async () => {
    const expenseId = allocatedExpense(400);
    await mount(<VorgangCostPanel vorgangId={V1} translate={translate} />);
    await click('vorgang-cost-rebill');

    expect((q('rebill-description') as HTMLInputElement).value).toBe(
      'Lieferantenkosten Baustoff Nord GmbH LR-4711',
    );
    expect(q('rebill-purchase')!.textContent).toContain('400');
    expect((q('rebill-markup') as HTMLInputElement).value).toBe('0');
    // Aufschlag 0: Vorschau gleich Einkaufspreis.
    expect(q('rebill-preview')!.textContent).toBe(q('rebill-purchase')!.textContent);

    await type('rebill-markup', '10');
    expect(q('rebill-preview')!.textContent).toContain('440');

    await click('rebill-submit');

    expect(q('rebill-cost-dialog')).toBeNull();
    const allocation = (getExpenseById(expenseId)!.allocations ?? [])[0]!;
    expect(allocation.rebilledOrderPositionId).toBeDefined();
    const position = getVorgangById(V1)!.orderPositions.find(
      (p) => p.id === allocation.rebilledOrderPositionId,
    )!;
    expect(position.unitPrice).toBe(440);
    expect(position.description).toBe('Lieferantenkosten Baustoff Nord GmbH LR-4711');
  });
});

describe('U3/U4 — Zustand und Rücknahme', () => {
  it('U3: danach zeigt die Ansicht den Bezug statt einer zweiten Aktion', async () => {
    allocatedExpense(400);
    await mount(<VorgangCostPanel vorgangId={V1} translate={translate} />);
    await click('vorgang-cost-rebill');
    await click('rebill-submit');

    expect(q('vorgang-cost-rebill')).toBeNull();
    expect(q('vorgang-cost-rebilled-badge')!.textContent).toBe(de['expense.rebill.badge']);
    const link = q('vorgang-cost-rebill-link')!.textContent ?? '';
    expect(link).toContain('Lieferantenkosten Baustoff Nord GmbH LR-4711');
    expect(link).toContain('400');
  });

  it('U4: die Rücknahme entfernt Position und Bezug und gibt die Aktion frei', async () => {
    const expenseId = allocatedExpense(400);
    await mount(<VorgangCostPanel vorgangId={V1} translate={translate} />);
    await click('vorgang-cost-rebill');
    await click('rebill-submit');

    await click('vorgang-cost-rebill-undo');

    expect(q('vorgang-cost-rebill-notice')!.textContent).toBe(de['expense.rebill.undone']);
    expect(q('vorgang-cost-rebill')).not.toBeNull();
    expect((getExpenseById(expenseId)!.allocations ?? [])[0]!.rebilledOrderPositionId).toBeUndefined();
    expect(getVorgangById(V1)!.orderPositions).toHaveLength(1);
  });
});

describe('U5 — gesperrter Vertragsplan', () => {
  it('U5: statt der Aktion steht der Nachtraghinweis', async () => {
    hydrateOrder({
      contractConfirmation: { confirmedAt: '2026-09-01T00:00:00.000Z', positions: [] } as never,
    });
    allocatedExpense(400);
    await mount(<VorgangCostPanel vorgangId={V1} translate={translate} />);

    expect(q('vorgang-cost-rebill')).toBeNull();
    expect(q('vorgang-cost-rebill-blocked')!.textContent).toBe(de['order_plan_amendment_required']);
    expect(q('vorgang-cost-rebill-blocked')!.textContent).toContain('Nachtrag');
  });
});
