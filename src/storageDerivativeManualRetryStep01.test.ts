import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingService';
import {
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './services/documentFileRepresentationBindingStoreService';
import {
  createDocumentFileDerivativeStepOutcome,
} from './services/documentFileDerivativeStepOutcomeService';
import {
  findDocumentFileDerivativeStepOutcome,
  getDocumentFileDerivativeStepOutcomeStoreSnapshot,
  hydrateDocumentFileDerivativeStepOutcomeStore,
  resetDocumentFileDerivativeStepOutcomeStoreForTests,
} from './services/documentFileDerivativeStepOutcomeStoreService';
import {
  DOCUMENT_FILE_DERIVATIVE_STEP_MAX_ATTEMPTS,
  retryDocumentFileDerivativeStep,
} from './services/documentFileDerivativeStepManualRetryService';
import {
  isDocumentFileDerivativeStepInFlightForTests,
  resetDocumentFileDerivativeStepInFlightLocksForTests,
  tryAcquireDocumentFileDerivativeStepInFlightLock,
  releaseDocumentFileDerivativeStepInFlightLock,
} from './services/documentFileDerivativeStepInFlightLockService';
import {
  orchestratePostImportDerivativesAfterImport,
  setPostImportDerivativeStepRunnersForTests,
} from './services/documentFilePostImportDerivativeOrchestrationService';
import { hydrateDocumentStore } from './services/documentService';
import {
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload,
} from './services/documentFileStoreService';
import { withNewEntitySync } from './services/sync/syncMetaService';
import { resetTestStores } from './test/resetStores';
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';
import type { CompanyDocument } from './types/models';
import type { PostImportDerivativeStepId } from './types/documentFileDerivativeStepOutcome';

const DOC_A = 'doc-manual-retry-a';
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x52]);

function samplePlan(): DocumentFileTransformPlan {
  return {
    policyId: 'business_document',
    mediaProfile: 'raster_image',
    hints: {
      metadataHandling: 'strip_nonessential',
      colorHandling: 'preserve',
      preferredOutputKind: 'preserve_source',
    },
    intents: [
      {
        targetKind: 'archive',
        intent: 'create_archive',
        executionIntent: 'preferred',
      },
    ],
  };
}

function sampleDocument(id: string, fileRefId: string): CompanyDocument {
  return withNewEntitySync(
    {
      id,
      title: `Document ${id}`,
      category: 'beleg',
      issuer: 'Test',
      recognizedText: '',
      issueDate: null,
      validUntil: null,
      digitalFolder: { id: 'belege', name: 'Belege', path: '/belege' },
      paperFolder: { folderId: 'belege', register: 'A', label: 'Belege' },
      tags: [],
      linkedCompany: 'Test GmbH',
      linkedVorgang: null,
      archived: false,
      createdAt: '2026-07-20T00:00:00.000Z',
      fileRefId,
    },
    'document',
  );
}

function seedOutcome(input: {
  stepId?: PostImportDerivativeStepId;
  outcome: 'error' | 'persisted' | 'noop' | 'conflict';
  attempt?: number;
  sourceFileRefId?: string;
}): void {
  const stepId = input.stepId ?? 'raster_archive';
  hydrateDocumentFileDerivativeStepOutcomeStore([
    createDocumentFileDerivativeStepOutcome({
      documentId: DOC_A,
      stepId,
      representationKind: 'archive',
      outcome: input.outcome,
      errorCode: input.outcome === 'error' ? 'orchestrator_error' : undefined,
      noopReason: input.outcome === 'noop' ? 'no_archive_intent' : undefined,
      registrationStatus: input.outcome === 'persisted' ? 'created' : undefined,
      resultFileRefId: input.outcome === 'persisted' ? 'file-missing-archive' : undefined,
      sourceFileRefId: input.sourceFileRefId ?? 'file-src',
      sourceMimeType: 'image/jpeg',
      createdFileRef: input.outcome === 'persisted',
      attempt: input.attempt ?? 1,
      updatedAt: '2026-07-20T12:00:00.000Z',
    }),
  ]);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  setPostImportDerivativeStepRunnersForTests(null);
  resetTestStores();
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
  resetDocumentFileDerivativeStepOutcomeStoreForTests();
  resetDocumentFileDerivativeStepInFlightLocksForTests();
});

