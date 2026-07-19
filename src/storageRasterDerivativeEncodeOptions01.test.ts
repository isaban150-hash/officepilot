import { afterEach, describe, expect, it } from 'vitest';
import { planDocumentFileRasterDerivativeEncode } from './services/documentFileRasterDerivativeEncodePlanService';
import {
  encodeDocumentFileRasterToJpeg,
  setDocumentFileRasterEncodeAdaptersForTests,
} from './services/documentFileRasterEncodeService';
import {
  RASTER_ENCODE_JPEG_QUALITY,
  RASTER_ENCODE_MAX_EDGE_PX,
  RASTER_ENCODE_SOURCE_MIME_TYPES,
  RASTER_PREVIEW_ENCODE_JPEG_QUALITY,
  RASTER_PREVIEW_ENCODE_MAX_EDGE_PX,
  RASTER_THUMBNAIL_ENCODE_JPEG_QUALITY,
  RASTER_THUMBNAIL_ENCODE_MAX_EDGE_PX,
} from './types/documentFileRasterEncode';
import type { DocumentFileTransformIntent } from './types/documentFileTransformPlan';

interface EncodeCall {
  targetWidth: number;
  targetHeight: number;
  quality: number;
}

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

afterEach(() => {
  setDocumentFileRasterEncodeAdaptersForTests(null);
});

