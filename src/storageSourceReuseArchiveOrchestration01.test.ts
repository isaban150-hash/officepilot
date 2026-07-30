import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDocumentFileRepresentationPlan } from './services/documentFileRepresentationPlanService';
import { buildDocumentFileTransformPlan } from './services/documentFileTransformPlanService';
import { createDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './services/documentFileRepresentationBindingStoreService';
import { orchestrateSourceReuseArchiveBindingAfterImport } from './services/documentFileSourceReuseArchiveOrchestrationService';
import { importInboxDocument } from './services/documentService';
import {
  hydrateDocumentFileStore,
  resetDocumentFileStoreForTests,
} from './services/documentFileStoreService';
import { hydrateInboxStore } from './services/inboxService';
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { DocumentFileRef } from './types/documentFileRef';
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';
import type { StoragePolicyId } from './types/storagePolicy';

const FILE_X = 'file-ref-orch-x';
const FILE_Y = 'file-ref-orch-y';

function sampleFileRef(
  id: string,
  lifecycleStatus: DocumentFileRef['lifecycleStatus'] = 'committed',
): DocumentFileRef {
  return {
    id,
    originalFileName: `${id}.pdf`,
    mimeType: 'application/pdf',
    fileSize: 256,
    contentHash: `hash-${id}`,
    storageType: 'indexeddb',
    localDataKey: id,
    createdAt: '2026-07-18T12:00:00.000Z',
    lifecycleStatus,
    ...(lifecycleStatus === 'committed'
      ? { committedAt: '2026-07-18T12:00:01.000Z' }
      : { expiresAt: '2026-07-19T12:00:00.000Z' }),
  };
}

function transformPlanFor(policyId: StoragePolicyId): DocumentFileTransformPlan {
  const representationPlan = buildDocumentFileRepresentationPlan({
    policyId,
    decision: 'save_permanently',
  });
  expect(representationPlan).not.toBeNull();
  const plan = buildDocumentFileTransformPlan({
    representationPlan: representationPlan!,
    mediaProfile: 'native_pdf',
  });
  expect(plan).not.toBeNull();
  return plan!;
}

function prepareInbox(fileRefId: string, lifecycleStatus: DocumentFileRef['lifecycleStatus'] = 'committed') {
  hydrateDocumentFileStore([sampleFileRef(fileRefId, lifecycleStatus)], {});
  const item = createAuftragInboxItem({
    id: `inbox-${fileRefId}`,
    title: 'Werkvertrag Test',
    fileRefId,
    sourceFileHash: `hash-${fileRefId}`,
    documentType: 'vertrag',
  });
  hydrateInboxStore([item]);
  return item;
}

describe('STORAGE-SOURCE-REUSE-ARCHIVE-ORCHESTRATION-01', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
    resetDocumentFileStoreForTests();
    resetDocumentFileRepresentationBindingStoreForTests();
  });

  it('Legal/source_reuse erzeugt nach Import ein Archive-Binding', () => {
    const item = prepareInbox(FILE_X);

    const result = importInboxDocumentForTests(item, 'Test GmbH', {
      transformPlan: transformPlanFor('legal_document'),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
      {
        documentId: result.document.id,
        kind: 'archive',
        fileRefId: FILE_X,
      },
    ]);
  });

  it('doppelter Aufruf bleibt unchanged (kein zweites Binding)', () => {
    const item = prepareInbox(FILE_X);
    const plan = transformPlanFor('legal_document');

    const first = importInboxDocumentForTests(item, 'Test GmbH', { transformPlan: plan });
    expect(first.success).toBe(true);
    if (!first.success) return;

    const second = orchestrateSourceReuseArchiveBindingAfterImport({
      documentId: first.document.id,
      transformPlan: plan,
    });

    expect(second).toEqual({
      kind: 'persisted',
      registration: 'unchanged',
      archiveFileRefId: FILE_X,
      createdArchiveFileRef: false,
    });
    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toHaveLength(1);
  });

  it('unresolved (business_document) bleibt no-op; Import erfolgreich', () => {
    const item = prepareInbox(FILE_X);

    const result = importInboxDocumentForTests(item, 'Test GmbH', {
      transformPlan: transformPlanFor('business_document'),
    });

    expect(result.success).toBe(true);
    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
  });

  it('fehlender archive-Intent (receipt) bleibt no-op; Import erfolgreich', () => {
    const item = prepareInbox(FILE_X);

    const result = importInboxDocumentForTests(item, 'Test GmbH', {
      transformPlan: transformPlanFor('receipt'),
    });

    expect(result.success).toBe(true);
    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
  });

  it('ohne Transform-Plan bleibt no-op; Import erfolgreich', () => {
    const item = prepareInbox(FILE_X);

    const result = importInboxDocumentForTests(item, 'Test GmbH');
    expect(result.success).toBe(true);
    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
  });

  it('conflict überschreibt nicht; Import bleibt erfolgreich', () => {
    hydrateDocumentFileStore([sampleFileRef(FILE_X), sampleFileRef(FILE_Y)], {});
    const item = createAuftragInboxItem({
      id: `inbox-${FILE_X}`,
      title: 'Werkvertrag Conflict',
      fileRefId: FILE_X,
      sourceFileHash: `hash-${FILE_X}`,
      documentType: 'vertrag',
    });
    hydrateInboxStore([item]);

    const first = importInboxDocumentForTests(item, 'Test GmbH');
    expect(first.success).toBe(true);
    if (!first.success) return;

    hydrateDocumentFileRepresentationBindingStore([
      createDocumentFileRepresentationBinding({
        documentId: first.document.id,
        kind: 'archive',
        fileRefId: FILE_Y,
      }),
    ]);

    const orch = orchestrateSourceReuseArchiveBindingAfterImport({
      documentId: first.document.id,
      transformPlan: transformPlanFor('legal_document'),
    });

    expect(orch.kind).toBe('conflict');
    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
      {
        documentId: first.document.id,
        kind: 'archive',
        fileRefId: FILE_Y,
      },
    ]);
  });

  it('nicht committed erzeugt kein Binding; Import bleibt erfolgreich', () => {
    const item = prepareInbox(FILE_X, 'temp');

    const result = importInboxDocumentForTests(item, 'Test GmbH', {
      transformPlan: transformPlanFor('legal_document'),
    });

    expect(result.success).toBe(true);
    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
  });

  it('Infrastrukturfehler werden geloggt und nicht still verschluckt', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = orchestrateSourceReuseArchiveBindingAfterImport(
      null as unknown as {
        documentId: string;
        transformPlan: DocumentFileTransformPlan | null;
      },
    );

    expect(result).toEqual({ kind: 'error', errorCode: 'unexpected_failure' });
    expect(errorSpy).toHaveBeenCalledWith(
      '[OfficePilot:source-reuse-archive-binding]',
      'source_reuse_archive',
      'unexpected_failure',
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toMatch(/TypeError|Invalid source/i);
  });
});
