import type { BusinessInterpretationResult } from './businessInterpretation';
import type { ClassifiedDocumentKind } from './models';
import type { WorkflowDecision } from './workflowDecision';

/** Bump when the persisted Document Work Result shape changes incompatibly. */
export const DOCUMENT_WORK_RESULT_SCHEMA_VERSION = 1 as const;

/**
 * Logical analysis rule/projection version (not schema).
 * Bump when projection semantics change; overlay survives across bumps.
 */
export const DOCUMENT_WORK_RESULT_ANALYSIS_VERSION = '01a.1' as const;

export type DocumentWorkResultOverlayStatus =
  | 'user_confirmed'
  | 'user_corrected'
  | 'discarded';

/**
 * Minimal confirmation overlay entry.
 * Slot identity is opaque (e.g. "facts.money.0", "operational.nextStep").
 */
export type DocumentWorkResultOverlayEntry = {
  slotId: string;
  status: DocumentWorkResultOverlayStatus;
  /** JSON-serializable confirmed/corrected value; null for discarded-without-value. */
  value: unknown;
  updatedAt: string;
  analysisVersionAtWrite?: string;
  /** Set when re-analysis / fingerprint change cannot safely apply the overlay silently. */
  reviewConflict?: boolean;
  conflictReason?: string;
};

/** Compact specialist identity — not full CI/proposal payloads. */
export type DocumentWorkResultSpecialistRefs = {
  hasContractIntelligence: boolean;
  hasContractOrderProposal: boolean;
  hasClassification: boolean;
  hasDocumentUnderstanding: boolean;
  companyRelevant: boolean;
  classifiedKind?: ClassifiedDocumentKind;
};

/**
 * Persistable projection of the document work truth (01A).
 * Natural key: inboxItemId (+ optional workspaceId for isolation metadata).
 */
export type DocumentWorkResult = {
  schemaVersion: typeof DOCUMENT_WORK_RESULT_SCHEMA_VERSION;
  inboxItemId: string;
  workspaceId?: string | null;
  analyzedAt: string;
  analysisVersion: string;
  /** OCR / file source fingerprint used for stale detection. */
  sourceFingerprint: string;
  /** Canonical core — projection of BusinessInterpretationResult (may be null if BI failed). */
  businessInterpretation: BusinessInterpretationResult | null;
  workflowDecision?: WorkflowDecision | null;
  specialistRefs: DocumentWorkResultSpecialistRefs;
  overlay: DocumentWorkResultOverlayEntry[];
};
