import type { StoragePolicyId, StoragePolicyRequirements } from '../types/storagePolicy';
import { STORAGE_POLICY_IDS } from '../types/storagePolicy';

/**
 * Central declarative storage requirements per existing StoragePolicyId.
 * Complements STORAGE_POLICY_BY_KIND (kind → policy) without a second resolver.
 */
export const STORAGE_POLICY_REQUIREMENTS_BY_ID: Record<
  StoragePolicyId,
  StoragePolicyRequirements
> = {
  receipt: {
    retainOriginal: 'preferred',
    archiveRepresentation: 'optimized_allowed',
    previewRequirement: 'preferred',
    thumbnailRequirement: 'preferred',
    metadataHandling: 'strip_nonessential',
    colorHandling: 'grayscale_allowed',
    preferredOutputKind: 'pdf_preferred',
  },
  business_document: {
    retainOriginal: 'preferred',
    archiveRepresentation: 'original_and_optimized',
    previewRequirement: 'preferred',
    thumbnailRequirement: 'preferred',
    metadataHandling: 'strip_nonessential',
    colorHandling: 'preserve',
    preferredOutputKind: 'preserve_source',
  },
  legal_document: {
    retainOriginal: 'required',
    archiveRepresentation: 'original_and_optimized',
    previewRequirement: 'preferred',
    thumbnailRequirement: 'preferred',
    metadataHandling: 'preserve',
    colorHandling: 'preserve',
    preferredOutputKind: 'preserve_source',
  },
  construction_photo: {
    retainOriginal: 'preferred',
    archiveRepresentation: 'optimized_allowed',
    previewRequirement: 'preferred',
    thumbnailRequirement: 'preferred',
    metadataHandling: 'strip_nonessential',
    colorHandling: 'preserve',
    preferredOutputKind: 'image_preferred',
  },
  temporary_unknown: {
    retainOriginal: 'preferred',
    archiveRepresentation: 'temporary_source_only',
    previewRequirement: 'none',
    thumbnailRequirement: 'none',
    metadataHandling: 'preserve',
    colorHandling: 'not_applicable',
    preferredOutputKind: 'preserve_source',
  },
};

export function getStoragePolicyRequirements(
  policyId: StoragePolicyId,
): StoragePolicyRequirements {
  const requirements = STORAGE_POLICY_REQUIREMENTS_BY_ID[policyId];
  if (!requirements) {
    throw new Error(`Missing storage policy requirements for policyId: ${policyId}`);
  }
  return requirements;
}

export function assertStoragePolicyRequirementsComplete(): void {
  for (const policyId of STORAGE_POLICY_IDS) {
    if (!(policyId in STORAGE_POLICY_REQUIREMENTS_BY_ID)) {
      throw new Error(`Missing storage policy requirements for policyId: ${policyId}`);
    }
  }
}
