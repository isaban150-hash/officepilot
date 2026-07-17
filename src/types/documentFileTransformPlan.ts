import type { DocumentFileRepresentationKind } from './documentFileRepresentation';
import type {
  StorageColorHandling,
  StorageMediaProfile,
  StorageMetadataHandling,
  StoragePolicyId,
  StoragePreferredOutputKind,
} from './storagePolicy';

export const DOCUMENT_FILE_TRANSFORM_EXECUTION_INTENTS = ['required', 'preferred'] as const;
export type DocumentFileTransformExecutionIntent =
  (typeof DOCUMENT_FILE_TRANSFORM_EXECUTION_INTENTS)[number];

export const DOCUMENT_FILE_TRANSFORM_INTENTS = [
  'create_archive',
  'create_preview',
  'create_thumbnail',
] as const;
export type DocumentFileTransformIntentKind = (typeof DOCUMENT_FILE_TRANSFORM_INTENTS)[number];

/** Derivative representation kinds that may appear as transform targets. */
export type DocumentFileTransformTargetKind = Exclude<DocumentFileRepresentationKind, 'original'>;

export interface DocumentFileTransformHints {
  metadataHandling: StorageMetadataHandling;
  colorHandling: StorageColorHandling;
  preferredOutputKind: StoragePreferredOutputKind;
}

export interface DocumentFileTransformIntent {
  targetKind: DocumentFileTransformTargetKind;
  intent: DocumentFileTransformIntentKind;
  executionIntent: DocumentFileTransformExecutionIntent;
}

/**
 * Compact declarative transform intent plan.
 * Roles come from the representation plan; hints from policy requirements.
 */
export interface DocumentFileTransformPlan {
  policyId: StoragePolicyId;
  mediaProfile: StorageMediaProfile;
  hints: DocumentFileTransformHints;
  intents: DocumentFileTransformIntent[];
}
