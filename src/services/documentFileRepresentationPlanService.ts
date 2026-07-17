import { DOCUMENT_FILE_REPRESENTATION_KINDS } from '../types/documentFileRepresentation';
import type {
  DocumentFileRepresentationDisposition,
  DocumentFileRepresentationPlan,
  DocumentFileRepresentationPlanEntry,
} from '../types/documentFileRepresentationPlan';
import type {
  StorageArchiveRepresentation,
  StoragePolicyId,
  StoragePolicyRequirements,
  StoragePreviewRequirement,
  StorageThumbnailRequirement,
} from '../types/storagePolicy';
import type { UserStorageDecision } from '../types/userStorageDecision';
import { isPersistingUserStorageDecision } from '../types/userStorageDecision';
import { getStoragePolicyRequirements } from './storagePolicyRequirements';

export interface BuildDocumentFileRepresentationPlanInput {
  policyId: StoragePolicyId;
  decision: UserStorageDecision;
}

function mapArchiveDisposition(
  archiveRepresentation: StorageArchiveRepresentation,
): DocumentFileRepresentationDisposition {
  switch (archiveRepresentation) {
    case 'original_only':
    case 'temporary_source_only':
      return 'excluded';
    case 'original_and_optimized':
      return 'preferred';
    case 'optimized_allowed':
      return 'allowed';
    default: {
      const _exhaustive: never = archiveRepresentation;
      return _exhaustive;
    }
  }
}

function mapPreviewOrThumbnailDisposition(
  requirement: StoragePreviewRequirement | StorageThumbnailRequirement,
): DocumentFileRepresentationDisposition {
  switch (requirement) {
    case 'required':
      return 'required';
    case 'preferred':
      return 'preferred';
    case 'none':
      return 'excluded';
    default: {
      const _exhaustive: never = requirement;
      return _exhaustive;
    }
  }
}

function buildTemporaryPlanEntries(): DocumentFileRepresentationPlanEntry[] {
  return DOCUMENT_FILE_REPRESENTATION_KINDS.map((kind) => ({
    kind,
    disposition: kind === 'original' ? 'required' : 'excluded',
  }));
}

function buildPermanentPlanEntries(
  requirements: StoragePolicyRequirements,
): DocumentFileRepresentationPlanEntry[] {
  const byKind: Record<
    (typeof DOCUMENT_FILE_REPRESENTATION_KINDS)[number],
    DocumentFileRepresentationDisposition
  > = {
    // Persisting intake always stores original bytes; retainOriginal does not skip that.
    original: 'required',
    archive: mapArchiveDisposition(requirements.archiveRepresentation),
    preview: mapPreviewOrThumbnailDisposition(requirements.previewRequirement),
    thumbnail: mapPreviewOrThumbnailDisposition(requirements.thumbnailRequirement),
  };

  return DOCUMENT_FILE_REPRESENTATION_KINDS.map((kind) => ({
    kind,
    disposition: byKind[kind],
  }));
}

/**
 * Pure, deterministic representation plan from policy + user decision.
 * Returns null for non-persisting decisions (discard, use_existing).
 * Does not read blobs, hash, persist, or mutate inputs.
 */
export function buildDocumentFileRepresentationPlan(
  input: BuildDocumentFileRepresentationPlanInput,
): DocumentFileRepresentationPlan | null {
  if (!isPersistingUserStorageDecision(input.decision)) {
    return null;
  }

  const decision = input.decision;
  const policyId = input.policyId;

  if (decision === 'keep_temporarily') {
    return {
      policyId,
      decision,
      entries: buildTemporaryPlanEntries(),
    };
  }

  const requirements = getStoragePolicyRequirements(policyId);
  return {
    policyId,
    decision,
    entries: buildPermanentPlanEntries(requirements),
  };
}
