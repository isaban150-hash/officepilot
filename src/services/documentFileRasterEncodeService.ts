import {
  RASTER_ENCODE_JPEG_QUALITY,
  RASTER_ENCODE_MAX_EDGE_PX,
  RASTER_ENCODE_SOURCE_MIME_TYPES,
  type DocumentFileRasterEncodeError,
  type DocumentFileRasterEncodeJpegResult,
  type RasterEncodeSourceMimeType,
} from '../types/documentFileRasterEncode';

export interface EncodeDocumentFileRasterToJpegInput {
  bytes: Uint8Array;
  sourceMimeType: string;
  /** Optional JPEG quality (0..1). Defaults to archive RASTER_ENCODE_JPEG_QUALITY. */
  quality?: number;
  /** Optional longest output edge in pixels. Defaults to archive RASTER_ENCODE_MAX_EDGE_PX. */
  maxEdge?: number;
}

/**
 * Drawable raster source produced by a decode adapter.
 * Production uses ImageBitmap; tests may supply a lightweight fake.
 */
export interface DocumentFileDecodedRasterSource {
  readonly width: number;
  readonly height: number;
}

export interface DocumentFileRasterEncodeAdapters {
  /**
   * Decode raster bytes. Prefer honoring EXIF orientation when the runtime supports it.
   */
  decodeRaster(
    bytes: Uint8Array,
    sourceMimeType: RasterEncodeSourceMimeType,
  ): Promise<DocumentFileDecodedRasterSource>;

  /**
   * Draw the decoded source into a canvas of the given size and encode as JPEG.
   * Re-encoding drops EXIF and other non-pixel metadata.
   */
  encodeJpeg(
    source: DocumentFileDecodedRasterSource,
    targetWidth: number,
    targetHeight: number,
    quality: number,
  ): Promise<Uint8Array>;

  /** Optional release of decode resources (e.g. ImageBitmap.close). */
  releaseDecoded?(source: DocumentFileDecodedRasterSource): void;
}

let adaptersOverride: DocumentFileRasterEncodeAdapters | null = null;

export function setDocumentFileRasterEncodeAdaptersForTests(
  adapters: DocumentFileRasterEncodeAdapters | null,
): void {
  adaptersOverride = adapters;
}

function isRasterSourceMimeType(value: unknown): value is RasterEncodeSourceMimeType {
  return (
    typeof value === 'string' &&
    (RASTER_ENCODE_SOURCE_MIME_TYPES as readonly string[]).includes(value.trim().toLowerCase())
  );
}

function normalizeSourceMimeType(sourceMimeType: string): RasterEncodeSourceMimeType {
  return sourceMimeType.trim().toLowerCase() as RasterEncodeSourceMimeType;
}

function rasterEncodeError(
  code: DocumentFileRasterEncodeError['code'],
  message: string,
): DocumentFileRasterEncodeError {
  return Object.freeze({ code, message });
}

function isRasterEncodeError(value: unknown): value is DocumentFileRasterEncodeError {
  return (
    value !== null &&
    typeof value === 'object' &&
    'code' in value &&
    ((value as { code: unknown }).code === 'decode_failed' ||
      (value as { code: unknown }).code === 'encode_failed')
  );
}

/**
 * Fit source dimensions within maxEdge without upscaling; preserve aspect ratio.
 */
export function computeRasterEncodeTargetDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxEdgePx: number = RASTER_ENCODE_MAX_EDGE_PX,
): { width: number; height: number } {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    !Number.isFinite(maxEdgePx) ||
    sourceWidth < 1 ||
    sourceHeight < 1 ||
    maxEdgePx < 1
  ) {
    throw new TypeError('Invalid raster encode dimensions');
  }

  const width = Math.round(sourceWidth);
  const height = Math.round(sourceHeight);
  const longest = Math.max(width, height);

  if (longest <= maxEdgePx) {
    return { width, height };
  }

  const scale = maxEdgePx / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function defaultDecodeRaster(
  bytes: Uint8Array,
  sourceMimeType: RasterEncodeSourceMimeType,
): Promise<ImageBitmap> {
  const copy = bytes.slice();
  const blob = new Blob([copy], { type: sourceMimeType });

  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    try {
      return await createImageBitmap(blob);
    } catch {
      throw rasterEncodeError(
        'decode_failed',
        'Raster image could not be decoded for JPEG encode.',
      );
    }
  }
}

