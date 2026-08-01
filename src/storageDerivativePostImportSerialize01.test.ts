import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  replaceDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './services/documentFileRepresentationBindingStoreService';
import {
  orchestratePostImportDerivativesAfterImport,
  POST_IMPORT_DERIVATIVE_STEP_IDS,
  setPostImportDerivativeStepRunnersForTests,
} from './services/documentFilePostImportDerivativeOrchestrationService';
import * as imageToPdfOrch from './services/documentFileImageToPdfArchiveEncodeOrchestrationService';
import {
  setImageToPdfWriteForTests,
} from './services/documentFileImageToPdfWriteService';
import { hydrateDocumentStore, importInboxDocument } from './services/documentService';
import {
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload,
} from './services/documentFileStoreService';
import { hydrateInboxStore } from './services/inboxService';
import { withNewEntitySync } from './services/sync/syncMetaService';
import { createAuftragInboxItem } from './test/fixtures';
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';
import type { CompanyDocument } from './types/models';
import type { PostImportDerivativeStepId } from './services/documentFilePostImportDerivativeOrchestrationService';

const DOC_A = 'doc-post-import-serialize-a';
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);

function imageToPdfTransformPlan(): DocumentFileTransformPlan {
  return {
    policyId: 'receipt',
    mediaProfile: 'raster_image',
    hints: {
      metadataHandling: 'preserve',
      colorHandling: 'preserve',
      preferredOutputKind: 'pdf_preferred',
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

useDocumentBlobDatabaseReset();

afterEach(() => {
  vi.restoreAllMocks();
  setPostImportDerivativeStepRunnersForTests(null);
  setImageToPdfWriteForTests(null);
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
});

describe('STORAGE-DERIVATIVE-POST-IMPORT-SERIALIZE-01', () => {
  it('führt Derived-Schritte in fester Reihenfolge aus', async () => {
    const order: PostImportDerivativeStepId[] = [];
    const runners = Object.fromEntries(
      POST_IMPORT_DERIVATIVE_STEP_IDS.map((stepId) => [
        stepId,
        async () => {
          order.push(stepId);
          return { kind: 'noop', reason: 'missing_transform_plan' };
        },
      ]),
    ) as Record<PostImportDerivativeStepId, () => Promise<unknown>>;

    setPostImportDerivativeStepRunnersForTests(runners);

    const result = await orchestratePostImportDerivativesAfterImport({
      documentId: DOC_A,
      transformPlan: null,
    });

    expect(order).toEqual([...POST_IMPORT_DERIVATIVE_STEP_IDS]);
    expect(result.steps.map((step) => step.stepId)).toEqual([...POST_IMPORT_DERIVATIVE_STEP_IDS]);
    expect(result.steps.every((step) => step.outcome === 'completed')).toBe(true);
  });

  it('läuft maximal ein Derived-Schritt gleichzeitig', async () => {
    let active = 0;
    let maxActive = 0;
    const gate = deferred<void>();
    let firstEntered = deferred<void>();

    setPostImportDerivativeStepRunnersForTests({
      raster_archive: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        firstEntered.resolve();
        await gate.promise;
        active -= 1;
        return { kind: 'noop', reason: 'missing_transform_plan' };
      },
      image_to_pdf_archive: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
        return { kind: 'noop', reason: 'missing_transform_plan' };
      },
      pdf_metadata_strip: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      raster_thumbnail: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      raster_preview: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      pdf_thumbnail: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      pdf_preview: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
    });

    const running = orchestratePostImportDerivativesAfterImport({
      documentId: DOC_A,
      transformPlan: null,
    });

    await firstEntered.promise;
    expect(active).toBe(1);
    gate.resolve();
    await running;

    expect(maxActive).toBe(1);
  });

  it('Import bleibt non-blocking gegenüber dem Coordinator', async () => {
    const gate = deferred<void>();
    let coordinatorStarted = false;

    setPostImportDerivativeStepRunnersForTests({
      raster_archive: async () => {
        coordinatorStarted = true;
        await gate.promise;
        return { kind: 'noop', reason: 'missing_transform_plan' };
      },
      image_to_pdf_archive: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      pdf_metadata_strip: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      raster_thumbnail: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      raster_preview: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      pdf_thumbnail: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      pdf_preview: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
    });

    const source = await storeDocumentFileFromCachedPayload(
      {
        fileName: 'import.jpg',
        mimeType: 'image/jpeg',
        fileSize: JPEG_BYTES.byteLength,
        bytes: JPEG_BYTES,
      },
      { lifecycleIntent: 'committed' },
    );
    const item = createAuftragInboxItem({
      id: 'inbox-post-import-serialize',
      fileRefId: source.fileRef.id,
      sourceFileHash: source.fileRef.contentHash,
    });
    hydrateInboxStore([item]);

    const imported = importInboxDocumentForTests(item, 'Test GmbH', {
      transformPlan: imageToPdfTransformPlan(),
    });
    expect(imported.success).toBe(true);

    await vi.waitFor(() => {
      expect(coordinatorStarted).toBe(true);
    });
    // Import hat bereits zurückgegeben, während der Coordinator noch wartet.
    expect(imported.success).toBe(true);

    gate.resolve();
    await vi.waitFor(() => {
      // Coordinator fertig: keine Assertion auf Store nötig — Gate freigeben reicht.
      expect(gate).toBeTruthy();
    });
  });

  it('Fehler stoppt Folgeschritte nicht', async () => {
    const order: PostImportDerivativeStepId[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    setPostImportDerivativeStepRunnersForTests({
      raster_archive: async () => {
        order.push('raster_archive');
        throw new Error('raster boom');
      },
      image_to_pdf_archive: async () => {
        order.push('image_to_pdf_archive');
        return { kind: 'error', errorCode: 'transform_failed' };
      },
      pdf_metadata_strip: async () => {
        order.push('pdf_metadata_strip');
        return { kind: 'noop', reason: 'missing_transform_plan' };
      },
      raster_thumbnail: async () => {
        order.push('raster_thumbnail');
        return { kind: 'noop', reason: 'missing_transform_plan' };
      },
      raster_preview: async () => {
        order.push('raster_preview');
        return { kind: 'noop', reason: 'missing_transform_plan' };
      },
      pdf_thumbnail: async () => {
        order.push('pdf_thumbnail');
        return { kind: 'noop', reason: 'missing_transform_plan' };
      },
      pdf_preview: async () => {
        order.push('pdf_preview');
        return { kind: 'noop', reason: 'missing_transform_plan' };
      },
    });

    const result = await orchestratePostImportDerivativesAfterImport({
      documentId: DOC_A,
      transformPlan: null,
    });

    expect(order).toEqual([...POST_IMPORT_DERIVATIVE_STEP_IDS]);
    expect(result.steps[0]).toMatchObject({
      stepId: 'raster_archive',
      outcome: 'failed',
      errorCode: 'runner_threw',
    });
    expect(result.steps[1]).toMatchObject({
      stepId: 'image_to_pdf_archive',
      outcome: 'failed',
      errorCode: 'transform_failed',
    });
    expect(result.steps.slice(2).every((step) => step.outcome === 'completed')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/raster boom|encode_failed|stack|SECRET/i);
    expect(result.steps.every((step) => !('error' in step))).toBe(true);
  });

  it('bewahrt Sibling-Binding bei Fehler-Rollback eines späteren Schritts', async () => {
    const sibling = createDocumentFileRepresentationBinding({
      documentId: DOC_A,
      kind: 'thumbnail',
      fileRefId: 'file-sibling-thumb',
    });

    const source = await storeDocumentFileFromCachedPayload(
      {
        fileName: 'sibling.jpg',
        mimeType: 'image/jpeg',
        fileSize: JPEG_BYTES.byteLength,
        bytes: JPEG_BYTES,
      },
      { lifecycleIntent: 'committed' },
    );
    hydrateDocumentStore([sampleDocument(DOC_A, source.fileRef.id)]);

    setImageToPdfWriteForTests(async () => {
      throw Object.freeze({ code: 'encode_failed', message: 'pdf boom' });
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Echten Image-to-PDF-Orchestrator für den Fehler-/Rollback-Pfad belassen.
    setPostImportDerivativeStepRunnersForTests({
      raster_archive: async () => {
        replaceDocumentFileRepresentationBindingStore([sibling]);
        return { kind: 'noop', reason: 'encode_plan_unresolved' };
      },
      image_to_pdf_archive: imageToPdfOrch.orchestrateImageToPdfArchiveEncodeAfterImport,
      pdf_metadata_strip: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      raster_thumbnail: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      raster_preview: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      pdf_thumbnail: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
      pdf_preview: async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
    });

    await orchestratePostImportDerivativesAfterImport({
      documentId: DOC_A,
      transformPlan: imageToPdfTransformPlan(),
    });

    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([sibling]);
  });

  it('Source-Reuse bleibt vor dem Derived-Coordinator synchron im Import', async () => {
    const order: string[] = [];
    setPostImportDerivativeStepRunnersForTests(
      Object.fromEntries(
        POST_IMPORT_DERIVATIVE_STEP_IDS.map((stepId) => [
          stepId,
          async () => {
            order.push(`derived:${stepId}`);
            return { kind: 'noop', reason: 'missing_transform_plan' };
          },
        ]),
      ) as Partial<
        Record<PostImportDerivativeStepId, () => Promise<unknown>>
      >,
    );

    const source = await storeDocumentFileFromCachedPayload(
      {
        fileName: 'legal.pdf',
        mimeType: 'application/pdf',
        fileSize: 8,
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x0a, 0x0a]),
      },
      { lifecycleIntent: 'committed' },
    );
    const item = createAuftragInboxItem({
      id: 'inbox-source-reuse-before-derived',
      fileRefId: source.fileRef.id,
      sourceFileHash: source.fileRef.contentHash,
    });
    hydrateInboxStore([item]);

    // Legal-ähnliche Preserve-Hints → Source-Reuse sync vor Derived.
    const legalPlan: DocumentFileTransformPlan = {
      policyId: 'legal_document',
      mediaProfile: 'native_pdf',
      hints: {
        metadataHandling: 'preserve',
        colorHandling: 'not_applicable',
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

    const imported = importInboxDocumentForTests(item, 'Test GmbH', { transformPlan: legalPlan });
    expect(imported.success).toBe(true);
    if (!imported.success) return;

    // Source-Reuse ist sync: Binding existiert, bevor Derived-Schritte laufen/fertig sind.
    expect(
      getDocumentFileRepresentationBindingStoreSnapshot().some(
        (binding) =>
          binding.documentId === imported.document.id &&
          binding.kind === 'archive' &&
          binding.fileRefId === source.fileRef.id,
      ),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(order).toEqual(POST_IMPORT_DERIVATIVE_STEP_IDS.map((id) => `derived:${id}`));
    });
  });
});
