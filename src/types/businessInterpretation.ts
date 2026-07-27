import type {
  AnalysisConfidence,
  ClassifiedDocumentKind,
  SuggestedVorgangLink,
  WorkflowActionId,
  WorkflowNextAction,
} from './models';
import type {
  ContractFamily,
  ContractPartyRole,
  ExtractedFieldStatus,
} from './documentIntelligence';

/**
 * Document kind ≠ business event type.
 * Event types describe what may have happened operationally.
 * Never applied automatically — read-only interpretation only.
 */
export type BusinessEventType =
  | 'possible_new_business_case'
  | 'business_case_update'
  | 'contract_proposed'
  | 'order_confirmed'
  | 'service_change_proposed'
  | 'invoice_received'
  | 'invoice_created'
  | 'payment_reminder_received'
  | 'delivery_recorded'
  | 'acceptance_recorded'
  | 'complaint_received'
  | 'deadline_or_obligation_detected'
  | 'evidence_added'
  | 'information_only'
  | 'review_required';

/**
 * How a statement relates to known specialist / state data.
 * No invented confidence scores — reuse existing confidence when present.
 */
export type BusinessFactCertainty =
  | 'confirmed_by_existing_state'
  | 'detected'
  | 'proposed'
  | 'uncertain'
  | 'conflicting';

/** Specialist / state origin for a structured fact — no new extraction. */
export type BusinessFactSource =
  | 'vorgangState'
  | 'contractIntelligence'
  | 'contractOrderProposal'
  | 'contractAnalysis'
  | 'understanding'
  | 'recognizedData'
  | 'companyProfile';

export type BusinessEffectKind =
  | 'performance'
  | 'money'
  | 'deadline'
  | 'material'
  | 'evidence'
  | 'contract'
  | 'invoice';

export type BusinessConfirmationId =
  | 'save_document'
  | 'assign_vorgang'
  | 'confirm_contract_parties'
  | 'confirm_positions'
  | 'confirm_amendment'
  | 'finalize_invoice'
  | 'storage_decision';

export type BusinessNextActionSource =
  | 'workflow.nextActions'
  | 'workflow.suggestedTasks';

export type BusinessMoneyKind =
  | 'contract_total'
  | 'boq_total'
  | 'fixed_fee'
  | 'recurring_fee'
  | 'rent'
  | 'invoice_total'
  | 'hourly_rate'
  | 'other';

export type BusinessConditionType =
  | 'material'
  | 'hourly_work'
  | 'waiting_time'
  | 'payment_terms'
  | 'advance_payment'
  | 'final_invoice'
  | 'acceptance'
  | 'warranty'
  | 'contractual_penalty'
  | 'retention_or_security'
  | 'evidence_requirement'
  | 'bg_bau'
  | 'soka_bau'
  | 'termination'
  | 'renewal'
  | 'service_interval'
  | 'delivery_terms'
  | 'reaction_time';

export type BusinessSignatureStatus =
  | 'detected'
  | 'not_detected'
  | 'partial'
  | 'unclear';

export type BusinessPartyRelation = 'counterparty' | 'own_company' | 'other';

export interface BusinessInterpretationSourceDocument {
  sourceDocumentId: string;
  classifiedKind: ClassifiedDocumentKind;
  classificationConfidence: AnalysisConfidence;
  recognitionUncertain: boolean;
}

export interface BusinessInterpretationMeaning {
  /** Primary operational reading — never silently chosen among equals. */
  eventType: BusinessEventType;
  certainty: BusinessFactCertainty;
  /** Short operational meaning derived from existing specialist outputs. */
  summary: string;
  /** Alternative readings when the primary is not unique. */
  alternativeEventTypes: BusinessEventType[];
  /** Existing confidence copied from specialists when available. */
  inheritedConfidence?: AnalysisConfidence;
}

export interface BusinessInterpretationVorgangRef {
  status:
    | 'suggested'
    | 'linked'
    | 'ambiguous'
    | 'none';
  suggested?: SuggestedVorgangLink | null;
  linkedVorgangId?: string | null;
  linkedVorgangTitle?: string | null;
  similarCount: number;
  ambiguityReason?: string;
}

export interface BusinessInterpretationParty {
  name: string;
  role?: ContractPartyRole | 'own_company' | 'counterparty' | 'unknown';
  certainty: BusinessFactCertainty;
  source: 'contractIntelligence' | 'contractOrderProposal' | 'understanding' | 'recognizedData' | 'companyProfile';
}

export interface BusinessInterpretationEffect {
  kind: BusinessEffectKind;
  summary: string;
  certainty: BusinessFactCertainty;
  /** Only when already present on specialist / state data. */
  detail?: string;
}

export interface BusinessInterpretationGap {
  id: string;
  summary: string;
  certainty: BusinessFactCertainty;
}

export interface BusinessInterpretationConflict {
  id: string;
  summary: string;
  certainty: 'conflicting';
}

