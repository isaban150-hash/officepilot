import type { FieldConfidenceLevel } from '../services/documentFieldExtractionService';
import type { ExtractedDocumentFields } from '../services/documentFieldExtractionService';

export const DOCUMENT_FIELD_FILL_CONFIRM_STATUSES = [
  'missing',
  'proposed',
  'confirmed',
  'rejected',
] as const;

export type DocumentFieldFillConfirmStatus =
  (typeof DOCUMENT_FIELD_FILL_CONFIRM_STATUSES)[number];

export type DocumentFieldFillConfirmFieldKey = keyof ExtractedDocumentFields;

/**
 * One local session row for the inbox fill-confirm panel.
 * Never persisted — component state only.
 */
export interface DocumentFieldFillConfirmRow {
  readonly fieldKey: DocumentFieldFillConfirmFieldKey;
  readonly label: string;
  /** Original proposal from extraction or page context; empty when missing. */
  readonly proposedValue: string;
  readonly confidence?: FieldConfidenceLevel;
  readonly status: DocumentFieldFillConfirmStatus;
  /** Set only when status is confirmed (confirm or correct). */
  readonly confirmedValue?: string;
}

export interface DocumentFieldFillConfirmViewModel {
  readonly rows: readonly DocumentFieldFillConfirmRow[];
}
