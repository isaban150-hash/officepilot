import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDocumentFileRepresentationPlan } from './services/documentFileRepresentationPlanService';
import { buildDocumentFileTransformPlan } from './services/documentFileTransformPlanService';
import {
  PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT,
  createProjectStaticDocumentFileTransformCapabilityProvider,
} from './services/documentFileTransformCapabilityProvider';
import { evaluateDocumentFileTransformCapabilities } from './services/documentFileTransformCapabilityEvaluationService';
import { deriveDocumentFileTransformCapabilityRequirements } from './services/documentFileTransformCapabilityRequirementsService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './services/documentFileRepresentationBindingStoreService';
import { importInboxDocument } from './services/documentService';
import {
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload,
} from './services/documentFileStoreService';
import { hydrateInboxStore } from './services/inboxService';
import { setDocumentFileRasterEncodeAdaptersForTests } from './services/documentFileRasterEncodeService';
import { createAuftragInboxItem } from './test/fixtures';
import type { DocumentFileTransformIntent } from './types/documentFileTransformPlan';

function archiveIntent(): DocumentFileTransformIntent {
  return {
    targetKind: 'archive',
    intent: 'create_archive',
    executionIntent: 'preferred',
  };
}

useDocumentBlobDatabaseReset();

afterEach(() => {
  setDocumentFileRasterEncodeAdaptersForTests(null);
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
});

describe('STORAGE-RASTER-CAPABILITY-ENABLEMENT-01', () => {
  describe('Fall A: Provider-Baseline', () => {
    it('zeigt decode/encode/write_pdf supported', async () => {
      expect(PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT).toEqual({
        load_pdf: 'supported',
        render_pdf_page: 'supported',
        decode_raster_image: 'supported',
        encode_raster_image: 'supported',
        write_pdf: 'supported',
      });

      const snapshot = await createProjectStaticDocumentFileTransformCapabilityProvider().getSnapshot();
      expect(snapshot.decode_raster_image).toBe('supported');
      expect(snapshot.encode_raster_image).toBe('supported');
      expect(snapshot.write_pdf).toBe('supported');
      expect(snapshot.load_pdf).toBe('supported');
      expect(snapshot.render_pdf_page).toBe('supported');
    });
  });

  describe('Fall B: Raster create_archive capability-seitig supported', () => {
    it('JPEG/PNG/WebP Archive-Requirements evaluieren zu supported', async () => {
      const snapshot = await createProjectStaticDocumentFileTransformCapabilityProvider().getSnapshot();

      for (const sourceMimeType of ['image/jpeg', 'image/png', 'image/webp'] as const) {
        const requirements = deriveDocumentFileTransformCapabilityRequirements({
          transformIntent: archiveIntent(),
          sourceMimeType,
        });
        expect(requirements).toEqual({
          kind: 'capability_requirements',
          requiredCapabilities: ['decode_raster_image', 'encode_raster_image'],
        });
        if (requirements.kind !== 'capability_requirements') return;

        const evaluation = evaluateDocumentFileTransformCapabilities({
          requiredCapabilities: requirements.requiredCapabilities,
          capabilitySnapshot: snapshot,
        });
        expect(evaluation.status).toBe('supported');
        expect(evaluation.unsupportedCapabilities).toEqual([]);
        expect(evaluation.unknownCapabilities).toEqual([]);
      }
    });
  });

  describe('Fall C: PDF create_archive bleibt unresolved', () => {
    it('PDF create_archive bleibt unresolved', async () => {
      expect(
        deriveDocumentFileTransformCapabilityRequirements({
          transformIntent: archiveIntent(),
          sourceMimeType: 'application/pdf',
        }),
      ).toEqual({ kind: 'unresolved' });
    });
  });

  describe('Fall D: Import erzeugt Raster-Derivative-Bindings ohne PDF-Pfad', () => {
    it('business Raster-Import darf archive/preview/thumbnail anlegen', async () => {
      setDocumentFileRasterEncodeAdaptersForTests({
        async decodeRaster() {
          return { width: 16, height: 12 };
        },
        async encodeJpeg() {
          return new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0x11]);
        },
      });

      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01]);
      const stored = await storeDocumentFileFromCachedPayload(
        {
          fileName: 'cap-enable.jpg',
          mimeType: 'image/jpeg',
          fileSize: bytes.byteLength,
          bytes,
        },
        { lifecycleIntent: 'committed' },
      );

      const representationPlan = buildDocumentFileRepresentationPlan({
        policyId: 'business_document',
        decision: 'save_permanently',
      });
      expect(representationPlan).not.toBeNull();
      const transformPlan = buildDocumentFileTransformPlan({
        representationPlan: representationPlan!,
        mediaProfile: 'raster_image',
      });
      expect(transformPlan).not.toBeNull();

      const item = createAuftragInboxItem({
        id: 'inbox-cap-enablement',
        fileRefId: stored.fileRef.id,
        sourceFileHash: stored.fileRef.contentHash,
      });
      hydrateInboxStore([item]);

      const imported = importInboxDocumentForTests(item, 'Test GmbH', {
        transformPlan: transformPlan!,
      });
      expect(imported.success).toBe(true);
      if (!imported.success) return;

      const { orchestrateRasterArchiveEncodeAfterImport } = await import(
        './services/documentFileRasterArchiveEncodeOrchestrationService'
      );
      const { orchestrateRasterThumbnailEncodeAfterImport } = await import(
        './services/documentFileRasterThumbnailEncodeOrchestrationService'
      );
      const { orchestrateRasterPreviewEncodeAfterImport } = await import(
        './services/documentFileRasterPreviewEncodeOrchestrationService'
      );
      await orchestrateRasterArchiveEncodeAfterImport({
        documentId: imported.document.id,
        transformPlan: transformPlan!,
      });
      await orchestrateRasterThumbnailEncodeAfterImport({
        documentId: imported.document.id,
        transformPlan: transformPlan!,
      });
      await orchestrateRasterPreviewEncodeAfterImport({
        documentId: imported.document.id,
        transformPlan: transformPlan!,
      });

      const bindings = getDocumentFileRepresentationBindingStoreSnapshot();
      expect(
        bindings.every(
          (binding) =>
            binding.kind === 'archive' ||
            binding.kind === 'thumbnail' ||
            binding.kind === 'preview',
        ),
      ).toBe(true);
      expect(bindings.some((binding) => binding.kind === 'preview')).toBe(true);
      expect(bindings.some((binding) => binding.kind === 'thumbnail')).toBe(true);
    });
  });
});