export interface BusinessInterpretationConfirmation {
  id: BusinessConfirmationId;
  summary: string;
  required: true;
}

export interface BusinessInterpretationNextActionCandidate {
  /** Stable id from the existing source (WorkflowActionId or task dedupe key). */
  id: string;
  labelKey?: string;
  label?: string;
  enabled?: boolean;
  source: BusinessNextActionSource;
  /** Optional WorkflowNextAction passthrough when source is workflow.nextActions. */
  workflowActionId?: WorkflowActionId;
}

/** Single labeled value with provenance. */
export interface BusinessLabeledFact {
  value: string;
  certainty: BusinessFactCertainty;
  source: BusinessFactSource;
  /** Optional field key from the specialist (e.g. bauvorhaben). */
  fieldKey?: string;
}

export interface BusinessStructuredParty {
  name: string;
  role?: ContractPartyRole | 'unknown';
  relation: BusinessPartyRelation;
  contactPerson?: string;
  certainty: BusinessFactCertainty;
  source: BusinessFactSource;
}

export interface BusinessStructuredSubject {
  /** Short subject / Vertragsgegenstand when present. */
  subject?: BusinessLabeledFact;
  /** Generic object (e.g. Mietobjekt, Wartungsobjekt). */
  object?: BusinessLabeledFact;
  /** Construction project name when present. */
  project?: BusinessLabeledFact;
  /** Site / Leistungsort / Baustelle when present. */
  site?: BusinessLabeledFact;
}

export interface BusinessStructuredTimeline {
  contractDate?: BusinessLabeledFact;
  start?: BusinessLabeledFact;
  end?: BusinessLabeledFact;
  duration?: BusinessLabeledFact;
  deadline?: BusinessLabeledFact;
}

export interface BusinessStructuredMoney {
  kind: BusinessMoneyKind;
  amount?: number;
  amountFormatted?: string;
  currency?: string;
  label?: string;
  certainty: BusinessFactCertainty;
  source: BusinessFactSource;
}

export interface BusinessStructuredPosition {
  /** Stable id derived from specialist position index / description. */
  id: string;
  description: string;
  quantity?: number;
  unit?: string;
  unitPrice?: number;
  lineTotal?: number;
  sourcePage?: number;
  reviewStatus?: ExtractedFieldStatus;
  certainty: BusinessFactCertainty;
  source: BusinessFactSource;
}

export interface BusinessStructuredCondition {
  type: BusinessConditionType;
  summary: string;
  certainty: BusinessFactCertainty;
  source: BusinessFactSource;
  sourceText?: string;
}

export interface BusinessStructuredSignatures {
  status: BusinessSignatureStatus;
  /** Heuristic page/party hints from contract analysis when present. */
  pageHints?: string[];
  partyHint?: string;
  certainty: BusinessFactCertainty;
  source: BusinessFactSource;
}

/**
 * Structured operational facts forwarded from specialists.
 * Empty collections mean “not available”, never invented.
 */
export interface BusinessStructuredFacts {
  parties: {
    counterparty?: BusinessStructuredParty;
    ownCompany?: BusinessStructuredParty;
    others: BusinessStructuredParty[];
    contactPerson?: BusinessLabeledFact;
  };
  subject: BusinessStructuredSubject;
  timeline: BusinessStructuredTimeline;
  money: BusinessStructuredMoney[];
  positions: BusinessStructuredPosition[];
  conditions: BusinessStructuredCondition[];
  signatures: BusinessStructuredSignatures;
}

/**
 * Read-only coordination output.
 * Must never trigger persistence or execution by itself.
 */
export interface BusinessInterpretationResult {
  readonly readOnly: true;
  sourceDocument: BusinessInterpretationSourceDocument;
  meaning: BusinessInterpretationMeaning;
  vorgangRef: BusinessInterpretationVorgangRef;
  parties: BusinessInterpretationParty[];
  effects: BusinessInterpretationEffect[];
  missingInformation: BusinessInterpretationGap[];
  conflicts: BusinessInterpretationConflict[];
  requiredConfirmations: BusinessInterpretationConfirmation[];
  /** Existing next-action candidates only — no new priority engine. */
  nextActionCandidates: BusinessInterpretationNextActionCandidate[];
  /** Structured facts forwarded from specialists (BUSINESS-BRAIN-01A1). */
  facts: BusinessStructuredFacts;
  /** Optional contract family copied from intelligence when present. */
  contractFamily?: ContractFamily;
  /** Passthrough reference for tests / callers — never mutate via this result. */
  derivedFrom: {
    hasContractIntelligence: boolean;
    hasContractOrderProposal: boolean;
    hasClassification: boolean;
    hasDocumentUnderstanding: boolean;
    companyRelevant: boolean;
  };
}

/** Narrow helper for callers that only need workflow next actions. */
export type BusinessInterpretationWorkflowNextAction = WorkflowNextAction;
