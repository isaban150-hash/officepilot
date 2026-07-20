import type {
  DocumentFileDerivativeStepErrorCode,
  DocumentFileDerivativeStepId,
} from '../types/documentFileDerivativeStepOutcome';
import { DOCUMENT_FILE_DERIVATIVE_STEP_ERROR_CODES } from '../types/documentFileDerivativeStepOutcome';

/**
 * Sanitized orchestrator error result — never carries Error objects, messages, or stacks.
 */
export type DocumentFileDerivativeOrchestrationErrorResult = {
  readonly kind: 'error';
  readonly errorCode: DocumentFileDerivativeStepErrorCode;
};

export function isDocumentFileDerivativeStepErrorCode(
  value: unknown,
): value is DocumentFileDerivativeStepErrorCode {
  return (
    typeof value === 'string' &&
    (DOCUMENT_FILE_DERIVATIVE_STEP_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Log only prefix + stepId + stable code. Never log raw errors, paths, or content.
 */
export function reportDocumentFileDerivativeStepError(
  logPrefix: string,
  stepId: DocumentFileDerivativeStepId,
  errorCode: DocumentFileDerivativeStepErrorCode,
): void {
  console.error(logPrefix, stepId, errorCode);
}

export function createDocumentFileDerivativeOrchestrationErrorResult(
  errorCode: DocumentFileDerivativeStepErrorCode,
): DocumentFileDerivativeOrchestrationErrorResult {
  return Object.freeze({ kind: 'error', errorCode });
}

/**
 * Read a stable error code from an orchestration result without retaining raw fields.
 */
export function readDocumentFileDerivativeOrchestrationErrorCode(
  result: unknown,
): DocumentFileDerivativeStepErrorCode | undefined {
  if (result === null || typeof result !== 'object' || !('kind' in result)) {
    return undefined;
  }
  const record = result as { kind?: unknown; errorCode?: unknown };
  if (record.kind !== 'error') {
    return undefined;
  }
  return isDocumentFileDerivativeStepErrorCode(record.errorCode)
    ? record.errorCode
    : 'orchestrator_error';
}
