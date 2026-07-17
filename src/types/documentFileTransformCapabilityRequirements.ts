import type { DocumentFileTransformCapabilityRequirementSet } from './documentFileTransformCapabilityEvaluation';

/**
 * Result of deriving abstract capability requirements for one transform intent.
 * Does not evaluate a capability snapshot and does not assert runtime support.
 */
export type DocumentFileTransformCapabilityRequirementsResult =
  | {
      readonly kind: 'capability_requirements';
      readonly requiredCapabilities: DocumentFileTransformCapabilityRequirementSet;
    }
  | {
      readonly kind: 'unresolved';
    };
