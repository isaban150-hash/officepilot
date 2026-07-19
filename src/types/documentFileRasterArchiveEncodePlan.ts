import type { RasterEncodeSourceMimeType } from './documentFileRasterEncode';

/**
 * Pure plan for the first raster archive encode path.
 * Does not invoke the encoder, persist bytes, or bind FileRefs.
 */
export type DocumentFileRasterArchiveEncodePlanResult =
  | {
      readonly kind: 'raster_jpeg_reencode';
      readonly strategy: 'raster_jpeg_reencode';
      readonly sourceMimeType: RasterEncodeSourceMimeType;
      readonly targetMimeType: 'image/jpeg';
      readonly quality: number;
      readonly maxEdge: number;
    }
  | {
      readonly kind: 'unresolved';
    };
