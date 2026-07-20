import type { StorageMediaProfile, StoragePolicyId } from './storagePolicy';
import type { PersistingUserStorageDecision } from './userStorageDecision';

/** Bump when the persisted intake carry context shape changes incompatibly. */
export const DOCUMENT_FILE_INTAKE_TRANSFORM_PLAN_CARRY_SCHEMA_VERSION = 1 as const;

/**
 * Sidecar context carried from confirmed pending intake to later archive import.
 * Natural key: inboxItemId.
 * Never inferred from MIME, document type, or classification at read time.
 */
export interface DocumentFileIntakeTransformPlanCarryContext {
  readonly inboxItemId: string;
  readonly policyId: StoragePolicyId;
  readonly userDecision: PersistingUserStorageDecision;
  readonly mediaProfile: StorageMediaProfile;
  readonly schemaVersion: typeof DOCUMENT_FILE_INTAKE_TRANSFORM_PLAN_CARRY_SCHEMA_VERSION;
  readonly capturedAt: string;
}
