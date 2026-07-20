import { afterEach, describe, expect, it } from 'vitest';
import { createDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingService';
import {
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './services/documentFileRepresentationBindingStoreService';
import { createDocumentFileDerivativeStepOutcome } from './services/documentFileDerivativeStepOutcomeService';
import {
  hydrateDocumentFileDerivativeStepOutcomeStore,
  resetDocumentFileDerivativeStepOutcomeStoreForTests,
} from './services/documentFileDerivativeStepOutcomeStoreService';
import { upsertDocumentFileDerivativeRecoveryContext } from './services/documentFileDerivativeRecoveryContextService';
import { resetDocumentFileDerivativeRecoveryContextStoreForTests } from './services/documentFileDerivativeRecoveryContextStoreService';
import { buildDocumentFileDerivativeRecoveryDetailStatus } from './services/documentFileDerivativeRecoveryDetailStatusService';
import {
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload,
} from './services/documentFileStoreService';
import { resetTestStores } from './test/resetStores';
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';
import type { PostImportDerivativeStepId } from './types/documentFileDerivativeStepOutcome';
import type { DocumentFileRepresentationBindingKind } from './types/documentFileRepresentationBinding';

const DOC = 'doc-recovery-detail-status';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x53]);

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

function putOutcomes(
  entries: Array<{
    stepId: PostImportDerivativeStepId;
    kind: DocumentFileRepresentationBindingKind;
    outcome: 'error' | 'persisted' | 'noop' | 'conflict';
    attempt?: number;
  }>,
): void {
  hydrateDocumentFileDerivativeStepOutcomeStore(
    entries.map((entry) =>
      createDocumentFileDerivativeStepOutcome({
        documentId: DOC,
        stepId: entry.stepId,
        representationKind: entry.kind,
        outcome: entry.outcome,
        errorCode: entry.outcome === 'error' ? 'orchestrator_error' : undefined,
        noopReason: entry.outcome === 'noop' ? 'no_preview_intent' : undefined,
        registrationStatus: entry.outcome === 'persisted' ? 'created' : undefined,
        resultFileRefId: entry.outcome === 'persisted' ? 'file-missing' : undefined,
        sourceFileRefId: 'file-src',
        sourceMimeType: 'image/jpeg',
        createdFileRef: entry.outcome === 'persisted',
        attempt: entry.attempt ?? 1,
        updatedAt: '2026-07-20T18:00:00.000Z',
      }),
    ),
  );
}

function seedRecoveryPlan(): void {
  upsertDocumentFileDerivativeRecoveryContext({
    documentId: DOC,
    transformPlan: samplePlan(),
  });
}

afterEach(() => {
  resetTestStores();
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
  resetDocumentFileDerivativeStepOutcomeStoreForTests();
  resetDocumentFileDerivativeRecoveryContextStoreForTests();
});

