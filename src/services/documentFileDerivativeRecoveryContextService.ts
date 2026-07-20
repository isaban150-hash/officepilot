import {
  DOCUMENT_FILE_DERIVATIVE_RECOVERY_CONTEXT_SCHEMA_VERSION,
  type DocumentFileDerivativeRecoveryContext,
  type DocumentFileDerivativeRecoveryContextOrigin,
} from '../types/documentFileDerivativeRecoveryContext';
import {
  DOCUMENT_FILE_TRANSFORM_EXECUTION_INTENTS,
  DOCUMENT_FILE_TRANSFORM_INTENTS,
  type DocumentFileTransformPlan,
  type DocumentFileTransformTargetKind,
} from '../types/documentFileTransformPlan';
import { DOCUMENT_FILE_REPRESENTATION_KINDS } from '../types/documentFileRepresentation';
import {
  STORAGE_COLOR_HANDLINGS,
  STORAGE_MEDIA_PROFILES,
  STORAGE_METADATA_HANDLINGS,
  STORAGE_POLICY_IDS,
  STORAGE_PREFERRED_OUTPUT_KINDS,
} from '../types/storagePolicy';
import { USER_STORAGE_DECISIONS } from '../types/userStorageDecision';
import {
  findDocumentFileDerivativeRecoveryContext,
  getDocumentFileDerivativeRecoveryContextStoreSnapshot,
  replaceDocumentFileDerivativeRecoveryContextStore,
} from './documentFileDerivativeRecoveryContextStoreService';
import { persistAll } from './persistenceService';

const LOG_PREFIX = '[OfficePilot:derivative-recovery-context]';

const TRANSFORM_TARGET_KINDS = DOCUMENT_FILE_REPRESENTATION_KINDS.filter(
  (kind): kind is DocumentFileTransformTargetKind => kind !== 'original',
);

function includesString(allowed: readonly string[], value: unknown): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

/**
 * Validate and defensively deep-copy a transform plan. Never mutates the input.
 */
export function cloneValidatedDocumentFileTransformPlan(
  plan: DocumentFileTransformPlan,
): DocumentFileTransformPlan {
  if (plan === null || typeof plan !== 'object') {
    throw new TypeError('Invalid transform plan');
  }
  if (!includesString(STORAGE_POLICY_IDS, plan.policyId)) {
    throw new TypeError('Invalid transform plan policyId');
  }
  if (!includesString(STORAGE_MEDIA_PROFILES, plan.mediaProfile)) {
    throw new TypeError('Invalid transform plan mediaProfile');
  }
  if (plan.hints === null || typeof plan.hints !== 'object') {
    throw new TypeError('Invalid transform plan hints');
  }
  if (!includesString(STORAGE_METADATA_HANDLINGS, plan.hints.metadataHandling)) {
    throw new TypeError('Invalid transform plan metadataHandling');
  }
  if (!includesString(STORAGE_COLOR_HANDLINGS, plan.hints.colorHandling)) {
    throw new TypeError('Invalid transform plan colorHandling');
  }
  if (!includesString(STORAGE_PREFERRED_OUTPUT_KINDS, plan.hints.preferredOutputKind)) {
    throw new TypeError('Invalid transform plan preferredOutputKind');
  }
  if (!Array.isArray(plan.intents) || plan.intents.length === 0) {
    throw new TypeError('Invalid transform plan intents');
  }

  const intents = plan.intents.map((entry) => {
    if (entry === null || typeof entry !== 'object') {
      throw new TypeError('Invalid transform plan intent');
    }
    if (!includesString(TRANSFORM_TARGET_KINDS, entry.targetKind)) {
      throw new TypeError('Invalid transform plan targetKind');
    }
    if (!includesString(DOCUMENT_FILE_TRANSFORM_INTENTS, entry.intent)) {
      throw new TypeError('Invalid transform plan intent kind');
    }
    if (!includesString(DOCUMENT_FILE_TRANSFORM_EXECUTION_INTENTS, entry.executionIntent)) {
      throw new TypeError('Invalid transform plan executionIntent');
    }
    return Object.freeze({
      targetKind: entry.targetKind,
      intent: entry.intent,
      executionIntent: entry.executionIntent,
    });
  });

  return Object.freeze({
    policyId: plan.policyId,
    mediaProfile: plan.mediaProfile,
    hints: Object.freeze({
      metadataHandling: plan.hints.metadataHandling,
      colorHandling: plan.hints.colorHandling,
      preferredOutputKind: plan.hints.preferredOutputKind,
    }),
    intents: Object.freeze(intents),
  }) as DocumentFileTransformPlan;
}

