import { beforeEach, describe, expect, it } from 'vitest';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateDocumentStore, importInboxDocument } from './documentService';
import { addExpense, getAllExpenses } from './expenseService';
import { hydrateInboxStore, markInboxImportedToArchive } from './inboxService';
import { createTaskForItem } from './inboxTaskService';
import { getAllDocumentMemories, resetMemory } from './officePilotMemoryService';
import { getAllTasksFromStore, setTaskStoreForTests } from './taskStore';
import { createTestVorgang, createAuftragInboxItem } from '../test/fixtures';
import { hydrateVorgangStore } from './vorgangService';
import {
  buildExpenseInputFromInbox,
  createExpenseFromInbox,
  executeDocumentAction,
  executeScanResultAction,
  filterAvailableDocumentActions,
  isDocumentActionAvailable,
  markInboxAsImportant,
  resolveHeuteQuickActionRoute,
} from './officeActionService';
import type { InboxItem } from '../types/models';

function cloneInbox(item: InboxItem, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    ...item,
    recognizedData: { ...item.recognizedData },
    digitalFolder: { ...item.digitalFolder },
    paperFiling: { ...item.paperFiling },
    ...overrides,
  };
}

describe('officeActionService', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMemory();
    hydrateDocumentStore([]);
    hydrateCompanyProfileStore(DEFAULT_COMPANY_PROFILE);
    setTaskStoreForTests([]);
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-action-1', title: 'Projekt Test', status: 'in_bearbeitung' }),
    ]);
  });

  it('legt Ausgabe aus Inbox wirklich an', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-expense',
      documentType: 'eingangsrechnung',
      classifiedKind: 'eingangsrechnung',
      sender: 'Baustoff Müller',
      title: 'Materialrechnung',
      recognizedData: { Betrag: '119,00', Rechnungsnummer: 'R-100' },
    });
    hydrateInboxStore([item]);

    const result = createExpenseFromInbox(item);
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'navigate') {
      expect(result.route).toMatch(/^\/ausgaben\//);
    }

    const expenses = getAllExpenses();
    expect(expenses.some((entry) => entry.linkedInboxId === item.id)).toBe(true);
  });

  it('verknüpft Ausgabe mit Inbox über linkedInboxId', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-expense-link',
      documentType: 'eingangsrechnung',
      recognizedData: { Betrag: '250,00' },
    });
    const input = buildExpenseInputFromInbox(item);
    expect(input.linkedInboxId).toBe(item.id);

    const created = addExpense(input);
    expect(created.success).toBe(true);
    if (created.success) {
      expect(created.expense.linkedInboxId).toBe(item.id);
    }
  });

  it('erstellt Aufgabe wirklich über record_expense-nahe Task-Action', () => {
    const item = cloneInbox(MOCK_INBOX_ITEMS[0]!, {
      id: 'inbox-task-action',
      markedAsCompanyDocument: true,
      taskTemplate: {
        type: 'dokument_pruefen',
        title: 'Frist prüfen',
        description: 'Frist prüfen',
        dueDate: '2026-12-31',
      },
    });
    hydrateInboxStore([item]);

    const result = executeDocumentAction('check_deadline', item);
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'delegate') {
      expect(result.delegate).toBe('createTask');
    }

    const taskResult = createTaskForItem(item.id);
    expect(taskResult).not.toBeNull();
    expect(getAllTasksFromStore().length).toBeGreaterThan(0);
  });

  it('archiviert Dokument und aktualisiert Memory', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-archive-action',
      classifiedKind: 'freistellungsbescheinigung',
      recognizedData: { Dokument: 'Freistellungsbescheinigung §48b' },
    });
    hydrateInboxStore([item]);

    const importResult = importInboxDocument(item, 'Test GmbH');
    expect(importResult.success).toBe(true);
    if (importResult.success) {
      markInboxImportedToArchive(item.id, importResult.document.id);
      expect(getAllDocumentMemories().some((mem) => mem.documentId === importResult.document.id)).toBe(
        true,
      );
    }
  });

  it('markiert Inbox als wichtig statt Toast-only', () => {
    const item = createAuftragInboxItem({ id: 'inbox-important', priority: 'mittel' });
    hydrateInboxStore([item]);

    const result = markInboxAsImportant(item.id);
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'done') {
      expect(result.updatedItem?.priority).toBe('hoch');
    }
  });

  it('Scan review öffnet Detail-Delegate statt No-op', () => {
    const item = createAuftragInboxItem({ id: 'inbox-review', recommendedAction: 'klaeren' });
    const result = executeScanResultAction('review', item);
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'delegate') {
      expect(result.delegate).toBe('expandDetails');
    }
  });

  it('blendet unavailable Actions aus', () => {
    const adItem = createAuftragInboxItem({ id: 'inbox-ad', isAdvertisement: true });
    expect(isDocumentActionAvailable('confirm_filing', adItem)).toBe(false);

    const item = createAuftragInboxItem({
      id: 'inbox-no-task',
      classifiedKind: 'brief',
      taskTemplate: undefined,
    });
    expect(isDocumentActionAvailable('check_deadline', item)).toBe(false);
    expect(filterAvailableDocumentActions(item).some((action) => action.id === 'check_deadline')).toBe(
      false,
    );
  });

  it('löst Heute-Rechnung auf aktiven Vorgang auf', () => {
    const route = resolveHeuteQuickActionRoute('heute.action.writeInvoice');
    expect(route).toBe('/vorgaenge/v-action-1/rechnung?type=abschlag');
  });

  it('blendet Auftrag öffnen aus wenn kein Vorgang vorhanden', () => {
    hydrateVorgangStore([]);
    expect(resolveHeuteQuickActionRoute('heute.action.openOrder')).toBeNull();
  });
});
