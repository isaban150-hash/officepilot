import type { DocumentFileRepresentationKind } from './documentFileRepresentation';
import type { StoragePolicyId } from './storagePolicy';
import type { PersistingUserStorageDecision } from './userStorageDecision';

export const DOCUMENT_FILE_REPRESENTATION_DISPOSITIONS = [
  'required',
  'preferred',
  'allowed',
  'excluded',
] as const;

export type DocumentFileRepresentationDisposition =
  (typeof DOCUMENT_FILE_REPRESENTATION_DISPOSITIONS)[number];

export interface DocumentFileRepresentationPlanEntry {
  kind: DocumentFileRepresentationKind;
  disposition: DocumentFileRepresentationDisposition;
}

/**
 * Declarative representation plan for a confirmed persisting storage decision.
 * Does not describe formats, quality, transforms, or persistence location.
 */
export interface DocumentFileRepresentationPlan {
  policyId: StoragePolicyId;
  decision: PersistingUserStorageDecision;
  entries: DocumentFileRepresentationPlanEntry[];
}
