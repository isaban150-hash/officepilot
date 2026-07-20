import { afterEach, describe, expect, it, vi } from 'vitest';
import { orchestrateSourceReuseArchiveBindingAfterImport } from './services/documentFileSourceReuseArchiveOrchestrationService';
import { orchestrateRasterArchiveEncodeAfterImport } from './services/documentFileRasterArchiveEncodeOrchestrationService';
import { orchestrateImageToPdfArchiveEncodeAfterImport } from './services/documentFileImageToPdfArchiveEncodeOrchestrationService';
import { orchestratePdfMetadataStripAfterImport } from './services/documentFilePdfMetadataStripOrchestrationService';
import { orchestrateRasterThumbnailEncodeAfterImport } from './services/documentFileRasterThumbnailEncodeOrchestrationService';
import { orchestrateRasterPreviewEncodeAfterImport } from './services/documentFileRasterPreviewEncodeOrchestrationService';
import { orchestratePdfThumbnailEncodeAfterImport } from './services/documentFilePdfThumbnailEncodeOrchestrationService';
import { orchestratePdfPreviewEncodeAfterImport } from './services/documentFilePdfPreviewEncodeOrchestrationService';
import {
  orchestratePostImportDerivativesAfterImport,
  setPostImportDerivativeStepRunnersForTests,
} from './services/documentFilePostImportDerivativeOrchestrationService';
import { retryDocumentFileDerivativeStep } from './services/documentFileDerivativeStepManualRetryService';
import { createDocumentFileDerivativeStepOutcome } from './services/documentFileDerivativeStepOutcomeService';
import {
  findDocumentFileDerivativeStepOutcome,
  hydrateDocumentFileDerivativeStepOutcomeStore,
  resetDocumentFileDerivativeStepOutcomeStoreForTests,
} from './services/documentFileDerivativeStepOutcomeStoreService';
import { hydrateDocumentStore } from './services/documentService';
import { resetDocumentFileDerivativeStepInFlightLocksForTests } from './services/documentFileDerivativeStepInFlightLockService';
import { withNewEntitySync } from './services/sync/syncMetaService';
import { resetTestStores } from './test/resetStores';
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';
import type { CompanyDocument } from './types/models';

const SENSITIVE =
  'SECRET_PATH_C:\\Users\\secret\\doc.bin MESSAGE_STACK_TRACE bytes=deadbeef hash=abc123';

const DOC = 'doc-privacy-safe-errors';

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
      {
        targetKind: 'preview',
        intent: 'create_preview',
        executionIntent: 'preferred',
      },
      {
        targetKind: 'thumbnail',
        intent: 'create_thumbnail',
        executionIntent: 'preferred',
      },
    ],
  };
}

function sampleDocument(): CompanyDocument {
  return withNewEntitySync(
    {
      id: DOC,
      title: 'Privacy Doc',
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
      fileRefId: 'file-privacy-src',
    },
    'document',
  );
}

function assertNoSensitiveLeak(value: unknown): void {
  const serialized = JSON.stringify(value) ?? String(value);
  expect(serialized).not.toMatch(/SECRET_PATH|MESSAGE_STACK|deadbeef|hash=abc123/i);
  expect(serialized).not.toMatch(/Error:|at Object\.|TypeError:/i);
}

afterEach(() => {
  vi.restoreAllMocks();
  setPostImportDerivativeStepRunnersForTests(null);
  resetDocumentFileDerivativeStepInFlightLocksForTests();
  resetDocumentFileDerivativeStepOutcomeStoreForTests();
  resetTestStores();
});

