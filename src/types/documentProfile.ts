import type { ClassifiedDocumentKind } from './models';

export type DocumentSenderCategory =
  | 'authority'
  | 'health_insurance'
  | 'insurer'
  | 'bank'
  | 'court'
  | 'customer'
  | 'supplier'
  | 'employee_related'
  | 'tax_advisor'
  | 'unknown';

export type DocumentFunction =
  | 'invoice'
  | 'reminder'
  | 'certificate'
  | 'contract'
  | 'form'
  | 'application'
  | 'notice'
  | 'confirmation'
  | 'statement'
  | 'report'
  | 'correspondence'
  | 'unknown';

export type DocumentActionType =
  | 'pay'
  | 'respond'
  | 'submit_documents'
  | 'sign'
  | 'review'
  | 'archive'
  | 'assign'
  | 'information_only'
  | 'unknown';

export type DocumentProfileConflictType =
  | 'authority_employment_vs_health_insurance'
  | 'form_certificate_vs_reminder'
  | 'invoice_vs_reminder'
  | 'contract_vs_payment'
  | 'candidates_too_close'
  | 'missing_required_evidence';

export type DocumentProfileCandidate = {
  kind: ClassifiedDocumentKind;
  score: number;
  confidence: number;
};

/**
 * Runtime-only universal document understanding.
 * Not persisted to InboxItem, CompanyDocument, IndexedDB, or Supabase.
 */
export type DocumentProfile = {
  senderEntity?: string;
  senderCategory: DocumentSenderCategory;
  documentFunction: DocumentFunction;
  subjectArea?: string;
  actionType: DocumentActionType;
  paymentDemand: boolean;
  deadlineEvidence: boolean;
  documentDateEvidence: boolean;
  affectedParty?: string;
  linkedCustomerOrOrder?: string;
  filingDomain?: string;
  confidence: number;
  margin: number;
  evidenceRefs: string[];
  conflicts: DocumentProfileConflictType[];
  warnings: string[];
  topCandidates: DocumentProfileCandidate[];
  classifiedKindHint?: ClassifiedDocumentKind;
  needsKindReview: boolean;
  reviewReasonKeys: string[];
};
