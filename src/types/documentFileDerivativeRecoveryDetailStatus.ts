import type { DocumentFileRepresentationBindingKind } from './documentFileRepresentationBinding';
import type { PostImportDerivativeStepId } from './documentFileDerivativeStepOutcome';

export const DOCUMENT_FILE_DERIVATIVE_RECOVERY_DETAIL_STATUSES = [
  'error',
  'missing_after_persist',
  'conflict',
  'exhausted',
] as const;

export type DocumentFileDerivativeRecoveryDetailStatus =
  (typeof DOCUMENT_FILE_DERIVATIVE_RECOVERY_DETAIL_STATUSES)[number];

/**
 * One user-visible recovery problem for a missing representation on the document detail page.
 * canRetry is informational only — no retry handler is attached in this sprint.
 */
export interface DocumentFileDerivativeRecoveryDetailProblem {
  readonly representationKind: DocumentFileRepresentationBindingKind;
  readonly status: DocumentFileDerivativeRecoveryDetailStatus;
  readonly selectedStepId?: PostImportDerivativeStepId;
  readonly canRetry: boolean;
  readonly attempt: number;
  /** Short kind label, e.g. "Vorschau fehlt". */
  readonly displayTitle: string;
  /** Status explanation without step IDs or error codes. */
  readonly displayDetail: string;
  /** Optional informational retry hint when canRetry is true. */
  readonly retryHint?: string;
}

export interface DocumentFileDerivativeRecoveryDetailStatusViewModel {
  readonly documentId: string;
  readonly hasRecoveryPlan: boolean;
  readonly problems: readonly DocumentFileDerivativeRecoveryDetailProblem[];
}
