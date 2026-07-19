import type { DocumentFileArchiveTransformResolutionResult } from '../types/documentFileArchiveTransformResolution';
import type { DocumentFileImageToPdfArchiveEncodePlanResult } from '../types/documentFileImageToPdfArchiveEncodePlan';
import type { DocumentFileTransformIntent } from '../types/documentFileTransformPlan';
import {
  IMAGE_TO_PDF_PAGE_HEIGHT_PT,
  IMAGE_TO_PDF_PAGE_WIDTH_PT,
  IMAGE_TO_PDF_SOURCE_MIME_TYPES,
  type ImageToPdfSourceMimeType,
} from '../types/documentFileImageToPdfWrite';

export interface PlanDocumentFileImageToPdfArchiveEncodeInput {
  transformIntent: DocumentFileTransformIntent;
  resolution: DocumentFileArchiveTransformResolutionResult;
  sourceMimeType: string;
}

const UNRESOLVED_RESULT = Object.freeze({
  kind: 'unresolved',
} as const satisfies DocumentFileImageToPdfArchiveEncodePlanResult);

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
    (ARCHIVE_RESOLUTION_KINDS as readonly string[]).includes((value as { kind: string }).kind)
  );
}

function assertArchiveIntent(
  transformIntent: unknown,
): asserts transformIntent is DocumentFileTransformIntent {
  if (
    transformIntent === null ||
    typeof transformIntent !== 'object' ||
    !('intent' in transformIntent)
  ) {
    throw new TypeError('Invalid image to pdf archive encode plan transform intent');
  }

  const intent = (transformIntent as { intent: unknown }).intent;
  if (intent !== 'create_archive') {
    throw new TypeError('Invalid image to pdf archive encode plan transform intent');
  }
}

function assertResolution(
  resolution: unknown,
): asserts resolution is DocumentFileArchiveTransformResolutionResult {
  if (!isArchiveResolutionResult(resolution)) {
    throw new TypeError('Invalid image to pdf archive encode plan resolution');
  }
}

function classifyImageToPdfSourceMimeType(
  sourceMimeType: unknown,
): ImageToPdfSourceMimeType | null {
  if (typeof sourceMimeType !== 'string') {
    throw new TypeError('Invalid image to pdf archive encode plan sourceMimeType');
  }

  const normalized = sourceMimeType.trim().toLowerCase();
  if ((IMAGE_TO_PDF_SOURCE_MIME_TYPES as readonly string[]).includes(normalized)) {
    return normalized as ImageToPdfSourceMimeType;
  }

  return null;
}

/**
 * Pure plan: whether create_archive should convert a raster source to a single-page PDF.
 * First allowed case: output_conversion_required + JPEG/PNG.
 * Does not call the writer or invent strategies for rewrite/unresolved cases.
 */
export function planDocumentFileImageToPdfArchiveEncode(
  input: PlanDocumentFileImageToPdfArchiveEncodeInput,
): DocumentFileImageToPdfArchiveEncodePlanResult {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid image to pdf archive encode plan input');
  }

  assertArchiveIntent(input.transformIntent);
  assertResolution(input.resolution);
  const sourceMimeType = classifyImageToPdfSourceMimeType(input.sourceMimeType);

  if (input.resolution.kind !== 'output_conversion_required') {
    return UNRESOLVED_RESULT;
  }

  if (sourceMimeType === null) {
    return UNRESOLVED_RESULT;
  }

  return Object.freeze({
    kind: 'image_to_pdf',
    strategy: 'image_to_pdf',
    sourceMimeType,
    targetMimeType: 'application/pdf',
    pageWidth: IMAGE_TO_PDF_PAGE_WIDTH_PT,
    pageHeight: IMAGE_TO_PDF_PAGE_HEIGHT_PT,
  });
}
