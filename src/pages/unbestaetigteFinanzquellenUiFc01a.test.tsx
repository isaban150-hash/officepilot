/**
 * FINANZ-CORE-01A — Bericht 20, Oberfläche: Der Nutzer sieht, woraus die Abschlusssperre besteht und wie sie endet.
 *
 *  U1  Sync-Seite: eine rechteabgewiesene Mitarbeiterzahlung lässt sich bewusst erneut senden (echter Speicher);
 *      eine abgewiesene Ausgabe bietet das nicht an (sie klärt der Abgleich)
 *  U2  Abschlusspanel: die Sperre nennt die Arten (Ausgaben, Mitarbeiterzahlungen …) und den Weg heraus
 *  U3  Ausgabe: eine abgewiesene Rücknahme ist als vorläufig benannt
 *  U4  Fristklärung kurz nach Mitternacht zeigt den Geschäftstag (Befund der Browserprüfung)
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { SyncPage } from './SyncPage';
import { AccountingPeriodPanel } from '../components/accounting/AccountingPeriodPanel';
import { ExpenseUnreconciledRejectionsNotice } from '../components/expenses/ExpenseRejectedActionsNotice';
import { InvoicePaymentSummary } from '../components/invoice/InvoicePaymentSummary';
import { resetTestStores } from '../test/resetStores';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../services/sync/syncOutboxService';
import { buildExpensePaymentEntityId } from '../services/expense/expenseCloudSyncService';
import { getAccountingPeriodState } from '../services/accounting/accountingPeriodService';
import { setAccountingStoreForTests } from '../services/accounting/accountingStore';
import { setAccountingPeriodStoreForTests } from '../services/accounting/accountingPeriodStore';
import { setExpenseStoreForTests } from '../services/expenseStore';
import { hydrateEmployeePaymentStore } from '../services/employee/employeeStore';
import { normalizeExpense } from '../services/expenseNormalize';
import { de } from '../i18n';
import type { TranslationKey } from '../i18n';
import type { Expense } from '../types/expense';
import type { EmployeePayment } from '../types/employee';
import type { SyncOutboxEntry } from '../types/sync';
import type { VorgangInvoice } from '../types/models';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };
const translate = (key: TranslationKey): string => de[key] ?? key;
const ROLLE = 'finance_forbidden_role: Keine Berechtigung für Finanzaktionen';

function abgewiesen(id: string, entityType: SyncOutboxEntry['entityType'], entityId: string, affectedMonths?: string[]): SyncOutboxEntry {
  return {
    id, entityType, entityId, operation: 'create', version: 1, queuedAt: '2026-06-25T10:00:00.000Z', retryCount: 1,
    status: 'failed', lastErrorMessage: ROLLE, lastErrorAt: '2026-06-25T10:00:01.000Z', lastErrorRetryable: false,
    ...(affectedMonths ? { affectedMonths } : {}),
  };
}

function mitarbeiterzahlung(): EmployeePayment {
  return {
    id: 'mz-u', employeeId: 'emp-u', employeeName: 'Erika U', kind: 'wage', amount: 1250, paymentDate: '2026-06-25',
    paymentMethod: 'cash', receiptReference: 'MZ-U-1', createdAt: '2026-06-25T10:00:00.000Z',
  } as EmployeePayment;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetTestStores();
  resetSyncOutboxForTests([]);
  setAccountingStoreForTests([]);
  setAccountingPeriodStoreForTests([]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('U — Abschlusssperre in der Oberfläche', () => {
  it('U1 Sync-Seite: „Bewusst erneut senden“ nur für Mitarbeiterzahlung/Kontierung, löst die Abweisung über den bewussten Weg ab', () => {
    resetSyncOutboxForTests([
      abgewiesen('ob-mz', 'employee_payment', 'mz-u', ['2026-06']),
      abgewiesen('ob-exp', 'expense_payment', buildExpensePaymentEntityId('exp-u', 'pay-u')),
    ]);
    act(() => {
      root.render(
        <MemoryRouter>
          <AppProvider initialSetup={completeSetup}>
            <SyncPage />
          </AppProvider>
        </MemoryRouter>,
      );
    });
    const knopf = container.querySelector<HTMLButtonElement>('[data-testid="sync-failure-resend-ob-mz"]');
    expect(knopf?.textContent).toBe('Bewusst erneut senden');
    expect(container.querySelector('[data-testid="sync-failure-resend-ob-exp"]')).toBeNull();
    act(() => knopf!.click());
    const nachher = getSyncOutboxSnapshot();
    expect(nachher.find((entry) => entry.id === 'ob-mz')?.status).toBe('completed');
    const neu = nachher.find((entry) => entry.entityId === 'mz-u' && entry.id !== 'ob-mz');
    expect(neu).toMatchObject({ status: 'pending', affectedMonths: ['2026-06'] });
    // Die Zeile mit dem Knopf ist weg (die Abweisung ist abgelöst), die Ausgaben-Abweisung bleibt sichtbar.
    expect(container.querySelector('[data-testid="sync-failure-resend-ob-mz"]')).toBeNull();
  });

  it('U2 Abschlusspanel: Arten und Ausweg der Sperre', () => {
    const e: Expense = normalizeExpense({
      id: 'exp-u2', status: 'gebucht', category: 'material', supplierName: 'U2', invoiceNumber: 'U2-1', title: 'U2',
      issueDate: '2026-06-05', taxStatus: 'standard_19', netAmount: 100, taxAmount: 19, grossAmount: 119,
    } as Expense);
    setExpenseStoreForTests([e]);
    hydrateEmployeePaymentStore([mitarbeiterzahlung()]);
    resetSyncOutboxForTests([
      { id: 'ob-e', entityType: 'expense', entityId: 'exp-u2', operation: 'update', version: 1, queuedAt: '2026-06-06T10:00:00.000Z', retryCount: 0, status: 'pending' },
      abgewiesen('ob-mz', 'employee_payment', 'mz-u', ['2026-06']),
    ]);
    const state = getAccountingPeriodState('2026-06');
    act(() => {
      root.render(<AccountingPeriodPanel state={state} monthLabel="Juni 2026" onChanged={() => {}} translate={translate} />);
    });
    expect(container.querySelector('[data-testid="accounting-period-blocker-unconfirmed_financial_changes"]')?.textContent).toContain(
      'Finanzdaten, die der Server noch nicht bestätigt hat',
    );
    expect(container.querySelector('[data-testid="accounting-period-unconfirmed-detail"]')?.textContent).toBe('Ausgaben: 1 · Mitarbeiterzahlungen: 1');
    expect(container.querySelector('[data-testid="accounting-period-unconfirmed-hint"]')?.textContent).toContain('Bewusst erneut senden');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="accounting-period-close"]')?.disabled ?? true).toBe(true);
  });

  it('U4 Fristklärung kurz nach Mitternacht: angezeigt wird der Geschäftstag, nicht das UTC-Datum (Browserprüfung B20)', () => {
    const zeitpunkt = '2026-10-16T23:58:44.000Z';
    const lokal = new Date(zeitpunkt);
    const erwartet = `${String(lokal.getDate()).padStart(2, '0')}.${String(lokal.getMonth() + 1).padStart(2, '0')}.${lokal.getFullYear()}`;
    const invoice = {
      id: 'inv-u4', number: 'RE-U4', type: 'rechnung', status: 'versendet', amount: 119, subtotal: 100, taxStatus: 'standard_19', positions: [],
      date: '2026-10-17', issueDate: '2026-10-17', createdAt: '2026-10-16T23:50:00.000Z', paymentDueDate: '2026-11-18',
      customerSnapshot: { name: 'U4', street: 'Weg 1', zip: '01990', city: 'Prüfstadt' }, payments: [],
      fristBasis: {
        lage: { art: 'inland', laender: ['BB'], gemeinde: {}, quelle: 'klaerung' },
        quelle: 'klaerung',
        festgelegtAm: zeitpunkt,
        klaerung: { id: 'kl-u4', begruendung: 'Sitz geprüft', am: zeitpunkt, angabe: { art: 'inland', region: 'BB' } },
      },
    } as unknown as VorgangInvoice;
    act(() => {
      root.render(<InvoicePaymentSummary invoice={invoice} translate={translate} />);
    });
    const note = container.querySelector('[data-testid="payment-summary-frist-clarified"]')?.textContent ?? '';
    expect(note).toContain(erwartet);
    expect(note).toContain('Sitz geprüft');
  });

  it('U3 Ausgabe: eine abgewiesene Rücknahme ist vorläufig benannt', () => {
    act(() => {
      root.render(
        <ExpenseUnreconciledRejectionsNotice
          pending={[{ outboxId: 'ob-r', kind: 'reverse', reason: ROLLE, paymentId: 'pay-u' }]}
          translate={translate}
        />,
      );
    });
    const zeile = container.querySelector('[data-testid="ausgabe-rejected-pending"]');
    expect(zeile?.getAttribute('data-kind')).toBe('reverse');
    expect(zeile?.textContent).toContain('Zahlungsrücknahme nicht angenommen');
  });
});
