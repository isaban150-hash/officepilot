/**
 * Abstract transform capabilities for later probe / resolution layers.
 * Does not assert runtime support; does not probe browsers or libraries.
 */

export const DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS = [
  'load_pdf',
  'render_pdf_page',
  'decode_raster_image',
  'encode_raster_image',
  'write_pdf',
] as const;

export type DocumentFileTransformCapabilityId =
  (typeof DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS)[number];

export const DOCUMENT_FILE_TRANSFORM_CAPABILITY_STATUSES = [
  'supported',
  'unsupported',
  'unknown',
] as const;

export type DocumentFileTransformCapabilityStatus =
  (typeof DOCUMENT_FILE_TRANSFORM_CAPABILITY_STATUSES)[number];

/**
 * Complete capability status map. Every known capability has exactly one status.
 * Produced later by probe/configuration — not hardcoded in this module.
 */
export type DocumentFileTransformCapabilitySnapshot = Readonly<
  Record<DocumentFileTransformCapabilityId, DocumentFileTransformCapabilityStatus>
>;

/**
 * Minimal source description for later capability resolution.
 * mediaProfile remains on the transform intent plan; not duplicated here.
 * Uses string to avoid a second MIME catalog; upload MIME unions stay in validation.
 */
export interface DocumentFileTransformSourceDescriptor {
  readonly sourceMimeType: string;
}
