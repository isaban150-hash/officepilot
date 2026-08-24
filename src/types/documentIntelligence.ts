import type { AnalysisConfidence, ClassifiedDocumentKind, DetectedOrderPosition, DetectedPaymentTerm } from './models';

export type DocumentSectionType =
  | 'contract_core'
  | 'bill_of_quantities'
  | 'technical_attachment'
  | 'commercial_attachment'
  | 'unknown';

export type ExtractedFieldStatus = 'confirmed' | 'review_required' | 'not_found';

export type FieldConfidenceLevel = 'high' | 'medium' | 'low';

export interface DocumentPageText {
  pageNumber: number;
  text: string;
}

export interface DocumentPageSection {
  pageNumber: number;
  sectionType: DocumentSectionType;
  confidence: AnalysisConfidence;
  textPreview: string;
}

export interface DocumentSegmentationResult {
  pages: DocumentPageSection[];
  contractCorePages: number[];
  billOfQuantitiesPages: number[];
  technicalAttachmentPages: number[];
  commercialAttachmentPages: number[];
  unknownPages: number[];
}

export interface ExtractedContractField<T = string> {
  value?: T;
  status: ExtractedFieldStatus;
  confidence: FieldConfidenceLevel;
  sourcePage?: number;
  sourceText?: string;
}

export interface AmountCandidate {
  value: number;
  formatted: string;
  context: string;
  label?: string;
  sourcePage?: number;
}

/** Machine-readable review reasons — several can apply to one position. */
export type PositionReviewReason = 'unit_unknown' | 'unit_ambiguous' | 'line_math_mismatch';

export interface EnhancedDetectedOrderPosition extends DetectedOrderPosition {
  sourcePage?: number;
  confidence: AnalysisConfidence;
  reviewStatus: ExtractedFieldStatus;
  constructionSection?: string;
  /** Verbatim unit text from the document, kept even when it cannot be mapped. */
  rawUnit?: string;
  /** Empty or absent when the position is clean. */
  reviewReasons?: PositionReviewReason[];
}

export type DetectedContractClauseId =
  | 'nachtraege'
  | 'behinderungsanzeige'
  | 'materialbereitstellung'
  | 'baustrom'
  | 'bauwasser'
  | 'geruest'
  | 'kran'
  | 'entsorgung'
  | 'stundenlohnarbeiten'
  | 'wartezeit'
  | 'kuendigung'
  | 'abnahme';

export interface DetectedContractClause {
  id: DetectedContractClauseId;
  status: ExtractedFieldStatus;
  confidence: FieldConfidenceLevel;
  sourcePage?: number;
  sourceText?: string;
  summary?: string;
}

export type ContractFamily =
  | 'werkvertrag'
  | 'subunternehmervertrag'
  | 'dienstleistungsvertrag'
  | 'wartungsvertrag'
  | 'mietvertrag'
  | 'leasingvertrag'
  | 'liefervertrag'
  | 'rahmenvertrag'
  | 'kaufvertrag'
  | 'versicherungsvertrag'
  | 'arbeitsvertrag'
  | 'general_contract'
  | 'unknown';

export type ContractPartyRole =
  | 'auftraggeber'
  | 'auftragnehmer'
  | 'subunternehmer'
  | 'nachunternehmer'
  | 'kunde'
  | 'dienstleister'
  | 'vermieter'
  | 'mieter'
  | 'leasinggeber'
  | 'leasingnehmer'
  | 'verkaeufer'
  | 'kaeufer'
  | 'versicherer'
  | 'versicherungsnehmer'
  | 'arbeitgeber'
  | 'arbeitnehmer'
  | 'unknown';

export interface DetectedContractParty {
  role: ContractPartyRole;
  name: string;
  address?: string;
  /**
   * Street, postal code, city and contact person are only set when they were
   * found inside this party's own block in the document. A document-wide
   * address never lands here — safety before completeness.
   */
  street?: string;
  zip?: string;
  city?: string;
  contactPerson?: string;
  email?: string;
  phone?: string;
  status: ExtractedFieldStatus;
  confidence: FieldConfidenceLevel;
  sourceText?: string;
}

export interface DetectedContractType {
  family: ContractFamily;
  labelKey: string;
  confidence: FieldConfidenceLevel;
  status: ExtractedFieldStatus;
  evidence: string[];
}

export interface ContractIntelligenceResult {
  documentLabelKey: string;
  classifiedKind: ClassifiedDocumentKind;
  reviewRequired: boolean;
  segmentation: DocumentSegmentationResult;
  contractFields: Record<string, ExtractedContractField>;
  /** Optional general contract-family detection (01A2). */
  contractType?: DetectedContractType;
  /** Optional structured parties with roles (01A2). */
  parties?: DetectedContractParty[];
  /** Common fields shared across contract families (01A2). */
  commonFields?: Record<string, ExtractedContractField>;
  /** Type-specific fields for the detected family only (01A2). */
  typeSpecificFields?: Record<string, ExtractedContractField>;
  positions: EnhancedDetectedOrderPosition[];
  contractTotalNet?: ExtractedContractField<number>;
  paymentTerms: DetectedPaymentTerm[];
  /** Structured clause hits from the same OCR pass — empty when none detected. */
  clauses?: DetectedContractClause[];
  progressBillingAllowed: boolean;
  finalInvoiceMentioned: boolean;
  technicalAttachmentCount: number;
  openReviewHints: string[];
}

export interface ContractOrderProposal {
  customer: string;
  contractor: string;
  constructionSite: string;
  contractDate?: string;
  positionCount: number;
  contractTotalNet?: string;
  paymentTermsSummary: string;
  progressBillingHint?: string;
  technicalAttachmentsLabel?: string;
  reviewHints: string[];
  positions: EnhancedDetectedOrderPosition[];
  intelligence: ContractIntelligenceResult;
}
