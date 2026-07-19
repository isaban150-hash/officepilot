/**
 * Pure in-memory raster → JPEG encode result.
 * Does not persist bytes, create FileRefs, or assert transform capabilities.
 */
export interface DocumentFileRasterEncodeJpegResult {
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/jpeg';
  readonly width: number;
  readonly height: number;
}

export type DocumentFileRasterEncodeErrorCode = 'decode_failed' | 'encode_failed';

export interface DocumentFileRasterEncodeError {
  readonly code: DocumentFileRasterEncodeErrorCode;
  readonly message: string;
}

/** Accepted raster source MIME types for the encode core (no PDF). */
export const RASTER_ENCODE_SOURCE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type RasterEncodeSourceMimeType = (typeof RASTER_ENCODE_SOURCE_MIME_TYPES)[number];

/**
 * JPEG quality (0..1) passed to the browser encoder / injectable adapter.
 * Documented default for STORAGE-RASTER-ENCODE-CORE-01 — not a policy knob.
 */
export const RASTER_ENCODE_JPEG_QUALITY = 0.85;

/**
 * Longest allowed output edge in pixels. Sources at or below this size are not upscaled.
 * Documented default for STORAGE-RASTER-ENCODE-CORE-01 — not a policy knob.
 */
export const RASTER_ENCODE_MAX_EDGE_PX = 2048;
