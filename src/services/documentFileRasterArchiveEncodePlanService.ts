import type { DocumentFileArchiveTransformResolutionResult } from '../types/documentFileArchiveTransformResolution';
import type { DocumentFileRasterArchiveEncodePlanResult } from '../types/documentFileRasterArchiveEncodePlan';
import type { DocumentFileTransformIntent } from '../types/documentFileTransformPlan';
import {
  RASTER_ENCODE_JPEG_QUALITY,
  RASTER_ENCODE_MAX_EDGE_PX,
  RASTER_ENCODE_SOURCE_MIME_TYPES,
  type RasterEncodeSourceMimeType,
} from '../types/documentFileRasterEncode';

export interface PlanDocumentFileRasterArchiveEncodeInput {
  transformIntent: DocumentFileTransformIntent;
  resolution: DocumentFileArchiveTransformResolutionResult;
  sourceMimeType: string;
}

const UNRESOLVED_RESULT = Object.freeze({
  kind: 'unresolved',
} as const satisfies DocumentFileRasterArchiveEncodePlanResult);

const ARCHIVE_RESOLUTION_KINDS = [
  'source_reuse',
  'metadata_rewrite_required',
  'output_conversion_required',
  'color_processing_required',
  'strategy_unresolved',
] as const;

function isArchiveResolutionResult(
  value: unknown,
): value is DocumentFileArchiveTransformResolutionResult {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    typeof (value as { kind: unknown }).kind === 'string' &&
    (ARCHIVE_RESOLUTION_KINDS as readonly string[]).includes(
      (value as { kind: string }).kind,
    )
  );
}

function assertArchiveIntent(transformIntent: unknown): asserts transformIntent is DocumentFileTransformIntent {
  if (
    transformIntent === null ||
    typeof transformIntent !== 'object' ||
    !('intent' in transformIntent)
  ) {
    throw new TypeError('Invalid raster archive encode plan transform intent');
  }

  const intent = (transformIntent as { intent: unknown }).intent;
  if (intent !== 'create_archive') {
    throw new TypeError('Invalid raster archive encode plan transform intent');
  }
}

function assertResolution(
  resolution: unknown,
): asserts resolution is DocumentFileArchiveTransformResolutionResult {
  if (!isArchiveResolutionResult(resolution)) {
    throw new TypeError('Invalid raster archive encode plan resolution');
  }
}

function classifyRasterSourceMimeType(
  sourceMimeType: unknown,
): RasterEncodeSourceMimeType | null {
  if (typeof sourceMimeType !== 'string') {
    throw new TypeError('Invalid raster archive encode plan sourceMimeType');
  }

  const normalized = sourceMimeType.trim().toLowerCase();
  if ((RASTER_ENCODE_SOURCE_MIME_TYPES as readonly string[]).includes(normalized)) {
    return normalized as RasterEncodeSourceMimeType;
  }

  // Known non-raster or unknown MIME → no encode plan (not a TypeError).
  return null;
}

/**
 * Pure plan: whether create_archive should re-encode a raster source as JPEG.
 * First allowed case: metadata_rewrite_required + accepted raster MIME.
 * Does not call the encoder or invent strategies for unresolved/conversion cases.
 */
export function planDocumentFileRasterArchiveEncode(
  input: PlanDocumentFileRasterArchiveEncodeInput,
): DocumentFileRasterArchiveEncodePlanResult {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid raster archive encode plan input');
  }

  assertArchiveIntent(input.transformIntent);
  assertResolution(input.resolution);
  const sourceMimeType = classifyRasterSourceMimeType(input.sourceMimeType);

  if (input.resolution.kind !== 'metadata_rewrite_required') {
    return UNRESOLVED_RESULT;
  }

  if (sourceMimeType === null) {
    return UNRESOLVED_RESULT;
  }

  return Object.freeze({
    kind: 'raster_jpeg_reencode',
    strategy: 'raster_jpeg_reencode',
    sourceMimeType,
    targetMimeType: 'image/jpeg',
    quality: RASTER_ENCODE_JPEG_QUALITY,
    maxEdge: RASTER_ENCODE_MAX_EDGE_PX,
  });
}
