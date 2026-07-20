import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDocumentFileRepresentationPlan } from './services/documentFileRepresentationPlanService';
import { buildDocumentFileTransformPlan } from './services/documentFileTransformPlanService';
import { createDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './services/documentFileRepresentationBindingStoreService';
import {
  createDocumentFileDerivativeStepOutcome,
  recordPostImportDerivativeStepOutcome,
} from './services/documentFileDerivativeStepOutcomeService';
import {
  findDocumentFileDerivativeStepOutcome,
  getDocumentFileDerivativeStepOutcomeStoreSnapshot,
  hydrateDocumentFileDerivativeStepOutcomeStore,
  resetDocumentFileDerivativeStepOutcomeStoreForTests,
} from './services/documentFileDerivativeStepOutcomeStoreService';
import { upsertDocumentFileDerivativeRecoveryContext } from './services/documentFileDerivativeRecoveryContextService';
import { resetDocumentFileDerivativeRecoveryContextStoreForTests } from './services/documentFileDerivativeRecoveryContextStoreService';
import { buildDocumentFileDerivativeRecoveryDetailStatus } from './services/documentFileDerivativeRecoveryDetailStatusService';
import { retryDocumentFileDerivativeStep } from './services/documentFileDerivativeStepManualRetryService';
import {
  DOCUMENT_FILE_DERIVATIVE_STEP_IDS,
  POST_IMPORT_DERIVATIVE_STEP_IDS,
} from './types/documentFileDerivativeStepOutcome';
import { setPostImportDerivativeStepRunnersForTests } from './services/documentFilePostImportDerivativeOrchestrationService';
import { orchestrateSourceReuseArchiveBindingAfterImport } from './services/documentFileSourceReuseArchiveOrchestrationService';
import * as sourceReusePersistence from './services/documentFileRepresentationSourceReuseArchiveBindingPersistenceService';
import { importInboxDocument } from './services/documentService';
import {
  hydrateDocumentFileStore,
  resetDocumentFileStoreForTests,
} from './services/documentFileStoreService';
import { hydrateInboxStore } from './services/inboxService';
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import { resetDocumentFileDerivativeStepInFlightLocksForTests } from './services/documentFileDerivativeStepInFlightLockService';
import type { DocumentFileRef } from './types/documentFileRef';
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';
import type { StoragePolicyId } from './types/storagePolicy';

const FILE_X = 'file-ref-source-reuse-outcome-x';
const FILE_Y = 'file-ref-source-reuse-outcome-y';

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

function prepareInbox(fileRefId: string) {
  hydrateDocumentFileStore([sampleFileRef(fileRefId)], {});
  const item = createAuftragInboxItem({
    id: `inbox-${fileRefId}-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Werkvertrag Test',
    fileRefId,
    sourceFileHash: `hash-${fileRefId}`,
    documentType: 'vertrag',
  });
  hydrateInboxStore([item]);
  return item;
}

function seedRecovery(documentId: string, plan: DocumentFileTransformPlan): void {
  upsertDocumentFileDerivativeRecoveryContext({
    documentId,
    transformPlan: plan,
  });
}

function resetLocalStores(): void {
  resetTestStores();
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
  resetDocumentFileDerivativeStepOutcomeStoreForTests();
  resetDocumentFileDerivativeRecoveryContextStoreForTests();
  resetDocumentFileDerivativeStepInFlightLocksForTests();
}

afterEach(() => {
  vi.restoreAllMocks();
  setPostImportDerivativeStepRunnersForTests(null);
  resetLocalStores();
});

describe('STORAGE-SOURCE-REUSE-STEP-OUTCOME-01', () => {
  it('bestehende sieben Derived-Schritte bleiben unverändert', () => {
    expect([...POST_IMPORT_DERIVATIVE_STEP_IDS]).toEqual([
      'raster_archive',
      'image_to_pdf_archive',
      'pdf_metadata_strip',
      'raster_thumbnail',
      'raster_preview',
      'pdf_thumbnail',
      'pdf_preview',
    ]);
    expect(POST_IMPORT_DERIVATIVE_STEP_IDS).not.toContain('source_reuse_archive');
    expect(DOCUMENT_FILE_DERIVATIVE_STEP_IDS[0]).toBe('source_reuse_archive');
    expect(DOCUMENT_FILE_DERIVATIVE_STEP_IDS.slice(1)).toEqual([
      ...POST_IMPORT_DERIVATIVE_STEP_IDS,
    ]);
  });

  it('Source-Reuse bleibt synchron vor dem async Coordinator', async () => {
    const callOrder: string[] = [];
    setPostImportDerivativeStepRunnersForTests(
      Object.fromEntries(
        POST_IMPORT_DERIVATIVE_STEP_IDS.map((stepId) => [
          stepId,
          async () => {
            callOrder.push(`async:${stepId}`);
            return { kind: 'noop', reason: 'missing_transform_plan' };
          },
        ]),
      ),
    );

    const item = prepareInbox(FILE_X);
    const result = importInboxDocument(item, 'Test GmbH', {
      transformPlan: transformPlanFor('legal_document'),
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Sync outcome must exist immediately (before async steps finish)
    expect(
      findDocumentFileDerivativeStepOutcome(result.document.id, 'source_reuse_archive'),
    ).toMatchObject({
      outcome: 'persisted',
      attempt: 1,
    });

    await vi.waitFor(() => {
      expect(callOrder).toHaveLength(POST_IMPORT_DERIVATIVE_STEP_IDS.length);
    });
    expect(callOrder.every((entry) => entry.startsWith('async:'))).toBe(true);
    expect(
      findDocumentFileDerivativeStepOutcome(result.document.id, 'source_reuse_archive')?.attempt,
    ).toBe(1);
  });

  it('initialer Erfolg schreibt persisted', () => {
    const item = prepareInbox(FILE_X);
    const result = importInboxDocument(item, 'Test GmbH', {
      transformPlan: transformPlanFor('legal_document'),
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const outcome = findDocumentFileDerivativeStepOutcome(
      result.document.id,
      'source_reuse_archive',
    );
    expect(outcome).toMatchObject({
      stepId: 'source_reuse_archive',
      representationKind: 'archive',
      outcome: 'persisted',
      registrationStatus: 'created',
      resultFileRefId: FILE_X,
      createdFileRef: false,
      attempt: 1,
    });
    expect(outcome?.errorCode).toBeUndefined();
    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
      {
        documentId: result.document.id,
        kind: 'archive',
        fileRefId: FILE_X,
      },
    ]);
  });

  it('Noop wird korrekt gespeichert', () => {
    const item = prepareInbox(FILE_X);
    const result = importInboxDocument(item, 'Test GmbH', {
      transformPlan: transformPlanFor('business_document'),
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(
      findDocumentFileDerivativeStepOutcome(result.document.id, 'source_reuse_archive'),
    ).toMatchObject({
      outcome: 'noop',
      noopReason: 'unresolved',
      attempt: 1,
    });
  });

  it('Conflict wird korrekt gespeichert', () => {
    const item = prepareInbox(FILE_X);
    hydrateDocumentFileStore([sampleFileRef(FILE_X), sampleFileRef(FILE_Y)], {});
    const result = importInboxDocument(item, 'Test GmbH', {
      transformPlan: transformPlanFor('legal_document'),
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    hydrateDocumentFileRepresentationBindingStore([
      createDocumentFileRepresentationBinding({
        documentId: result.document.id,
        kind: 'archive',
        fileRefId: FILE_Y,
      }),
    ]);

    const conflictResult = orchestrateSourceReuseArchiveBindingAfterImport({
      documentId: result.document.id,
      transformPlan: transformPlanFor('legal_document'),
    });
    expect(conflictResult.kind).toBe('conflict');

    recordPostImportDerivativeStepOutcome({
      documentId: result.document.id,
      stepId: 'source_reuse_archive',
      result: conflictResult,
      sourceFileRefId: FILE_X,
      sourceMimeType: 'application/pdf',
    });

    expect(
      findDocumentFileDerivativeStepOutcome(result.document.id, 'source_reuse_archive'),
    ).toMatchObject({
      outcome: 'conflict',
      attempt: 2,
    });
  });

  it('Error wird korrekt gespeichert ohne Rohfehlermeldung', () => {
    hydrateDocumentFileStore([sampleFileRef(FILE_X)], {});
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(
      sourceReusePersistence,
      'persistSourceReuseArchiveRepresentationBinding',
    ).mockImplementation(() => {
      throw new Error('secret-internal-detail');
    });

    const item = prepareInbox(FILE_X);
    const result = importInboxDocument(item, 'Test GmbH', {
      transformPlan: transformPlanFor('legal_document'),
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const outcome = findDocumentFileDerivativeStepOutcome(
      result.document.id,
      'source_reuse_archive',
    );
    expect(outcome).toMatchObject({
      outcome: 'error',
      errorCode: 'orchestrator_error',
      attempt: 1,
    });
    expect(JSON.stringify(outcome)).not.toMatch(/secret-internal-detail/);
  });

  it('Attempt wird genau einmal erhöht', () => {
    const item = prepareInbox(FILE_X);
    const plan = transformPlanFor('legal_document');
    const first = importInboxDocument(item, 'Test GmbH', { transformPlan: plan });
    expect(first.success).toBe(true);
    if (!first.success) return;

    expect(
      findDocumentFileDerivativeStepOutcome(first.document.id, 'source_reuse_archive')?.attempt,
    ).toBe(1);

    const second = orchestrateSourceReuseArchiveBindingAfterImport({
      documentId: first.document.id,
      transformPlan: plan,
    });
    expect(second).toMatchObject({ kind: 'persisted', registration: 'unchanged' });

    recordPostImportDerivativeStepOutcome({
      documentId: first.document.id,
      stepId: 'source_reuse_archive',
      result: second,
      sourceFileRefId: FILE_X,
      sourceMimeType: 'application/pdf',
    });

    expect(
      findDocumentFileDerivativeStepOutcome(first.document.id, 'source_reuse_archive')?.attempt,
    ).toBe(2);
  });

  it('Source-Reuse wird nicht zusätzlich vom async Coordinator ausgeführt', async () => {
    let sourceReuseRunnerCalls = 0;
    setPostImportDerivativeStepRunnersForTests({
      source_reuse_archive: async () => {
        sourceReuseRunnerCalls += 1;
        return { kind: 'noop', reason: 'missing_transform_plan' };
      },
      raster_archive: async () => ({ kind: 'noop', reason: 'encode_plan_unresolved' }),
      image_to_pdf_archive: async () => ({ kind: 'noop', reason: 'encode_plan_unresolved' }),
      pdf_metadata_strip: async () => ({ kind: 'noop', reason: 'strip_plan_unresolved' }),
      raster_thumbnail: async () => ({ kind: 'noop', reason: 'encode_plan_unresolved' }),
      raster_preview: async () => ({ kind: 'noop', reason: 'encode_plan_unresolved' }),
      pdf_thumbnail: async () => ({ kind: 'noop', reason: 'encode_plan_unresolved' }),
      pdf_preview: async () => ({ kind: 'noop', reason: 'encode_plan_unresolved' }),
    });

    const item = prepareInbox(FILE_X);
    const result = importInboxDocument(item, 'Test GmbH', {
      transformPlan: transformPlanFor('legal_document'),
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    await vi.waitFor(() => {
      expect(
        getDocumentFileDerivativeStepOutcomeStoreSnapshot().filter((entry) =>
          (POST_IMPORT_DERIVATIVE_STEP_IDS as readonly string[]).includes(entry.stepId),
        ).length,
      ).toBeGreaterThanOrEqual(POST_IMPORT_DERIVATIVE_STEP_IDS.length);
    });

    expect(sourceReuseRunnerCalls).toBe(0);
    expect(
      findDocumentFileDerivativeStepOutcome(result.document.id, 'source_reuse_archive')?.attempt,
    ).toBe(1);
    expect(
      getDocumentFileDerivativeStepOutcomeStoreSnapshot().filter(
        (entry) => entry.stepId === 'source_reuse_archive',
      ),
    ).toHaveLength(1);
  });

  it('Error + fehlendes Archive + Recovery-Context ist retrybar', async () => {
    const item = prepareInbox(FILE_X);
    const plan = transformPlanFor('legal_document');
    const imported = importInboxDocument(item, 'Test GmbH', { transformPlan: plan });
    expect(imported.success).toBe(true);
    if (!imported.success) return;

    hydrateDocumentFileRepresentationBindingStore([]);
    hydrateDocumentFileDerivativeStepOutcomeStore([
      createDocumentFileDerivativeStepOutcome({
        documentId: imported.document.id,
        stepId: 'source_reuse_archive',
        representationKind: 'archive',
        outcome: 'error',
        errorCode: 'orchestrator_error',
        sourceFileRefId: FILE_X,
        sourceMimeType: 'application/pdf',
        createdFileRef: false,
        attempt: 1,
        updatedAt: '2026-07-20T20:00:00.000Z',
      }),
    ]);
    seedRecovery(imported.document.id, plan);

    const status = await buildDocumentFileDerivativeRecoveryDetailStatus(imported.document.id);
    expect(status.problems).toHaveLength(1);
    expect(status.problems[0]).toMatchObject({
      representationKind: 'archive',
      status: 'error',
      selectedStepId: 'source_reuse_archive',
      canRetry: true,
    });
  });

  it('erfolgreicher Retry erzeugt bzw. bindet das Archive', async () => {
    const item = prepareInbox(FILE_X);
    const plan = transformPlanFor('legal_document');
    const imported = importInboxDocument(item, 'Test GmbH', { transformPlan: plan });
    expect(imported.success).toBe(true);
    if (!imported.success) return;

    hydrateDocumentFileRepresentationBindingStore([]);
    hydrateDocumentFileDerivativeStepOutcomeStore([
      createDocumentFileDerivativeStepOutcome({
        documentId: imported.document.id,
        stepId: 'source_reuse_archive',
        representationKind: 'archive',
        outcome: 'error',
        errorCode: 'orchestrator_error',
        sourceFileRefId: FILE_X,
        sourceMimeType: 'application/pdf',
        createdFileRef: false,
        attempt: 1,
        updatedAt: '2026-07-20T20:00:00.000Z',
      }),
    ]);
    seedRecovery(imported.document.id, plan);

    const retry = await retryDocumentFileDerivativeStep({
      documentId: imported.document.id,
      stepId: 'source_reuse_archive',
      transformPlan: plan,
    });
    expect(retry.kind).toBe('retried');
    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
      {
        documentId: imported.document.id,
        kind: 'archive',
        fileRefId: FILE_X,
      },
    ]);
    expect(
      findDocumentFileDerivativeStepOutcome(imported.document.id, 'source_reuse_archive'),
    ).toMatchObject({
      outcome: 'persisted',
      attempt: 2,
      resultFileRefId: FILE_X,
      registrationStatus: 'created',
    });
    expect(retry.orchestrationResult).toMatchObject({
      kind: 'persisted',
      registration: 'created',
      archiveFileRefId: FILE_X,
    });
  });

  it('Conflict/Noop/kein Context zeigen keinen Retry', async () => {
    const item = prepareInbox(FILE_X);
    const plan = transformPlanFor('legal_document');
    const imported = importInboxDocument(item, 'Test GmbH', { transformPlan: plan });
    expect(imported.success).toBe(true);
    if (!imported.success) return;

    hydrateDocumentFileRepresentationBindingStore([]);

    hydrateDocumentFileDerivativeStepOutcomeStore([
      createDocumentFileDerivativeStepOutcome({
        documentId: imported.document.id,
        stepId: 'source_reuse_archive',
        representationKind: 'archive',
        outcome: 'conflict',
        sourceFileRefId: FILE_X,
        sourceMimeType: 'application/pdf',
        createdFileRef: false,
        attempt: 1,
        updatedAt: '2026-07-20T20:00:00.000Z',
      }),
    ]);
    seedRecovery(imported.document.id, plan);
    let status = await buildDocumentFileDerivativeRecoveryDetailStatus(imported.document.id);
    expect(status.problems[0]).toMatchObject({ status: 'conflict', canRetry: false });

    hydrateDocumentFileDerivativeStepOutcomeStore([
      createDocumentFileDerivativeStepOutcome({
        documentId: imported.document.id,
        stepId: 'source_reuse_archive',
        representationKind: 'archive',
        outcome: 'noop',
        noopReason: 'unresolved',
        sourceFileRefId: FILE_X,
        sourceMimeType: 'application/pdf',
        createdFileRef: false,
        attempt: 1,
        updatedAt: '2026-07-20T20:00:00.000Z',
      }),
    ]);
    status = await buildDocumentFileDerivativeRecoveryDetailStatus(imported.document.id);
    expect(status.problems).toEqual([]);

    hydrateDocumentFileDerivativeStepOutcomeStore([
      createDocumentFileDerivativeStepOutcome({
        documentId: imported.document.id,
        stepId: 'source_reuse_archive',
        representationKind: 'archive',
        outcome: 'error',
        errorCode: 'orchestrator_error',
        sourceFileRefId: FILE_X,
        sourceMimeType: 'application/pdf',
        createdFileRef: false,
        attempt: 1,
        updatedAt: '2026-07-20T20:00:00.000Z',
      }),
    ]);
    resetDocumentFileDerivativeRecoveryContextStoreForTests();
    status = await buildDocumentFileDerivativeRecoveryDetailStatus(imported.document.id);
    expect(status.hasRecoveryPlan).toBe(false);
    expect(status.problems[0]).toMatchObject({ status: 'error', canRetry: false });
  });
});
