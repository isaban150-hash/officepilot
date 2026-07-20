import type { DocumentFileTransformPlan } from '../types/documentFileTransformPlan';
import {
  POST_IMPORT_DERIVATIVE_STEP_IDS,
  POST_IMPORT_DERIVATIVE_STEP_REPRESENTATION_KIND,
  type DocumentFileDerivativeStepOutcome,
  type PostImportDerivativeStepId,
} from '../types/documentFileDerivativeStepOutcome';
import { findDocumentFileDerivativeStepOutcome } from './documentFileDerivativeStepOutcomeStoreService';
import { recordPostImportDerivativeStepOutcome } from './documentFileDerivativeStepOutcomeService';
import { resolveDocumentFileDerivativeStepRunner } from './documentFileDerivativeStepRunnerService';
import {
  releaseDocumentFileDerivativeStepInFlightLock,
  tryAcquireDocumentFileDerivativeStepInFlightLock,
} from './documentFileDerivativeStepInFlightLockService';
import { resolveDocumentFileRepresentation } from './documentFileRepresentationReadService';
import { getDocumentById } from './documentService';
import { getDocumentFileRefById } from './documentFileStoreService';

const LOG_PREFIX = '[OfficePilot:derivative-step-retry]';

/** Maximum actual orchestrator executions recorded as attempt on an outcome. */
export const DOCUMENT_FILE_DERIVATIVE_STEP_MAX_ATTEMPTS = 5;

export interface RetryDocumentFileDerivativeStepInput {
  documentId: string;
  stepId: PostImportDerivativeStepId;
  /** Required pre-built plan; never reconstructed or persisted here. */
  transformPlan: DocumentFileTransformPlan;
}

export type RetryDocumentFileDerivativeStepResult =
  | {
      readonly kind: 'retried';
      readonly outcome: DocumentFileDerivativeStepOutcome | null;
      readonly orchestrationResult: unknown;
    }
  | {
      readonly kind: 'skipped';
      readonly reason: 'already_ready';
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'in_flight' | 'not_eligible';
    }
  | {
      readonly kind: 'exhausted';
    };

function isStepId(value: unknown): value is PostImportDerivativeStepId {
  return (
    typeof value === 'string' &&
    (POST_IMPORT_DERIVATIVE_STEP_IDS as readonly string[]).includes(value)
  );
}

function reportRetryCode(stepId: PostImportDerivativeStepId, code: string): void {
  console.error(LOG_PREFIX, stepId, code);
}

function resolveStepSourceContext(documentId: string): {
  sourceFileRefId: string;
  sourceMimeType: string;
} {
  const document = getDocumentById(documentId);
  if (!document?.fileRefId) {
    return { sourceFileRefId: '', sourceMimeType: '' };
  }
  const fileRef = getDocumentFileRefById(document.fileRefId);
  return {
    sourceFileRefId: document.fileRefId,
    sourceMimeType: fileRef?.mimeType ?? '',
  };
}

function evaluateEligibility(
  existing: DocumentFileDerivativeStepOutcome | null,
): 'ok' | 'not_eligible' | 'exhausted' {
  if (!existing) {
    return 'not_eligible';
  }
  if (existing.attempt >= DOCUMENT_FILE_DERIVATIVE_STEP_MAX_ATTEMPTS) {
    return 'exhausted';
  }
  if (existing.outcome === 'noop' || existing.outcome === 'conflict') {
    return 'not_eligible';
  }
  if (existing.outcome === 'error' || existing.outcome === 'persisted') {
    return 'ok';
  }
  return 'not_eligible';
}

/**
 * Manually retry exactly one post-import derived step.
 * Shares the step→orchestrator map and in-flight lock with the coordinator.
 */
export async function retryDocumentFileDerivativeStep(
  input: RetryDocumentFileDerivativeStepInput,
): Promise<RetryDocumentFileDerivativeStepResult> {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid derivative step retry input');
  }
  if (typeof input.documentId !== 'string' || input.documentId.trim().length === 0) {
    throw new TypeError('Invalid derivative step retry documentId');
  }
  if (!isStepId(input.stepId)) {
    throw new TypeError('Invalid derivative step retry stepId');
  }
  if (input.transformPlan === null || typeof input.transformPlan !== 'object') {
    throw new TypeError('Invalid derivative step retry transformPlan');
  }

  const existing = findDocumentFileDerivativeStepOutcome(input.documentId, input.stepId);
  const eligibility = evaluateEligibility(existing);
  if (eligibility === 'not_eligible') {
    reportRetryCode(input.stepId, 'not_eligible');
    return Object.freeze({ kind: 'rejected', reason: 'not_eligible' });
  }
  if (eligibility === 'exhausted') {
    reportRetryCode(input.stepId, 'exhausted');
    return Object.freeze({ kind: 'exhausted' });
  }

  if (!tryAcquireDocumentFileDerivativeStepInFlightLock(input.documentId, input.stepId)) {
    reportRetryCode(input.stepId, 'in_flight');
    return Object.freeze({ kind: 'rejected', reason: 'in_flight' });
  }

  try {
    const representationKind = POST_IMPORT_DERIVATIVE_STEP_REPRESENTATION_KIND[input.stepId];
    const representation = await resolveDocumentFileRepresentation({
      documentId: input.documentId,
      kind: representationKind,
    });

    if (representation.kind === 'ready') {
      reportRetryCode(input.stepId, 'already_ready');
      return Object.freeze({ kind: 'skipped', reason: 'already_ready' });
    }

    const source = resolveStepSourceContext(input.documentId);
    const runner = resolveDocumentFileDerivativeStepRunner(input.stepId);
    let orchestrationResult: unknown;
    let runnerThrew = false;

    try {
      orchestrationResult = await runner({
        documentId: input.documentId,
        transformPlan: input.transformPlan,
      });
    } catch (error) {
      runnerThrew = true;
      orchestrationResult = null;
      reportRetryCode(input.stepId, 'runner_threw');
      void error;
    }

    const outcome = recordPostImportDerivativeStepOutcome({
      documentId: input.documentId,
      stepId: input.stepId,
      result: orchestrationResult,
      sourceFileRefId: source.sourceFileRefId,
      sourceMimeType: source.sourceMimeType,
      runnerThrew,
    });

    return Object.freeze({
      kind: 'retried',
      outcome,
      orchestrationResult,
    });
  } finally {
    releaseDocumentFileDerivativeStepInFlightLock(input.documentId, input.stepId);
  }
}