describe('STORAGE-RASTER-DERIVATIVE-ENCODE-OPTIONS-01', () => {
  describe('Fall A: dokumentierte Defaults', () => {
    it('Archive-, Preview- und Thumbnail-Defaults sind fest dokumentiert', () => {
      expect(RASTER_ENCODE_JPEG_QUALITY).toBe(0.85);
      expect(RASTER_ENCODE_MAX_EDGE_PX).toBe(2048);
      expect(RASTER_PREVIEW_ENCODE_JPEG_QUALITY).toBe(0.8);
      expect(RASTER_PREVIEW_ENCODE_MAX_EDGE_PX).toBe(1280);
      expect(RASTER_THUMBNAIL_ENCODE_JPEG_QUALITY).toBe(0.72);
      expect(RASTER_THUMBNAIL_ENCODE_MAX_EDGE_PX).toBe(384);
    });
  });

  describe('Fall B: Encode-Overrides', () => {
    it('ohne Overrides bleiben Archive-Defaults', async () => {
      let encodeCall: EncodeCall | undefined;
      setDocumentFileRasterEncodeAdaptersForTests({
        async decodeRaster() {
          return { width: 4000, height: 2000 };
        },
        async encodeJpeg(_source, targetWidth, targetHeight, quality) {
          encodeCall = { targetWidth, targetHeight, quality };
          return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
        },
      });

      const result = await encodeDocumentFileRasterToJpeg({
        bytes: new Uint8Array([1, 2, 3]),
        sourceMimeType: 'image/jpeg',
      });

      expect(encodeCall?.quality).toBe(RASTER_ENCODE_JPEG_QUALITY);
      expect(encodeCall?.targetWidth).toBe(2048);
      expect(encodeCall?.targetHeight).toBe(1024);
      expect(result.width).toBe(2048);
      expect(result.height).toBe(1024);
    });

    it('Overrides für quality und maxEdge werden korrekt verwendet', async () => {
      let encodeCall: EncodeCall | undefined;
      setDocumentFileRasterEncodeAdaptersForTests({
        async decodeRaster() {
          return { width: 2000, height: 1000 };
        },
        async encodeJpeg(_source, targetWidth, targetHeight, quality) {
          encodeCall = { targetWidth, targetHeight, quality };
          return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
        },
      });

      const result = await encodeDocumentFileRasterToJpeg({
        bytes: new Uint8Array([1, 2, 3]),
        sourceMimeType: 'image/png',
        quality: RASTER_THUMBNAIL_ENCODE_JPEG_QUALITY,
        maxEdge: RASTER_THUMBNAIL_ENCODE_MAX_EDGE_PX,
      });

      expect(encodeCall?.quality).toBe(0.72);
      expect(encodeCall?.targetWidth).toBe(384);
      expect(encodeCall?.targetHeight).toBe(192);
      expect(result.width).toBe(384);
      expect(result.height).toBe(192);
    });

    it('ungültige Overrides → TypeError', async () => {
      setDocumentFileRasterEncodeAdaptersForTests({
        async decodeRaster() {
          return { width: 10, height: 10 };
        },
        async encodeJpeg() {
          return new Uint8Array([0xff, 0xd8]);
        },
      });

      await expect(
        encodeDocumentFileRasterToJpeg({
          bytes: new Uint8Array([1]),
          sourceMimeType: 'image/jpeg',
          quality: 1.5,
        }),
      ).rejects.toThrow(TypeError);

      await expect(
        encodeDocumentFileRasterToJpeg({
          bytes: new Uint8Array([1]),
          sourceMimeType: 'image/jpeg',
          maxEdge: 0,
        }),
      ).rejects.toThrow(TypeError);
    });
  });

  describe('Fall C: Preview-/Thumbnail-Pläne', () => {
    it('create_preview → preview_jpeg_encode mit Preview-Defaults', () => {
      for (const sourceMimeType of RASTER_ENCODE_SOURCE_MIME_TYPES) {
        const plan = planDocumentFileRasterDerivativeEncode({
          transformIntent: previewIntent(),
          sourceMimeType,
        });
        expect(plan).toEqual({
          kind: 'preview_jpeg_encode',
          strategy: 'preview_jpeg_encode',
          role: 'preview',
          sourceMimeType,
          targetMimeType: 'image/jpeg',
          quality: 0.8,
          maxEdge: 1280,
        });
      }
    });

    it('create_thumbnail → thumbnail_jpeg_encode mit Thumbnail-Defaults', () => {
      for (const sourceMimeType of RASTER_ENCODE_SOURCE_MIME_TYPES) {
        const plan = planDocumentFileRasterDerivativeEncode({
          transformIntent: thumbnailIntent(),
          sourceMimeType,
        });
        expect(plan).toEqual({
          kind: 'thumbnail_jpeg_encode',
          strategy: 'thumbnail_jpeg_encode',
          role: 'thumbnail',
          sourceMimeType,
          targetMimeType: 'image/jpeg',
          quality: 0.72,
          maxEdge: 384,
        });
      }
    });

    it('PDF und unbekannte MIME → unresolved', () => {
      for (const sourceMimeType of [
        'application/pdf',
        'image/heic',
        'text/plain',
        'application/octet-stream',
      ] as const) {
        expect(
          planDocumentFileRasterDerivativeEncode({
            transformIntent: previewIntent(),
            sourceMimeType,
          }),
        ).toEqual({ kind: 'unresolved' });
        expect(
          planDocumentFileRasterDerivativeEncode({
            transformIntent: thumbnailIntent(),
            sourceMimeType,
          }),
        ).toEqual({ kind: 'unresolved' });
      }
    });

    it('create_archive → TypeError (nicht Derivative-Plan)', () => {
      expect(() =>
        planDocumentFileRasterDerivativeEncode({
          transformIntent: archiveIntent(),
          sourceMimeType: 'image/jpeg',
        }),
      ).toThrow(TypeError);
    });

    it('Result ist eingefroren und ohne Persistenzfelder', () => {
      const plan = planDocumentFileRasterDerivativeEncode({
        transformIntent: thumbnailIntent(),
        sourceMimeType: 'image/webp',
      });
      expect(Object.isFrozen(plan)).toBe(true);
      expect(plan).not.toHaveProperty('bytes');
      expect(plan).not.toHaveProperty('fileRefId');
      expect(plan).not.toHaveProperty('executor');
    });
  });
});
