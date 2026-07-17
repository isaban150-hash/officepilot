import { DOCUMENT_FILE_REPRESENTATION_KINDS } from '../types/documentFileRepresentation';
import type { DocumentFileRepresentationPlan } from '../types/documentFileRepresentationPlan';
import type {
  DocumentFileTransformExecutionIntent,
  DocumentFileTransformIntent,
  DocumentFileTransformIntentKind,
  DocumentFileTransformPlan,
  DocumentFileTransformTargetKind,
} from '../types/documentFileTransformPlan';
import type { StorageMediaProfile } from '../types/storagePolicy';
import { getStoragePolicyRequirements } from './storagePolicyRequirements';

export interface BuildDocumentFileTransformPlanInput {
  representationPlan: DocumentFileRepresentationPlan;
  mediaProfile: StorageMediaProfile;
}

const TRANSFORM_TARGET_KINDS = DOCUMENT_FILE_REPRESENTATION_KINDS.filter(
  (kind): kind is DocumentFileTransformTargetKind => kind !== 'original',
);

function intentKindForTarget(targetKind: DocumentFileTransformTargetKind): DocumentFileTransformIntentKind {
  switch (targetKind) {
    case 'archive':
      return 'create_archive';
    case 'preview':
      return 'create_preview';
    case 'thumbnail':
      return 'create_thumbnail';
    default: {
      const _exhaustive: never = targetKind;
      return _exhaustive;
    }
  }
}

function toExecutionIntent(
  disposition: DocumentFileRepresentationPlan['entries'][number]['disposition'],
): DocumentFileTransformExecutionIntent | null {
  if (disposition === 'required' || disposition === 'preferred') {
    return disposition;
  }
  return null;
}

/**
 * Pure transform intent planner.
 * Representation plan is the sole role truth; requirements supply hints only.
 * Returns null when no active derivative intents exist.
 */
export function buildDocumentFileTransformPlan(
  input: BuildDocumentFileTransformPlanInput,
): DocumentFileTransformPlan | null {
  const { representationPlan, mediaProfile } = input;
  const dispositionByKind = new Map(
    representationPlan.entries.map((entry) => [entry.kind, entry.disposition]),
  );

  const intents: DocumentFileTransformIntent[] = [];
  for (const targetKind of TRANSFORM_TARGET_KINDS) {
    const disposition = dispositionByKind.get(targetKind);
    if (!disposition) continue;
    const executionIntent = toExecutionIntent(disposition);
    if (!executionIntent) continue;
    intents.push({
      targetKind,
      intent: intentKindForTarget(targetKind),
      executionIntent,
    });
  }

  if (intents.length === 0) {
    return null;
  }

  const requirements = getStoragePolicyRequirements(representationPlan.policyId);
  return {
    policyId: representationPlan.policyId,
    mediaProfile,
    hints: {
      metadataHandling: requirements.metadataHandling,
      colorHandling: requirements.colorHandling,
      preferredOutputKind: requirements.preferredOutputKind,
    },
    intents,
  };
}
