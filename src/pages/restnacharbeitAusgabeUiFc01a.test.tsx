/**
 * FINANZ-CORE-01A — Restnacharbeit nach WEISS-Bericht 18, END18-R3 an der echten Ausgabenseite: Was der Server
 * endgültig abgewiesen hat, steht sichtbar als „nicht gebucht“ bzw. „zurückgenommen“ da — mit Betrag, Datum und
 * verständlichem Grund —, aber nicht unter den Zahlungen und nicht im Saldo.
 *
 *  A1  abgewiesene Zahlung und abgewiesene Betragsänderung: Hinweis mit Grund; Zahlungen und Saldo nur angenommen
 *  A2  ohne Abweisung: kein Hinweis
 *  A3  Bericht 19: abgewiesen, Abgleich steht aus → „vorläufig, nicht verbindlich“; mit Nachweis kein Hinweis mehr
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { AusgabeDetailPage } from './AusgabeDetailPage';
import { normalizeExpense } from '../services/expenseNormalize';
import { setExpenseStoreForTests } from '../services/expenseStore';
import { resetTestStores } from '../test/resetStores';
import { alsInhaber } from '../test/workspaceRoleTestUtils';
import type { Expense } from '../types/expense';
import type { SyncOutboxEntry } from '../types/sync';
import { resetSyncOutboxForTests } from '../services/sync/syncOutboxService';

beforeEach(() => alsInhaber());

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-b19-ui',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'RE-B19',
    title: 'B19 Ausgabe',
    issueDate: '2026-06-01',
    paymentDueDate: '2099-06-15',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    payments: [{ id: 'pay-A', date: '2026-06-02', amount: 119, createdAt: '2026-06-02T09:00:00.000Z' }],
    ...overrides,
  } as Expense);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetTestStores();
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

async function zeige(value: Expense): Promise<void> {
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

describe('END18-R3 — abgewiesene Ausgabenaktionen an der echten Seite', () => {
  it('A1 abgewiesene Zahlung und Betragsänderung: sichtbar mit Grund, aber nicht unter den Zahlungen und nicht im Saldo', async () => {
    await zeige(
      ausgabe({
        paymentStatus: 'bezahlt',
        rejectedPayments: [
          {
            id: 'pay-B',
            date: '2026-06-02',
            amount: 119,
            createdAt: '2026-06-02T10:00:00.000Z',
            rejectedAt: '2026-06-02T10:00:05.000Z',
            reason: 'expense_payment_overpayment_unconfirmed: offen 0.00',
            outboxId: 'ob-1',
          },
        ],
        rejectedChanges: [
          {
            outboxId: 'ob-2',
            kind: 'update',
            reason: 'expense_amount_locked_after_payment: 1 aktive Zahlung(en)',
            rejectedAt: '2026-06-02T10:01:00.000Z',
            attempted: { grossAmount: 238, netAmount: 200, taxAmount: 38, status: 'gebucht' },
          },
        ],
      }),
    );

    const panel = container.querySelector('[data-testid="ausgabe-rejected-panel"]');
    expect(panel).not.toBeNull();
    const zahlung = container.querySelectorAll('[data-testid="ausgabe-rejected-payment"]');
    expect(zahlung).toHaveLength(1);
    expect(zahlung[0].textContent).toContain('nicht gebucht');
    expect(zahlung[0].textContent).toContain('119,00');
    expect(zahlung[0].textContent).toContain('Überzahlung ohne Bestätigung');
    const aenderung = container.querySelector('[data-testid="ausgabe-rejected-change"]');
    expect(aenderung?.getAttribute('data-kind')).toBe('update');
    expect(aenderung?.textContent).toContain('238,00');
    expect(aenderung?.textContent).toContain('Beträge sind nach einer gebuchten Zahlung fest');

    // Unter den Zahlungen steht nur die angenommene; der Saldo kennt die abgewiesene nicht.
    expect(container.querySelector('[data-testid="payment-remove-pay-A"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="payment-remove-pay-B"]')).toBeNull();
    const zeilen = [...container.querySelectorAll('.invoice-payment-summary__row')].map((row) => [
      row.querySelector('dt')?.textContent?.trim(),
      row.querySelector('dd')?.textContent?.replace(/\s+/g, ' ').trim(),
    ]);
    expect(zeilen.find(([label]) => label === 'Bezahlt')?.[1]).toMatch(/^119,00/);
    expect(zeilen.find(([label]) => label === 'Offen')?.[1]).toMatch(/^0,00/);
    expect(container.querySelector('.invoice-payment-summary__row--overpaid')).toBeNull();
  });

  it('A2 ohne Abweisung: kein Hinweis', async () => {
    await zeige(ausgabe({ paymentStatus: 'bezahlt' }));
    expect(container.querySelector('[data-testid="ausgabe-rejected-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="ausgabe-rejected-pending-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="payment-remove-pay-A"]')).not.toBeNull();
  });

  it('A3 Bericht 19 — abgewiesen, Abgleich steht aus: „vorläufig, nicht verbindlich“; mit Nachweis verschwindet der Hinweis', async () => {
    const abgewiesen: SyncOutboxEntry = {
      id: 'ob-b19-a3',
      entityType: 'expense',
      entityId: 'exp-b19-ui',
      operation: 'update',
      version: 1,
      queuedAt: '2026-06-02T10:00:00.000Z',
      retryCount: 1,
      status: 'failed',
      lastErrorMessage: 'expense_amount_locked_after_payment: 1 aktive Zahlung(en)',
      lastErrorRetryable: false,
    };
    resetSyncOutboxForTests([abgewiesen]);
    await zeige(ausgabe({ paymentStatus: 'bezahlt', grossAmount: 238, netAmount: 200, taxAmount: 38 }));
    const offen = container.querySelector('[data-testid="ausgabe-rejected-pending-panel"]');
    expect(offen?.textContent).toContain('vorläufig und nicht verbindlich');
    expect(offen?.textContent).toContain('Monatsabschluss ist bis zum nächsten erfolgreichen Abgleich gesperrt');
    const zeile = container.querySelector('[data-testid="ausgabe-rejected-pending"]');
    expect(zeile?.getAttribute('data-kind')).toBe('change');
    expect(zeile?.textContent).toContain('Beträge sind nach einer gebuchten Zahlung fest');

    // Nach dem Abgleich trägt die Ausgabe den Nachweis mit derselben Auftragskennung: kein „steht aus“ mehr.
    act(() => root.unmount());
    root = createRoot(container);
    await zeige(
      ausgabe({
        paymentStatus: 'bezahlt',
        rejectedChanges: [
          { outboxId: 'ob-b19-a3', kind: 'update', reason: abgewiesen.lastErrorMessage!, rejectedAt: '2026-06-02T10:01:00.000Z', attempted: { grossAmount: 238 } },
        ],
      }),
    );
    expect(container.querySelector('[data-testid="ausgabe-rejected-pending-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="ausgabe-rejected-change"]')).not.toBeNull();
  });
});
