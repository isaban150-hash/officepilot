import type { DocumentFileRepresentationBindingKind } from './documentFileRepresentationBinding';
import type { DocumentFileDerivativeStepId } from './documentFileDerivativeStepOutcome';

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
 * When canRetry and selectedStepId are set, the detail panel may offer a one-step manual retry.
 */
export interface DocumentFileDerivativeRecoveryDetailProblem {
  readonly representationKind: DocumentFileRepresentationBindingKind;
  readonly status: DocumentFileDerivativeRecoveryDetailStatus;
  readonly selectedStepId?: DocumentFileDerivativeStepId;
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
