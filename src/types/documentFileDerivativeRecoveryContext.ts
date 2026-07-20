import type { DocumentFileTransformPlan } from './documentFileTransformPlan';
import type { StorageMediaProfile, StoragePolicyId } from './storagePolicy';
import type { UserStorageDecision } from './userStorageDecision';

/** Bump when the persisted recovery context shape changes incompatibly. */
export const DOCUMENT_FILE_DERIVATIVE_RECOVERY_CONTEXT_SCHEMA_VERSION = 1 as const;

/**
 * Optional provenance supplied at import — never inferred from MIME/document/outcomes.
 */
export interface DocumentFileDerivativeRecoveryContextOrigin {
  readonly policyId: StoragePolicyId;
  readonly decision: UserStorageDecision;
  readonly mediaProfile: StorageMediaProfile;
}

/**
 * Frozen post-import recovery context for one document.
 * Natural key: documentId.
 */
export interface DocumentFileDerivativeRecoveryContext {
  readonly documentId: string;
  readonly transformPlan: DocumentFileTransformPlan;
  readonly capturedAt: string;
  readonly schemaVersion: typeof DOCUMENT_FILE_DERIVATIVE_RECOVERY_CONTEXT_SCHEMA_VERSION;
  readonly origin?: DocumentFileDerivativeRecoveryContextOrigin;
}
