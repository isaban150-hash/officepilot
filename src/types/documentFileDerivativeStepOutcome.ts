import type { DocumentFileRepresentationBindingKind } from './documentFileRepresentationBinding';

/**
 * All durable derivative step ids (sync source-reuse + async post-import).
 * Order is diagnostic/retry priority: source_reuse_archive before other archive steps.
 */
export const DOCUMENT_FILE_DERIVATIVE_STEP_IDS = [
  'source_reuse_archive',
  'raster_archive',
  'image_to_pdf_archive',
  'pdf_metadata_strip',
  'raster_thumbnail',
  'raster_preview',
  'pdf_thumbnail',
  'pdf_preview',
] as const;

export type DocumentFileDerivativeStepId =
  (typeof DOCUMENT_FILE_DERIVATIVE_STEP_IDS)[number];

/**
 * Async fire-and-forget coordinator steps only.
 * Excludes sync `source_reuse_archive` — that runs before this list on import.
 */
export const POST_IMPORT_DERIVATIVE_STEP_IDS = [
  'raster_archive',
  'image_to_pdf_archive',
  'pdf_metadata_strip',
  'raster_thumbnail',
  'raster_preview',
  'pdf_thumbnail',
  'pdf_preview',
] as const;

export type PostImportDerivativeStepId =
  (typeof POST_IMPORT_DERIVATIVE_STEP_IDS)[number];

export const DOCUMENT_FILE_DERIVATIVE_STEP_OUTCOMES = [
  'persisted',
  'noop',
  'conflict',
  'error',
] as const;

export type DocumentFileDerivativeStepOutcomeKind =
  (typeof DOCUMENT_FILE_DERIVATIVE_STEP_OUTCOMES)[number];

export const DOCUMENT_FILE_DERIVATIVE_STEP_REGISTRATION_STATUSES = [
  'created',
  'unchanged',
] as const;

export type DocumentFileDerivativeStepRegistrationStatus =
  (typeof DOCUMENT_FILE_DERIVATIVE_STEP_REGISTRATION_STATUSES)[number];

/** Stable noop reasons from derived orchestrators (no free-text). */
export const DOCUMENT_FILE_DERIVATIVE_STEP_NOOP_REASONS = [
  'missing_transform_plan',
  'no_archive_intent',
  'no_preview_intent',
  'no_thumbnail_intent',
  'encode_plan_unresolved',
  'strip_plan_unresolved',
  'unresolved',
  'missing_document',
  'missing_file_ref',
  'not_committed',
  'missing_bytes',
] as const;

export type DocumentFileDerivativeStepNoopReason =
  (typeof DOCUMENT_FILE_DERIVATIVE_STEP_NOOP_REASONS)[number];

/** Stable error codes only — never raw messages or stacks. */
export const DOCUMENT_FILE_DERIVATIVE_STEP_ERROR_CODES = [
  'orchestrator_error',
  'runner_threw',
  'unknown_result',
] as const;

export type DocumentFileDerivativeStepErrorCode =
  (typeof DOCUMENT_FILE_DERIVATIVE_STEP_ERROR_CODES)[number];

/**
 * Persisted derivative step outcome.
 * Natural key: documentId + stepId.
 */
export interface DocumentFileDerivativeStepOutcome {
  readonly documentId: string;
  readonly stepId: DocumentFileDerivativeStepId;
  readonly representationKind: DocumentFileRepresentationBindingKind;
  readonly outcome: DocumentFileDerivativeStepOutcomeKind;
  readonly noopReason?: DocumentFileDerivativeStepNoopReason;
  readonly errorCode?: DocumentFileDerivativeStepErrorCode;
  readonly registrationStatus?: DocumentFileDerivativeStepRegistrationStatus;
  readonly sourceFileRefId: string;
  readonly sourceMimeType: string;
  readonly resultFileRefId?: string;
  readonly createdFileRef: boolean;
  readonly attempt: number;
  readonly updatedAt: string;
}

export const DOCUMENT_FILE_DERIVATIVE_STEP_REPRESENTATION_KIND: Readonly<
  Record<DocumentFileDerivativeStepId, DocumentFileRepresentationBindingKind>
> = Object.freeze({
  source_reuse_archive: 'archive',
  raster_archive: 'archive',
  image_to_pdf_archive: 'archive',
  pdf_metadata_strip: 'archive',
  raster_thumbnail: 'thumbnail',
  raster_preview: 'preview',
  pdf_thumbnail: 'thumbnail',
  pdf_preview: 'preview',
});

/** @deprecated Prefer DOCUMENT_FILE_DERIVATIVE_STEP_REPRESENTATION_KIND */
export const POST_IMPORT_DERIVATIVE_STEP_REPRESENTATION_KIND =
  DOCUMENT_FILE_DERIVATIVE_STEP_REPRESENTATION_KIND;
