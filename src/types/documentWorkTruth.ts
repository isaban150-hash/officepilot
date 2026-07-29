import type { BusinessInterpretationResult } from './businessInterpretation';
import type { DocumentWorkResultOverlayStatus } from './documentWorkResult';

/** Where the TruthView BI core came from. */
export type DocumentWorkTruthSource = 'live_merged' | 'snapshot';

/** Provenance of a resolved overlay slot. */
export type DocumentWorkTruthSlotProvenance =
  | 'analysis'
  | 'user_confirmed'
  | 'user_corrected'
  | 'discarded'
  | 'conflict';

/** Supported overlay slot IDs for DOCUMENT-WORK-RESULT-01B. */
export type DocumentWorkResultKnownSlotId =
  | 'operational.nextStep'
  | 'operational.confirmRequirement'
  | 'facts.money.0'
  | 'facts.parties.counterparty'
  | 'facts.parties.ownCompany'
  | 'facts.timeline.deadline'
  | 'meaning.summary';

export type DocumentWorkTruthResolvedSlot = {
  slotId: DocumentWorkResultKnownSlotId;
  status: DocumentWorkResultOverlayStatus;
  provenance: DocumentWorkTruthSlotProvenance;
  /** Analysis value before overlay apply (JSON-serializable clone). */
  analysisValue: unknown;
  /** Stored overlay value (JSON-serializable clone). */
  userValue: unknown;
  /** Effective value after apply; null/undefined when discarded or empty. */
  effectiveValue: unknown;
  reviewConflict: boolean;
  conflictReason?: string;
  /** True when stored value failed type validation and was not applied. */
  valueInvalid?: boolean;
};

export type DocumentWorkTruthUnresolvedConflict = {
  slotId: DocumentWorkResultKnownSlotId;
  analysisValue: unknown;
  userValue: unknown;
  conflictReason?: string;
  status: DocumentWorkResultOverlayStatus;
};

/**
 * Ephemeral resolved document truth — never persist.
 * Not a WorkflowResult; display / assist context only.
 */
export type DocumentWorkTruthView = {
  inboxItemId: string;
  analysisVersion: string;
  sourceFingerprint: string;
  source: DocumentWorkTruthSource;
  businessInterpretation: BusinessInterpretationResult | null;
  slots: DocumentWorkTruthResolvedSlot[];
  unresolvedConflicts: DocumentWorkTruthUnresolvedConflict[];
  ignoredUnknownSlotIds: string[];
};
