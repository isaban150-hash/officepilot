import { describe, expect, it } from 'vitest';
import {
  PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT,
  createProjectStaticDocumentFileTransformCapabilityProvider,
} from './services/documentFileTransformCapabilityProvider';
import { evaluateDocumentFileTransformCapabilities } from './services/documentFileTransformCapabilityEvaluationService';
import { deriveDocumentFileTransformCapabilityRequirements } from './services/documentFileTransformCapabilityRequirementsService';
import type { DocumentFileTransformIntent } from './types/documentFileTransformPlan';

function previewIntent(): DocumentFileTransformIntent {
  return {
    targetKind: 'preview',
    intent: 'create_preview',
    executionIntent: 'preferred',
  };
}

function thumbnailIntent(): DocumentFileTransformIntent {
  return {
    targetKind: 'thumbnail',
    intent: 'create_thumbnail',
    executionIntent: 'preferred',
  };
}

function archiveIntent(): DocumentFileTransformIntent {
  return {
    targetKind: 'archive',
    intent: 'create_archive',
    executionIntent: 'preferred',
  };
}

describe('STORAGE-PDF-RENDER-CAPABILITY-ENABLEMENT-01', () => {
  describe('Fall A: Provider-Snapshot', () => {
    it('setzt load_pdf und render_pdf_page auf supported', async () => {
      expect(PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT).toEqual({
        load_pdf: 'supported',
        render_pdf_page: 'supported',
        decode_raster_image: 'supported',
        encode_raster_image: 'supported',
        write_pdf: 'supported',
      });

      const snapshot = await createProjectStaticDocumentFileTransformCapabilityProvider().getSnapshot();
      expect(snapshot).toEqual(PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT);
      expect(snapshot.load_pdf).toBe('supported');
      expect(snapshot.render_pdf_page).toBe('supported');
      expect(snapshot.write_pdf).toBe('supported');
    });
  });

  describe('Fall B: PDF Preview/Thumbnail capability-seitig erfüllbar', () => {
    it('PDF create_preview und create_thumbnail evaluieren zu supported', async () => {
      const snapshot = await createProjectStaticDocumentFileTransformCapabilityProvider().getSnapshot();

      for (const transformIntent of [previewIntent(), thumbnailIntent()]) {
        const requirements = deriveDocumentFileTransformCapabilityRequirements({
          transformIntent,
          sourceMimeType: 'application/pdf',
        });
        expect(requirements).toEqual({
          kind: 'capability_requirements',
          requiredCapabilities: ['load_pdf', 'render_pdf_page', 'encode_raster_image'],
        });
        if (requirements.kind !== 'capability_requirements') return;

        const evaluation = evaluateDocumentFileTransformCapabilities({
          requiredCapabilities: requirements.requiredCapabilities,
          capabilitySnapshot: snapshot,
        });
        expect(evaluation.status).toBe('supported');
        expect(evaluation.unsupportedCapabilities).toEqual([]);
        expect(evaluation.unknownCapabilities).toEqual([]);
        expect(evaluation.requiredCapabilities).not.toContain('write_pdf');
      }
    });
  });

  describe('Fall C: write_pdf ist capability-seitig supported', () => {
    it('write_pdf-Requirement evaluieren zu supported', async () => {
      const snapshot = await createProjectStaticDocumentFileTransformCapabilityProvider().getSnapshot();
      const evaluation = evaluateDocumentFileTransformCapabilities({
        requiredCapabilities: ['write_pdf'],
        capabilitySnapshot: snapshot,
      });
      expect(evaluation.status).toBe('supported');
      expect(evaluation.unsupportedCapabilities).toEqual([]);
    });
  });

  describe('Fall D: Rasterpfade unverändert', () => {
    it('Raster Archive/Preview Requirements bleiben decode+encode und supported', async () => {
      const snapshot = await createProjectStaticDocumentFileTransformCapabilityProvider().getSnapshot();

      for (const sourceMimeType of ['image/jpeg', 'image/png', 'image/webp'] as const) {
        const archiveRequirements = deriveDocumentFileTransformCapabilityRequirements({
          transformIntent: archiveIntent(),
          sourceMimeType,
        });
        expect(archiveRequirements).toEqual({
          kind: 'capability_requirements',
          requiredCapabilities: ['decode_raster_image', 'encode_raster_image'],
        });
        if (archiveRequirements.kind !== 'capability_requirements') return;

        expect(
          evaluateDocumentFileTransformCapabilities({
            requiredCapabilities: archiveRequirements.requiredCapabilities,
            capabilitySnapshot: snapshot,
          }).status,
        ).toBe('supported');

        const previewRequirements = deriveDocumentFileTransformCapabilityRequirements({
          transformIntent: previewIntent(),
          sourceMimeType,
        });
        expect(previewRequirements).toEqual({
          kind: 'capability_requirements',
          requiredCapabilities: ['decode_raster_image', 'encode_raster_image'],
        });
        if (previewRequirements.kind !== 'capability_requirements') return;

        expect(
          evaluateDocumentFileTransformCapabilities({
            requiredCapabilities: previewRequirements.requiredCapabilities,
            capabilitySnapshot: snapshot,
          }).status,
        ).toBe('supported');
      }
    });

    it('PDF create_archive bleibt unresolved', () => {
      expect(
        deriveDocumentFileTransformCapabilityRequirements({
          transformIntent: archiveIntent(),
          sourceMimeType: 'application/pdf',
        }),
      ).toEqual({ kind: 'unresolved' });
    });
  });
});