async function canvasEncodeJpeg(
  source: CanvasImageSource,
  targetWidth: number,
  targetHeight: number,
  quality: number,
): Promise<Uint8Array> {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw rasterEncodeError(
      'encode_failed',
      'Raster JPEG encode requires a DOM canvas environment.',
    );
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext('2d');
  if (!context) {
    throw rasterEncodeError('encode_failed', 'Raster JPEG encode could not obtain a 2D context.');
  }

  try {
    context.drawImage(source, 0, 0, targetWidth, targetHeight);
  } catch {
    throw rasterEncodeError('encode_failed', 'Raster JPEG encode failed while drawing to canvas.');
  }

  if (typeof canvas.toBlob !== 'function') {
    throw rasterEncodeError(
      'encode_failed',
      'Raster JPEG encode requires canvas.toBlob support.',
    );
  }

  let blob: Blob;
  try {
    blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => {
          if (result) {
            resolve(result);
            return;
          }
          reject(rasterEncodeError('encode_failed', 'Raster JPEG encode produced an empty blob.'));
        },
        'image/jpeg',
        quality,
      );
    });
  } catch (error) {
    if (isRasterEncodeError(error)) {
      throw error;
    }
    throw rasterEncodeError('encode_failed', 'Raster JPEG encode failed.');
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }

  return new Uint8Array(await blob.arrayBuffer());
}

const defaultAdapters: DocumentFileRasterEncodeAdapters = {
  async decodeRaster(bytes, sourceMimeType) {
    return defaultDecodeRaster(bytes, sourceMimeType);
  },
  async encodeJpeg(source, targetWidth, targetHeight, quality) {
    return canvasEncodeJpeg(source as CanvasImageSource, targetWidth, targetHeight, quality);
  },
  releaseDecoded(source) {
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
      source.close();
    }
  },
};

function resolveAdapters(): DocumentFileRasterEncodeAdapters {
  return adaptersOverride ?? defaultAdapters;
}

function assertOptionalEncodeNumber(
  value: unknown,
  field: 'quality' | 'maxEdge',
): asserts value is number | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid raster encode ${field}`);
  }
  if (field === 'quality' && (value <= 0 || value > 1)) {
    throw new TypeError('Invalid raster encode quality');
  }
  if (field === 'maxEdge' && value < 1) {
    throw new TypeError('Invalid raster encode maxEdge');
  }
}

function assertInput(
  input: EncodeDocumentFileRasterToJpegInput,
): asserts input is EncodeDocumentFileRasterToJpegInput & {
  bytes: Uint8Array;
  sourceMimeType: RasterEncodeSourceMimeType;
} {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid raster encode input');
  }
  if (!(input.bytes instanceof Uint8Array)) {
    throw new TypeError('Invalid raster encode bytes');
  }
  if (input.bytes.byteLength === 0) {
    throw new TypeError('Invalid raster encode bytes');
  }
  if (!isRasterSourceMimeType(input.sourceMimeType)) {
    throw new TypeError('Invalid raster encode sourceMimeType');
  }
  assertOptionalEncodeNumber(input.quality, 'quality');
  assertOptionalEncodeNumber(input.maxEdge, 'maxEdge');
}

/**
 * Decode accepted raster source bytes and re-encode as JPEG in memory.
 * EXIF and other non-pixel metadata are removed by the decode→canvas→encode path.
 * Does not persist, bind FileRefs, or update capability snapshots.
 */
export async function encodeDocumentFileRasterToJpeg(
  input: EncodeDocumentFileRasterToJpegInput,
): Promise<DocumentFileRasterEncodeJpegResult> {
  assertInput(input);

  const sourceMimeType = normalizeSourceMimeType(input.sourceMimeType);
  const adapters = resolveAdapters();
  // Copy so decode adapters never observe a live alias of caller-owned bytes.
  const decodeBytes = input.bytes.slice();

  let decoded: DocumentFileDecodedRasterSource;
  try {
    decoded = await adapters.decodeRaster(decodeBytes, sourceMimeType);
  } catch (error) {
    if (isRasterEncodeError(error)) {
      throw error;
    }
    throw rasterEncodeError('decode_failed', 'Raster image could not be decoded for JPEG encode.');
  }

  if (
    !Number.isFinite(decoded.width) ||
    !Number.isFinite(decoded.height) ||
    decoded.width < 1 ||
    decoded.height < 1
  ) {
    adapters.releaseDecoded?.(decoded);
    throw rasterEncodeError('decode_failed', 'Raster decode produced invalid dimensions.');
  }

  const maxEdge = input.maxEdge ?? RASTER_ENCODE_MAX_EDGE_PX;
  const quality = input.quality ?? RASTER_ENCODE_JPEG_QUALITY;

  const target = computeRasterEncodeTargetDimensions(
    decoded.width,
    decoded.height,
    maxEdge,
  );

  let encoded: Uint8Array;
  try {
    encoded = await adapters.encodeJpeg(
      decoded,
      target.width,
      target.height,
      quality,
    );
  } catch (error) {
    adapters.releaseDecoded?.(decoded);
    if (isRasterEncodeError(error)) {
      throw error;
    }
    throw rasterEncodeError('encode_failed', 'Raster JPEG encode failed.');
  }

  adapters.releaseDecoded?.(decoded);

  if (!(encoded instanceof Uint8Array) || encoded.byteLength === 0) {
    throw rasterEncodeError('encode_failed', 'Raster JPEG encode produced empty output.');
  }

  return Object.freeze({
    bytes: encoded,
    mimeType: 'image/jpeg',
    width: target.width,
    height: target.height,
  });
}
