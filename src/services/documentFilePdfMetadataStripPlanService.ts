import type { DocumentFileArchiveTransformResolutionResult } from '../types/documentFileArchiveTransformResolution';
import { PDF_INFO_METADATA_STRIP_KEYS } from '../types/documentFilePdfMetadataStrip';
import type { DocumentFilePdfMetadataStripPlanResult } from '../types/documentFilePdfMetadataStripPlan';
import type { DocumentFileTransformIntent } from '../types/documentFileTransformPlan';

export interface PlanDocumentFilePdfMetadataStripInput {
  transformIntent: DocumentFileTransformIntent;
  resolution: DocumentFileArchiveTransformResolutionResult;
  sourceMimeType: string;
}

const UNRESOLVED_RESULT = Object.freeze({
  kind: 'unresolved',
} as const satisfies DocumentFilePdfMetadataStripPlanResult);

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
    throw new TypeError('Invalid pdf metadata strip plan transform intent');
  }

  const intent = (transformIntent as { intent: unknown }).intent;
  if (intent !== 'create_archive') {
    throw new TypeError('Invalid pdf metadata strip plan transform intent');
  }
}

function assertResolution(
  resolution: unknown,
): asserts resolution is DocumentFileArchiveTransformResolutionResult {
  if (!isArchiveResolutionResult(resolution)) {
    throw new TypeError('Invalid pdf metadata strip plan resolution');
  }
}

function isPdfSourceMimeType(sourceMimeType: unknown): sourceMimeType is 'application/pdf' {
  if (typeof sourceMimeType !== 'string') {
    throw new TypeError('Invalid pdf metadata strip plan sourceMimeType');
  }

  return sourceMimeType.trim().toLowerCase() === 'application/pdf';
}

/**
 * Pure plan: whether create_archive should clear classic PDF Info metadata.
 * Allowed only for application/pdf + metadata_rewrite_required.
 * Does not call the strip core, persist bytes, or claim XMP / input-safety guarantees.
 */
export function planDocumentFilePdfMetadataStrip(
  input: PlanDocumentFilePdfMetadataStripInput,
): DocumentFilePdfMetadataStripPlanResult {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid pdf metadata strip plan input');
  }

  assertArchiveIntent(input.transformIntent);
  assertResolution(input.resolution);
  const isPdf = isPdfSourceMimeType(input.sourceMimeType);

  if (input.resolution.kind !== 'metadata_rewrite_required') {
    return UNRESOLVED_RESULT;
  }

  if (!isPdf) {
    return UNRESOLVED_RESULT;
  }

  return Object.freeze({
    kind: 'pdf_info_metadata_strip',
    strategy: 'pdf_info_metadata_strip',
    sourceMimeType: 'application/pdf',
    targetMimeType: 'application/pdf',
    clearedInfoKeys: PDF_INFO_METADATA_STRIP_KEYS,
    xmpFullyRemoved: false,
    stripInputSafetyVerified: false,
  });
}