describe('STORAGE-DERIVATIVE-RECOVERY-DETAIL-STATUS-01', () => {
  it('noop bleibt unsichtbar', async () => {
    putOutcomes([
      { stepId: 'raster_preview', kind: 'preview', outcome: 'noop' },
      { stepId: 'raster_thumbnail', kind: 'thumbnail', outcome: 'noop' },
      { stepId: 'raster_archive', kind: 'archive', outcome: 'noop' },
    ]);
    seedRecoveryPlan();

    const status = await buildDocumentFileDerivativeRecoveryDetailStatus(DOC);
    expect(status.problems).toEqual([]);
  });

  it('fehlende Representation ohne Outcome bleibt unsichtbar', async () => {
    seedRecoveryPlan();
    const status = await buildDocumentFileDerivativeRecoveryDetailStatus(DOC);
    expect(status.problems).toEqual([]);
  });

  it('error + Recovery-Plan → canRetry', async () => {
    putOutcomes([{ stepId: 'raster_preview', kind: 'preview', outcome: 'error', attempt: 2 }]);
    seedRecoveryPlan();

    const status = await buildDocumentFileDerivativeRecoveryDetailStatus(DOC);
    expect(status.problems).toHaveLength(1);
    expect(status.problems[0]).toMatchObject({
      representationKind: 'preview',
      status: 'error',
      selectedStepId: 'raster_preview',
      canRetry: true,
      attempt: 2,
      displayTitle: 'Vorschau fehlt',
    });
    expect(status.problems[0]?.retryHint).toBeTruthy();
    expect(status.problems[0]?.displayTitle).not.toMatch(/raster_|orchestrator_/);
    expect(status.problems[0]?.displayDetail).not.toMatch(/raster_|orchestrator_/);
  });

  it('error ohne Recovery-Plan → nicht retrybar', async () => {
    putOutcomes([{ stepId: 'pdf_thumbnail', kind: 'thumbnail', outcome: 'error' }]);

    const status = await buildDocumentFileDerivativeRecoveryDetailStatus(DOC);
    expect(status.hasRecoveryPlan).toBe(false);
    expect(status.problems[0]).toMatchObject({
      representationKind: 'thumbnail',
      status: 'error',
      canRetry: false,
      displayTitle: 'Vorschaubild fehlt',
    });
  });

  it('persisted + missing → korrekt', async () => {
    putOutcomes([
      { stepId: 'image_to_pdf_archive', kind: 'archive', outcome: 'persisted', attempt: 1 },
    ]);
    seedRecoveryPlan();

    const status = await buildDocumentFileDerivativeRecoveryDetailStatus(DOC);
    expect(status.problems[0]).toMatchObject({
      representationKind: 'archive',
      status: 'missing_after_persist',
      selectedStepId: 'image_to_pdf_archive',
      canRetry: true,
      displayTitle: 'Archivkopie fehlt',
    });
  });

  it('ready → kein Problem', async () => {
    const stored = await storeDocumentFileFromCachedPayload(
      {
        fileName: 'preview.jpg',
        mimeType: 'image/jpeg',
        fileSize: JPEG.byteLength,
        bytes: JPEG,
      },
      { lifecycleIntent: 'committed' },
    );
    hydrateDocumentFileRepresentationBindingStore([
      createDocumentFileRepresentationBinding({
        documentId: DOC,
        kind: 'preview',
        fileRefId: stored.fileRef.id,
      }),
    ]);
    putOutcomes([{ stepId: 'raster_preview', kind: 'preview', outcome: 'error' }]);
    seedRecoveryPlan();

    const status = await buildDocumentFileDerivativeRecoveryDetailStatus(DOC);
    expect(status.problems.find((entry) => entry.representationKind === 'preview')).toBeUndefined();
  });

  it('conflict → sichtbar, nicht retrybar', async () => {
    putOutcomes([{ stepId: 'pdf_preview', kind: 'preview', outcome: 'conflict' }]);
    seedRecoveryPlan();

    const status = await buildDocumentFileDerivativeRecoveryDetailStatus(DOC);
    expect(status.problems[0]).toMatchObject({
      representationKind: 'preview',
      status: 'conflict',
      canRetry: false,
    });
  });

  it('attempt >= 5 → exhausted, nicht retrybar', async () => {
    putOutcomes([
      { stepId: 'raster_archive', kind: 'archive', outcome: 'error', attempt: 5 },
    ]);
    seedRecoveryPlan();

    const status = await buildDocumentFileDerivativeRecoveryDetailStatus(DOC);
    expect(status.problems[0]).toMatchObject({
      representationKind: 'archive',
      status: 'exhausted',
      canRetry: false,
      attempt: 5,
    });
  });

  it('feste Step-Auswahl bei mehreren Archive-/Preview-/Thumbnail-Steps', async () => {
    putOutcomes([
      { stepId: 'pdf_metadata_strip', kind: 'archive', outcome: 'error', attempt: 1 },
      { stepId: 'raster_archive', kind: 'archive', outcome: 'error', attempt: 1 },
      { stepId: 'image_to_pdf_archive', kind: 'archive', outcome: 'persisted', attempt: 1 },
      { stepId: 'pdf_preview', kind: 'preview', outcome: 'error', attempt: 1 },
      { stepId: 'raster_preview', kind: 'preview', outcome: 'error', attempt: 1 },
      { stepId: 'pdf_thumbnail', kind: 'thumbnail', outcome: 'error', attempt: 1 },
      { stepId: 'raster_thumbnail', kind: 'thumbnail', outcome: 'error', attempt: 1 },
    ]);
    seedRecoveryPlan();

    const status = await buildDocumentFileDerivativeRecoveryDetailStatus(DOC);
    expect(status.problems.find((p) => p.representationKind === 'archive')?.selectedStepId).toBe(
      'raster_archive',
    );
    expect(status.problems.find((p) => p.representationKind === 'preview')?.selectedStepId).toBe(
      'raster_preview',
    );
    expect(status.problems.find((p) => p.representationKind === 'thumbnail')?.selectedStepId).toBe(
      'raster_thumbnail',
    );
  });

  it('Diagnose-Priorität exhausted > conflict > error', async () => {
    putOutcomes([
      { stepId: 'raster_archive', kind: 'archive', outcome: 'error', attempt: 1 },
      { stepId: 'image_to_pdf_archive', kind: 'archive', outcome: 'conflict', attempt: 1 },
      { stepId: 'pdf_metadata_strip', kind: 'archive', outcome: 'error', attempt: 5 },
    ]);
    seedRecoveryPlan();

    const status = await buildDocumentFileDerivativeRecoveryDetailStatus(DOC);
    expect(status.problems[0]).toMatchObject({
      representationKind: 'archive',
      status: 'exhausted',
      canRetry: false,
      attempt: 5,
    });
  });
});