describe('STORAGE-DERIVATIVE-MANUAL-RETRY-STEP-01', () => {
  it('error → erfolgreicher Retry und Attempt genau einmal erhöht', async () => {
    const source = await storeDocumentFileFromCachedPayload(
      {
        fileName: 'src.jpg',
        mimeType: 'image/jpeg',
        fileSize: JPEG_BYTES.byteLength,
        bytes: JPEG_BYTES,
      },
      { lifecycleIntent: 'committed' },
    );
    hydrateDocumentStore([sampleDocument(DOC_A, source.fileRef.id)]);
    seedOutcome({ outcome: 'error', attempt: 1, sourceFileRefId: source.fileRef.id });

    let runs = 0;
    setPostImportDerivativeStepRunnersForTests({
      raster_archive: async () => {
        runs += 1;
        return {
          kind: 'persisted',
          registration: 'created',
          archiveFileRefId: 'file-archive-retry',
          createdArchiveFileRef: true,
        };
      },
    });

    const result = await retryDocumentFileDerivativeStep({
      documentId: DOC_A,
      stepId: 'raster_archive',
      transformPlan: samplePlan(),
    });

    expect(result.kind).toBe('retried');
    expect(runs).toBe(1);
    const stored = findDocumentFileDerivativeStepOutcome(DOC_A, 'raster_archive');
    expect(stored).toMatchObject({
      outcome: 'persisted',
      registrationStatus: 'created',
      resultFileRefId: 'file-archive-retry',
      attempt: 2,
    });
  });

  it('persisted + missing Representation → Retry', async () => {
    hydrateDocumentStore([sampleDocument(DOC_A, 'file-src')]);
    seedOutcome({ outcome: 'persisted', attempt: 2 });
    expect(getDocumentFileDerivativeStepOutcomeStoreSnapshot()[0]?.attempt).toBe(2);

    setPostImportDerivativeStepRunnersForTests({
      raster_archive: async () => ({
        kind: 'persisted',
        registration: 'created',
        archiveFileRefId: 'file-archive-rebuilt',
        createdArchiveFileRef: true,
      }),
    });

    const result = await retryDocumentFileDerivativeStep({
      documentId: DOC_A,
      stepId: 'raster_archive',
      transformPlan: samplePlan(),
    });

    expect(result.kind).toBe('retried');
    expect(findDocumentFileDerivativeStepOutcome(DOC_A, 'raster_archive')?.attempt).toBe(3);
  });

  it('ready → Skip ohne Attempt-Erhöhung und ohne Outcome-Overwrite', async () => {
    const archive = await storeDocumentFileFromCachedPayload(
      {
        fileName: 'archive.jpg',
        mimeType: 'image/jpeg',
        fileSize: JPEG_BYTES.byteLength,
        bytes: JPEG_BYTES,
      },
      { lifecycleIntent: 'committed' },
    );
    hydrateDocumentStore([sampleDocument(DOC_A, 'file-src')]);
    hydrateDocumentFileRepresentationBindingStore([
      createDocumentFileRepresentationBinding({
        documentId: DOC_A,
        kind: 'archive',
        fileRefId: archive.fileRef.id,
      }),
    ]);
    seedOutcome({
      outcome: 'error',
      attempt: 3,
      sourceFileRefId: 'file-src',
    });

    let runs = 0;
    setPostImportDerivativeStepRunnersForTests({
      raster_archive: async () => {
        runs += 1;
        return { kind: 'noop', reason: 'missing_transform_plan' };
      },
    });

    const before = findDocumentFileDerivativeStepOutcome(DOC_A, 'raster_archive');
    const result = await retryDocumentFileDerivativeStep({
      documentId: DOC_A,
      stepId: 'raster_archive',
      transformPlan: samplePlan(),
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'already_ready' });
    expect(runs).toBe(0);
    expect(findDocumentFileDerivativeStepOutcome(DOC_A, 'raster_archive')).toEqual(before);
  });

  it('noop/conflict/fehlendes Outcome → not_eligible', async () => {
    hydrateDocumentStore([sampleDocument(DOC_A, 'file-src')]);

    seedOutcome({ outcome: 'noop' });
    expect(
      await retryDocumentFileDerivativeStep({
        documentId: DOC_A,
        stepId: 'raster_archive',
        transformPlan: samplePlan(),
      }),
    ).toEqual({ kind: 'rejected', reason: 'not_eligible' });

    seedOutcome({ outcome: 'conflict' });
    expect(
      await retryDocumentFileDerivativeStep({
        documentId: DOC_A,
        stepId: 'raster_archive',
        transformPlan: samplePlan(),
      }),
    ).toEqual({ kind: 'rejected', reason: 'not_eligible' });

    hydrateDocumentFileDerivativeStepOutcomeStore([]);
    expect(
      await retryDocumentFileDerivativeStep({
        documentId: DOC_A,
        stepId: 'raster_archive',
        transformPlan: samplePlan(),
      }),
    ).toEqual({ kind: 'rejected', reason: 'not_eligible' });
  });

  it('attempt 5 → exhausted', async () => {
    hydrateDocumentStore([sampleDocument(DOC_A, 'file-src')]);
    seedOutcome({
      outcome: 'error',
      attempt: DOCUMENT_FILE_DERIVATIVE_STEP_MAX_ATTEMPTS,
    });

    let runs = 0;
    setPostImportDerivativeStepRunnersForTests({
      raster_archive: async () => {
        runs += 1;
        return { kind: 'persisted', registration: 'created', archiveFileRefId: 'x', createdArchiveFileRef: true };
      },
    });

    expect(
      await retryDocumentFileDerivativeStep({
        documentId: DOC_A,
        stepId: 'raster_archive',
        transformPlan: samplePlan(),
      }),
    ).toEqual({ kind: 'exhausted' });
    expect(runs).toBe(0);
    expect(findDocumentFileDerivativeStepOutcome(DOC_A, 'raster_archive')?.attempt).toBe(5);
  });

  it('paralleler Aufruf → in_flight', async () => {
    hydrateDocumentStore([sampleDocument(DOC_A, 'file-src')]);
    seedOutcome({ outcome: 'error', attempt: 1 });

    const gate = deferred<void>();
    setPostImportDerivativeStepRunnersForTests({
      raster_archive: async () => {
        await gate.promise;
        return {
          kind: 'persisted',
          registration: 'created',
          archiveFileRefId: 'file-a',
          createdArchiveFileRef: true,
        };
      },
    });

    const first = retryDocumentFileDerivativeStep({
      documentId: DOC_A,
      stepId: 'raster_archive',
      transformPlan: samplePlan(),
    });

    await vi.waitFor(() => {
      expect(isDocumentFileDerivativeStepInFlightForTests(DOC_A, 'raster_archive')).toBe(true);
    });

    const second = await retryDocumentFileDerivativeStep({
      documentId: DOC_A,
      stepId: 'raster_archive',
      transformPlan: samplePlan(),
    });
    expect(second).toEqual({ kind: 'rejected', reason: 'in_flight' });

    gate.resolve();
    const firstResult = await first;
    expect(firstResult.kind).toBe('retried');
    expect(isDocumentFileDerivativeStepInFlightForTests(DOC_A, 'raster_archive')).toBe(false);
  });

  it('Coordinator und Retry teilen denselben Lock', async () => {
    hydrateDocumentStore([sampleDocument(DOC_A, 'file-src')]);
    seedOutcome({ outcome: 'error', attempt: 1 });

    expect(tryAcquireDocumentFileDerivativeStepInFlightLock(DOC_A, 'raster_archive')).toBe(true);

    const retryWhileLocked = await retryDocumentFileDerivativeStep({
      documentId: DOC_A,
      stepId: 'raster_archive',
      transformPlan: samplePlan(),
    });
    expect(retryWhileLocked).toEqual({ kind: 'rejected', reason: 'in_flight' });

    let coordinatorRanRaster = false;
    setPostImportDerivativeStepRunnersForTests({
      raster_archive: async () => {
        coordinatorRanRaster = true;
        return { kind: 'noop', reason: 'missing_transform_plan' };
      },
      image_to_pdf_archive: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      pdf_metadata_strip: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      raster_thumbnail: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      raster_preview: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      pdf_thumbnail: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      pdf_preview: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
    });

    const orch = await orchestratePostImportDerivativesAfterImport({
      documentId: DOC_A,
      transformPlan: null,
    });
    expect(coordinatorRanRaster).toBe(false);
    expect(orch.steps.find((s) => s.stepId === 'raster_archive')?.outcome).toBe('failed');

    releaseDocumentFileDerivativeStepInFlightLock(DOC_A, 'raster_archive');
  });

  it('Lock wird auch bei Fehler freigegeben', async () => {
    hydrateDocumentStore([sampleDocument(DOC_A, 'file-src')]);
    seedOutcome({ outcome: 'error', attempt: 1 });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    setPostImportDerivativeStepRunnersForTests({
      raster_archive: async () => {
        throw new Error('encode boom');
      },
    });

    const result = await retryDocumentFileDerivativeStep({
      documentId: DOC_A,
      stepId: 'raster_archive',
      transformPlan: samplePlan(),
    });

    expect(result.kind).toBe('retried');
    expect(isDocumentFileDerivativeStepInFlightForTests(DOC_A, 'raster_archive')).toBe(false);
    expect(findDocumentFileDerivativeStepOutcome(DOC_A, 'raster_archive')).toMatchObject({
      outcome: 'error',
      errorCode: 'runner_threw',
      attempt: 2,
    });
  });
});
