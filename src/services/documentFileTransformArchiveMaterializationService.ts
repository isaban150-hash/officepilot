import type { DocumentFileTransformArchiveMaterializationResult } from '../types/documentFileTransformArchiveMaterialization';
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

export interface ResolveDocumentFileTransformArchiveMaterializationInput {
  transformIntent: DocumentFileTransformIntent;
  hints: DocumentFileTransformHints;
}

const SOURCE_REUSE_RESULT = Object.freeze({
  kind: 'source_reuse',
} as const satisfies DocumentFileTransformArchiveMaterializationResult);

const UNRESOLVED_RESULT = Object.freeze({
  kind: 'unresolved',
} as const satisfies DocumentFileTransformArchiveMaterializationResult);

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
    throw new TypeError('Invalid archive materialization transform intent');
  }

  const intent = (transformIntent as { intent: unknown }).intent;
  if (intent !== 'create_archive') {
    throw new TypeError('Invalid archive materialization transform intent');
  }
}

function assertHints(hints: unknown): asserts hints is DocumentFileTransformHints {
  if (hints === null || typeof hints !== 'object') {
    throw new TypeError('Invalid archive materialization hints');
  }

  const record = hints as Record<string, unknown>;
  if (!('preferredOutputKind' in record) || !isPreferredOutputKind(record.preferredOutputKind)) {
    throw new TypeError('Invalid archive materialization hints');
  }
  if (!('metadataHandling' in record) || !isMetadataHandling(record.metadataHandling)) {
    throw new TypeError('Invalid archive materialization hints');
  }
  if (!('colorHandling' in record) || !isColorHandling(record.colorHandling)) {
    throw new TypeError('Invalid archive materialization hints');
  }
}

/**
 * Pure archive materialization resolution from a create_archive intent and plan hints.
 * Does not evaluate capabilities, bind representations, or inspect source bytes.
 */
export function resolveDocumentFileTransformArchiveMaterialization(
  input: ResolveDocumentFileTransformArchiveMaterializationInput,
): DocumentFileTransformArchiveMaterializationResult {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid archive materialization input');
  }

  assertArchiveIntent(input.transformIntent);
  assertHints(input.hints);

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

  return UNRESOLVED_RESULT;
}
