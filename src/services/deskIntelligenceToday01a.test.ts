import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetHomeHintDismissals } from './homeHintDismissalService';
import { buildDeskPriorities } from './deskIntelligenceService';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateDocumentStore } from './documentService';
import { hydrateExpenseStore } from './expenseStore';
import { hydrateInboxStore } from './inboxService';
import {
  scanAuthorityDeadlines,
  scanExpenseDueDates,
  scanPendingItems,
} from './pendingEngineService';
import { hydrateTaskStore, setTaskStoreForTests } from './taskStore';
import { normalizeTask } from './taskNormalize';
import { hydrateVorgangStore } from './vorgangService';
import type { Expense } from '../types/expense';
import type { InboxItem } from '../types/models';

const TODAY = '2026-07-06';

function baseInbox(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-today-1',
    title: 'BG BAU Schreiben',
    documentType: 'behoerde',
    sender: 'BG BAU',
    priority: 'hoch',
    deadline: TODAY,
    classifiedKind: 'bg_bau',
    recommendedAction: 'pruefen',
    digitalFolder: { id: 'd', name: 'n', path: '/' },
    paperFiling: { folderId: 'folder-5', register: 'A', label: 'x' },
    status: 'neu',
    receivedAt: TODAY,
    recognizedData: {},
    officePilotSuggestion: 'Prüfen',
    nextTaskLabel: 'Prüfen',
    securityHint: '',
    ...overrides,
  };
}

function baseExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-today-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Material GmbH',
    invoiceNumber: 'RE-1',
    title: 'Materiallieferung',
    description: '',
    issueDate: '2026-07-01',
    paymentDueDate: TODAY,
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    currency: 'EUR',
    paymentStatus: 'offen',
    payments: [],
    positions: [],
    allocations: [],
    isCreditNote: false,
    dedupeKey: 'material gmbh|re-1',
    tags: [],
    digitalFolder: { id: 'dig-1', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'folder-1', register: 'A', label: 'Test' },
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('TODAY-DASHBOARD-01A', () => {
  beforeEach(() => {
    resetHomeHintDismissals();
    localStorage.clear();
    hydrateInboxStore([]);
    hydrateDocumentStore([]);
    hydrateVorgangStore([]);
    hydrateTaskStore([]);
    hydrateExpenseStore([]);
    hydrateCompanyProfileStore({
      companyName: 'Test GmbH',
      contactPerson: 'Max',
    });
  });

  afterEach(() => {
    resetHomeHintDismissals();
  });

  it('aggregiert Behördenfristen (heute/überfällig)', () => {
    hydrateInboxStore([
      baseInbox({ id: 'auth-1', classifiedKind: 'finanzamt', deadline: TODAY, title: 'FA' }),
      baseInbox({ id: 'auth-2', classifiedKind: 'soka_bau', deadline: '2026-07-01', title: 'SOKA' }),
      baseInbox({ id: 'auth-3', classifiedKind: 'bg_bau', deadline: '2026-08-01', title: 'Später' }),
    ]);
    setTaskStoreForTests([
      normalizeTask({
        id: 'auth-task',
        title: 'Behörden-Schreiben prüfen',
        description: 'BG',
        status: 'open',
        priority: 'hoch',
        category: 'behoerden',
        type: 'dokument_pruefen',
        taskKind: 'authority_review:bg_bau',
        dueDate: TODAY,
        done: false,
      }),
    ]);

    const items = scanAuthorityDeadlines(TODAY);
    expect(items.length).toBeGreaterThanOrEqual(2);

    const { summary } = scanPendingItems(TODAY);
    expect(summary.authorityDeadlines).toBeGreaterThanOrEqual(2);
    const highlight = summary.highlights.find((h) => h.kind === 'authority_deadline');
    expect(highlight?.count).toBe(summary.authorityDeadlines);
    expect(highlight?.labelKey).toMatch(/authorityDeadline/);
  });

  it('fällige und überfällige Ausgaben erscheinen aggregiert', () => {
    hydrateExpenseStore([
      baseExpense({ id: 'e1', paymentDueDate: TODAY, invoiceNumber: 'A-1', dedupeKey: 'a|1' }),
      baseExpense({
        id: 'e2',
        paymentDueDate: '2026-07-01',
        invoiceNumber: 'A-2',
        dedupeKey: 'a|2',
        paymentStatus: 'ueberfaellig',
      }),
      baseExpense({
        id: 'e3',
        paymentDueDate: '2026-08-01',
        invoiceNumber: 'A-3',
        dedupeKey: 'a|3',
      }),
    ]);

    const items = scanExpenseDueDates(TODAY);
    expect(items).toHaveLength(2);

    const { summary } = scanPendingItems(TODAY);
    expect(summary.dueTodayExpenses + summary.overdueExpenses).toBe(2);
    const expenseHighlights = summary.highlights.filter(
      (h) => h.kind === 'expense_due_today' || h.kind === 'expense_overdue',
    );
    expect(expenseHighlights).toHaveLength(1);
    expect(expenseHighlights[0]!.count).toBe(2);
  });

  it('Behördenfristen erscheinen vor neuen Dokumenten', () => {
    hydrateInboxStore([
      baseInbox({
        id: 'auth-fa',
        classifiedKind: 'finanzamt',
        deadline: TODAY,
        status: 'geprueft',
        title: 'Finanzamt Frist',
      }),
      baseInbox({ id: 'doc-new-1', status: 'neu', deadline: null, classifiedKind: undefined }),
      baseInbox({ id: 'doc-new-2', status: 'neu', deadline: null, classifiedKind: undefined }),
      baseInbox({ id: 'doc-new-3', status: 'neu', deadline: null, classifiedKind: undefined }),
      baseInbox({ id: 'doc-new-4', status: 'neu', deadline: null, classifiedKind: undefined }),
    ]);

    const priorities = buildDeskPriorities(new Date(`${TODAY}T09:00:00`));
    expect(priorities.length).toBeGreaterThan(0);
    expect(priorities.length).toBeLessThanOrEqual(3);

    const authorityIndex = priorities.findIndex((p) =>
      String(p.messageKey).includes('authorityDeadline'),
    );
    const docsIndex = priorities.findIndex((p) => String(p.messageKey).includes('newDocuments'));
    expect(authorityIndex).toBeGreaterThanOrEqual(0);
    if (docsIndex >= 0) {
      expect(authorityIndex).toBeLessThan(docsIndex);
    }
  });

  it('Aufgaben ohne Due-Date erscheinen nicht als Desk-Priorität', () => {
    setTaskStoreForTests([
      normalizeTask({
        id: 'no-due',
        title: 'Ohne Termin',
        description: '',
        status: 'open',
        priority: 'mittel',
        category: 'dokumente',
        type: 'dokument_pruefen',
        done: false,
      }),
    ]);
    hydrateInboxStore([]);

    const priorities = buildDeskPriorities(new Date(`${TODAY}T09:00:00`));
    expect(priorities.every((p) => !String(p.messageKey).includes('dueTasksToday'))).toBe(true);
    expect(priorities.every((p) => !String(p.messageKey).includes('openTasks'))).toBe(true);
  });

  it('maximal drei Prioritäten bleiben bestehen', () => {
    hydrateInboxStore([
      baseInbox({ id: 'a1', classifiedKind: 'finanzamt', deadline: TODAY, status: 'geprueft' }),
      baseInbox({ id: 'n1', status: 'neu', deadline: null }),
      baseInbox({ id: 'n2', status: 'neu', deadline: null }),
      baseInbox({ id: 'd1', status: 'spaeter_klaeren', deadline: null }),
    ]);
    hydrateExpenseStore([
      baseExpense({ id: 'e1', paymentDueDate: TODAY }),
      baseExpense({
        id: 'e2',
        paymentDueDate: '2026-06-01',
        invoiceNumber: 'B-2',
        dedupeKey: 'b|2',
      }),
    ]);
    setTaskStoreForTests([
      normalizeTask({
        id: 't1',
        title: 'Aufgabe heute',
        description: '',
        status: 'open',
        priority: 'hoch',
        category: 'dokumente',
        type: 'dokument_pruefen',
        dueDate: TODAY,
        done: false,
      }),
    ]);

    const priorities = buildDeskPriorities(new Date(`${TODAY}T09:00:00`));
    expect(priorities.length).toBeLessThanOrEqual(3);
  });

  it('eine Priorität pro Themenblock (Aggregation)', () => {
    hydrateExpenseStore([
      baseExpense({ id: 'e1', paymentDueDate: TODAY, invoiceNumber: 'C-1', dedupeKey: 'c|1' }),
      baseExpense({
        id: 'e2',
        paymentDueDate: TODAY,
        invoiceNumber: 'C-2',
        dedupeKey: 'c|2',
      }),
    ]);
    hydrateInboxStore([
      baseInbox({ id: 'fa1', classifiedKind: 'finanzamt', deadline: TODAY, status: 'geprueft' }),
      baseInbox({ id: 'bg1', classifiedKind: 'bg_bau', deadline: TODAY, status: 'geprueft' }),
    ]);

    const { summary } = scanPendingItems(TODAY);
    expect(summary.highlights.filter((h) => h.kind === 'authority_deadline')).toHaveLength(1);
    expect(
      summary.highlights.filter(
        (h) => h.kind === 'expense_due_today' || h.kind === 'expense_overdue',
      ),
    ).toHaveLength(1);
  });
});
