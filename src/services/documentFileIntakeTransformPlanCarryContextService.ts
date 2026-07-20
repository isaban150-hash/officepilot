import {
  DOCUMENT_FILE_INTAKE_TRANSFORM_PLAN_CARRY_SCHEMA_VERSION,
  type DocumentFileIntakeTransformPlanCarryContext,
} from '../types/documentFileIntakeTransformPlanCarryContext';
import type { DocumentFileDerivativeRecoveryContextOrigin } from '../types/documentFileDerivativeRecoveryContext';
import type { DocumentFileTransformPlan } from '../types/documentFileTransformPlan';
import {
  STORAGE_MEDIA_PROFILES,
  STORAGE_POLICY_IDS,
  type StorageMediaProfile,
  type StoragePolicyId,
} from '../types/storagePolicy';
import {
  PERSISTING_USER_STORAGE_DECISIONS,
  type PersistingUserStorageDecision,
} from '../types/userStorageDecision';
import { buildDocumentFileRepresentationPlan } from './documentFileRepresentationPlanService';
import { buildDocumentFileTransformPlan } from './documentFileTransformPlanService';
import {
  findDocumentFileIntakeTransformPlanCarryContext,
  getDocumentFileIntakeTransformPlanCarryContextStoreSnapshot,
  replaceDocumentFileIntakeTransformPlanCarryContextStore,
} from './documentFileIntakeTransformPlanCarryContextStoreService';
import { persistAll } from './persistenceService';

const LOG_PREFIX = '[OfficePilot:intake-transform-plan-carry]';

function includesString(allowed: readonly string[], value: unknown): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

export function createDocumentFileIntakeTransformPlanCarryContext(input: {
  inboxItemId: string;
  policyId: StoragePolicyId;
  userDecision: PersistingUserStorageDecision;
  mediaProfile: StorageMediaProfile;
  capturedAt?: string;
}): DocumentFileIntakeTransformPlanCarryContext {
  if (typeof input.inboxItemId !== 'string' || input.inboxItemId.trim().length === 0) {
    throw new TypeError('Invalid intake transform plan carry inboxItemId');
  }
  if (!includesString(STORAGE_POLICY_IDS, input.policyId)) {
    throw new TypeError('Invalid intake transform plan carry policyId');
  }
  if (!includesString(PERSISTING_USER_STORAGE_DECISIONS, input.userDecision)) {
    throw new TypeError('Invalid intake transform plan carry userDecision');
  }
  if (!includesString(STORAGE_MEDIA_PROFILES, input.mediaProfile)) {
    throw new TypeError('Invalid intake transform plan carry mediaProfile');
  }

  return Object.freeze({
    inboxItemId: input.inboxItemId,
    policyId: input.policyId,
    userDecision: input.userDecision,
    mediaProfile: input.mediaProfile,
    schemaVersion: DOCUMENT_FILE_INTAKE_TRANSFORM_PLAN_CARRY_SCHEMA_VERSION,
    capturedAt:
      typeof input.capturedAt === 'string' && input.capturedAt.trim().length > 0
        ? input.capturedAt
        : new Date().toISOString(),
  });
}

/**
 * Upsert by inboxItemId. Does not persist.
 */
export function upsertDocumentFileIntakeTransformPlanCarryContext(input: {
  inboxItemId: string;
  policyId: StoragePolicyId;
  userDecision: PersistingUserStorageDecision;
  mediaProfile: StorageMediaProfile;
}): DocumentFileIntakeTransformPlanCarryContext {
  const next = createDocumentFileIntakeTransformPlanCarryContext(input);
  const current = getDocumentFileIntakeTransformPlanCarryContextStoreSnapshot();
  const index = current.findIndex((entry) => entry.inboxItemId === next.inboxItemId);
  if (index === -1) {
    replaceDocumentFileIntakeTransformPlanCarryContextStore([...current, next]);
  } else {
    replaceDocumentFileIntakeTransformPlanCarryContextStore([
      ...current.slice(0, index),
      next,
      ...current.slice(index + 1),
    ]);
  }
  return next;
}

/**
 * Persist carry context after a successful pending-intake confirm.
 * Failures are logged with stable codes and must not fail intake.
 */
export function persistDocumentFileIntakeTransformPlanCarryContextAfterConfirm(input: {
  inboxItemId: string;
  policyId: StoragePolicyId;
  userDecision: PersistingUserStorageDecision;
  mediaProfile: StorageMediaProfile;
}): DocumentFileIntakeTransformPlanCarryContext | null {
  try {
    const recorded = upsertDocumentFileIntakeTransformPlanCarryContext(input);
    persistAll();
    return recorded;
  } catch {
    console.error(LOG_PREFIX, 'carry_write_failed');
    return null;
  }
}

export function getDocumentFileIntakeTransformPlanCarryContext(
  inboxItemId: string,
): DocumentFileIntakeTransformPlanCarryContext | null {
  return findDocumentFileIntakeTransformPlanCarryContext(inboxItemId);
}

export interface IntakeTransformPlanImportBundle {
  readonly transformPlan: DocumentFileTransformPlan;
  readonly transformPlanOrigin: DocumentFileDerivativeRecoveryContextOrigin;
}

/**
 * Build import options from a persisted carry context using existing plan builders only.
 * Returns null when no carry exists or builders yield no active transform plan.
 * Does not infer policy/decision/media from MIME or classification.
 */
export function buildTransformPlanImportBundleFromIntakeCarry(
  inboxItemId: string,
): IntakeTransformPlanImportBundle | null {
  const carry = findDocumentFileIntakeTransformPlanCarryContext(inboxItemId);
  if (!carry) {
    return null;
  }

  const representationPlan = buildDocumentFileRepresentationPlan({
    policyId: carry.policyId,
    decision: carry.userDecision,
  });
  if (!representationPlan) {
    return null;
  }

  const transformPlan = buildDocumentFileTransformPlan({
    representationPlan,
    mediaProfile: carry.mediaProfile,
  });
  if (!transformPlan) {
    return null;
  }

  return Object.freeze({
    transformPlan,
    transformPlanOrigin: Object.freeze({
      policyId: carry.policyId,
      decision: carry.userDecision,
      mediaProfile: carry.mediaProfile,
    }),
  });
}

/**
 * Convenience for importInboxDocument callers — undefined when no usable carry/plan.
 */
export function resolveImportInboxDocumentOptionsFromIntakeCarry(
  inboxItemId: string,
): IntakeTransformPlanImportBundle | undefined {
  return buildTransformPlanImportBundleFromIntakeCarry(inboxItemId) ?? undefined;
}
