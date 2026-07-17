import type { ClassifiedDocumentKind } from './models';

export const STORAGE_POLICY_IDS = [
  'receipt',
  'business_document',
  'legal_document',
  'construction_photo',
  'temporary_unknown',
] as const;

export type StoragePolicyId = (typeof STORAGE_POLICY_IDS)[number];

export const STORAGE_MEDIA_PROFILES = [
  'native_pdf',
  'scanned_pdf',
  'raster_image',
] as const;

export type StorageMediaProfile = (typeof STORAGE_MEDIA_PROFILES)[number];

export interface ResolvedStoragePolicy {
  /** Effective policy after deterministic resolver rules (may differ from catalog on overrides). */
  policyId: StoragePolicyId;
  /** Policy assigned by kind catalog before resolver overrides. */
  catalogPolicyId: StoragePolicyId;
  mediaProfile: StorageMediaProfile;
  classifiedKind: ClassifiedDocumentKind;
  policyOverrideApplied: boolean;
}

/** Whether the source original should remain the authoritative archive representation. */
export const STORAGE_RETAIN_ORIGINAL = ['required', 'preferred', 'not_required'] as const;
export type StorageRetainOriginal = (typeof STORAGE_RETAIN_ORIGINAL)[number];

/**
 * Declares which archive representations are fachlich allowed later.
 * Does not create, transform, or delete any file bytes.
 */
export const STORAGE_ARCHIVE_REPRESENTATIONS = [
  'original_only',
  'original_and_optimized',
  'optimized_allowed',
  'temporary_source_only',
] as const;
export type StorageArchiveRepresentation = (typeof STORAGE_ARCHIVE_REPRESENTATIONS)[number];

export const STORAGE_PREVIEW_REQUIREMENTS = ['required', 'preferred', 'none'] as const;
export type StoragePreviewRequirement = (typeof STORAGE_PREVIEW_REQUIREMENTS)[number];

export const STORAGE_THUMBNAIL_REQUIREMENTS = ['required', 'preferred', 'none'] as const;
export type StorageThumbnailRequirement = (typeof STORAGE_THUMBNAIL_REQUIREMENTS)[number];

export const STORAGE_METADATA_HANDLINGS = [
  'preserve',
  'strip_nonessential',
  'not_applicable',
] as const;
export type StorageMetadataHandling = (typeof STORAGE_METADATA_HANDLINGS)[number];

export const STORAGE_COLOR_HANDLINGS = [
  'preserve',
  'grayscale_allowed',
  'not_applicable',
] as const;
export type StorageColorHandling = (typeof STORAGE_COLOR_HANDLINGS)[number];

/** Soft preference for a later archive output shape — not a guaranteed MIME or transform. */
export const STORAGE_PREFERRED_OUTPUT_KINDS = [
  'preserve_source',
  'pdf_preferred',
  'image_preferred',
] as const;
export type StoragePreferredOutputKind = (typeof STORAGE_PREFERRED_OUTPUT_KINDS)[number];

/**
 * Declarative physical-storage requirements for a StoragePolicyId.
 * No quality/DPI/size numbers; no runtime transform behavior.
 */
export interface StoragePolicyRequirements {
  retainOriginal: StorageRetainOriginal;
  archiveRepresentation: StorageArchiveRepresentation;
  previewRequirement: StoragePreviewRequirement;
  thumbnailRequirement: StorageThumbnailRequirement;
  metadataHandling: StorageMetadataHandling;
  colorHandling: StorageColorHandling;
  preferredOutputKind: StoragePreferredOutputKind;
}