function cloneValidatedOrigin(
  origin: DocumentFileDerivativeRecoveryContextOrigin,
): DocumentFileDerivativeRecoveryContextOrigin {
  if (origin === null || typeof origin !== 'object') {
    throw new TypeError('Invalid recovery context origin');
  }
  if (!includesString(STORAGE_POLICY_IDS, origin.policyId)) {
    throw new TypeError('Invalid recovery context origin policyId');
  }
  if (!includesString(USER_STORAGE_DECISIONS, origin.decision)) {
    throw new TypeError('Invalid recovery context origin decision');
  }
  if (!includesString(STORAGE_MEDIA_PROFILES, origin.mediaProfile)) {
    throw new TypeError('Invalid recovery context origin mediaProfile');
  }
  return Object.freeze({
    policyId: origin.policyId,
    decision: origin.decision,
    mediaProfile: origin.mediaProfile,
  });
}

export function createDocumentFileDerivativeRecoveryContext(input: {
  documentId: string;
  transformPlan: DocumentFileTransformPlan;
  capturedAt?: string;
  origin?: DocumentFileDerivativeRecoveryContextOrigin;
}): DocumentFileDerivativeRecoveryContext {
  if (typeof input.documentId !== 'string' || input.documentId.trim().length === 0) {
    throw new TypeError('Invalid recovery context documentId');
  }

  const context: DocumentFileDerivativeRecoveryContext = {
    documentId: input.documentId,
    transformPlan: cloneValidatedDocumentFileTransformPlan(input.transformPlan),
    capturedAt:
      typeof input.capturedAt === 'string' && input.capturedAt.trim().length > 0
        ? input.capturedAt
        : new Date().toISOString(),
    schemaVersion: DOCUMENT_FILE_DERIVATIVE_RECOVERY_CONTEXT_SCHEMA_VERSION,
  };

  if (input.origin !== undefined) {
    (context as { origin?: DocumentFileDerivativeRecoveryContextOrigin }).origin =
      cloneValidatedOrigin(input.origin);
  }

  return Object.freeze(context);
}

/**
 * Upsert by documentId — replaces any existing entry deterministically.
 * Does not persist.
 */
export function upsertDocumentFileDerivativeRecoveryContext(input: {
  documentId: string;
  transformPlan: DocumentFileTransformPlan;
  origin?: DocumentFileDerivativeRecoveryContextOrigin;
}): DocumentFileDerivativeRecoveryContext {
  const next = createDocumentFileDerivativeRecoveryContext(input);
  const current = getDocumentFileDerivativeRecoveryContextStoreSnapshot();
  const index = current.findIndex((entry) => entry.documentId === next.documentId);
  if (index === -1) {
    replaceDocumentFileDerivativeRecoveryContextStore([...current, next]);
  } else {
    replaceDocumentFileDerivativeRecoveryContextStore([
      ...current.slice(0, index),
      next,
      ...current.slice(index + 1),
    ]);
  }
  return next;
}

/**
 * Persist recovery context after a successful import that received a transformPlan.
 * Failures are logged with stable codes and must not fail import.
 */
export function persistDocumentFileDerivativeRecoveryContextAfterImport(input: {
  documentId: string;
  transformPlan: DocumentFileTransformPlan;
  origin?: DocumentFileDerivativeRecoveryContextOrigin;
}): DocumentFileDerivativeRecoveryContext | null {
  try {
    const recorded = upsertDocumentFileDerivativeRecoveryContext(input);
    persistAll();
    return recorded;
  } catch {
    console.error(LOG_PREFIX, 'context_write_failed');
    return null;
  }
}

/** Read helper — returns a defensive copy or null. */
export function getDocumentFileDerivativeRecoveryContext(
  documentId: string,
): DocumentFileDerivativeRecoveryContext | null {
  return findDocumentFileDerivativeRecoveryContext(documentId);
}

/**
 * Returns the frozen transform plan snapshot for a later manual retry.
 * Does not replan or consult current policy.
 */
export function getDocumentFileTransformPlanForDerivativeRetry(
  documentId: string,
): DocumentFileTransformPlan | null {
  const context = findDocumentFileDerivativeRecoveryContext(documentId);
  return context ? cloneValidatedDocumentFileTransformPlan(context.transformPlan) : null;
}
