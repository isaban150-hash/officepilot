import {
  DOCUMENT_FILE_TRANSFORM_INTENTS,
  type DocumentFileTransformIntent,
  type DocumentFileTransformIntentKind,
} from '../types/documentFileTransformPlan';
import type { DocumentFileTransformCapabilityId } from '../types/documentFileTransformCapability';
import type { DocumentFileTransformCapabilityRequirementSet } from '../types/documentFileTransformCapabilityEvaluation';
import type { DocumentFileTransformCapabilityRequirementsResult } from '../types/documentFileTransformCapabilityRequirements';
import {
  isAcceptedUploadMimeType,
  isImageUpload,
  isPdfUpload,
} from './documentUploadValidation';

export interface DeriveDocumentFileTransformCapabilityRequirementsInput {
  transformIntent: DocumentFileTransformIntent;
  sourceMimeType: string;
}

type TechnicalSourceClass = 'pdf' | 'raster_image';

const PDF_PREVIEW_OR_THUMBNAIL_CAPABILITIES = Object.freeze([
  'load_pdf',
  'render_pdf_page',
  'encode_raster_image',
] as const satisfies readonly DocumentFileTransformCapabilityId[]);

const RASTER_PREVIEW_OR_THUMBNAIL_CAPABILITIES = Object.freeze([
  'decode_raster_image',
  'encode_raster_image',
] as const satisfies readonly DocumentFileTransformCapabilityId[]);

/** Raster create_archive JPEG re-encode path (decode → canvas → JPEG). */
const RASTER_ARCHIVE_CAPABILITIES = Object.freeze([
  'decode_raster_image',
  'encode_raster_image',
] as const satisfies readonly DocumentFileTransformCapabilityId[]);

function isTransformIntentKind(value: unknown): value is DocumentFileTransformIntentKind {
  return (
    typeof value === 'string' &&
    (DOCUMENT_FILE_TRANSFORM_INTENTS as readonly string[]).includes(value)
  );
}

function classifyTechnicalSource(sourceMimeType: string): TechnicalSourceClass {
  if (typeof sourceMimeType !== 'string' || !isAcceptedUploadMimeType(sourceMimeType)) {
    throw new TypeError('Invalid transform capability requirements source');
  }

  // MIME-only classification via existing upload helpers (empty name = no extension path).
  if (isPdfUpload(sourceMimeType, '')) {
    return 'pdf';
  }
  if (isImageUpload(sourceMimeType, '')) {
    return 'raster_image';
  }

  throw new TypeError('Invalid transform capability requirements source');
}

function freezeRequirementSet(
  capabilities: readonly DocumentFileTransformCapabilityId[],
): DocumentFileTransformCapabilityRequirementSet {
  if (capabilities.length === 0) {
    throw new TypeError('Invalid transform capability requirements');
  }
  return Object.freeze(capabilities.slice()) as DocumentFileTransformCapabilityRequirementSet;
}

function freezeResult(
  result: DocumentFileTransformCapabilityRequirementsResult,
): DocumentFileTransformCapabilityRequirementsResult {
  if (result.kind === 'capability_requirements') {
    return Object.freeze({
      kind: 'capability_requirements',
      requiredCapabilities: freezeRequirementSet(result.requiredCapabilities),
    });
  }
  return Object.freeze({ kind: 'unresolved' });
}

/**
 * Pure derivation of abstract capability requirements for one transform intent
 * and a validated technical source MIME type.
 * Does not evaluate snapshots, preflight health, or archive materialization.
 */
export function deriveDocumentFileTransformCapabilityRequirements(
  input: DeriveDocumentFileTransformCapabilityRequirementsInput,
): DocumentFileTransformCapabilityRequirementsResult {
  const intentKind = input.transformIntent?.intent;
  if (!isTransformIntentKind(intentKind)) {
    throw new TypeError('Invalid transform capability requirements intent');
  }

  const sourceClass = classifyTechnicalSource(input.sourceMimeType);

  if (intentKind === 'create_archive') {
    if (sourceClass === 'raster_image') {
      return freezeResult({
        kind: 'capability_requirements',
        requiredCapabilities: RASTER_ARCHIVE_CAPABILITIES,
      });
    }
    // PDF and other non-raster archive strategies remain unresolved here.
    return freezeResult({ kind: 'unresolved' });
  }

  if (intentKind === 'create_preview' || intentKind === 'create_thumbnail') {
    if (sourceClass === 'pdf') {
      return freezeResult({
        kind: 'capability_requirements',
        requiredCapabilities: PDF_PREVIEW_OR_THUMBNAIL_CAPABILITIES,
      });
    }
    return freezeResult({
      kind: 'capability_requirements',
      requiredCapabilities: RASTER_PREVIEW_OR_THUMBNAIL_CAPABILITIES,
    });
  }

  throw new TypeError('Invalid transform capability requirements intent');
}