describe('STORAGE-DERIVATIVE-PRIVACY-SAFE-ERRORS-01', () => {
  const invalidInput = null as unknown as {
    documentId: string;
    transformPlan: DocumentFileTransformPlan | null;
  };

  it.each([
    {
      name: 'source_reuse_archive',
      run: () => orchestrateSourceReuseArchiveBindingAfterImport(invalidInput),
      prefix: '[OfficePilot:source-reuse-archive-binding]',
      stepId: 'source_reuse_archive',
    },
    {
      name: 'raster_archive',
      run: () => orchestrateRasterArchiveEncodeAfterImport(invalidInput),
      prefix: '[OfficePilot:raster-archive-encode]',
      stepId: 'raster_archive',
    },
    {
      name: 'image_to_pdf_archive',
      run: () => orchestrateImageToPdfArchiveEncodeAfterImport(invalidInput),
      prefix: '[OfficePilot:image-to-pdf-archive-encode]',
      stepId: 'image_to_pdf_archive',
    },
    {
      name: 'pdf_metadata_strip',
      run: () => orchestratePdfMetadataStripAfterImport(invalidInput),
      prefix: '[OfficePilot:pdf-metadata-strip]',
      stepId: 'pdf_metadata_strip',
    },
    {
      name: 'raster_thumbnail',
      run: () => orchestrateRasterThumbnailEncodeAfterImport(invalidInput),
      prefix: '[OfficePilot:raster-thumbnail-encode]',
      stepId: 'raster_thumbnail',
    },
    {
      name: 'raster_preview',
      run: () => orchestrateRasterPreviewEncodeAfterImport(invalidInput),
      prefix: '[OfficePilot:raster-preview-encode]',
      stepId: 'raster_preview',
    },
    {
      name: 'pdf_thumbnail',
      run: () => orchestratePdfThumbnailEncodeAfterImport(invalidInput),
      prefix: '[OfficePilot:pdf-thumbnail-encode]',
      stepId: 'pdf_thumbnail',
    },
    {
      name: 'pdf_preview',
      run: () => orchestratePdfPreviewEncodeAfterImport(invalidInput),
      prefix: '[OfficePilot:pdf-preview-encode]',
      stepId: 'pdf_preview',
    },
  ] as const)(
    'echter Catch-Pfad $name liefert kein Error-Objekt und loggt nur Prefix/stepId/Code',
    async ({ run, prefix, stepId }) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const result = await run();

      expect(result).toEqual({ kind: 'error', errorCode: 'unexpected_failure' });
      expect(result).not.toHaveProperty('error');
      assertNoSensitiveLeak(result);

      expect(errorSpy).toHaveBeenCalledWith(prefix, stepId, 'unexpected_failure');
      for (const call of errorSpy.mock.calls) {
        assertNoSensitiveLeak(call);
        expect(call).toHaveLength(3);
      }
    },
  );

  it('Coordinator-Result enthält keine Rohfehler', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setPostImportDerivativeStepRunnersForTests({
      raster_archive: async () => {
        throw new Error(SENSITIVE);
      },
      image_to_pdf_archive: async () => ({
        kind: 'error',
        errorCode: 'transform_failed',
      }),
      pdf_metadata_strip: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      raster_thumbnail: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      raster_preview: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      pdf_thumbnail: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      pdf_preview: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
    });

    const result = await orchestratePostImportDerivativesAfterImport({
      documentId: DOC,
      transformPlan: samplePlan(),
    });

    expect(result.steps[0]).toEqual({
      stepId: 'raster_archive',
      outcome: 'failed',
      errorCode: 'runner_threw',
    });
    expect(result.steps[1]).toEqual({
      stepId: 'image_to_pdf_archive',
      outcome: 'failed',
      errorCode: 'transform_failed',
    });
    expect(result.steps[0]).not.toHaveProperty('error');
    assertNoSensitiveLeak(result);
    assertNoSensitiveLeak(errorSpy.mock.calls);

    const outcome = findDocumentFileDerivativeStepOutcome(DOC, 'raster_archive');
    expect(outcome).toMatchObject({
      outcome: 'error',
      errorCode: 'runner_threw',
    });
    assertNoSensitiveLeak(outcome);
  });

  it('Manual-Retry gibt keine Rohfehler weiter', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    hydrateDocumentStore([sampleDocument()]);
    hydrateDocumentFileDerivativeStepOutcomeStore([
      createDocumentFileDerivativeStepOutcome({
        documentId: DOC,
        stepId: 'raster_preview',
        representationKind: 'preview',
        outcome: 'error',
        errorCode: 'orchestrator_error',
        sourceFileRefId: 'file-privacy-src',
        sourceMimeType: 'image/jpeg',
        createdFileRef: false,
        attempt: 1,
        updatedAt: '2026-07-20T21:00:00.000Z',
      }),
    ]);

    setPostImportDerivativeStepRunnersForTests({
      raster_preview: async () => {
        throw new Error(SENSITIVE);
      },
    });

    const result = await retryDocumentFileDerivativeStep({
      documentId: DOC,
      stepId: 'raster_preview',
      transformPlan: samplePlan(),
    });

    expect(result.kind).toBe('retried');
    if (result.kind !== 'retried') return;
    expect(result.orchestrationResult).toBeNull();
    expect(result.outcome).toMatchObject({
      outcome: 'error',
      errorCode: 'runner_threw',
    });
    assertNoSensitiveLeak(result);
    assertNoSensitiveLeak(errorSpy.mock.calls);
  });

  it('Outcome enthält nur stabilen errorCode bei Orchestrator-errorCode', async () => {
    hydrateDocumentStore([sampleDocument()]);
    setPostImportDerivativeStepRunnersForTests({
      raster_archive: async () => ({
        kind: 'error',
        errorCode: 'file_ref_write_failed',
      }),
      image_to_pdf_archive: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      pdf_metadata_strip: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      raster_thumbnail: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      raster_preview: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      pdf_thumbnail: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      pdf_preview: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
    });

    await orchestratePostImportDerivativesAfterImport({
      documentId: DOC,
      transformPlan: samplePlan(),
    });

    const outcome = findDocumentFileDerivativeStepOutcome(DOC, 'raster_archive');
    expect(outcome).toMatchObject({
      outcome: 'error',
      errorCode: 'file_ref_write_failed',
    });
    expect(Object.keys(outcome ?? {})).not.toContain('error');
    assertNoSensitiveLeak(outcome);
  });
});
