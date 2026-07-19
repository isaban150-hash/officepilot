import { describe, expect, it } from 'vitest';
import { planDocumentFilePdfDerivativeEncode } from './services/documentFilePdfDerivativeEncodePlanService';
import {
  RASTER_ENCODE_SOURCE_MIME_TYPES,
  RASTER_PREVIEW_ENCODE_JPEG_QUALITY,
  RASTER_PREVIEW_ENCODE_MAX_EDGE_PX,
  RASTER_THUMBNAIL_ENCODE_JPEG_QUALITY,
  RASTER_THUMBNAIL_ENCODE_MAX_EDGE_PX,
} from './types/documentFileRasterEncode';
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

describe('STORAGE-PDF-DERIVATIVE-ENCODE-PLAN-01', () => {
  describe('Fall A: PDF Preview-Plan', () => {
    it('create_preview → page_1_preview_jpeg_encode mit Preview-Defaults', () => {
      const plan = planDocumentFilePdfDerivativeEncode({
        transformIntent: previewIntent(),
        sourceMimeType: 'application/pdf',
      });

      expect(plan).toEqual({
        kind: 'page_1_preview_jpeg_encode',
        strategy: 'page_1_preview_jpeg_encode',
        role: 'preview',
        sourceMimeType: 'application/pdf',
        targetMimeType: 'image/jpeg',
        pageNumber: 1,
        quality: 0.8,
        maxEdge: 1280,
      });
      expect(plan).toMatchObject({
        pageNumber: 1,
        quality: RASTER_PREVIEW_ENCODE_JPEG_QUALITY,
        maxEdge: RASTER_PREVIEW_ENCODE_MAX_EDGE_PX,
      });
    });
  });

  describe('Fall B: PDF Thumbnail-Plan', () => {
    it('create_thumbnail → page_1_thumbnail_jpeg_encode mit Thumbnail-Defaults', () => {
      const plan = planDocumentFilePdfDerivativeEncode({
        transformIntent: thumbnailIntent(),
        sourceMimeType: 'application/pdf',
      });

      expect(plan).toEqual({
        kind: 'page_1_thumbnail_jpeg_encode',
        strategy: 'page_1_thumbnail_jpeg_encode',
        role: 'thumbnail',
        sourceMimeType: 'application/pdf',
        targetMimeType: 'image/jpeg',
        pageNumber: 1,
        quality: 0.72,
        maxEdge: 384,
      });
      expect(plan).toMatchObject({
        pageNumber: 1,
        quality: RASTER_THUMBNAIL_ENCODE_JPEG_QUALITY,
        maxEdge: RASTER_THUMBNAIL_ENCODE_MAX_EDGE_PX,
      });
    });
  });

  describe('Fall C: Seite, Qualität und maxEdge', () => {
    it('Seite ist immer 1; Qualität und maxEdge kommen aus Raster-Defaults', () => {
      const preview = planDocumentFilePdfDerivativeEncode({
        transformIntent: previewIntent(),
        sourceMimeType: 'Application/PDF',
      });
      const thumbnail = planDocumentFilePdfDerivativeEncode({
        transformIntent: thumbnailIntent(),
        sourceMimeType: ' application/pdf ',
      });

      expect(preview).toMatchObject({
        kind: 'page_1_preview_jpeg_encode',
        pageNumber: 1,
        quality: RASTER_PREVIEW_ENCODE_JPEG_QUALITY,
        maxEdge: RASTER_PREVIEW_ENCODE_MAX_EDGE_PX,
      });
      expect(thumbnail).toMatchObject({
        kind: 'page_1_thumbnail_jpeg_encode',
        pageNumber: 1,
        quality: RASTER_THUMBNAIL_ENCODE_JPEG_QUALITY,
        maxEdge: RASTER_THUMBNAIL_ENCODE_MAX_EDGE_PX,
      });
    });
  });

  describe('Fall D: unresolved-Fälle', () => {
    it('Raster- und unbekannte MIME → unresolved', () => {
      for (const sourceMimeType of [
        ...RASTER_ENCODE_SOURCE_MIME_TYPES,
        'image/heic',
        'text/plain',
        'application/octet-stream',
      ] as const) {
        expect(
          planDocumentFilePdfDerivativeEncode({
            transformIntent: previewIntent(),
            sourceMimeType,
          }),
        ).toEqual({ kind: 'unresolved' });
        expect(
          planDocumentFilePdfDerivativeEncode({
            transformIntent: thumbnailIntent(),
            sourceMimeType,
          }),
        ).toEqual({ kind: 'unresolved' });
      }
    });

    it('create_archive → unresolved', () => {
      expect(
        planDocumentFilePdfDerivativeEncode({
          transformIntent: archiveIntent(),
          sourceMimeType: 'application/pdf',
        }),
      ).toEqual({ kind: 'unresolved' });
    });
  });

  describe('Fall E: Reinheit', () => {
    it('Result ist eingefroren und ohne Render-/Persistenzfelder', () => {
      const plan = planDocumentFilePdfDerivativeEncode({
        transformIntent: thumbnailIntent(),
        sourceMimeType: 'application/pdf',
      });
      expect(Object.isFrozen(plan)).toBe(true);
      expect(plan).not.toHaveProperty('bytes');
      expect(plan).not.toHaveProperty('fileRefId');
      expect(plan).not.toHaveProperty('executor');
      expect(plan).not.toHaveProperty('canvas');
      expect(JSON.stringify(plan)).not.toMatch(/write_pdf|pdf-lib|renderPdfPage/);
    });

    it('ungültige Inputs → TypeError', () => {
      expect(() =>
        planDocumentFilePdfDerivativeEncode(
          null as unknown as { transformIntent: DocumentFileTransformIntent; sourceMimeType: string },
        ),
      ).toThrow(TypeError);

      expect(() =>
        planDocumentFilePdfDerivativeEncode({
          transformIntent: previewIntent(),
          sourceMimeType: 123 as unknown as string,
        }),
      ).toThrow(TypeError);
    });
  });
});
