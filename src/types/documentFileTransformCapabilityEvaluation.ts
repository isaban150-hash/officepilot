import type {
  DocumentFileTransformCapabilityId,
  DocumentFileTransformCapabilityStatus,
} from './documentFileTransformCapability';

/**
 * Non-empty set of explicitly required transform capabilities.
 * Empty sets are rejected so unresolved cases cannot look supported.
 */
export type DocumentFileTransformCapabilityRequirementSet = readonly [
  DocumentFileTransformCapabilityId,
  ...DocumentFileTransformCapabilityId[],
];

/**
 * Aggregated evaluation of an explicit capability requirement set against a snapshot.
 * status reuses capability status literals with aggregate semantics.
 */
export interface DocumentFileTransformCapabilityEvaluation {
  readonly status: DocumentFileTransformCapabilityStatus;
  readonly requiredCapabilities: readonly DocumentFileTransformCapabilityId[];
  readonly unsupportedCapabilities: readonly DocumentFileTransformCapabilityId[];
  readonly unknownCapabilities: readonly DocumentFileTransformCapabilityId[];
}
