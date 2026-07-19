import type { DocumentFileRasterDerivativeEncodePlanResult } from '../types/documentFileRasterDerivativeEncodePlan';
import type { DocumentFileTransformIntent } from '../types/documentFileTransformPlan';
import {
  RASTER_ENCODE_SOURCE_MIME_TYPES,
  RASTER_PREVIEW_ENCODE_JPEG_QUALITY,
  RASTER_PREVIEW_ENCODE_MAX_EDGE_PX,
  RASTER_THUMBNAIL_ENCODE_JPEG_QUALITY,
  RASTER_THUMBNAIL_ENCODE_MAX_EDGE_PX,
  type RasterEncodeSourceMimeType,
} from '../types/documentFileRasterEncode';

export interface PlanDocumentFileRasterDerivativeEncodeInput {
  transformIntent: DocumentFileTransformIntent;
  sourceMimeType: string;
}

const UNRESOLVED_RESULT = Object.freeze({
  kind: 'unresolved',
} as const satisfies DocumentFileRasterDerivativeEncodePlanResult);

function classifyRasterSourceMimeType(
  sourceMimeType: unknown,
): RasterEncodeSourceMimeType | null {
  if (typeof sourceMimeType !== 'string') {
    throw new TypeError('Invalid raster derivative encode plan sourceMimeType');
  }

  const normalized = sourceMimeType.trim().toLowerCase();
  if ((RASTER_ENCODE_SOURCE_MIME_TYPES as readonly string[]).includes(normalized)) {
    return normalized as RasterEncodeSourceMimeType;
  }

  return null;
}

function assertDerivativeIntent(
  transformIntent: unknown,
): asserts transformIntent is DocumentFileTransformIntent & {
  intent: 'create_preview' | 'create_thumbnail';
} {
  if (
    transformIntent === null ||
    typeof transformIntent !== 'object' ||
    !('intent' in transformIntent)
  ) {
    throw new TypeError('Invalid raster derivative encode plan transform intent');
  }

  const intent = (transformIntent as { intent: unknown }).intent;
  if (intent !== 'create_preview' && intent !== 'create_thumbnail') {
    throw new TypeError('Invalid raster derivative encode plan transform intent');
  }
}

/**
 * Pure plan: whether create_preview / create_thumbnail should JPEG-encode a raster source.
 * Does not call the encoder or persist/bind results.
 */
export function planDocumentFileRasterDerivativeEncode(
  input: PlanDocumentFileRasterDerivativeEncodeInput,
): DocumentFileRasterDerivativeEncodePlanResult {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid raster derivative encode plan input');
  }

  assertDerivativeIntent(input.transformIntent);
  const sourceMimeType = classifyRasterSourceMimeType(input.sourceMimeType);

  if (sourceMimeType === null) {
    return UNRESOLVED_RESULT;
  }

  if (input.transformIntent.intent === 'create_preview') {
    return Object.freeze({
      kind: 'preview_jpeg_encode',
      strategy: 'preview_jpeg_encode',
      role: 'preview',
      sourceMimeType,
      targetMimeType: 'image/jpeg',
      quality: RASTER_PREVIEW_ENCODE_JPEG_QUALITY,
      maxEdge: RASTER_PREVIEW_ENCODE_MAX_EDGE_PX,
    });
  }

  return Object.freeze({
    kind: 'thumbnail_jpeg_encode',
    strategy: 'thumbnail_jpeg_encode',
    role: 'thumbnail',
    sourceMimeType,
    targetMimeType: 'image/jpeg',
    quality: RASTER_THUMBNAIL_ENCODE_JPEG_QUALITY,
    maxEdge: RASTER_THUMBNAIL_ENCODE_MAX_EDGE_PX,
  });
}
