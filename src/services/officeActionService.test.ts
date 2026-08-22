import { importInboxDocumentForTests } from '../test/confirmFilingDecisionForTests';
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

    const importResult = importInboxDocumentForTests(item, 'Test GmbH');
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

/*
 * DOCUMENT-BELEGNUMMER-CONSISTENCY-01 — die fünf Belegarten führen ihren
 * Identifikator unter `Belegnummer`. Ohne Rückfall ging er beim Anlegen einer
 * Ausgabe verloren, und der Dedupe-Schlüssel kollabierte auf `<lieferant>|`.
 */
describe('DOCUMENT-BELEGNUMMER-CONSISTENCY-01 — Belegnummer in der Ausgabe', () => {
  const TANKSTELLE = 'Testtankstelle Musterstadt';

  function receipt(id: string, recognizedData: Record<string, string>): InboxItem {
    return createAuftragInboxItem({
      id,
      documentType: 'eingangsrechnung',
      classifiedKind: 'tankbeleg',
      sender: TANKSTELLE,
      title: 'Tankbeleg',
      recognizedData: { Betrag: '70,51', ...recognizedData },
    });
  }

  beforeEach(() => {
    localStorage.clear();
    hydrateDocumentStore([]);
    hydrateInboxStore([]);
  });

  it('A: eine erkannte Belegnummer erreicht die Ausgabe', () => {
    const item = receipt('inbox-beleg-a', { Belegnummer: 'TEST-000184' });
    const input = buildExpenseInputFromInbox(item);

    expect(input.invoiceNumber).toBe('TEST-000184');

    const created = addExpense(input);
    expect(created.success, JSON.stringify(created)).toBe(true);
    if (created.success) {
      expect(created.expense.invoiceNumber).toBe('TEST-000184');
    }
  });

  it('B: zwei verschiedene Belege desselben Lieferanten sind beide anlegbar', () => {
    const first = addExpense(
      buildExpenseInputFromInbox(receipt('inbox-beleg-b1', { Belegnummer: 'TEST-000184' })),
    );
    const second = addExpense(
      buildExpenseInputFromInbox(receipt('inbox-beleg-b2', { Belegnummer: 'TEST-000185' })),
    );

    expect(first.success, JSON.stringify(first)).toBe(true);
    expect(second.success, JSON.stringify(second)).toBe(true);
    if (first.success && second.success) {
      expect(first.expense.dedupeKey).not.toBe(second.expense.dedupeKey);
      // Der Schlüssel kollabiert nicht mehr auf `<lieferant>|`.
      expect(first.expense.dedupeKey.endsWith('|')).toBe(false);
      expect(second.expense.dedupeKey.endsWith('|')).toBe(false);
    }
    expect(getAllExpenses()).toHaveLength(2);
  });

  it('C: ein echtes Duplikat bleibt blockiert', () => {
    const first = addExpense(
      buildExpenseInputFromInbox(receipt('inbox-beleg-c1', { Belegnummer: 'TEST-000184' })),
    );
    expect(first.success).toBe(true);

    const second = addExpense(
      buildExpenseInputFromInbox(receipt('inbox-beleg-c2', { Belegnummer: 'TEST-000184' })),
    );
    expect(second.success).toBe(false);
    if (!second.success) expect(second.errorKey).toBe('expense.duplicate');
    expect(getAllExpenses()).toHaveLength(1);
  });

  it('D: sind beide Felder gesetzt, gewinnt die Rechnungsnummer — beide bleiben erhalten', () => {
    const item = receipt('inbox-beleg-d', {
      Rechnungsnummer: 'R-2026-77',
      Belegnummer: 'TEST-000184',
    });
    const input = buildExpenseInputFromInbox(item);

    expect(input.invoiceNumber).toBe('R-2026-77');
    // Der Ursprungsbestand wird vollständig übernommen, nichts überschrieben.
    expect(input.recognizedData?.Rechnungsnummer).toBe('R-2026-77');
    expect(input.recognizedData?.Belegnummer).toBe('TEST-000184');
    // Und die Quelle selbst bleibt unangetastet.
    expect(item.recognizedData.Belegnummer).toBe('TEST-000184');
  });

  it('E: Whitespace blockiert den Rückfall nicht und erzeugt keinen Leeridentifikator', () => {
    const withWhitespaceInvoice = buildExpenseInputFromInbox(
      receipt('inbox-beleg-e1', { Rechnungsnummer: '   ', Belegnummer: 'TEST-000184' }),
    );
    expect(withWhitespaceInvoice.invoiceNumber).toBe('TEST-000184');

    const legacyWhitespace = buildExpenseInputFromInbox(
      receipt('inbox-beleg-e2', { rechnungsnummer: '  ', Belegnummer: 'TEST-000185' }),
    );
    expect(legacyWhitespace.invoiceNumber).toBe('TEST-000185');

    const onlyWhitespace = buildExpenseInputFromInbox(
      receipt('inbox-beleg-e3', { Belegnummer: '   ' }),
    );
    expect(onlyWhitespace.invoiceNumber).toBe('');

    const created = addExpense(onlyWhitespace);
    expect(created.success).toBe(true);
    if (created.success) {
      // Kein Whitespace-Identifikator in Ausgabe und Dedupe-Schlüssel.
      expect(created.expense.invoiceNumber).toBe('');
      expect(created.expense.dedupeKey).not.toMatch(/\|\s+$/);
    }
  });

  it('F: eine normale Eingangsrechnung verhält sich unverändert', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-beleg-f',
      documentType: 'eingangsrechnung',
      classifiedKind: 'eingangsrechnung',
      sender: 'Baustoff Müller',
      title: 'Materialrechnung',
      recognizedData: { Betrag: '119,00', Rechnungsnummer: 'R-100' },
    });

    expect(buildExpenseInputFromInbox(item).invoiceNumber).toBe('R-100');
  });
});
