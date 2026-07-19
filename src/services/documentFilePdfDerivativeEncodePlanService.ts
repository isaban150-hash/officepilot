import type { DocumentFilePdfDerivativeEncodePlanResult } from '../types/documentFilePdfDerivativeEncodePlan';
import type { DocumentFileTransformIntent } from '../types/documentFileTransformPlan';
import {
  RASTER_PREVIEW_ENCODE_JPEG_QUALITY,
  RASTER_PREVIEW_ENCODE_MAX_EDGE_PX,
  RASTER_THUMBNAIL_ENCODE_JPEG_QUALITY,
  RASTER_THUMBNAIL_ENCODE_MAX_EDGE_PX,
} from '../types/documentFileRasterEncode';

export interface PlanDocumentFilePdfDerivativeEncodeInput {
  transformIntent: DocumentFileTransformIntent;
  sourceMimeType: string;
}

const UNRESOLVED_RESULT = Object.freeze({
  kind: 'unresolved',
} as const satisfies DocumentFilePdfDerivativeEncodePlanResult);

const PDF_SOURCE_MIME_TYPE = 'application/pdf';

function isPdfSourceMimeType(sourceMimeType: unknown): sourceMimeType is typeof PDF_SOURCE_MIME_TYPE {
  if (typeof sourceMimeType !== 'string') {
    throw new TypeError('Invalid pdf derivative encode plan sourceMimeType');
  }

  return sourceMimeType.trim().toLowerCase() === PDF_SOURCE_MIME_TYPE;
}

function assertTransformIntent(
  transformIntent: unknown,
): asserts transformIntent is DocumentFileTransformIntent {
  if (
    transformIntent === null ||
    typeof transformIntent !== 'object' ||
    !('intent' in transformIntent)
  ) {
    throw new TypeError('Invalid pdf derivative encode plan transform intent');
  }

  const intent = (transformIntent as { intent: unknown }).intent;
  if (
    intent !== 'create_preview' &&
    intent !== 'create_thumbnail' &&
    intent !== 'create_archive'
  ) {
    throw new TypeError('Invalid pdf derivative encode plan transform intent');
  }
}

/**
 * Pure plan: whether create_preview / create_thumbnail should JPEG-encode PDF page 1.
 * Does not render, encode, persist, or bind results.
 */
export function planDocumentFilePdfDerivativeEncode(
  input: PlanDocumentFilePdfDerivativeEncodeInput,
): DocumentFilePdfDerivativeEncodePlanResult {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid pdf derivative encode plan input');
  }

  assertTransformIntent(input.transformIntent);
  if (!isPdfSourceMimeType(input.sourceMimeType)) {
    return UNRESOLVED_RESULT;
  }

  if (input.transformIntent.intent === 'create_preview') {
    return Object.freeze({
      kind: 'page_1_preview_jpeg_encode',
      strategy: 'page_1_preview_jpeg_encode',
      role: 'preview',
      sourceMimeType: PDF_SOURCE_MIME_TYPE,
      targetMimeType: 'image/jpeg',
      pageNumber: 1,
      quality: RASTER_PREVIEW_ENCODE_JPEG_QUALITY,
      maxEdge: RASTER_PREVIEW_ENCODE_MAX_EDGE_PX,
    });
  }

  if (input.transformIntent.intent === 'create_thumbnail') {
    return Object.freeze({
      kind: 'page_1_thumbnail_jpeg_encode',
      strategy: 'page_1_thumbnail_jpeg_encode',
      role: 'thumbnail',
      sourceMimeType: PDF_SOURCE_MIME_TYPE,
      targetMimeType: 'image/jpeg',
      pageNumber: 1,
      quality: RASTER_THUMBNAIL_ENCODE_JPEG_QUALITY,
      maxEdge: RASTER_THUMBNAIL_ENCODE_MAX_EDGE_PX,
    });
  }

  return UNRESOLVED_RESULT;
}
