/**
 * DOCUMENT-INBOX-DELETE-01 — tombstone delete for unused inbox documents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import {
  deleteInboxItem,
  getInboxItemById,
  getInboxSummary,
  hydrateInboxStore,
} from './inboxService';
import {
  getDocumentWorkResult,
  upsertDocumentWorkResult,
} from './documentWorkResultStoreService';
import {
  findDocumentFileIntakeTransformPlanCarryContext,
  replaceDocumentFileIntakeTransformPlanCarryContextStore,
} from './documentFileIntakeTransformPlanCarryContextStoreService';
import { getDocumentFileRefById, hydrateDocumentFileStore } from './documentFileStoreService';
import { setExpenseStoreForTests } from './expenseStore';
import { normalizeExpense } from './expenseNormalize';
import { resetLastPersistFailureForTests } from './persistenceService';
import type { DocumentFileIntakeTransformPlanCarryContext } from '../types/documentFileIntakeTransformPlanCarryContext';
import type { DocumentFileRef } from '../types/documentFileRef';
import type { DocumentWorkResult } from '../types/documentWorkResult';

function createDwr(inboxItemId: string): DocumentWorkResult {
  return {
    schemaVersion: 1,
    inboxItemId,
    analyzedAt: '2026-08-01T10:00:00.000Z',
    analysisVersion: '01a.1',
    sourceFingerprint: `fp-${inboxItemId}`,
    businessInterpretation: null,
    specialistRefs: {
      hasContractIntelligence: false,
      hasContractOrderProposal: false,
      hasClassification: false,
      hasDocumentUnderstanding: false,
      companyRelevant: false,
    },
    overlay: [],
  };
}

function createCarryContext(
  inboxItemId: string,
): DocumentFileIntakeTransformPlanCarryContext {
  return {
    inboxItemId,
    policyId: 'business_document',
    userDecision: 'save_permanently',
    mediaProfile: 'native_pdf',
    schemaVersion: 1,
    capturedAt: '2026-08-01T10:00:00.000Z',
  };
}

function createFileRef(id: string): DocumentFileRef {
  return {
    id,
    originalFileName: 'beleg.pdf',
    mimeType: 'application/pdf',
    fileSize: 1024,
    contentHash: `hash-${id}`,
    storageType: 'local_data_url',
    localDataKey: `blob-${id}`,
    createdAt: '2026-08-01T10:00:00.000Z',
    lifecycleStatus: 'committed',
  };
}

function failLocalStorageSetItem(): void {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {
      const error = new Error('quota');
      error.name = 'QuotaExceededError';
      throw error;
    },
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  });
}

describe('DOCUMENT-INBOX-DELETE-01 – inbox delete service', () => {
  beforeEach(() => {
    resetTestStores();
    resetLastPersistFailureForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTestStores();
    resetLastPersistFailureForTests();
  });

  it('A: löscht ein ungenutztes Dokument und senkt die Eingangszahl', async () => {
    const item = createAuftragInboxItem({ id: 'inbox-delete-a' });
    hydrateInboxStore([item]);
    upsertDocumentWorkResult(createDwr(item.id));
    replaceDocumentFileIntakeTransformPlanCarryContextStore([createCarryContext(item.id)]);

    expect(getInboxSummary().total).toBe(1);

    const result = await deleteInboxItem(item.id);

    expect(result?.success).toBe(true);
    expect(result?.messageKey).toBe('inbox.toast.deleted');
    expect(getInboxItemById(item.id)).toBeUndefined();
    expect(getInboxSummary().total).toBe(0);
    expect(getDocumentWorkResult(item.id)).toBeNull();
    expect(findDocumentFileIntakeTransformPlanCarryContext(item.id)).toBeNull();
  });

  it('A: schreibt einen Tombstone statt hart zu löschen', async () => {
    const item = createAuftragInboxItem({ id: 'inbox-delete-a2' });
    hydrateInboxStore([item]);

    const result = await deleteInboxItem(item.id);

    expect(result?.item.sync?.deleted).toBe(true);
    expect(result?.item.sync?.deletedAt).toBeTruthy();
  });

  it('B: blockiert Löschen bei gesetzter vorgangId und behält den DWR', async () => {
    const item = createAuftragInboxItem({
      id: 'inbox-delete-b',
      vorgangId: 'v-1',
      vorgangTitle: 'Auftrag 1',
    });
    hydrateInboxStore([item]);
    upsertDocumentWorkResult(createDwr(item.id));

    const result = await deleteInboxItem(item.id);

    expect(result?.success).toBe(false);
    expect(result?.messageKey).toBe('inbox.delete.blocked.vorgang');
    expect(getInboxItemById(item.id)).toBeDefined();
    expect(getInboxSummary().total).toBe(1);
    expect(getDocumentWorkResult(item.id)).not.toBeNull();
  });

  it('C: blockiert Löschen bei archiveDocumentId', async () => {
    const item = createAuftragInboxItem({
      id: 'inbox-delete-c1',
      archiveDocumentId: 'doc-1',
    });
    hydrateInboxStore([item]);

    const result = await deleteInboxItem(item.id);

    expect(result?.success).toBe(false);
    expect(result?.messageKey).toBe('inbox.delete.blocked.archive');
    expect(getInboxItemById(item.id)).toBeDefined();
  });

  it('C: blockiert Löschen bei importedToArchive', async () => {
    const item = createAuftragInboxItem({
      id: 'inbox-delete-c2',
      importedToArchive: true,
    });
    hydrateInboxStore([item]);

    const result = await deleteInboxItem(item.id);

    expect(result?.success).toBe(false);
    expect(result?.messageKey).toBe('inbox.delete.blocked.archive');
    expect(getInboxItemById(item.id)).toBeDefined();
  });

  it('D: blockiert Löschen bei verknüpfter Ausgabe', async () => {
    const item = createAuftragInboxItem({ id: 'inbox-delete-d' });
    hydrateInboxStore([item]);
    setExpenseStoreForTests([
      normalizeExpense({ id: 'exp-d', grossAmount: 119, linkedInboxId: item.id }),
    ]);

    const result = await deleteInboxItem(item.id);

    expect(result?.success).toBe(false);
    expect(result?.messageKey).toBe('inbox.delete.blocked.expense');
    expect(getInboxItemById(item.id)).toBeDefined();
    expect(getInboxSummary().total).toBe(1);
  });

  it('E: rollt bei Persist-Fehler alles zurück – kein halb gelöschter Zustand', async () => {
    const item = createAuftragInboxItem({
      id: 'inbox-delete-e',
      fileRefId: 'fileref-e',
    });
    hydrateInboxStore([item]);
    upsertDocumentWorkResult(createDwr(item.id));
    replaceDocumentFileIntakeTransformPlanCarryContextStore([createCarryContext(item.id)]);
    hydrateDocumentFileStore([createFileRef('fileref-e')], {});

    failLocalStorageSetItem();
    const result = await deleteInboxItem(item.id);

    expect(result?.success).toBe(false);
    expect(result?.messageKey).toBe('inbox.delete.failed');
    expect(getInboxItemById(item.id)).toBeDefined();
    expect(getInboxSummary().total).toBe(1);
    expect(getDocumentWorkResult(item.id)).not.toBeNull();
    expect(findDocumentFileIntakeTransformPlanCarryContext(item.id)).not.toBeNull();
    expect(getDocumentFileRefById('fileref-e')).toBeDefined();
  });

  it('F: gemeinsam genutzte fileRefId bleibt erhalten, solange ein Item sie hält', async () => {
    const shared = 'fileref-shared';
    const first = createAuftragInboxItem({ id: 'inbox-delete-f1', fileRefId: shared });
    const second = createAuftragInboxItem({ id: 'inbox-delete-f2', fileRefId: shared });
    hydrateInboxStore([first, second]);
    hydrateDocumentFileStore([createFileRef(shared)], {});

    const firstResult = await deleteInboxItem(first.id);

    expect(firstResult?.success).toBe(true);
    expect(getInboxItemById(second.id)).toBeDefined();
    expect(getDocumentFileRefById(shared)).toBeDefined();

    // Only once the last holder is gone may the original file be released.
    const secondResult = await deleteInboxItem(second.id);

    expect(secondResult?.success).toBe(true);
    expect(getDocumentFileRefById(shared)).toBeUndefined();
  });
});
