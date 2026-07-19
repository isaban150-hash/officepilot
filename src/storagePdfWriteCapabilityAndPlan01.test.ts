import { describe, expect, it } from 'vitest';
import { resolveDocumentFileArchiveTransformResolution } from './services/documentFileArchiveTransformResolutionService';
import { planDocumentFileImageToPdfArchiveEncode } from './services/documentFileImageToPdfArchiveEncodePlanService';
import { planDocumentFileRasterArchiveEncode } from './services/documentFileRasterArchiveEncodePlanService';
import {
  PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT,
  createProjectStaticDocumentFileTransformCapabilityProvider,
} from './services/documentFileTransformCapabilityProvider';
import { evaluateDocumentFileTransformCapabilities } from './services/documentFileTransformCapabilityEvaluationService';
import type { DocumentFileArchiveTransformResolutionResult } from './types/documentFileArchiveTransformResolution';
import type { DocumentFileTransformIntent } from './types/documentFileTransformPlan';
import {
  IMAGE_TO_PDF_PAGE_HEIGHT_PT,
  IMAGE_TO_PDF_PAGE_WIDTH_PT,
  IMAGE_TO_PDF_SOURCE_MIME_TYPES,
} from './types/documentFileImageToPdfWrite';
import { RASTER_ENCODE_SOURCE_MIME_TYPES } from './types/documentFileRasterEncode';

function archiveIntent(): DocumentFileTransformIntent {
  return {
    targetKind: 'archive',
    intent: 'create_archive',
    executionIntent: 'preferred',
  };
}

function previewIntent(): DocumentFileTransformIntent {
  return {
    targetKind: 'preview',
    intent: 'create_preview',
    executionIntent: 'preferred',
  };
}

describe('STORAGE-PDF-WRITE-CAPABILITY-AND-PLAN-01', () => {
  describe('Fall A: Provider write_pdf supported', () => {
    it('setzt write_pdf auf supported im project-static Snapshot', async () => {
      expect(PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT).toEqual({
        load_pdf: 'supported',
        render_pdf_page: 'supported',
        decode_raster_image: 'supported',
        encode_raster_image: 'supported',
        write_pdf: 'supported',
      });

      const snapshot = await createProjectStaticDocumentFileTransformCapabilityProvider().getSnapshot();
      expect(snapshot.write_pdf).toBe('supported');
      expect(
        evaluateDocumentFileTransformCapabilities({
          requiredCapabilities: ['write_pdf'],
          capabilitySnapshot: snapshot,
        }).status,
      ).toBe('supported');
    });
  });

  describe('Fall B: image_to_pdf-Plan', () => {
    it('JPEG/PNG + output_conversion_required → image_to_pdf mit A4-Defaults', () => {
      const resolution: DocumentFileArchiveTransformResolutionResult = {
        kind: 'output_conversion_required',
      };

      for (const sourceMimeType of IMAGE_TO_PDF_SOURCE_MIME_TYPES) {
        const plan = planDocumentFileImageToPdfArchiveEncode({
          transformIntent: archiveIntent(),
          resolution,
          sourceMimeType,
        });
        expect(plan).toEqual({
          kind: 'image_to_pdf',
          strategy: 'image_to_pdf',
          sourceMimeType,
          targetMimeType: 'application/pdf',
          pageWidth: IMAGE_TO_PDF_PAGE_WIDTH_PT,
          pageHeight: IMAGE_TO_PDF_PAGE_HEIGHT_PT,
        });
        expect(plan).not.toHaveProperty('bytes');
        expect(plan).not.toHaveProperty('fileRefId');
        expect(JSON.stringify(plan)).not.toMatch(/encodeDocumentFileImageToPdf|pdf-lib|FileRef/);
      }
    });

    it('pdf_preferred + Raster (ohne metadata strip) → output_conversion_required → image_to_pdf', () => {
      const resolution = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archiveIntent(),
        hints: {
          retainOriginal: 'preferred',
          archiveRepresentation: 'optimized_allowed',
          previewRequirement: 'preferred',
          thumbnailRequirement: 'preferred',
          metadataHandling: 'preserve',
          colorHandling: 'preserve',
          preferredOutputKind: 'pdf_preferred',
        },
        sourceMimeType: 'image/png',
      });
      expect(resolution).toEqual({ kind: 'output_conversion_required' });

      expect(
        planDocumentFileImageToPdfArchiveEncode({
          transformIntent: archiveIntent(),
          resolution,
          sourceMimeType: 'image/png',
        }),
      ).toEqual({
        kind: 'image_to_pdf',
        strategy: 'image_to_pdf',
        sourceMimeType: 'image/png',
        targetMimeType: 'application/pdf',
        pageWidth: IMAGE_TO_PDF_PAGE_WIDTH_PT,
        pageHeight: IMAGE_TO_PDF_PAGE_HEIGHT_PT,
      });
    });
  });

  describe('Fall C: unresolved-Fälle', () => {
    it('WebP/PDF/unbekannte MIME → unresolved', () => {
      const resolution: DocumentFileArchiveTransformResolutionResult = {
        kind: 'output_conversion_required',
      };
      for (const sourceMimeType of [
        'image/webp',
        'application/pdf',
        'image/heic',
        'text/plain',
      ] as const) {
        expect(
          planDocumentFileImageToPdfArchiveEncode({
            transformIntent: archiveIntent(),
            resolution,
            sourceMimeType,
          }),
        ).toEqual({ kind: 'unresolved' });
      }
    });

    it('metadata_rewrite_required und strategy_unresolved → kein image_to_pdf-Plan', () => {
      for (const kind of ['metadata_rewrite_required', 'strategy_unresolved'] as const) {
        expect(
          planDocumentFileImageToPdfArchiveEncode({
            transformIntent: archiveIntent(),
            resolution: { kind },
            sourceMimeType: 'image/jpeg',
          }),
        ).toEqual({ kind: 'unresolved' });
      }
    });

    it('create_preview → TypeError', () => {
      expect(() =>
        planDocumentFileImageToPdfArchiveEncode({
          transformIntent: previewIntent(),
          resolution: { kind: 'output_conversion_required' },
          sourceMimeType: 'image/jpeg',
        }),
      ).toThrow(TypeError);
    });
  });

  describe('Fall D: bestehende Raster-/PDF-Pfade unverändert', () => {
    it('Raster metadata_rewrite_required bleibt raster_jpeg_reencode inkl. WebP', () => {
      const resolution: DocumentFileArchiveTransformResolutionResult = {
        kind: 'metadata_rewrite_required',
      };
      for (const sourceMimeType of RASTER_ENCODE_SOURCE_MIME_TYPES) {
        expect(
          planDocumentFileRasterArchiveEncode({
            transformIntent: archiveIntent(),
            resolution,
            sourceMimeType,
          }).kind,
        ).toBe('raster_jpeg_reencode');
      }
    });

    it('Raster output_conversion_required bleibt für JPEG-Reencode unresolved', () => {
      expect(
        planDocumentFileRasterArchiveEncode({
          transformIntent: archiveIntent(),
          resolution: { kind: 'output_conversion_required' },
          sourceMimeType: 'image/jpeg',
        }),
      ).toEqual({ kind: 'unresolved' });
    });
  });
});
