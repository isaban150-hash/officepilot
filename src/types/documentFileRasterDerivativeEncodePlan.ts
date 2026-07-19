import type { DocumentFileTransformTargetKind } from './documentFileTransformPlan';
import type { RasterEncodeSourceMimeType } from './documentFileRasterEncode';

/**
 * Pure plan for raster preview/thumbnail JPEG encode.
 * Does not invoke the encoder, persist bytes, or bind FileRefs.
 */
export type DocumentFileRasterDerivativeEncodePlanResult =
  | {
      readonly kind: 'preview_jpeg_encode';
      readonly strategy: 'preview_jpeg_encode';
      readonly role: 'preview';
      readonly sourceMimeType: RasterEncodeSourceMimeType;
      readonly targetMimeType: 'image/jpeg';
      readonly quality: number;
      readonly maxEdge: number;
    }
  | {
      readonly kind: 'thumbnail_jpeg_encode';
      readonly strategy: 'thumbnail_jpeg_encode';
      readonly role: 'thumbnail';
      readonly sourceMimeType: RasterEncodeSourceMimeType;
      readonly targetMimeType: 'image/jpeg';
      readonly quality: number;
      readonly maxEdge: number;
    }
  | {
      readonly kind: 'unresolved';
    };

export type DocumentFileRasterDerivativeEncodeRole = Extract<
  DocumentFileTransformTargetKind,
  'preview' | 'thumbnail'
>;
