import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPersistedStateSnapshot,
  seedSyncChangeTrackerFromCurrentStores,
} from '../persistenceService';
import {
  addDocument,
  deleteDocument,
  hydrateDocumentStore,
  updateDocument,
} from '../documentService';
import { hydrateExpenseStore, getExpenseStoreSnapshot } from '../expenseStore';
import { addExpense } from '../expenseService';
import { recordExpensePayment } from '../expensePaymentService';
import { createSyncClient, hydrateSyncClient, resetSyncClientForTests } from './syncClientService';
import {
  getSyncOutboxSnapshot,
  resetSyncOutboxForTests,
} from './syncOutboxService';
import {
  resetSyncChangeTrackerForTests,
  trackPersistedChanges,
} from './syncChangeTrackerService';
import { runSyncFromUi } from './syncUiService';
import { resetSyncCoordinatorForTests } from './syncCoordinator';
import { resetLocalSyncHubForTests } from './syncSimulatorService';
import { resetLocalSyncAdapterStoresForTests } from './localSyncAdapter';

function expectDocument(result: Awaited<ReturnType<typeof addDocument>>) {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('expected document mutation success');
  }
  return result.document;
}

describe('syncChangeTrackerService', () => {
  beforeEach(() => {
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
    resetSyncCoordinatorForTests();
    resetLocalSyncHubForTests();
    resetLocalSyncAdapterStoresForTests();
    vi.unstubAllEnvs();
  });

  it('erzeugt Outbox-Eintrag bei neuer Entity', () => {
    hydrateSyncClient(createSyncClient());
    hydrateDocumentStore([]);
    seedSyncChangeTrackerFromCurrentStores();

    const result = addDocument({ title: 'Tracker Test', category: 'vertrag' });
    expect(result.success).toBe(true);

    const outbox = getSyncOutboxSnapshot();
    const documentEntries = outbox.filter((entry) => entry.entityType === 'document');
    expect(documentEntries.length).toBeGreaterThanOrEqual(1);
    expect(documentEntries[0].operation).toBe('create');
    expect(documentEntries[0].status).toBe('pending');
  });

  it('erzeugt Outbox-Eintrag bei Tombstone/Delete', () => {
    hydrateSyncClient(createSyncClient());
    const document = expectDocument(addDocument({ title: 'Delete Me', category: 'steuer' }));
    seedSyncChangeTrackerFromCurrentStores();
    resetSyncOutboxForTests([]);

    deleteDocument(document.id);

    const outbox = getSyncOutboxSnapshot();
    const deleteEntry = outbox.find(
      (entry) => entry.entityType === 'document' && entry.entityId === document.id,
    );
    expect(deleteEntry).toBeDefined();
    expect(deleteEntry!.operation).toBe('delete');
  });

  it('dedupliziert mehrere Änderungen an derselben Entity', () => {
    hydrateSyncClient(createSyncClient());
    const document = expectDocument(addDocument({ title: 'Dedupe', category: 'vertrag' }));
    seedSyncChangeTrackerFromCurrentStores();
    resetSyncOutboxForTests([]);

    updateDocument(document.id, { title: 'Dedupe v2' });
    updateDocument(document.id, { title: 'Dedupe v3' });

    const outbox = getSyncOutboxSnapshot().filter((entry) => entry.entityId === document.id);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].operation).toBe('update');
    expect(outbox[0].status).toBe('pending');
  });

  it('erzeugt keine Outbox ohne Entity-Änderung', () => {
    hydrateSyncClient(createSyncClient());
    hydrateDocumentStore([]);
    seedSyncChangeTrackerFromCurrentStores();

    const snapshot = buildPersistedStateSnapshot();
    trackPersistedChanges(snapshot);

    expect(getSyncOutboxSnapshot()).toEqual([]);
  });

  it('trackt Inhaltsänderungen auch ohne Sync-Meta-Bump', () => {
    hydrateSyncClient(createSyncClient());
    hydrateExpenseStore([]);
    const created = addExpense({
      title: 'Material',
      category: 'material',
      supplierName: 'Lieferant GmbH',
      issueDate: '2026-03-01',
      grossAmount: 120,
    });
    expect(created.success).toBe(true);
    if (!created.success) throw new Error('setup failed');
    seedSyncChangeTrackerFromCurrentStores();
    resetSyncOutboxForTests([]);

    const result = recordExpensePayment(created.expense.id, {
      amount: 50,
      date: '2026-03-02',
    });
    expect(result.success).toBe(true);

    const outbox = getSyncOutboxSnapshot();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].entityType).toBe('expense');
    expect(outbox[0].operation).toBe('update');
    expect(getExpenseStoreSnapshot()[0].payments?.length).toBe(1);
  });

  it('markiert Outbox-Einträge nach Sync als completed', async () => {
    hydrateSyncClient(createSyncClient());
    hydrateDocumentStore([]);
    seedSyncChangeTrackerFromCurrentStores();

    addDocument({ title: 'Sync Complete', category: 'vertrag' });
    expect(getSyncOutboxSnapshot()[0].status).toBe('pending');

    await runSyncFromUi();

    const outbox = getSyncOutboxSnapshot();
    expect(outbox.some((entry) => entry.status === 'completed')).toBe(true);
    expect(outbox.some((entry) => entry.status === 'pending')).toBe(false);
  });

  it('setzt Outbox im Beta-Modus auf blocked', () => {
    vi.stubEnv('VITE_BETA_TEST_MODE', 'true');
    resetSyncClientForTests(createSyncClient());
    hydrateDocumentStore([]);
    seedSyncChangeTrackerFromCurrentStores();

    addDocument({ title: 'Beta Guard', category: 'vertrag' });

    const outbox = getSyncOutboxSnapshot();
    expect(outbox[0].status).toBe('blocked');
    expect(outbox[0].blockedReason).toBe('beta_mode');
  });
});

describe('seedSyncChangeTrackerFromCurrentStores', () => {
  beforeEach(() => {
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
  });

  it('initialisiert Tracker aus Setup ohne Outbox', () => {
    hydrateDocumentStore([]);
    seedSyncChangeTrackerFromCurrentStores();

    trackPersistedChanges(buildPersistedStateSnapshot());
    expect(getSyncOutboxSnapshot()).toEqual([]);
  });
});
