import type { DocumentFileDerivativeStepId } from '../types/documentFileDerivativeStepOutcome';
import { getDocumentFileTransformPlanForDerivativeRetry } from './documentFileDerivativeRecoveryContextService';
import { retryDocumentFileDerivativeStep } from './documentFileDerivativeStepManualRetryService';

export type DocumentFileDerivativeRecoveryDetailRetryFeedback =
  | 'missing_plan'
  | 'success'
  | 'failed'
  | 'in_flight'
  | 'noop';

export interface DocumentFileDerivativeRecoveryDetailRetryResult {
  readonly feedback: DocumentFileDerivativeRecoveryDetailRetryFeedback;
  readonly shouldRefreshPreview: boolean;
}

export interface ExecuteDocumentFileDerivativeRecoveryDetailRetryInput {
  documentId: string;
  selectedStepId: DocumentFileDerivativeStepId;
}

/**
 * Detail-page manual retry for exactly one recovery problem row.
 * Loads the transform plan only from recovery context — never replans.
 */
export async function executeDocumentFileDerivativeRecoveryDetailRetry(
  input: ExecuteDocumentFileDerivativeRecoveryDetailRetryInput,
): Promise<DocumentFileDerivativeRecoveryDetailRetryResult> {
  const transformPlan = getDocumentFileTransformPlanForDerivativeRetry(input.documentId);
  if (!transformPlan) {
    return Object.freeze({
      feedback: 'missing_plan',
      shouldRefreshPreview: false,
    });
  }

  try {
    const result = await retryDocumentFileDerivativeStep({
      documentId: input.documentId,
      stepId: input.selectedStepId,
      transformPlan,
    });

    if (result.kind === 'skipped' && result.reason === 'already_ready') {
      return Object.freeze({
        feedback: 'success',
        shouldRefreshPreview: true,
      });
    }

    if (result.kind === 'rejected' && result.reason === 'in_flight') {
      return Object.freeze({
        feedback: 'in_flight',
        shouldRefreshPreview: false,
      });
    }

    if (
      result.kind === 'exhausted' ||
      (result.kind === 'rejected' && result.reason === 'not_eligible')
    ) {
      return Object.freeze({
        feedback: 'noop',
        shouldRefreshPreview: false,
      });
    }

    if (result.kind === 'retried') {
      if (result.outcome?.outcome === 'error') {
        return Object.freeze({
          feedback: 'failed',
          shouldRefreshPreview: false,
        });
      }
      return Object.freeze({
        feedback: 'success',
        shouldRefreshPreview: true,
      });
    }

    return Object.freeze({
      feedback: 'failed',
      shouldRefreshPreview: false,
    });
  } catch {
    return Object.freeze({
      feedback: 'failed',
      shouldRefreshPreview: false,
    });
  }
}
