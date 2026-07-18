import type { DocumentFileArchiveTransformResolutionResult } from '../types/documentFileArchiveTransformResolution';
import type {
  DocumentFileTransformHints,
  DocumentFileTransformIntent,
} from '../types/documentFileTransformPlan';
import {
  STORAGE_COLOR_HANDLINGS,
  STORAGE_METADATA_HANDLINGS,
  STORAGE_PREFERRED_OUTPUT_KINDS,
  type StorageColorHandling,
  type StorageMetadataHandling,
  type StoragePreferredOutputKind,
} from '../types/storagePolicy';
import {
  isAcceptedUploadMimeType,
  isImageUpload,
  isPdfUpload,
} from './documentUploadValidation';

export interface ResolveDocumentFileArchiveTransformResolutionInput {
  transformIntent: DocumentFileTransformIntent;
  hints: DocumentFileTransformHints;
  /** Required only when preferred output conversion must be evaluated unambiguously. */
  sourceMimeType?: string;
}

type TechnicalSourceClass = 'pdf' | 'raster_image';

const SOURCE_REUSE_RESULT = Object.freeze({
  kind: 'source_reuse',
} as const satisfies DocumentFileArchiveTransformResolutionResult);

const METADATA_REWRITE_REQUIRED_RESULT = Object.freeze({
  kind: 'metadata_rewrite_required',
} as const satisfies DocumentFileArchiveTransformResolutionResult);

const OUTPUT_CONVERSION_REQUIRED_RESULT = Object.freeze({
  kind: 'output_conversion_required',
} as const satisfies DocumentFileArchiveTransformResolutionResult);

const STRATEGY_UNRESOLVED_RESULT = Object.freeze({
  kind: 'strategy_unresolved',
} as const satisfies DocumentFileArchiveTransformResolutionResult);

function isPreferredOutputKind(value: unknown): value is StoragePreferredOutputKind {
  return (
    typeof value === 'string' &&
    (STORAGE_PREFERRED_OUTPUT_KINDS as readonly string[]).includes(value)
  );
}

function isMetadataHandling(value: unknown): value is StorageMetadataHandling {
  return (
    typeof value === 'string' &&
    (STORAGE_METADATA_HANDLINGS as readonly string[]).includes(value)
  );
}

function isColorHandling(value: unknown): value is StorageColorHandling {
  return (
    typeof value === 'string' &&
    (STORAGE_COLOR_HANDLINGS as readonly string[]).includes(value)
  );
}

function assertArchiveIntent(transformIntent: unknown): asserts transformIntent is DocumentFileTransformIntent {
  if (
    transformIntent === null ||
    typeof transformIntent !== 'object' ||
    !('intent' in transformIntent)
  ) {
    throw new TypeError('Invalid archive transform resolution transform intent');
  }

  const intent = (transformIntent as { intent: unknown }).intent;
  if (intent !== 'create_archive') {
    throw new TypeError('Invalid archive transform resolution transform intent');
  }
}

function assertHints(hints: unknown): asserts hints is DocumentFileTransformHints {
  if (hints === null || typeof hints !== 'object') {
    throw new TypeError('Invalid archive transform resolution hints');
  }

  const record = hints as Record<string, unknown>;
  if (!('preferredOutputKind' in record) || !isPreferredOutputKind(record.preferredOutputKind)) {
    throw new TypeError('Invalid archive transform resolution hints');
  }
  if (!('metadataHandling' in record) || !isMetadataHandling(record.metadataHandling)) {
    throw new TypeError('Invalid archive transform resolution hints');
  }
  if (!('colorHandling' in record) || !isColorHandling(record.colorHandling)) {
    throw new TypeError('Invalid archive transform resolution hints');
  }
}

/**
 * MIME-only technical source class. Returns null when sourceMimeType is omitted.
 * Throws when a provided MIME is not an accepted, classifiable upload type.
 */
function classifyOptionalSourceMimeType(
  sourceMimeType: unknown,
): TechnicalSourceClass | null {
  if (sourceMimeType === undefined) {
    return null;
  }

  if (typeof sourceMimeType !== 'string' || !isAcceptedUploadMimeType(sourceMimeType)) {
    throw new TypeError('Invalid archive transform resolution sourceMimeType');
  }

  if (isPdfUpload(sourceMimeType, '')) {
    return 'pdf';
  }
  if (isImageUpload(sourceMimeType, '')) {
    return 'raster_image';
  }

  throw new TypeError('Invalid archive transform resolution sourceMimeType');
}

function resolvePreferredOutputConversion(
  preferredOutputKind: StoragePreferredOutputKind,
  sourceClass: TechnicalSourceClass | null,
): DocumentFileArchiveTransformResolutionResult | null {
  if (preferredOutputKind === 'pdf_preferred') {
    if (sourceClass === 'raster_image') {
      return OUTPUT_CONVERSION_REQUIRED_RESULT;
    }
    // PDF source or unknown MIME: do not invent a rewrite/keep strategy.
    return STRATEGY_UNRESOLVED_RESULT;
  }

  if (preferredOutputKind === 'image_preferred') {
    if (sourceClass === 'pdf') {
      return OUTPUT_CONVERSION_REQUIRED_RESULT;
    }
    // Raster source or unknown MIME: do not invent an encode/optimize strategy.
    return STRATEGY_UNRESOLVED_RESULT;
  }

  return null;
}

/**
 * Pure archive transform resolution for a create_archive intent.
 * Explains why source_reuse materialization is not available, without claiming
 * executors, capabilities, or a concrete transform pipeline.
 */
export function resolveDocumentFileArchiveTransformResolution(
  input: ResolveDocumentFileArchiveTransformResolutionInput,
): DocumentFileArchiveTransformResolutionResult {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid archive transform resolution input');
  }

  assertArchiveIntent(input.transformIntent);
  assertHints(input.hints);
  const sourceClass = classifyOptionalSourceMimeType(input.sourceMimeType);

  const { preferredOutputKind, metadataHandling, colorHandling } = input.hints;

  const colorAllowsReuse =
    colorHandling === 'preserve' || colorHandling === 'not_applicable';

  if (
    preferredOutputKind === 'preserve_source' &&
    metadataHandling === 'preserve' &&
    colorAllowsReuse
  ) {
    return SOURCE_REUSE_RESULT;
  }

  // Metadata rewrite blocks reuse before output-kind or color permission checks.
  if (metadataHandling === 'strip_nonessential') {
    return METADATA_REWRITE_REQUIRED_RESULT;
  }

  const conversion = resolvePreferredOutputConversion(preferredOutputKind, sourceClass);
  if (conversion !== null) {
    return conversion;
  }

  // grayscale_allowed is a soft permission, not an executable color transform demand.
  return STRATEGY_UNRESOLVED_RESULT;
}
